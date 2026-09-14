/**
 * The HTTP application (docs/bff-api.md): process endpoints, per-database snapshot/events,
 * read and write proxies, and the SPA — all under `BDDB_BASE_PATH`.
 *
 * `createApp` discovers databases, synthesizes workspaces, starts one `DatabaseRuntime` per
 * database and binds `Bun.serve`. `stop()` tears everything down (bd serve processes and their
 * db-proxy children included).
 */
import path from "node:path";
import type { Config } from "./config.ts";
import { DiscoveryError, discoverDatabases, doltConnection } from "./discovery.ts";
import type { Logger } from "./log.ts";
import { checkBd } from "./preflight.ts";
import { jsonResponse, problemResponse } from "./problem.ts";
import { DatabaseRuntime } from "./project.ts";
import {
  filterQuery,
  forward,
  invalidArgument,
  matchProxyRoute,
  withAttribution,
} from "./proxy.ts";
import { prepareStatic, type StaticAssets } from "./static.ts";
import type { DatabaseInfo, Meta, Snapshot } from "./types.ts";
import { BDDB_VERSION, BUILT_FOR_BEADS } from "./version.ts";
import { ensureWorkspace, workspaceRoot } from "./workspace.ts";

export interface App {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  databases: Map<string, DatabaseRuntime>;
  defaultDatabase: string;
  stop(): Promise<void>;
}

/** bd serve's own request-body limit; bodies above it are refused before parsing. */
export const MAX_BODY_BYTES = 1_048_576;
/** `Bun.serve` hard cap: the limit plus headroom so the 413 problem is ours, not Bun's bare one. */
const MAX_REQUEST_BODY_SIZE = MAX_BODY_BYTES + 64 * 1024;

export interface CreateAppOptions {
  config: Config;
  log: Logger;
  /** Skip discovery and use these names (tests). */
  databases?: string[];
}

export async function createApp(options: CreateAppOptions): Promise<App> {
  const { config, log } = options;
  // Fail fast on a missing / unsupported bd: without it every database would stay `down`.
  const bd = await checkBd(config.bdPath);
  if (bd.warning) log.warn(bd.warning);
  log.info(`bd: ${bd.raw} (${config.bdPath}); dolt: ${config.doltHost}:${config.doltPort}`);
  const names =
    options.databases ??
    (await discoverDatabases({ connection: doltConnection(config), requested: config.databases }));
  const defaultDatabase = config.defaultDatabase ?? names[0];
  if (!defaultDatabase || !names.includes(defaultDatabase)) {
    throw new DiscoveryError(
      `BDDB_DEFAULT_DATABASE ${JSON.stringify(config.defaultDatabase)} is not among the served databases`,
      [`databases: ${names.join(", ")}`],
    );
  }
  log.info("databases", { databases: names.join(","), default: defaultDatabase });

  const root = workspaceRoot(config.workDir);
  const runtimes = new Map<string, DatabaseRuntime>();
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const name of names) {
      const ws = await ensureWorkspace({ root, database: name, log });
      releases.push(ws.release);
      runtimes.set(name, new DatabaseRuntime({ name, wsDir: ws.dir, config, log }));
    }
  } catch (err) {
    await Promise.all(releases.map((release) => release()));
    throw err;
  }

  const statics = await prepareStatic({
    basePath: config.basePath,
    webDir: config.webDir,
    buildDir: path.join(root, "web"),
    log,
  });

  const handler = createHandler({ config, log, runtimes, defaultDatabase, statics });
  const routes: Record<string, Bun.HTMLBundle> = {};
  for (const [pattern, bundle] of Object.entries(statics.routes)) {
    routes[`${config.basePath}${pattern}`] = bundle;
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    development: process.env.NODE_ENV === "development",
    idleTimeout: 120,
    maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
    routes,
    fetch: handler,
    error(err) {
      log.error("unhandled error in request handler", { error: err });
      return problemResponse("bddb_upstream_unavailable", "internal error");
    },
  });
  for (const runtime of runtimes.values()) runtime.start();

  const url = `http://${server.hostname}:${server.port}${config.basePath}`;
  // A wildcard bind is not a URL a browser can open; print the loopback one next to it.
  const open =
    server.hostname === "0.0.0.0" || server.hostname === "::"
      ? `http://127.0.0.1:${server.port}${config.basePath}/`
      : `${url}/`;
  log.info(`dashboard: ${open}`, { listen: url, static: statics.mode });
  for (const runtime of runtimes.values()) {
    log.info(`database ${runtime.name}: ${runtime.info.state} (starting bd serve)`);
  }

  let stopping: Promise<void> | null = null;
  return {
    server,
    url,
    databases: runtimes,
    defaultDatabase,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        log.info("shutting down");
        await Promise.all([...runtimes.values()].map((r) => r.stop()));
        server.stop(true);
        await Promise.all(releases.map((release) => release()));
      })();
      return stopping;
    },
  };
}

/** What the handler needs from a database runtime (an interface so tests can fake it). */
export interface RuntimeView {
  readonly name: string;
  readonly info: DatabaseInfo;
  readonly ready: boolean;
  snapshot(): Snapshot | null;
  subscribe(signal?: AbortSignal): Response;
  target(): { baseUrl: string; projectId: string | null } | null;
}

export interface HandlerContext {
  config: Pick<Config, "basePath" | "actor" | "closedDays" | "pollIntervalMs">;
  log: Logger;
  runtimes: Map<string, RuntimeView>;
  defaultDatabase: string;
  statics: StaticAssets;
}

/** `413 bddb_payload_too_large` for a write body above `MAX_BODY_BYTES`. */
function bodyTooLarge(): Response {
  return problemResponse("bddb_payload_too_large", "request body exceeds 1 MiB", {
    extra: { limit_bytes: MAX_BODY_BYTES },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Strip the base path; `null` when the request is outside the mount. */
export function innerPath(pathname: string, basePath: string): string | null {
  if (basePath === "") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter((s) => s !== "")
      .map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

export function createHandler(ctx: HandlerContext): (request: Request) => Promise<Response> {
  const { config, runtimes, statics } = ctx;

  const meta = (): Meta => ({
    bddb: { version: BDDB_VERSION, builtForBeads: BUILT_FOR_BEADS },
    defaultDatabase: ctx.defaultDatabase,
    actorDefault: config.actor,
    closedDays: config.closedDays,
    pollIntervalMs: config.pollIntervalMs,
    databases: [...runtimes.values()].map((r) => ({ ...r.info })),
  });

  const notReady = (runtime: RuntimeView): Response =>
    problemResponse(
      "bddb_not_ready",
      `database "${runtime.name}" is ${runtime.info.state}; retry shortly`,
      {
        headers: { "retry-after": "2" },
        extra: { database: runtime.name, state: runtime.info.state },
      },
    );

  async function handleDatabase(request: Request, url: URL, parts: string[]): Promise<Response> {
    const name = parts[0] ?? "";
    const runtime = runtimes.get(name);
    if (!runtime) {
      return problemResponse("bddb_database_unknown", `no database "${name}" is served`, {
        extra: { databases: [...runtimes.keys()] },
      });
    }
    const rest = parts.slice(1);
    if (rest.length === 1 && rest[0] === "snapshot" && request.method === "GET") {
      const snapshot = runtime.snapshot();
      return snapshot ? jsonResponse(snapshot) : notReady(runtime);
    }
    if (rest.length === 1 && rest[0] === "events" && request.method === "GET") {
      if (!runtime.ready) return notReady(runtime);
      return runtime.subscribe(request.signal);
    }
    const match = matchProxyRoute(request.method, rest);
    if (match.kind === "none") {
      return problemResponse("bddb_not_found", `no route ${request.method} ${url.pathname}`);
    }
    const target = runtime.target();
    if (!target) return notReady(runtime);
    if (match.kind === "read") {
      const filtered = filterQuery(url.searchParams, match.route.allowed);
      if (!filtered.ok) {
        return invalidArgument(`query parameter "${filtered.param}" is not accepted here`, {
          param: filtered.param,
        });
      }
      return forward(target, "GET", match.route.upstream, filtered.query, undefined, {
        signal: request.signal,
      });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return bodyTooLarge();
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return bodyTooLarge();
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return invalidArgument("request body is not valid JSON");
    }
    const body = withAttribution(parsed, match.route.attribution, config.actor);
    if (!body) return invalidArgument("request body must be a JSON object");
    return forward(
      target,
      match.route.method,
      match.route.upstream,
      undefined,
      JSON.stringify(body),
      {
        signal: request.signal,
      },
    );
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const inner = innerPath(url.pathname, config.basePath);
    if (inner === null) return text("not found (outside BDDB_BASE_PATH)", 404);

    if (inner === "/healthz") return text("ok");
    if (inner === "/readyz") {
      const states = Object.fromEntries([...runtimes.values()].map((r) => [r.name, r.info.state]));
      const anyReady = [...runtimes.values()].some((r) => r.ready);
      return jsonResponse({ databases: states }, anyReady ? 200 : 503);
    }
    if (inner === "/api/meta") return jsonResponse(meta());
    if (inner === "/api" || inner.startsWith("/api/")) {
      const parts = decodeSegments(inner);
      if (!parts) return invalidArgument("malformed percent-encoding in path");
      if (parts[1] === "p" && parts.length >= 3)
        return handleDatabase(request, url, parts.slice(2));
      return problemResponse("bddb_not_found", `no route ${request.method} ${url.pathname}`);
    }
    if (inner === "/") {
      const to = `${config.basePath}/p/${encodeURIComponent(ctx.defaultDatabase)}/board`;
      return Response.redirect(to, 302);
    }
    const asset = await statics.handle(inner);
    if (asset) return asset;
    return text("not found", 404);
  };
}
