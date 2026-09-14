/**
 * Serving the SPA (docs/bff-api.md "Static assets").
 *
 * Modes, picked by configuration and by how bddb itself was built:
 *
 * 1. Root mount from source (`BDDB_BASE_PATH` empty, no `BDDB_WEB_DIR`, running from a
 *    checkout): `src/web/index.html` is imported as a Bun HTML bundle and mounted on `/p/*` —
 *    Bun bundles Preact & co. on demand, with HMR under `bun --hot`. Bun always emits
 *    root-absolute asset URLs (`/chunk-<hash>.js`), which is exactly right here. The SPA sees no
 *    `<base href>`, so its base path resolves to `""`. (A `bun build --target=bun` bundle
 *    cannot use this mode: Bun resolves the manifest paths against the cwd, not the bundle.)
 *
 * 2. Files mode — everything else. `index.html` and the hashed assets come from one of:
 *    - `BDDB_WEB_DIR`: a directory produced by `scripts/build-web.sh`
 *      (`bun build src/web/index.html --outdir DIR --production --public-path ./`);
 *    - the assets embedded in the server bundle / compiled binary (`HTMLBundle.files`, set by
 *      `bun build`; paths are `/$bunfs/...` in a binary, relative to the bundle otherwise);
 *    - a `Bun.build` from `src/web` into `<work-dir>/web` at start (running from a checkout).
 *    The asset URLs in `index.html` are rewritten to `./<file>` and `<base href="<prefix>/">`
 *    is injected, so the same files serve under any base path: `<prefix>/p/*` → `index.html`,
 *    `<prefix>/<hashed asset>` → immutable file. The SPA reads the base path from `<base>`.
 */
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
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
  /** Where the files come from: a directory, `"embedded"`, or `null` (bundle / broken). */
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

/** `Bun.build` the SPA with relative asset URLs; returns the output directory. */
export async function buildWeb(
  outdir: string,
  log: Logger,
  entry: string = WEB_INDEX,
): Promise<string> {
  await mkdir(outdir, { recursive: true });
  const started = Date.now();
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    publicPath: "./",
    target: "browser",
    minify: true,
    sourcemap: "none",
  });
  if (!result.success) {
    const messages = result.logs.map((l) => l.message).join("\n");
    throw new Error(`SPA build failed:\n${messages}`);
  }
  log.info("SPA built", { outdir, ms: Date.now() - started });
  return outdir;
}

/** `<base href="/prefix/">` right after `<head>` (idempotent); `basePath ""` → `<base href="/">`. */
export function injectBaseHref(html: string, basePath: string): string {
  if (/<base\s/i.test(html)) return html;
  const tag = `<base href="${basePath}/">`;
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return `${tag}${html}`;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

/**
 * Rewrite `href`/`src` values that point at one of `names` (by basename, any directory part,
 * no URL scheme) to `./<name>`, so `<base href>` decides where they are fetched from. Handles
 * the `/chunk-x.js` of a compiled binary, the `../../index-x.css` of a bundle and the
 * `./index-x.js` of `--public-path ./` alike.
 */
export function relativizeAssetUrls(html: string, names: Iterable<string>): string {
  const known = new Set(names);
  return html.replace(/\b(href|src)="([^"]*)"/g, (whole, attr: string, value: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return whole;
    const name = value.slice(value.lastIndexOf("/") + 1);
    return known.has(name) ? `${attr}="./${name}"` : whole;
  });
}

const IMMUTABLE = /-[a-z0-9]{6,}\.(js|css|woff2?|png|svg|jpg|webp|ico|json|map)$/i;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(name: string): string {
  return CONTENT_TYPES[path.posix.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Where the files of files mode come from. */
export interface FileSource {
  label: string;
  /** Raw `index.html`. */
  index(): Promise<string>;
  /** Basenames of every served file (for URL rewriting). */
  names(): Promise<string[]>;
  /** Resolve a request path (no leading slash, normalized) to a readable file, or null. */
  resolve(rel: string): Promise<string | null>;
}

export function directorySource(dir: string): FileSource {
  return {
    label: dir,
    index: () => readFile(path.join(dir, "index.html"), "utf8"),
    names: async () => (await readdir(dir)).filter((n) => n !== "index.html"),
    async resolve(rel) {
      const file = path.join(dir, rel);
      if (!file.startsWith(`${dir}${path.sep}`)) return null;
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? file : null;
    },
  };
}

/** Resolve an `HTMLBundle.files[].path` (absolute in a binary, relative to the bundle otherwise). */
function bundleFilePath(p: string): string {
  return path.isAbsolute(p) ? p : fileURLToPath(new URL(p, import.meta.url));
}

/** Assets emitted by `bun build` next to (or inside) the server; null when running from source. */
export function embeddedSource(bundle: HTMLBundle = index): FileSource | null {
  const files = bundle.files;
  if (!files || files.length === 0) return null;
  const byName = new Map<string, string>();
  let indexPath: string | null = null;
  for (const f of files) {
    if (f.loader === "html") indexPath = bundleFilePath(f.path);
    else byName.set(path.posix.basename(f.path), bundleFilePath(f.path));
  }
  if (indexPath === null) return null;
  const indexFile = indexPath;
  return {
    label: "embedded",
    index: () => Bun.file(indexFile).text(),
    names: async () => [...byName.keys()],
    async resolve(rel) {
      const file = byName.get(rel);
      if (file === undefined) return null;
      return (await Bun.file(file).exists()) ? file : null;
    },
  };
}

export async function filesAssets(source: FileSource, basePath: string): Promise<StaticAssets> {
  const raw = await source.index();
  const html = injectBaseHref(relativizeAssetUrls(raw, await source.names()), basePath);
  const indexResponse = () =>
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  return {
    routes: {},
    mode: "files",
    dir: source.label,
    async handle(innerPath) {
      if (innerPath === "/p" || innerPath.startsWith("/p/")) return indexResponse();
      if (innerPath === "/index.html") return indexResponse();
      const rel = path.posix.normalize(innerPath).replace(/^\/+/, "");
      if (rel === "" || rel.startsWith("..") || rel.includes("/../")) return null;
      const file = await source.resolve(rel);
      if (file === null) return null;
      return new Response(Bun.file(file), {
        headers: {
          "content-type": contentType(rel),
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
  const embedded = embeddedSource();
  if (options.basePath === "" && options.webDir === null && embedded === null) {
    return bundleAssets();
  }
  try {
    let source: FileSource;
    if (options.webDir !== null) {
      source = directorySource(path.resolve(options.webDir));
    } else {
      source =
        embedded ?? directorySource(path.resolve(await buildWeb(options.buildDir, options.log)));
    }
    return await filesAssets(source, options.basePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.log.error("SPA unavailable; API endpoints still work", { error: message });
    return brokenAssets(message);
  }
}
