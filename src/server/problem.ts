/**
 * RFC 9457 problem responses produced by bddb itself (docs/bff-api.md "Conventions"). Problems
 * from `bd serve` are never rebuilt here — they are streamed through unchanged.
 */
import type { Problem } from "../api-client/index.ts";

export type BddbProblemCode =
  | "bddb_database_unknown"
  | "bddb_not_ready"
  | "bddb_upstream_unavailable"
  | "bddb_invalid_argument"
  | "bddb_not_found";

const TITLES: Record<BddbProblemCode, string> = {
  bddb_database_unknown: "Unknown database",
  bddb_not_ready: "Database not ready",
  bddb_upstream_unavailable: "bd serve unavailable",
  bddb_invalid_argument: "Invalid argument",
  bddb_not_found: "Not found",
};

const STATUS: Record<BddbProblemCode, number> = {
  bddb_database_unknown: 404,
  bddb_not_ready: 503,
  bddb_upstream_unavailable: 502,
  bddb_invalid_argument: 400,
  bddb_not_found: 404,
};

let counter = 0;

export function problemBody(
  code: BddbProblemCode,
  detail: string,
  extra: Record<string, unknown> = {},
): Problem {
  counter = (counter + 1) % 1_000_000;
  return {
    code,
    status: STATUS[code],
    title: TITLES[code],
    detail,
    request_id: `bddb-${Date.now().toString(36)}-${counter.toString(36)}`,
    ...extra,
  } as Problem;
}

export function problemResponse(
  code: BddbProblemCode,
  detail: string,
  options: { extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Response {
  const body = problemBody(code, detail, options.extra);
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
      ...options.headers,
    },
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
