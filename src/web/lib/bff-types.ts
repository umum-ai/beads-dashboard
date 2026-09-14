/**
 * Wire types of the BFF API (docs/bff-api.md). The SPA and the dev mock share them; the
 * `bd serve` row types come from src/api-client so the board stays aligned with the spec.
 */
import type { IssueWithCounts, Stats } from "../../api-client/types.ts";

export type { Comment, IssueDetails, IssueListResponse, Problem } from "../../api-client/types.ts";
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
}

export type StatusCategory = "active" | "wip" | "frozen" | "done";

export interface StatusDef {
  name: string;
  category: StatusCategory;
  builtin: boolean;
}

/**
 * `IssueWithCounts` row from `GET issues?brief=true` plus the BFF-derived `blocked`. The epic
 * progress counters exist only on `IssueDetails` in the spec; they are optional here so a BFF
 * that decorates epic rows with them is honoured, and the board derives them from the
 * snapshot's `parent` links otherwise.
 */
export type BoardIssue = IssueWithCounts & {
  blocked: boolean;
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
