/** Board data for the current database: snapshot state, live status, derived indexes. */
import { computed, effect, signal } from "@preact/signals";
import type { BoardIssue, DatabaseInfo } from "../lib/bff-types.ts";
import { type BoardState, emptyBoardState } from "../lib/delta.ts";
import { buildIndex, type HierarchyIndex } from "../lib/hierarchy.ts";

export const board = signal<BoardState>(emptyBoardState());
export const boardLoading = signal(false);
export const boardError = signal<unknown>(null);
/** Database this `board` belongs to (guards against late responses after a switch). */
export const boardDb = signal<string | null>(null);

/**
 * EventSource state. `closed` = the server is reachable but refused the stream (the database
 * is starting or down; `dbInfo.state` says which); `disconnected` = the dashboard server
 * itself cannot be reached.
 */
export type Connection = "idle" | "connecting" | "open" | "closed" | "disconnected";
export const connection = signal<Connection>("idle");
/** When the server became unreachable (`connection === "disconnected"`), for the elapsed time. */
export const disconnectedSince = signal<number | null>(null);
export const dbInfo = signal<DatabaseInfo | null>(null);

/** Ticks every 15 s so relative times re-render; every second while the server is unreachable. */
export const now = signal(Date.now());
if (typeof setInterval !== "undefined") {
  setInterval(() => (now.value = Date.now()), 15_000);
  let fast: ReturnType<typeof setInterval> | null = null;
  effect(() => {
    const active = disconnectedSince.value !== null;
    if (active && !fast) fast = setInterval(() => (now.value = Date.now()), 1000);
    if (!active && fast) {
      clearInterval(fast);
      fast = null;
    }
  });
}

/** Every row of the snapshot (the server's closed window included; the board narrows it). */
export const allIssues = computed<BoardIssue[]>(() => [...board.value.issues.values()]);

export function resetBoard(): void {
  board.value = emptyBoardState();
  boardError.value = null;
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
