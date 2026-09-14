/**
 * Typed HTTP client for the `bd serve` `/v0/beads` API (spec/openapi.v0.yaml, beads 1.3.0-rc.2).
 *
 * - Every non-2xx response becomes a `ProblemError` (`code` is the only dispatch key).
 * - Query parameters are serialised exactly as the spec declares (arrays → repeated key) and
 *   keys outside an operation's parameter table are refused before the request is sent.
 * - Bodies always go with `Content-Type: application/json`; `actor` (or `author` for
 *   comments) is filled from the client default when the body omits it.
 * - `Bd-Project-Id` is sent when `projectId` is configured.
 * - `issues:delete`, `issues:sweep`, config writes and `memories` are deliberately absent.
 */

import { type WatchEvent, type WatchEventsOptions, watchEvents } from "./events.ts";
import {
  API_PREFIX,
  baseHeaders,
  buildUrl,
  type ConnectionOptions,
  combineSignals,
  pathSegment,
  type QueryValue,
  serializeQuery,
} from "./http.ts";
import { problemFromResponse } from "./problem.ts";
import type {
  AddCommentBody,
  BatchApplyBody,
  BatchApplyResponse,
  BatchCloseBody,
  BatchCloseResponse,
  BatchCreateBody,
  BatchCreateResponse,
  BlockingAnnotations,
  ClaimIssueBody,
  ClaimIssueResponse,
  CloseIssueBody,
  CloseIssueResponse,
  Comment,
  ConfigEntry,
  ConfigPage,
  Context,
  CreateIssueBody,
  CyclesPage,
  DepAddBody,
  DepAddResponse,
  DependenciesBlockingParams,
  DependenciesCountParams,
  DependenciesParams,
  DependencyEdges,
  DepRemoveBody,
  DepRemoveResponse,
  EdgeCounts,
  EventsPage,
  EventsParams,
  GetIssueParams,
  Health,
  Issue,
  IssueDetails,
  IssueListResponse,
  ListIssuesParams,
  PatchIssueBody,
  PatchIssueResponse,
  QueryIssuesParams,
  QueryPage,
  ReadyCount,
  ReadyCountParams,
  ReadyPage,
  ReadyParams,
  RelatedIssues,
  RelatedParams,
  ReleaseIssueBody,
  ReleaseIssueResponse,
  ReopenIssueBody,
  ReopenIssueResponse,
  StatsParams,
  StatsResponse,
  TreePage,
  TreeParams,
} from "./types.ts";

export interface BdClientOptions extends ConnectionOptions {
  /** Default `actor` for writes (and `author` for comments) when the body omits it. */
  actor?: string;
  /** Per-request timeout; default 30 s. Not applied to `watchEvents`. */
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Cancels the request; combined with the client timeout. */
  signal?: AbortSignal;
}

// Parameter tables, one per operation, copied from the spec (`operations[...]["parameters"]["query"]`).
// `Record<keyof Params, true>` makes each table exhaustive AND closed at compile time.
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
const READY_COUNT: Record<keyof ReadyCountParams, true> = {
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
};
const TREE: Record<keyof TreeParams, true> = {
  root_id: true,
  direction: true,
  max_depth: true,
  status: true,
};
const RELATED: Record<keyof RelatedParams, true> = { direction: true, type: true };
const DEPENDENCIES: Record<keyof DependenciesParams, true> = { issue_id: true, type: true };
const DEPENDENCIES_COUNT: Record<keyof DependenciesCountParams, true> = {
  issue_id: true,
  direction: true,
  type: true,
  status: true,
};
const DEPENDENCIES_BLOCKING: Record<keyof DependenciesBlockingParams, true> = { issue_id: true };
const STATS: Record<keyof StatsParams, true> = { assignee: true, skip_blocked: true };
const EVENTS: Record<keyof EventsParams, true> = { since: true, limit: true };

type Method = "GET" | "POST" | "PATCH";

interface Call {
  method: Method;
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  signal?: AbortSignal;
}

export class BdClient {
  readonly baseUrl: string;
  readonly projectId: string | undefined;
  readonly actor: string | undefined;
  readonly timeoutMs: number;
  private readonly connection: ConnectionOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BdClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.projectId = options.projectId;
    this.actor = options.actor;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.connection = {
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.token === undefined ? {} : { token: options.token }),
    };
  }

  /** Same server, different defaults (e.g. the browser user's `actor`). */
  with(overrides: Partial<BdClientOptions>): BdClient {
    return new BdClient({
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
      ...(this.actor === undefined ? {} : { actor: this.actor }),
      ...(this.connection.token === undefined ? {} : { token: this.connection.token }),
      ...overrides,
    });
  }

  // ------------------------------------------------------------------ handshake / health

  /** `GET /healthz` — liveness without touching the database. */
  healthz(options?: RequestOptions): Promise<Health> {
    return this.request<Health>({ method: "GET", path: "/healthz", ...sig(options) });
  }

  /** `GET /v0/beads/context` — identity handshake: `api_version`, `bd_version`, `capabilities`, `project_id`. */
  context(options?: RequestOptions): Promise<Context> {
    return this.get<Context>("/context", undefined, options);
  }

  // ------------------------------------------------------------------ reads

  /** `GET ready` — unblocked open work (`IssueWithCounts` items). Readiness probe: `ready({ limit: 1 })`. */
  ready(params?: ReadyParams, options?: RequestOptions): Promise<ReadyPage> {
    return this.get<ReadyPage>("/ready", serializeQuery("ready", params, READY), options);
  }

  /** `GET ready:count`. */
  readyCount(params?: ReadyCountParams, options?: RequestOptions): Promise<ReadyCount> {
    return this.get<ReadyCount>(
      "/ready:count",
      serializeQuery("readyCount", params, READY_COUNT),
      options,
    );
  }

  /** `GET issues` → `{ items, has_more, next_cursor? }`. Rows carry no `revision`. */
  listIssues(params?: ListIssuesParams, options?: RequestOptions): Promise<IssueListResponse> {
    return this.get<IssueListResponse>(
      "/issues",
      serializeQuery("listIssues", params, LIST_ISSUES),
      options,
    );
  }

  /** `GET issues/{id}` → `IssueDetails` with the string `revision`. */
  getIssue(id: string, params?: GetIssueParams, options?: RequestOptions): Promise<IssueDetails> {
    return this.get<IssueDetails>(
      `/issues/${pathSegment(id)}`,
      serializeQuery("getIssue", params, GET_ISSUE),
      options,
    );
  }

  /** `GET issues:query?q=` — the `bd query` expression language. */
  queryIssues(
    q: string,
    params?: Omit<QueryIssuesParams, "q">,
    options?: RequestOptions,
  ): Promise<QueryPage> {
    return this.get<QueryPage>(
      "/issues:query",
      serializeQuery("queryIssues", { ...params, q }, QUERY_ISSUES),
      options,
    );
  }

  /** `GET dependencies/tree?root_id=&direction=&max_depth=` — flat DFS pre-order `TreeNode`s. */
  dependencyTree(params: TreeParams, options?: RequestOptions): Promise<TreePage> {
    return this.get<TreePage>(
      "/dependencies/tree",
      serializeQuery("dependencyTree", params, TREE),
      options,
    );
  }

  /** `GET issues/{id}/related?direction=out|in[&type=...]`. */
  related(id: string, params: RelatedParams, options?: RequestOptions): Promise<RelatedIssues> {
    return this.get<RelatedIssues>(
      `/issues/${pathSegment(id)}/related`,
      serializeQuery("related", params, RELATED),
      options,
    );
  }

  /** `GET dependencies?issue_id=...` — outgoing edges of the anchors. */
  dependencies(params: DependenciesParams, options?: RequestOptions): Promise<DependencyEdges> {
    return this.get<DependencyEdges>(
      "/dependencies",
      serializeQuery("dependencies", params, DEPENDENCIES),
      options,
    );
  }

  /** `GET dependencies:count?issue_id=...&direction=`. */
  dependenciesCount(
    params: DependenciesCountParams,
    options?: RequestOptions,
  ): Promise<EdgeCounts> {
    return this.get<EdgeCounts>(
      "/dependencies:count",
      serializeQuery("dependenciesCount", params, DEPENDENCIES_COUNT),
      options,
    );
  }

  /** `GET dependencies/blocking?issue_id=...` — `blocked_by` / `blocks` annotations. */
  dependenciesBlocking(
    params: DependenciesBlockingParams,
    options?: RequestOptions,
  ): Promise<BlockingAnnotations> {
    return this.get<BlockingAnnotations>(
      "/dependencies/blocking",
      serializeQuery("dependenciesBlocking", params, DEPENDENCIES_BLOCKING),
      options,
    );
  }

  /** `GET dependencies/cycles`. */
  dependencyCycles(options?: RequestOptions): Promise<CyclesPage> {
    return this.get<CyclesPage>("/dependencies/cycles", undefined, options);
  }

  /** `GET stats` → `{ summary, blocked_count_skipped }`. */
  stats(params?: StatsParams, options?: RequestOptions): Promise<StatsResponse> {
    return this.get<StatsResponse>("/stats", serializeQuery("stats", params, STATS), options);
  }

  /** `GET config` → `{ items: [{ key, value?, redacted }], has_more }`. */
  config(options?: RequestOptions): Promise<ConfigPage> {
    return this.get<ConfigPage>("/config", undefined, options);
  }

  /** `GET config/{key}` — `value` is absent when the key is unset (e.g. `status.custom`). */
  configKey(key: string, options?: RequestOptions): Promise<ConfigEntry> {
    return this.get<ConfigEntry>(`/config/${pathSegment(key)}`, undefined, options);
  }

  /** `GET events?since=N&limit=` → `{ records, head }`; caught up when last `seq === head`. */
  events(since: number, limit?: number, options?: RequestOptions): Promise<EventsPage> {
    const params: EventsParams = limit === undefined ? { since } : { since, limit };
    return this.get<EventsPage>("/events", serializeQuery("events", params, EVENTS), options);
  }

  /** `GET events:watch` as an async iterable of frames; see `events.ts`. No timeout applies. */
  watchEvents(
    options: Omit<WatchEventsOptions, keyof ConnectionOptions>,
  ): AsyncGenerator<WatchEvent, void, undefined> {
    return watchEvents({ ...this.connection, ...options });
  }

  // ------------------------------------------------------------------ writes

  /** `POST issues` → the created `Issue`. `issue_type` is effectively required. */
  createIssue(body: CreateIssueBody, options?: RequestOptions): Promise<Issue> {
    return this.post<Issue>("/issues", this.withActor(body), options);
  }

  /** `PATCH issues/{id}` → `{ issue, changed, revision }`; guards → `409 precondition_failed`. */
  patchIssue(
    id: string,
    body: PatchIssueBody,
    options?: RequestOptions,
  ): Promise<PatchIssueResponse> {
    return this.request<PatchIssueResponse>({
      method: "PATCH",
      path: `${API_PREFIX}/issues/${pathSegment(id)}`,
      body: this.withActor(body),
      ...sig(options),
    });
  }

  /** `POST issues/{id}:close` → `{ issue, already_closed, open_children, revision }`. */
  closeIssue(
    id: string,
    body: CloseIssueBody = {},
    options?: RequestOptions,
  ): Promise<CloseIssueResponse> {
    return this.post<CloseIssueResponse>(
      `/issues/${pathSegment(id)}:close`,
      this.withActor(body),
      options,
    );
  }

  /** `POST issues/{id}:reopen` → `{ issue, already_open, revision }`. */
  reopenIssue(
    id: string,
    body: ReopenIssueBody = {},
    options?: RequestOptions,
  ): Promise<ReopenIssueResponse> {
    return this.post<ReopenIssueResponse>(
      `/issues/${pathSegment(id)}:reopen`,
      this.withActor(body),
      options,
    );
  }

  /** `POST issues/{id}:claim` → `{ issue, already_claimed }`; `409 already_claimed|not_claimable`. */
  claimIssue(
    id: string,
    body: ClaimIssueBody = {},
    options?: RequestOptions,
  ): Promise<ClaimIssueResponse> {
    return this.post<ClaimIssueResponse>(
      `/issues/${pathSegment(id)}:claim`,
      this.withActor(body),
      options,
    );
  }

  /** `POST issues/{id}:release` — NOT idempotent: `409 not_releasable` on an unclaimed issue. */
  releaseIssue(
    id: string,
    body: ReleaseIssueBody = {},
    options?: RequestOptions,
  ): Promise<ReleaseIssueResponse> {
    return this.post<ReleaseIssueResponse>(
      `/issues/${pathSegment(id)}:release`,
      this.withActor(body),
      options,
    );
  }

  /** `POST issues/{id}/comments` `{ author, text }` → the `Comment`. */
  addComment(id: string, body: AddCommentBody, options?: RequestOptions): Promise<Comment> {
    const author = body.author ?? this.actor;
    if (author === undefined || author === "") {
      throw new TypeError("addComment: `author` is required (or configure the client `actor`)");
    }
    return this.post<Comment>(`/issues/${pathSegment(id)}/comments`, { ...body, author }, options);
  }

  /** `POST dependencies:add` `{ actor, edges: [{ issue_id, depends_on_id, type }] }`. */
  depAdd(body: DepAddBody, options?: RequestOptions): Promise<DepAddResponse> {
    return this.post<DepAddResponse>("/dependencies:add", this.withActor(body), options);
  }

  /** `POST dependencies:remove` `{ actor, issue_id, depends_on_id }` → `{ removed }`. */
  depRemove(body: DepRemoveBody, options?: RequestOptions): Promise<DepRemoveResponse> {
    return this.post<DepRemoveResponse>("/dependencies:remove", this.withActor(body), options);
  }

  /** `POST issues:batchApply` — ordered items in one transaction. */
  batchApply(body: BatchApplyBody, options?: RequestOptions): Promise<BatchApplyResponse> {
    return this.post<BatchApplyResponse>("/issues:batchApply", this.withActor(body), options);
  }

  /** `POST issues:batchCreate`. */
  batchCreate(body: BatchCreateBody, options?: RequestOptions): Promise<BatchCreateResponse> {
    return this.post<BatchCreateResponse>("/issues:batchCreate", this.withActor(body), options);
  }

  /** `POST issues:batchClose` → per-item `outcomes` (failures are items, not a 409). */
  batchClose(body: BatchCloseBody, options?: RequestOptions): Promise<BatchCloseResponse> {
    return this.post<BatchCloseResponse>("/issues:batchClose", this.withActor(body), options);
  }

  // ------------------------------------------------------------------ plumbing

  private withActor<T extends { actor?: string }>(body: T): T & { actor: string } {
    const actor = body.actor ?? this.actor;
    if (actor === undefined || actor === "") {
      throw new TypeError("`actor` is required on every write (or configure the client `actor`)");
    }
    return { ...body, actor };
  }

  private get<T>(
    apiPath: string,
    query: URLSearchParams | undefined,
    options: RequestOptions | undefined,
  ): Promise<T> {
    return this.request<T>({
      method: "GET",
      path: `${API_PREFIX}${apiPath}`,
      ...(query ? { query } : {}),
      ...sig(options),
    });
  }

  private post<T>(apiPath: string, body: unknown, options: RequestOptions | undefined): Promise<T> {
    return this.request<T>({
      method: "POST",
      path: `${API_PREFIX}${apiPath}`,
      body,
      ...sig(options),
    });
  }

  private async request<T>(call: Call): Promise<T> {
    const url = buildUrl(this.baseUrl, call.path, call.query);
    const headers = baseHeaders(this.connection, "application/json");
    const init: RequestInit = { method: call.method, headers };
    if (call.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(call.body);
    }
    const signal = combineSignals(call.signal, this.timeoutMs);
    if (signal) init.signal = signal;

    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw await problemFromResponse(response, { method: call.method, url });
    return (await response.json()) as T;
  }
}

/** Re-exported so `QueryValue` consumers (the BFF's pass-through) can type their input. */
export type { QueryValue };

function sig(options: RequestOptions | undefined): { signal?: AbortSignal } {
  return options?.signal ? { signal: options.signal } : {};
}
