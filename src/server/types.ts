/**
 * Wire types of the BFF ↔ SPA contract (docs/bff-api.md). The SPA may import this file as
 * `import type` only; nothing here has runtime code.
 */
import type { IssueWithCounts, Stats } from "../api-client/index.ts";

export type StatusCategory = "active" | "wip" | "frozen" | "done";

export interface StatusDef {
  name: string;
  category: StatusCategory;
  builtin: boolean;
}

export type DatabaseState = "starting" | "ready" | "degraded" | "down";
export type LiveMode = "sse" | "polling" | "none";

export interface DatabaseInfo {
  name: string;
  state: DatabaseState;
  live: LiveMode;
  lastSyncAt: string | null;
  bdVersion: string | null;
  projectId: string | null;
  versionWarning: string | null;
  capabilities: string[];
  /** Rows in the `issues` table when bddb discovered the database (startup); not kept live. */
  issueCount: number;
  /**
   * Why the database is `down` / `degraded`: the supervisor's exit reason plus the last line
   * `bd serve` printed, or the upstream problem detail. `null` while `ready`.
   */
  lastError?: string | null;
}

export interface Meta {
  bddb: { version: string; builtForBeads: string };
  defaultDatabase: string;
  actorDefault: string;
  closedHours: number;
  pollIntervalMs: number;
  databases: DatabaseInfo[];
}

/**
 * `IssueWithCounts` row from a brief listing plus the BFF-derived fields: `blocked`, and for
 * rows that have children inside the snapshot scope, the direct-children counters
 * `child_count` / `child_closed_count` (closed = done-category status). Absent when the row has
 * no children in the snapshot.
 */
export type BoardIssue = IssueWithCounts & {
  blocked: boolean;
  child_count?: number;
  child_closed_count?: number;
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

/** Frames of `GET /api/p/<db>/events`. */
export type StreamEvent =
  | { event: "snapshot"; data: Snapshot }
  | { event: "delta"; data: Delta }
  | { event: "status"; data: DatabaseInfo }
  | { event: "heartbeat"; data: { ts: string } };
