/**
 * Fetch wrapper for the BFF (docs/bff-api.md). Every non-2xx response is parsed as an RFC 9457
 * problem and thrown as `ApiError`, whose `code` is the only member the UI dispatches on.
 */

import { withBase } from "./basePath.ts";
import type {
  IssueDetails,
  IssueListResponse,
  Meta,
  Problem,
  Snapshot,
  TreePage,
} from "./bff-types.ts";

export class ApiError extends Error {
  readonly problem: Problem;
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(problem: Problem, retryAfterMs: number | null = null) {
    super(problem.detail ?? problem.title ?? problem.code);
    this.name = "ApiError";
    this.problem = problem;
    this.status = problem.status;
    this.code = problem.code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Synthesize a problem for responses that are not `application/problem+json`. */
function synthesizeProblem(status: number, text: string): Problem {
  return {
    type: "about:blank",
    code: status === 0 ? "network_error" : "non_problem_response",
    status,
    title: status === 0 ? "Network error" : `HTTP ${status}`,
    detail: text.slice(0, 300),
    request_id: "",
  };
}

async function toApiError(response: Response): Promise<ApiError> {
  const retry = response.headers.get("retry-after");
  const retryAfterMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : null;
  const text = await response.text();
  try {
    const body = JSON.parse(text) as Partial<Problem>;
    if (body && typeof body === "object" && typeof body.code === "string") {
      return new ApiError(
        {
          ...body,
          code: body.code,
          status: body.status ?? response.status,
          title: body.title ?? body.code,
          request_id: typeof body.request_id === "string" ? body.request_id : "",
        },
        retryAfterMs,
      );
    }
  } catch {
    // not JSON, fall through
  }
  return new ApiError(synthesizeProblem(response.status, text), retryAfterMs);
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withBase(path), {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(synthesizeProblem(0, err instanceof Error ? err.message : String(err)));
  }
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function db(name: string): string {
  return encodeURIComponent(name);
}

export const api = {
  meta: () => apiFetch<Meta>("/api/meta"),
  snapshot: (database: string) => apiFetch<Snapshot>(`/api/p/${db(database)}/snapshot`),
  issue: (database: string, id: string) =>
    apiFetch<IssueDetails>(
      `/api/p/${db(database)}/issues/${encodeURIComponent(id)}?include_comments=true&include_dependents=true`,
    ),
  /** `GET issues` proxy; `params` are repeated for array values (`status=a&status=b`). */
  issues: (database: string, params: Record<string, string | number | boolean | string[]>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const v of value) search.append(key, v);
      else search.set(key, String(value));
    }
    return apiFetch<IssueListResponse>(`/api/p/${db(database)}/issues?${search.toString()}`);
  },
  /** `GET dependencies/tree` proxy: flat DFS pre-order `TreeNode`s (docs/bff-api.md). */
  tree: (database: string, rootId: string, direction: "down" | "up" | "both", maxDepth: number) =>
    apiFetch<TreePage>(
      `/api/p/${db(database)}/dependencies/tree?root_id=${encodeURIComponent(rootId)}&direction=${direction}&max_depth=${maxDepth}`,
    ),
  eventsUrl: (database: string) => withBase(`/api/p/${db(database)}/events`),
};

/** Load every done-category issue (`all=true`) following `next_cursor` while `has_more`. */
export async function loadAllClosed(database: string, statuses: string[]) {
  const items: IssueListResponse["items"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params: Record<string, string | number | boolean | string[]> = {
      status: statuses,
      all: true,
      limit: 0,
      brief: true,
    };
    if (cursor) params.cursor = cursor;
    const res = await api.issues(database, params);
    items.push(...res.items);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return items;
}
