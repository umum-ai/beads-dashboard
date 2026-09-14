/**
 * Serving the SPA (docs/bff-api.md "Static assets").
 *
 * Two modes, picked by configuration:
 *
 * 1. Root mount (`BDDB_BASE_PATH` empty, no `BDDB_WEB_DIR`): `src/web/index.html` is imported as
 *    a Bun HTML bundle and mounted on `/p/*` — Bun bundles Preact & co. on demand, with HMR
 *    under `bun --hot` in development. Bun always emits root-absolute asset URLs
 *    (`/chunk-<hash>.js`), which is exactly right here. The SPA sees no `<base href>` and no
 *    `window.__BDDB__`, so its base path resolves to `""`.
 *
 * 2. Prefixed mount (`BDDB_BASE_PATH=/prefix`) or a pre-built directory (`BDDB_WEB_DIR`): the
 *    SPA is built with `Bun.build({ publicPath: "<prefix>/" })` into `<work-dir>/web` at start
 *    (or taken from `BDDB_WEB_DIR`, which must have been built with the same `--public-path`),
 *    `<base href="<prefix>/">` is injected into `index.html`, and the files are served by
 *    hand: `<prefix>/p/*` → `index.html`, `<prefix>/<hashed asset>` → immutable file.
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HTMLBundle } from "bun";
import index from "../web/index.html";
import type { Logger } from "./log.ts";

export const WEB_INDEX = fileURLToPath(new URL("../web/index.html", import.meta.url));

export interface StaticAssets {
  /** Extra `Bun.serve` routes (HTML-bundle mode only). */
  routes: Record<string, HTMLBundle>;
  /** Serve a path (already relative to the base path); `null` → not a static asset. */
  handle(innerPath: string): Promise<Response | null>;
  mode: "bundle" | "files";
  dir: string | null;
}

export interface StaticOptions {
  basePath: string;
  webDir: string | null;
  /** Where to build when `webDir` is null (`<work-dir>/web`). */
  buildDir: string;
  log: Logger;
}

/** Bun HTML bundle on `/p/*`; nothing else to do by hand. */
function bundleAssets(): StaticAssets {
  return {
    routes: { "/p/*": index },
    handle: async () => null,
    mode: "bundle",
    dir: null,
  };
}

/** `Bun.build` the SPA with the given public path; returns the output directory. */
export async function buildWeb(
  outdir: string,
  publicPath: string,
  log: Logger,
  entry: string = WEB_INDEX,
): Promise<string> {
  await mkdir(outdir, { recursive: true });
  const started = Date.now();
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    publicPath,
    target: "browser",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    const messages = result.logs.map((l) => l.message).join("\n");
    throw new Error(`SPA build failed:\n${messages}`);
  }
  log.info("SPA built", { outdir, public_path: publicPath, ms: Date.now() - started });
  return outdir;
}

/** `<base href="/prefix/">` right after `<head>` (idempotent). */
export function injectBaseHref(html: string, basePath: string): string {
  if (basePath === "" || /<base\s/i.test(html)) return html;
  const tag = `<base href="${basePath}/">`;
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return `${tag}${html}`;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

const IMMUTABLE = /-[a-z0-9]{6,}\.(js|css|woff2?|png|svg|jpg|webp|ico|json|map)$/i;

async function filesAssets(dir: string, basePath: string): Promise<StaticAssets> {
  const raw = await readFile(path.join(dir, "index.html"), "utf8");
  const html = injectBaseHref(raw, basePath);
  const indexResponse = () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  return {
    routes: {},
    mode: "files",
    dir,
    async handle(innerPath) {
      if (innerPath === "/p" || innerPath.startsWith("/p/")) return indexResponse();
      if (innerPath === "/index.html") return indexResponse();
      const rel = path.posix.normalize(innerPath).replace(/^\/+/, "");
      if (rel === "" || rel.startsWith("..") || rel.includes("/../")) return null;
      const file = path.join(dir, rel);
      if (!file.startsWith(`${dir}${path.sep}`)) return null;
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return null;
      return new Response(Bun.file(file), {
        headers: {
          "cache-control": IMMUTABLE.test(rel) ? "public, max-age=31536000, immutable" : "no-cache",
        },
      });
    },
  };
}

/** The SPA could not be built: the API keeps working, pages explain why. */
function brokenAssets(message: string): StaticAssets {
  return {
    routes: {},
    mode: "files",
    dir: null,
    async handle(innerPath) {
      if (innerPath === "/p" || innerPath.startsWith("/p/")) {
        return new Response(`bddb: the dashboard could not be built.\n\n${message}\n`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return null;
    },
  };
}

export async function prepareStatic(options: StaticOptions): Promise<StaticAssets> {
  if (options.basePath === "" && options.webDir === null) return bundleAssets();
  try {
    const dir =
      options.webDir ?? (await buildWeb(options.buildDir, `${options.basePath}/`, options.log));
    return await filesAssets(path.resolve(dir), options.basePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.log.error("SPA unavailable; API endpoints still work", { error: message });
    return brokenAssets(message);
  }
}
