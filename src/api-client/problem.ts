/**
 * RFC 9457 problem documents as `bd serve` emits them on every non-2xx response, and the
 * `ProblemError` the client throws for them.
 *
 * Rules (spec/openapi.v0.yaml, `Problem`): the ONLY member a client may dispatch on is
 * `code`; on an unknown `code` fall back to the status class (`problemClass`). `title`,
 * `detail` and `type` are human-facing. Extension members (`param`, `reason`,
 * `open_children`, `expected_version`, ...) are documented per code and passed through as-is.
 */
import type { components } from "./generated/openapi.d.ts";

/** The generated Problem schema plus the additive extension members the vocabulary may grow. */
export type Problem = components["schemas"]["Problem"] & { [extension: string]: unknown };

/**
 * v0 `code` vocabulary. It grows additively; always keep a default branch. The
 * `(string & {})` member keeps literal autocompletion while admitting unknown values.
 * `non_problem_response` is this client's own synthesized code (see `synthesizeProblem`).
 */
export type ProblemCode =
  | "invalid_argument"
  | "invalid_cursor"
  | "unauthenticated"
  | "not_found"
  | "already_claimed"
  | "not_claimable"
  | "not_closable"
  | "not_releasable"
  | "dependency_cycle"
  | "dependency_exists"
  | "already_exists"
  | "precondition_failed"
  | "events_journal_disabled"
  | "events_journal_truncated"
  | "busy"
  | "db_unavailable"
  | "events_watch_saturated"
  | "internal"
  | "non_problem_response"
  | (string & {});

/** `reason` values that accompany `invalid_argument`; also an open vocabulary. */
export type ProblemReason =
  | "unknown_parameter"
  | "invalid_value"
  | "project_mismatch"
  | (string & {});

/**
 * Coarse class of a status code, for the default branch when `code` is unknown:
 * unknown 4xx → client bug (fail loud); `unavailable` → retry per `Retry-After`; other 5xx →
 * server fault.
 */
export type ProblemClass =
  | "invalid" // 400
  | "unauthenticated" // 401
  | "not_found" // 404
  | "conflict" // 409
  | "gone" // 410
  | "client" // other 4xx
  | "unavailable" // 503
  | "server" // other 5xx
  | "unknown";

export function problemClass(status: number): ProblemClass {
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "unauthenticated";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 410:
      return "gone";
    case 503:
      return "unavailable";
    default:
      if (status >= 400 && status < 500) return "client";
      if (status >= 500 && status < 600) return "server";
      return "unknown";
  }
}

/** Where the response came from; carried on the error for logging, never for dispatch. */
export interface ProblemSource {
  method?: string;
  url?: string;
}

/**
 * Thrown by the client for every non-2xx response. `problem` is the parsed (or synthesized)
 * document; `status` and `code` are copied out for convenient dispatch; `retryAfterMs` is the
 * parsed `Retry-After` header when the server sent one (503s).
 */
export class ProblemError extends Error {
  readonly problem: Problem;
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfterMs: number | undefined;
  readonly method: string | undefined;
  readonly url: string | undefined;

  constructor(problem: Problem, options: ProblemSource & { retryAfterMs?: number } = {}) {
    const where = options.method && options.url ? ` (${options.method} ${options.url})` : "";
    super(`${problem.status} ${problem.code}: ${problem.detail ?? problem.title}${where}`);
    this.name = "ProblemError";
    this.problem = problem;
    this.status = problem.status;
    this.code = problem.code;
    this.retryAfterMs = options.retryAfterMs;
    this.method = options.method;
    this.url = options.url;
  }

  /** Status class, for the default branch. */
  get class(): ProblemClass {
    return problemClass(this.status);
  }
}

/** `true` when `err` is a ProblemError carrying exactly this `code`. */
export function isProblemCode(err: unknown, code: ProblemCode): err is ProblemError {
  return err instanceof ProblemError && err.code === code;
}

/** `true` when `err` is a ProblemError of this status class. */
export function isProblemClass(err: unknown, cls: ProblemClass): err is ProblemError {
  return err instanceof ProblemError && err.class === cls;
}

/** Type guard for a value that structurally is a Problem document. */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === "string" && typeof v.status === "number";
}

/**
 * Parse `Retry-After` (delta-seconds or HTTP-date) into milliseconds. Returns `undefined`
 * when absent or unparsable.
 */
export function parseRetryAfter(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

const BODY_SNIPPET_LIMIT = 512;

/**
 * Synthesize a Problem for a non-2xx response whose body is NOT a problem document (a reverse
 * proxy's HTML 502, an empty 504, a `404 no such route` from an unrelated server, ...).
 *
 * Convention (documented in docs/api-client.md): `code` is `"internal"` for 5xx — the same
 * word bd uses for a server fault, so a generic "server is broken" branch catches both — and
 * `"non_problem_response"` for everything else. The document carries `synthesized: true` and
 * a `body` snippet so logs can tell it apart from a real bd problem; `request_id` is empty.
 */
export function synthesizeProblem(
  status: number,
  statusText: string,
  bodySnippet: string,
  contentType: string | null,
): Problem {
  return {
    status,
    title: statusText || `HTTP ${status}`,
    code: status >= 500 && status < 600 ? "internal" : "non_problem_response",
    detail: `non-problem response (${contentType ?? "no content-type"})`,
    request_id: "",
    synthesized: true,
    body: bodySnippet.slice(0, BODY_SNIPPET_LIMIT),
  };
}

/**
 * Parse a response body into a Problem. Accepts `application/problem+json` and, leniently,
 * any JSON object that carries a string `code` (bd serve always sends the right media type;
 * the leniency is for intermediaries that rewrite it). Missing required members are filled
 * from the HTTP status.
 */
export function problemFromBody(
  status: number,
  statusText: string,
  contentType: string | null,
  body: string,
): Problem {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Problem).code === "string"
    ) {
      const p = parsed as Partial<Problem> & { code: string };
      return {
        ...p,
        code: p.code,
        status: typeof p.status === "number" ? p.status : status,
        title: typeof p.title === "string" ? p.title : statusText || `HTTP ${status}`,
        request_id: typeof p.request_id === "string" ? p.request_id : "",
      };
    }
  }
  return synthesizeProblem(status, statusText, body, contentType);
}

/** Build a ProblemError from a non-2xx `Response` (consumes the body). */
export async function problemFromResponse(
  response: Response,
  source: ProblemSource = {},
): Promise<ProblemError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const problem = problemFromBody(
    response.status,
    response.statusText,
    response.headers.get("content-type"),
    body,
  );
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return new ProblemError(problem, {
    ...source,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}
