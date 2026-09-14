/**
 * Wire types of the BFF API (docs/bff-api.md). The SPA and the dev mock share them; the
 * `bd serve` row types come from src/api-client so the board stays aligned with the spec.
 */
import type { IssueWithCounts, Stats } from "../../api-client/types.ts";

export type {
  AddCommentBody,
  ApplyItem,
  BatchApplyBody,
  BatchApplyResponse,
  ClaimIssueBody,
  ClaimIssueResponse,
  CloseIssueBody,
  CloseIssueResponse,
  Comment,
  CreateIssueBody,
  DepAddBody,
  DepAddResponse,
  DepRemoveBody,
  DepRemoveResponse,
  Issue,
  IssueDetails,
  IssueListResponse,
  IssuePatch,
  PatchIssueBody,
  PatchIssueResponse,
  Problem,
  QueryPage,
  ReleaseIssueBody,
  ReleaseIssueResponse,
  ReopenIssueBody,
  ReopenIssueResponse,
  TreeNode,
  TreePage,
} from "../../api-client/types.ts";
export type { IssueWithCounts, Stats };

export type DatabaseState = "starting" | "ready" | "degraded" | "down";
export type LiveMode = "sse" | "polling" | "none";

export interface Meta {
  bddb: { version: string; builtForBeads: string };
  defaultDatabase: string;
  actorDefault: string;
  closedDays: number;
  pollIntervalMs: number;
  databases: DatabaseInfo[];
}

export interface DatabaseInfo {
  name: string;
  state: DatabaseState;
  live: LiveMode;
  lastSyncAt: string | null;
  bdVersion: string | null;
  projectId: string | null;
  versionWarning: string | null;
  capabilities: string[];
  /** Why the database is `down` / `degraded` (supervisor reason + last `bd serve` line). */
  lastError?: string | null;
}

export type StatusCategory = "active" | "wip" | "frozen" | "done";

export interface StatusDef {
  name: string;
  category: StatusCategory;
  builtin: boolean;
}

/**
 * `IssueWithCounts` row from `GET issues?brief=true` plus the BFF-derived `blocked` and, on rows
 * with children inside the snapshot, the direct-children counters `child_count` /
 * `child_closed_count` (docs/bff-api.md). The spec's `epic_*` counters exist only on
 * `IssueDetails`; they stay optional here so a BFF that decorates rows with them is honoured,
 * and the board falls back to the snapshot's `parent` links when neither pair is present.
 */
export type BoardIssue = IssueWithCounts & {
  blocked: boolean;
  child_count?: number;
  child_closed_count?: number;
  epic_total_children?: number;
  epic_closed_children?: number;
};

export interface Snapshot {
  seq: number;
  database: DatabaseInfo;
  statuses: StatusDef[];
  types: string[];
  issues: BoardIssue[];
  ready: string[];
  stats: Stats | null;
}

export interface Delta {
  seq: number;
  upserts: BoardIssue[];
  removes: string[];
  ready?: string[];
  stats?: Stats;
}

export interface Heartbeat {
  ts: string;
}
