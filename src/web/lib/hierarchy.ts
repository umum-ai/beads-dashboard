/**
 * Hierarchy over the snapshot's `parent` links: children, ancestors, descendants, the top epic
 * of an issue and the swimlane grouping of the board. Pure functions over a `HierarchyIndex`
 * built once per render from the issues; every walk is guarded against cycles and parents
 * missing from the snapshot.
 */
import type { BoardIssue } from "./bff-types.ts";
import { compareCards } from "./board.ts";

export interface HierarchyIndex {
  byId: Map<string, BoardIssue>;
  children: Map<string, BoardIssue[]>;
}

export function buildIndex(issues: Iterable<BoardIssue>): HierarchyIndex {
  const byId = new Map<string, BoardIssue>();
  const children = new Map<string, BoardIssue[]>();
  for (const row of issues) {
    byId.set(row.id, row);
    if (!row.parent) continue;
    const list = children.get(row.parent);
    if (list) list.push(row);
    else children.set(row.parent, [row]);
  }
  return { byId, children };
}

export function isEpic(row: BoardIssue | undefined): boolean {
  return row?.issue_type === "epic";
}

/** Direct children known to the snapshot, newest first (ties by id). */
export function childrenOf(index: HierarchyIndex, id: string): BoardIssue[] {
  return [...(index.children.get(id) ?? [])].sort(compareCards);
}

/**
 * Ancestors of `id`, root first, nearest parent last. Stops at a parent missing from the
 * snapshot and at the first repeated id (cycle).
 */
export function ancestorsOf(index: HierarchyIndex, id: string): BoardIssue[] {
  const out: BoardIssue[] = [];
  const seen = new Set<string>([id]);
  let current = index.byId.get(id);
  while (current?.parent) {
    if (seen.has(current.parent)) break;
    const parent = index.byId.get(current.parent);
    if (!parent) break;
    seen.add(parent.id);
    out.unshift(parent);
    current = parent;
  }
  return out;
}

/**
 * The topmost epic on the path from the issue to its root, the issue itself included, or
 * `null` when no epic is on that path (the "no epic" lane).
 */
export function topEpicOf(index: HierarchyIndex, issue: BoardIssue): BoardIssue | null {
  for (const ancestor of ancestorsOf(index, issue.id)) {
    if (isEpic(ancestor)) return ancestor; // root first: the first epic seen is the topmost
  }
  return isEpic(issue) ? issue : null;
}

/** Every descendant of `id` (any depth), depth-first in children order. */
export function descendantsOf(index: HierarchyIndex, id: string): BoardIssue[] {
  const out: BoardIssue[] = [];
  const seen = new Set<string>([id]);
  const stack = [...childrenOf(index, id)].reverse();
  while (stack.length) {
    const row = stack.pop() as BoardIssue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    const kids = childrenOf(index, row.id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as BoardIssue);
  }
  return out;
}

/** Whether `id` is `ancestorId` or lies somewhere under it. */
export function isUnder(index: HierarchyIndex, id: string, ancestorId: string): boolean {
  if (id === ancestorId) return true;
  return ancestorsOf(index, id).some((a) => a.id === ancestorId);
}

export interface Lane {
  /** Swimlane key: the epic id, or `""` for the "no epic" lane. */
  key: string;
  /** The epic that heads the lane; `null` for the "no epic" lane. */
  epic: BoardIssue | null;
  issues: BoardIssue[];
}

/** Epics first by priority (P0 first), then oldest first, then id — the order of the epics view. */
export function compareEpics(a: BoardIssue, b: BoardIssue): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Group `issues` into one lane per top-level epic plus a trailing "no epic" lane. The epic that
 * heads a lane is looked up in `index` (which may hold rows the filters hid), so a lane keeps
 * its header even when its epic row is filtered out. Empty lanes are not emitted, except that
 * an epic which is itself among `issues` always has a lane (holding at least the epic card).
 */
export function groupByTopEpic(issues: Iterable<BoardIssue>, index: HierarchyIndex): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const row of issues) {
    const epic = topEpicOf(index, row);
    const key = epic?.id ?? "";
    const lane = lanes.get(key);
    if (lane) lane.issues.push(row);
    else lanes.set(key, { key, epic, issues: [row] });
  }
  return orderLanes(lanes);
}

/**
 * Drill-down grouping: `issues` (already restricted to the descendants of `epicId`) are put
 * into one lane per direct child of the epic that is itself an epic, and a "directly in this
 * epic" lane (key `""`, `epic: null`) for the rest. Returns `null` when no sub-epic lane
 * exists, meaning the caller should render a flat board.
 */
export function groupBySubEpic(
  issues: Iterable<BoardIssue>,
  index: HierarchyIndex,
  epicId: string,
): Lane[] | null {
  const lanes = new Map<string, Lane>();
  let subEpics = 0;
  for (const row of issues) {
    // Walk up until the parent is the drilled epic: that ancestor is the row's branch.
    let branch: BoardIssue | undefined = row;
    const seen = new Set<string>();
    while (branch && branch.parent !== epicId && !seen.has(branch.id)) {
      seen.add(branch.id);
      branch = branch.parent ? index.byId.get(branch.parent) : undefined;
    }
    const sub = branch && branch.parent === epicId && isEpic(branch) ? branch : null;
    const key = sub?.id ?? "";
    const lane = lanes.get(key);
    if (lane) lane.issues.push(row);
    else {
      lanes.set(key, { key, epic: sub, issues: [row] });
      if (sub) subEpics++;
    }
  }
  if (subEpics === 0) return null;
  return orderLanes(lanes);
}

function orderLanes(lanes: Map<string, Lane>): Lane[] {
  const out = [...lanes.values()];
  out.sort((a, b) => {
    if (!a.epic) return b.epic ? 1 : 0;
    if (!b.epic) return -1;
    return compareEpics(a.epic, b.epic);
  });
  return out;
}

export interface Progress {
  total: number;
  closed: number;
}

/**
 * Epic progress from the BFF's counters (`child_count`/`child_closed_count`), falling back to
 * `epic_*` if a server decorates rows with them, else counting the snapshot's direct children.
 */
export function progressOf(
  row: BoardIssue,
  index: HierarchyIndex,
  doneStatuses: ReadonlySet<string>,
): Progress {
  if (row.child_count !== undefined) {
    return { total: row.child_count, closed: row.child_closed_count ?? 0 };
  }
  if (row.epic_total_children !== undefined) {
    return { total: row.epic_total_children, closed: row.epic_closed_children ?? 0 };
  }
  const kids = index.children.get(row.id) ?? [];
  return {
    total: kids.length,
    closed: kids.filter((k) => doneStatuses.has(k.status ?? "open")).length,
  };
}
