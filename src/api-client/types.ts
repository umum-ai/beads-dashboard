/**
 * Friendly aliases over the generated OpenAPI types (src/api-client/generated/openapi.d.ts).
 *
 * Rules: `revision` is an opaque string (equality only); `metadata` is an arbitrary JSON
 * object (`{ [key: string]: unknown }`), never a string map; `status`, `issue_type`,
 * `dependency_type` and event `op` are OPEN vocabularies — the unions below list the built-in
 * values for autocompletion and admit any other string via `(string & {})`; consumers must
 * default-branch.
 */
import type { components, operations } from "./generated/openapi.d.ts";
import type { Problem } from "./problem.ts";

export type { Problem };
export type Schemas = components["schemas"];
export type Operations = operations;

/** Opaque optimistic-concurrency token (`IssueDetails.revision`, `expected_version`). */
export type Revision = string;

// ---------------------------------------------------------------------------------------------
// Open vocabularies
// ---------------------------------------------------------------------------------------------

/** Built-in statuses; `status.custom` adds more. */
export type IssueStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "hooked"
  | "deferred"
  | "pinned"
  | "closed"
  | (string & {});

/** Built-in issue types; `types.custom` adds more. Infra types (`gate`, `agent`, ...) exist too. */
export type IssueType =
  | "task"
  | "bug"
  | "feature"
  | "chore"
  | "epic"
  | "decision"
  | "spike"
  | "story"
  | "milestone"
  | (string & {});

/** Edge types. Blocking: blocks, conditional-blocks, waits-for, parent-child. Others annotate. */
export type DependencyType =
  | "blocks"
  | "conditional-blocks"
  | "waits-for"
  | "parent-child"
  | "related"
  | "discovered-from"
  | "tracks"
  | "caused-by"
  | "validates"
  | "supersedes"
  | (string & {});

/** Events journal op; closed in v0 but default-branch anyway. */
export type EventOp =
  | "create"
  | "update"
  | "close"
  | "delete"
  | "dep_add"
  | "dep_remove"
  | "comment"
  | (string & {});

// ---------------------------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------------------------

export type Issue = Schemas["Issue"];
export type IssueWithCounts = Schemas["IssueWithCounts"];
export type IssueDetails = Schemas["IssueDetails"];
export type IssueWithDependencyMetadata = Schemas["IssueWithDependencyMetadata"];
export type TreeNode = Schemas["TreeNode"];
export type Dependency = Schemas["Dependency"];
export type Comment = Schemas["Comment"];
export type Stats = Schemas["Statistics"];
export type StatsResponse = Schemas["StatsResponse"];
export type ConfigEntry = Schemas["Setting"];
export type ConfigPage = Schemas["SettingsPage"];
export type Context = Schemas["ContextResponse"];
export type Health = Schemas["Health"];
export type Cycle = Schemas["Cycle"];
export type IssueBlocking = Schemas["IssueBlocking"];

/** `GET issues` page: `{ items, has_more, next_cursor? }` (the key is `items`, not `issues`). */
export type IssueListResponse = Schemas["IssuesPage"];
export type ReadyPage = Schemas["ReadyPage"];
export type ReadyCount = Schemas["ReadyCount"];
export type QueryPage = Schemas["QueryPage"];
export type TreePage = Schemas["DependencyTreePage"];
export type RelatedIssues = Schemas["RelatedIssues"];
export type DependencyEdges = Schemas["DependencyEdges"];
export type EdgeCounts = Schemas["EdgeCounts"];
export type BlockingAnnotations = Schemas["BlockingAnnotations"];
export type CyclesPage = Schemas["CyclesPage"];

/** `dep` half of a `dep_add` / `dep_remove` event record. `metadata` is the stored JSON text. */
export interface EventDep {
  kind: DependencyType;
  target: string;
  metadata?: string;
}

/** `comment` half of a `comment` event record. */
export interface EventComment {
  id: string;
  author: string;
  text: string;
  created_at: string;
  source?: string;
}

/**
 * One journal record. The spec types `issue`/`dep`/`comment` as bare objects; they are
 * narrowed here to what the operation description documents: `issue` is the full state after
 * the mutation (`null` on delete, ALWAYS present).
 */
export type EventRecord = Omit<Schemas["EventRecord"], "op" | "issue" | "dep" | "comment"> & {
  op: EventOp;
  issue: Issue | null;
  dep?: EventDep;
  comment?: EventComment;
};

export type EventsPage = Omit<Schemas["EventsPage"], "records"> & { records: EventRecord[] };

// ---------------------------------------------------------------------------------------------
// Query parameters (typed from the spec; the client refuses keys outside these)
// ---------------------------------------------------------------------------------------------

type Query<Op extends keyof operations> = operations[Op]["parameters"]["query"];

export type ListIssuesParams = NonNullable<Query<"listIssues">>;
export type GetIssueParams = NonNullable<Query<"getIssue">>;
export type QueryIssuesParams = NonNullable<Query<"queryIssues">>;
export type ReadyParams = NonNullable<Query<"listReadyWork">>;
export type ReadyCountParams = NonNullable<Query<"countReadyWork">>;
export type TreeParams = NonNullable<Query<"getDependencyTree">>;
export type RelatedParams = NonNullable<Query<"listRelatedIssues">>;
export type DependenciesParams = NonNullable<Query<"listDependencies">>;
export type DependenciesCountParams = NonNullable<Query<"countDependencyEdges">>;
export type DependenciesBlockingParams = NonNullable<Query<"listBlockingAnnotations">>;
export type StatsParams = NonNullable<Query<"getStats">>;
export type EventsParams = NonNullable<Query<"listEvents">>;

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

/**
 * openapi-typescript marks members that carry a `default` as required (they are always
 * present in the wire model). On the request side the server applies the default when the
 * member is absent, so the client accepts them as optional.
 */
type WithDefaults<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** `actor` may come from the client's default; the client fills it in before sending. */
type OptionalActor<T extends { actor: string }> = Omit<T, "actor"> & { actor?: string };

export type CreateIssueDependency = WithDefaults<Schemas["CreateIssueDependency"], "reverse">;
export type CreateIssueBody = OptionalActor<
  WithDefaults<
    Omit<Schemas["CreateIssueRequest"], "dependencies"> & {
      dependencies?: CreateIssueDependency[];
    },
    "ephemeral" | "no_history" | "inherit_labels_from_parent" | "force_id_prefix"
  >
>;
export type IssuePatch = Schemas["IssuePatchBody"];
export type PatchIssueBody = OptionalActor<
  WithDefaults<Schemas["UpdateIssueRequest"], "force_close_policy" | "force_assignee_transfer">
>;
export type CloseIssueBody = OptionalActor<WithDefaults<Schemas["CloseIssueRequest"], "force">>;
export type ReopenIssueBody = OptionalActor<Schemas["ReopenIssueRequest"]>;
export type ClaimIssueBody = OptionalActor<Schemas["ClaimRequest"]>;
export type ReleaseIssueBody = OptionalActor<WithDefaults<Schemas["ReleaseIssueRequest"], "force">>;
/** Comments carry `author` (not `actor`); the client defaults it from `actor`. */
export type AddCommentBody = Omit<Schemas["AddCommentRequest"], "author"> & { author?: string };
export type DepAddBody = OptionalActor<Schemas["AddDependenciesRequest"]>;
export type DepRemoveBody = OptionalActor<Schemas["RemoveDependencyRequest"]>;
/** `issues:batchApply` items with the server-defaulted booleans optional. */
export type ApplyCreateItem = WithDefaults<Schemas["ApplyCreateItem"], "ephemeral" | "no_history">;
export type ApplyUpdateItem = WithDefaults<
  Schemas["ApplyUpdateItem"],
  "force_close_policy" | "force_assignee_transfer"
>;
export type ApplyCloseItem = WithDefaults<Schemas["ApplyCloseItem"], "force">;
export type ApplyDepAddItem = Schemas["ApplyDepAddItem"];
export type ApplyItem = Omit<Schemas["ApplyItem"], "create" | "update" | "close" | "dep_add"> & {
  create?: ApplyCreateItem;
  update?: ApplyUpdateItem;
  close?: ApplyCloseItem;
  dep_add?: ApplyDepAddItem;
};
export type BatchApplyBody = OptionalActor<
  WithDefaults<
    Omit<Schemas["ApplyBatchRequest"], "items"> & { items: ApplyItem[] },
    "force_id_prefix" | "skip_per_edge_cycle_check"
  >
>;
export type BatchCreateBody = OptionalActor<Schemas["BatchCreateRequest"]>;
export type BatchCloseBody = OptionalActor<WithDefaults<Schemas["BatchCloseRequest"], "force">>;

// ---------------------------------------------------------------------------------------------
// Responses of writes
// ---------------------------------------------------------------------------------------------

export type PatchIssueResponse = Schemas["UpdateIssueResponse"];
export type CloseIssueResponse = Schemas["CloseIssueResponse"];
export type ReopenIssueResponse = Schemas["ReopenIssueResponse"];
export type ClaimIssueResponse = Schemas["ClaimResponse"];
export type ReleaseIssueResponse = Schemas["ReleaseIssueResponse"];
export type DepAddResponse = Schemas["AddDependenciesResponse"];
export type DepRemoveResponse = Schemas["RemoveDependencyResponse"];
export type BatchApplyResponse = Schemas["ApplyBatchResponse"];
export type BatchCreateResponse = Schemas["BatchCreateResponse"];
export type BatchCloseResponse = Schemas["BatchCloseResponse"];
export type DependencyEdge = Schemas["DependencyEdge"];
