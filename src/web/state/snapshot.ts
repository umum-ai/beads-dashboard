/** Board data for the current database: snapshot state, live status, extra closed rows. */
import { computed, signal } from "@preact/signals";
import type { BoardIssue, DatabaseInfo } from "../lib/bff-types.ts";
import { type BoardState, emptyBoardState } from "../lib/delta.ts";
import { buildIndex, type HierarchyIndex } from "../lib/hierarchy.ts";

export const board = signal<BoardState>(emptyBoardState());
export const boardLoading = signal(false);
export const boardError = signal<unknown>(null);
/** Database this `board` belongs to (guards against late responses after a switch). */
export const boardDb = signal<string | null>(null);

export type Connection = "idle" | "connecting" | "open" | "disconnected";
export const connection = signal<Connection>("idle");
export const dbInfo = signal<DatabaseInfo | null>(null);

/** Closed issues outside the closed window, loaded on demand ("Show all closed"). */
export const extraClosed = signal<Map<string, BoardIssue>>(new Map());
export const extraClosedLoading = signal(false);
export const extraClosedLoaded = signal(false);

/** Ticks every 15 s so relative times re-render. */
export const now = signal(Date.now());
if (typeof setInterval !== "undefined") setInterval(() => (now.value = Date.now()), 15_000);

export const allIssues = computed<BoardIssue[]>(() => {
  const main = board.value.issues;
  const out = [...main.values()];
  for (const [id, row] of extraClosed.value) if (!main.has(id)) out.push(row);
  return out;
});

export function resetBoard(): void {
  board.value = emptyBoardState();
  boardError.value = null;
  extraClosed.value = new Map();
  extraClosedLoaded.value = false;
  extraClosedLoading.value = false;
  dbInfo.value = null;
}

export interface ChildStats {
  total: number;
  closed: number;
}

/** Per-parent child counters derived from the snapshot (`parent` links; done-category = closed). */
export const childStats = computed<Map<string, ChildStats>>(() => {
  const done = new Set(
    board.value.statuses.filter((s) => s.category === "done").map((s) => s.name),
  );
  const out = new Map<string, ChildStats>();
  for (const row of allIssues.value) {
    if (!row.parent) continue;
    const entry = out.get(row.parent) ?? { total: 0, closed: 0 };
    entry.total++;
    if (done.has(row.status ?? "open")) entry.closed++;
    out.set(row.parent, entry);
  }
  return out;
});

/** Children of `id` known to the snapshot (rows whose `parent` equals it). */
export function childrenOf(id: string): BoardIssue[] {
  const out: BoardIssue[] = [];
  for (const row of allIssues.value) if (row.parent === id) out.push(row);
  return out;
}

/** Parent/children index over `allIssues` (lib/hierarchy.ts), rebuilt when the rows change. */
export const hierarchy = computed<HierarchyIndex>(() => buildIndex(allIssues.value));
