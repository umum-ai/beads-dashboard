/**
 * Internal helpers shared by `client.ts` and `events.ts`: URL building, query serialisation
 * exactly as the spec describes it, and the common request headers.
 */

/** Options every request needs to reach a `bd serve`. */
export interface ConnectionOptions {
  /** Server root, e.g. `http://127.0.0.1:47313` (with or without a trailing slash). */
  baseUrl: string;
  /** `fetch` implementation; defaults to the global one. */
  fetch?: typeof fetch;
  /** Sent as `Bd-Project-Id` so a server with `project.enforce` refuses a wrong workspace. */
  projectId?: string;
  /** Bearer token for a server started with `--auth-token-file`. */
  token?: string;
}

export const API_PREFIX = "/v0/beads";

/** Query parameter values the spec uses: scalars, or arrays serialised as repeated keys. */
export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

/**
 * Serialise query parameters. Arrays are `style: form, explode: true` in the spec → the key
 * is REPEATED (`label=a&label=b`; bd also accepts CSV for `status`, but repetition is what the
 * spec declares and it is unambiguous for values containing commas). Booleans become
 * `true`/`false`. `undefined` members are skipped.
 *
 * `allowed` is the operation's parameter table from the spec; a key outside it throws
 * `TypeError` rather than reaching the server, where it would be a `400 unknown_parameter` —
 * or worse, on a newer server, a filter the caller did not mean.
 */
export function serializeQuery(
  operation: string,
  params: Readonly<Record<string, QueryValue>> | undefined,
  allowed: Readonly<Record<string, true>>,
): URLSearchParams {
  const search = new URLSearchParams();
  if (!params) return search;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (!Object.hasOwn(allowed, key)) {
      throw new TypeError(
        `${operation}: query parameter "${key}" is not in the bd serve spec for this operation`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else if (typeof value === "boolean") {
      search.append(key, value ? "true" : "false");
    } else {
      search.append(key, String(value));
    }
  }
  return search;
}

/** `baseUrl` + `path` (+ `?query`), tolerating a trailing slash on the base. */
export function buildUrl(baseUrl: string, path: string, query?: URLSearchParams): string {
  const root = baseUrl.replace(/\/+$/, "");
  const qs = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
  return `${root}${path}${qs}`;
}

/** Percent-encode one path segment (issue ids such as `kb-jfq.1`; config keys such as `status.custom`). */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Headers common to every request: `Accept`, optional `Bd-Project-Id` and bearer token. */
export function baseHeaders(options: ConnectionOptions, accept: string): Record<string, string> {
  const headers: Record<string, string> = { accept };
  if (options.projectId !== undefined && options.projectId !== "") {
    headers["bd-project-id"] = options.projectId;
  }
  if (options.token !== undefined && options.token !== "") {
    headers.authorization = `Bearer ${options.token}`;
  }
  return headers;
}

/** Combine an optional caller signal with an optional timeout into one AbortSignal. */
export function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs !== undefined && timeoutMs > 0) parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}
