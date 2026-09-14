/**
 * Base path discovery. The server may mount the SPA under `BDDB_BASE_PATH`; it tells the
 * page either through `<base href="/prefix/">` or through `window.__BDDB__ = { basePath }`.
 * Both are supported; `<base href>` wins. The result never has a trailing slash and is `""`
 * for the root mount.
 */

export interface BasePathSource {
  baseHref?: string | null | undefined;
  injected?: string | null | undefined;
  /** `location.origin`, used to strip an absolute `<base href>`. */
  origin?: string | undefined;
}

export function normalizeBasePath(raw: string | null | undefined, origin?: string): string {
  if (!raw) return "";
  let path = raw.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      if (origin && url.origin !== origin) return "";
      path = url.pathname;
    } catch {
      return "";
    }
  }
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/+$/, "");
  return path === "/" ? "" : path;
}

export function resolveBasePath(source: BasePathSource): string {
  const fromBase = normalizeBasePath(source.baseHref, source.origin);
  if (fromBase) return fromBase;
  return normalizeBasePath(source.injected, source.origin);
}

declare global {
  interface Window {
    __BDDB__?: { basePath?: string };
  }
}

let cached: string | null = null;

/** Base path of the running page (browser only; memoised). */
export function basePath(): string {
  if (cached !== null) return cached;
  if (typeof document === "undefined") return "";
  const baseEl = document.querySelector("base[href]");
  cached = resolveBasePath({
    baseHref: baseEl?.getAttribute("href"),
    injected: window.__BDDB__?.basePath,
    origin: window.location.origin,
  });
  return cached;
}

/** Prefix an app-relative path (`/p/db/board`, `/api/meta`) with the base path. */
export function withBase(path: string): string {
  return `${basePath()}${path}`;
}

/** Strip the base path from `location.pathname`; returns null when outside the mount. */
export function stripBase(pathname: string, base: string): string | null {
  if (!base) return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return null;
}
