/**
 * Read/write proxies `/api/p/<db>/…` → `bd serve` (docs/bff-api.md). Query parameters are
 * whitelisted against the spec (the tables are typed from the generated operation parameter
 * types, so they cannot drift from `spec/openapi.v0.yaml`); bodies of writes get the default
 * `actor` / `author` when missing; upstream responses — including problems — pass through
 * with their status, `Content-Type` and body untouched.
 */
import type {
  GetIssueParams,
  ListIssuesParams,
  QueryIssuesParams,
  ReadyParams,
  RelatedParams,
  StatsParams,
  TreeParams,
} from "../api-client/index.ts";
import { problemResponse } from "./problem.ts";

export const API_PREFIX = "/v0/beads";

// Typing each table as Record<keyof Params, true> makes it exhaustive and closed at compile time.
const LIST_ISSUES: Record<keyof ListIssuesParams, true> = {
  status: true,
  type: true,
  assignee: true,
  label: true,
  label_any: true,
  exclude_label: true,
  parent: true,
  all: true,
  include_templates: true,
  include_gates: true,
  include_infra: true,
  include_ephemeral: true,
  created_before: true,
  created_after: true,
  metadata_field: true,
  has_metadata_key: true,
  sort: true,
  cursor: true,
  limit: true,
  brief: true,
};
const GET_ISSUE: Record<keyof GetIssueParams, true> = {
  include_comments: true,
  include_dependents: true,
  brief_deps: true,
};
const QUERY_ISSUES: Record<keyof QueryIssuesParams, true> = {
  q: true,
  all: true,
  sort: true,
  reverse: true,
  limit: true,
};
const READY: Record<keyof ReadyParams, true> = {
  assignee: true,
  unassigned: true,
  type: true,
  exclude_type: true,
  label: true,
  label_any: true,
  exclude_label: true,
  label_pattern: true,
  label_regex: true,
  priority: true,
  parent: true,
  metadata_field: true,
  has_metadata_key: true,
  include_ephemeral: true,
  include_deferred: true,
  sort: true,
  limit: true,
  brief: true,
};
const TREE: Record<keyof TreeParams, true> = {
  root_id: true,
  direction: true,
  max_depth: true,
  status: true,
};
const RELATED: Record<keyof RelatedParams, true> = { direction: true, type: true };
const STATS: Record<keyof StatsParams, true> = { assignee: true, skip_blocked: true };
const NONE: Record<string, true> = {};

export interface ReadRoute {
  /** Upstream path under `/v0/beads` (issue ids already percent-encoded). */
  upstream: string;
  allowed: Readonly<Record<string, true>>;
}

export interface WriteRoute {
  method: "POST" | "PATCH";
  upstream: string;
  /** Body member that carries the attribution: `actor` everywhere, `author` for comments. */
  attribution: "actor" | "author";
}

export type RouteMatch =
  | { kind: "read"; route: ReadRoute }
  | { kind: "write"; route: WriteRoute }
  | { kind: "none" };

function seg(id: string): string {
  return encodeURIComponent(id);
}

function read(upstream: string, allowed: Readonly<Record<string, true>>): RouteMatch {
  return { kind: "read", route: { upstream, allowed } };
}

function write(
  method: "POST" | "PATCH",
  upstream: string,
  attribution: "actor" | "author" = "actor",
): RouteMatch {
  return { kind: "write", route: { method, upstream, attribution } };
}

/**
 * Map the part after `/api/p/<db>/` to an upstream operation. `parts` are the decoded path
 * segments (`issues`, `<id>`, `close`, …); `issues:query` is one segment.
 */
export function matchProxyRoute(method: string, parts: readonly string[]): RouteMatch {
  const [a, b, c] = parts;
  if (method === "GET") {
    if (parts.length === 1) {
      switch (a) {
        case "issues":
          return read("/issues", LIST_ISSUES);
        case "issues:query":
          return read("/issues:query", QUERY_ISSUES);
        case "ready":
          return read("/ready", READY);
        case "stats":
          return read("/stats", STATS);
        case "config":
          return read("/config", NONE);
        default:
          return { kind: "none" };
      }
    }
    if (parts.length === 2 && a === "issues" && b) return read(`/issues/${seg(b)}`, GET_ISSUE);
    if (parts.length === 2 && a === "dependencies" && b === "tree") {
      return read("/dependencies/tree", TREE);
    }
    if (parts.length === 3 && a === "issues" && b && c === "related") {
      return read(`/issues/${seg(b)}/related`, RELATED);
    }
    return { kind: "none" };
  }
  if (method === "POST") {
    if (parts.length === 1 && a === "issues") return write("POST", "/issues");
    if (parts.length === 2 && a === "issues" && b === "batch-apply") {
      return write("POST", "/issues:batchApply");
    }
    if (parts.length === 2 && a === "dependencies" && (b === "add" || b === "remove")) {
      return write("POST", `/dependencies:${b}`);
    }
    if (parts.length === 3 && a === "issues" && b) {
      switch (c) {
        case "close":
        case "reopen":
        case "claim":
        case "release":
          return write("POST", `/issues/${seg(b)}:${c}`);
        case "comments":
          return write("POST", `/issues/${seg(b)}/comments`, "author");
        default:
          return { kind: "none" };
      }
    }
    return { kind: "none" };
  }
  if (method === "PATCH" && parts.length === 2 && a === "issues" && b) {
    return write("PATCH", `/issues/${seg(b)}`);
  }
  return { kind: "none" };
}

/** Keep only whitelisted keys; the first offending key is returned instead. */
export function filterQuery(
  search: URLSearchParams,
  allowed: Readonly<Record<string, true>>,
): { ok: true; query: URLSearchParams } | { ok: false; param: string } {
  const out = new URLSearchParams();
  for (const [key, value] of search) {
    if (!Object.hasOwn(allowed, key)) return { ok: false, param: key };
    out.append(key, value);
  }
  return { ok: true, query: out };
}

/** Fill `actor` (or `author`) when the body omits it; the body must be a JSON object. */
export function withAttribution(
  body: unknown,
  member: "actor" | "author",
  fallback: string,
): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const current = record[member];
  if (typeof current === "string" && current !== "") return record;
  return { ...record, [member]: fallback };
}

export interface UpstreamTarget {
  baseUrl: string;
  projectId: string | null;
}

/** Headers copied from the upstream response; everything else is dropped. */
const PASS_HEADERS = ["content-type", "retry-after"];

/** Forward one request and stream the upstream answer back unchanged. */
export async function forward(
  target: UpstreamTarget,
  method: string,
  upstreamPath: string,
  query: URLSearchParams | undefined,
  body: string | undefined,
  timeoutMs = 60_000,
): Promise<Response> {
  const qs = query && [...query.keys()].length > 0 ? `?${query.toString()}` : "";
  const url = `${target.baseUrl}${API_PREFIX}${upstreamPath}${qs}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (target.projectId) headers["bd-project-id"] = target.projectId;
  if (body !== undefined) headers["content-type"] = "application/json";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unavailable(`bd serve did not answer: ${message}`);
  }
  const out = new Headers({ "cache-control": "no-store" });
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export function unavailable(detail: string): Response {
  return problemResponse("bddb_upstream_unavailable", detail);
}

export function invalidArgument(detail: string, extra?: Record<string, unknown>): Response {
  return problemResponse("bddb_invalid_argument", detail, extra ? { extra } : {});
}
