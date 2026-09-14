/** Board layout logic: columns by status, priority sections, card ordering. */
import type { BoardIssue, StatusDef } from "./bff-types.ts";

export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface PrioritySection {
  priority: Priority;
  cards: BoardIssue[];
}

/** Priorities outside 0..4 are folded into the nearest end so no card is ever lost. */
export function clampPriority(p: number): Priority {
  if (!Number.isFinite(p) || p < 0) return 0;
  if (p > 4) return 4;
  return Math.round(p) as Priority;
}

/** Newest first; ties broken by id for a stable order. */
export function compareCards(a: BoardIssue, b: BoardIssue): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Split a column's cards into P0..P4 sections; empty sections are omitted. */
export function sectionize(cards: Iterable<BoardIssue>): PrioritySection[] {
  const buckets = new Map<Priority, BoardIssue[]>();
  for (const card of cards) {
    const p = clampPriority(card.priority);
    const bucket = buckets.get(p);
    if (bucket) bucket.push(card);
    else buckets.set(p, [card]);
  }
  const out: PrioritySection[] = [];
  for (const p of PRIORITIES) {
    const bucket = buckets.get(p);
    if (bucket?.length) out.push({ priority: p, cards: bucket.sort(compareCards) });
  }
  return out;
}

/** Group issues by status. Statuses unknown to `statuses` get an extra column at the end. */
export function groupByStatus(
  issues: Iterable<BoardIssue>,
  statuses: StatusDef[],
): { columns: StatusDef[]; byStatus: Map<string, BoardIssue[]> } {
  const byStatus = new Map<string, BoardIssue[]>();
  const columns = [...statuses];
  const known = new Set(statuses.map((s) => s.name));
  for (const s of statuses) byStatus.set(s.name, []);
  for (const issue of issues) {
    const status = issue.status ?? "open";
    if (!known.has(status)) {
      known.add(status);
      columns.push({ name: status, category: "active", builtin: false });
      byStatus.set(status, []);
    }
    byStatus.get(status)?.push(issue);
  }
  return { columns, byStatus };
}

export function doneStatuses(statuses: StatusDef[]): string[] {
  return statuses.filter((s) => s.category === "done").map((s) => s.name);
}
