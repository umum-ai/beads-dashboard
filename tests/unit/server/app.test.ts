import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createHandler,
  innerPath,
  MAX_BODY_BYTES,
  type RuntimeView,
} from "../../../src/server/app.ts";
import { Fanout } from "../../../src/server/fanout.ts";
import { silentLogger } from "../../../src/server/log.ts";
import type { StaticAssets } from "../../../src/server/static.ts";
import type { DatabaseInfo, Snapshot } from "../../../src/server/types.ts";

// A fake `bd serve` that records what it receives and answers like the real one would.
let upstream: ReturnType<typeof Bun.serve>;
let lastUpstream: { method: string; path: string; body: string; headers: Headers } | null = null;

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      lastUpstream = {
        method: req.method,
        path: url.pathname + url.search,
        body: await req.text(),
        headers: req.headers,
      };
      if (url.pathname.endsWith("/issues/stale")) {
        return new Response(
          JSON.stringify({
            code: "precondition_failed",
            status: 409,
            title: "Conflict",
            request_id: "x",
            expected_version: "1",
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, path: url.pathname }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
});

afterAll(() => upstream.stop(true));

function info(name: string, state: DatabaseInfo["state"]): DatabaseInfo {
  return {
    name,
    state,
    live: state === "ready" ? "sse" : "none",
    lastSyncAt: null,
    bdVersion: "1.3.0-rc.2",
    projectId: "pid-1",
    versionWarning: null,
    capabilities: [],
  };
}

function runtime(name: string, state: DatabaseInfo["state"]): RuntimeView {
  const i = info(name, state);
  const fanout = new Fanout({ heartbeatMs: 0 });
  const snapshot: Snapshot = {
    seq: 7,
    database: i,
    statuses: [],
    types: [],
    issues: [],
    ready: [],
    stats: null,
  };
  const ready = state === "ready";
  return {
    name,
    info: i,
    ready,
    snapshot: () => (ready ? snapshot : null),
    subscribe: (signal) => fanout.subscribe([{ event: "snapshot", data: snapshot }], signal),
    target: () =>
      ready ? { baseUrl: `http://127.0.0.1:${upstream.port}`, projectId: "pid-1" } : null,
  };
}

const statics: StaticAssets = {
  routes: {},
  mode: "files",
  dir: null,
  handle: async (p) => (p === "/asset.js" ? new Response("js") : null),
};

function handlerFor(basePath: string) {
  return createHandler({
    config: { basePath, actor: "bddb", closedDays: 7, pollIntervalMs: 15_000 },
    log: silentLogger,
    runtimes: new Map([
      ["kb", runtime("kb", "ready")],
      ["cold", runtime("cold", "starting")],
    ]),
    defaultDatabase: "kb",
    statics,
  });
}

const handle = handlerFor("");
const req = (path: string, init?: RequestInit) =>
  handle(new Request(`http://bddb.test${path}`, init));

describe("innerPath", () => {
  test("strips the base path or rejects", () => {
    expect(innerPath("/x", "")).toBe("/x");
    expect(innerPath("/beads", "/beads")).toBe("/");
    expect(innerPath("/beads/api/meta", "/beads")).toBe("/api/meta");
    expect(innerPath("/beadsx/api", "/beads")).toBeNull();
    expect(innerPath("/api/meta", "/beads")).toBeNull();
  });
});

describe("process endpoints", () => {
  test("healthz, readyz, meta", async () => {
    expect(await (await req("/healthz")).text()).toBe("ok");
    const ready = await req("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ databases: { kb: "ready", cold: "starting" } });
    const meta = await (await req("/api/meta")).json();
    expect(meta.bddb.builtForBeads).toBe("1.3.0-rc.2");
    expect(meta.defaultDatabase).toBe("kb");
    expect(meta.actorDefault).toBe("bddb");
    expect(meta.databases.map((d: DatabaseInfo) => d.name)).toEqual(["kb", "cold"]);
  });
  test("readyz is 503 when nothing is ready", async () => {
    const h = createHandler({
      config: { basePath: "", actor: "bddb", closedDays: 7, pollIntervalMs: 15_000 },
      log: silentLogger,
      runtimes: new Map([["cold", runtime("cold", "down")]]),
      defaultDatabase: "cold",
      statics,
    });
    expect((await h(new Request("http://x/readyz"))).status).toBe(503);
  });
  test("/ redirects to the default board; static fallback; 404 otherwise", async () => {
    const r = await req("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/p/kb/board");
    expect(await (await req("/asset.js")).text()).toBe("js");
    expect((await req("/nothing")).status).toBe(404);
    expect((await req("/api/nothing")).status).toBe(404);
  });
});

describe("per-database", () => {
  test("unknown database → 404 bddb_database_unknown", async () => {
    const r = await req("/api/p/zzz/snapshot");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    const body = await r.json();
    expect(body.code).toBe("bddb_database_unknown");
    expect(body.databases).toEqual(["kb", "cold"]);
  });
  test("not ready → 503 bddb_not_ready with Retry-After", async () => {
    for (const path of ["/api/p/cold/snapshot", "/api/p/cold/events", "/api/p/cold/issues"]) {
      const r = await req(path);
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("2");
      expect((await r.json()).code).toBe("bddb_not_ready");
    }
  });
  test("snapshot and events", async () => {
    const snap = await req("/api/p/kb/snapshot");
    expect(snap.status).toBe(200);
    expect((await snap.json()).seq).toBe(7);
    const ctrl = new AbortController();
    const events = await req("/api/p/kb/events", { signal: ctrl.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body?.getReader();
    let text = "";
    while (!text.includes("event: snapshot")) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("event: snapshot");
    ctrl.abort();
    reader?.cancel().catch(() => {});
  });
  test("read proxy forwards whitelisted params and Bd-Project-Id; rejects unknown params", async () => {
    const ok = await req("/api/p/kb/issues?status=open&status=closed&limit=0&brief=true");
    expect(ok.status).toBe(200);
    expect(lastUpstream?.path).toBe(
      "/v0/beads/issues?status=open&status=closed&limit=0&brief=true",
    );
    expect(lastUpstream?.headers.get("bd-project-id")).toBe("pid-1");
    const bad = await req("/api/p/kb/issues?status=open&updated_after=x");
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.code).toBe("bddb_invalid_argument");
    expect(body.param).toBe("updated_after");
    const detail = await req("/api/p/kb/issues/kb-a.1?include_comments=true");
    expect(detail.status).toBe(200);
    expect(lastUpstream?.path).toBe("/v0/beads/issues/kb-a.1?include_comments=true");
    const query = await req("/api/p/kb/issues:query?q=status%3Dopen&limit=5");
    expect(query.status).toBe(200);
    expect(lastUpstream?.path).toBe("/v0/beads/issues:query?q=status%3Dopen&limit=5");
  });
  test("write proxy injects actor/author and passes problems through unchanged", async () => {
    const created = await req("/api/p/kb/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "t", issue_type: "task" }),
    });
    expect(created.status).toBe(200);
    expect(JSON.parse(lastUpstream?.body ?? "")).toEqual({
      title: "t",
      issue_type: "task",
      actor: "bddb",
    });
    expect(lastUpstream?.headers.get("content-type")).toBe("application/json");

    await req("/api/p/kb/issues/kb-1/comments", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(lastUpstream?.path).toBe("/v0/beads/issues/kb-1/comments");
    expect(JSON.parse(lastUpstream?.body ?? "")).toEqual({ text: "hi", author: "bddb" });

    await req("/api/p/kb/issues/kb-1/close", {
      method: "POST",
      body: JSON.stringify({ actor: "me" }),
    });
    expect(lastUpstream?.path).toBe("/v0/beads/issues/kb-1:close");
    expect(JSON.parse(lastUpstream?.body ?? "")).toEqual({ actor: "me" });

    const stale = await req("/api/p/kb/issues/stale", {
      method: "PATCH",
      body: JSON.stringify({ patch: { title: "x" }, expected_version: "0" }),
    });
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toBe("application/problem+json");
    const problem = await stale.json();
    expect(problem.code).toBe("precondition_failed");
    expect(problem.expected_version).toBe("1");

    const notJson = await req("/api/p/kb/issues", { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
    const notObject = await req("/api/p/kb/issues", { method: "POST", body: "[]" });
    expect(notObject.status).toBe(400);
  });
  test("write bodies above 1 MiB (in bytes, not characters) are refused with 413", async () => {
    const tooLong = `{"title":"${"x".repeat(MAX_BODY_BYTES)}"}`;
    const big = await req("/api/p/kb/issues", { method: "POST", body: tooLong });
    expect(big.status).toBe(413);
    expect(big.headers.get("content-type")).toContain("application/problem+json");
    const problem = await big.json();
    expect(problem.code).toBe("bddb_payload_too_large");
    expect(problem.limit_bytes).toBe(MAX_BODY_BYTES);

    // Fewer characters than the limit, but more bytes: still refused.
    const multibyte = `{"title":"${"я".repeat(MAX_BODY_BYTES / 2)}"}`;
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(MAX_BODY_BYTES);
    const wide = await req("/api/p/kb/issues", { method: "POST", body: multibyte });
    expect(wide.status).toBe(413);

    // A declared Content-Length above the limit is refused before the body is read.
    const declared = await req("/api/p/kb/issues", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: "{}",
    });
    expect(declared.status).toBe(413);

    // Right at the limit passes through.
    const fits = `{"title":"${"x".repeat(MAX_BODY_BYTES - 12)}"}`;
    expect(Buffer.byteLength(fits)).toBe(MAX_BODY_BYTES);
    const ok = await req("/api/p/kb/issues", { method: "POST", body: fits });
    expect(ok.status).toBe(200);
  });
  test("forbidden operations are not routed", async () => {
    expect((await req("/api/p/kb/issues:delete", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await req("/api/p/kb/issues/kb-1", { method: "DELETE" })).status).toBe(404);
    expect((await req("/api/p/kb/config/x", { method: "PUT", body: "{}" })).status).toBe(404);
  });
});

describe("base path", () => {
  const h = handlerFor("/beads");
  const r = (path: string) => h(new Request(`http://bddb.test${path}`));
  test("routes live under the prefix; outside is 404", async () => {
    expect((await r("/beads/healthz")).status).toBe(200);
    expect((await r("/healthz")).status).toBe(404);
    expect((await r("/beads/api/meta")).status).toBe(200);
    const redirect = await r("/beads");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/beads/p/kb/board");
    expect((await r("/beads/api/p/kb/snapshot")).status).toBe(200);
  });
});
