/** Snapshot state and pure delta application (no signals here so it is unit-testable). */
import type { BoardIssue, Delta, Snapshot, Stats, StatusDef } from "./bff-types.ts";

export interface BoardState {
  seq: number;
  issues: Map<string, BoardIssue>;
  ready: Set<string>;
  statuses: StatusDef[];
  types: string[];
  stats: Stats | null;
}

export function emptyBoardState(): BoardState {
  return { seq: -1, issues: new Map(), ready: new Set(), statuses: [], types: [], stats: null };
}

export function fromSnapshot(snapshot: Snapshot): BoardState {
  const issues = new Map<string, BoardIssue>();
  for (const issue of snapshot.issues) issues.set(issue.id, issue);
  return {
    seq: snapshot.seq,
    issues,
    ready: new Set(snapshot.ready),
    statuses: snapshot.statuses,
    types: snapshot.types,
    stats: snapshot.stats,
  };
}

export type ApplyResult = { ok: true; state: BoardState } | { ok: false; reason: "gap" | "stale" };

/**
 * Apply a delta. `seq` must be exactly `state.seq + 1`: a larger value is a gap (the caller
 * refetches the snapshot), a smaller or equal one is a stale duplicate and is ignored.
 * Returns a new state object (maps are copied) so signal consumers see the change.
 */
export function applyDelta(state: BoardState, delta: Delta): ApplyResult {
  if (delta.seq <= state.seq) return { ok: false, reason: "stale" };
  if (state.seq >= 0 && delta.seq !== state.seq + 1) return { ok: false, reason: "gap" };
  const issues = new Map(state.issues);
  for (const row of delta.upserts) issues.set(row.id, row);
  for (const id of delta.removes) issues.delete(id);
  return {
    ok: true,
    state: {
      seq: delta.seq,
      issues,
      ready: delta.ready ? new Set(delta.ready) : state.ready,
      statuses: state.statuses,
      types: state.types,
      stats: delta.stats ?? state.stats,
    },
  };
}
