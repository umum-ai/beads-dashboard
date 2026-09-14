/**
 * Per-database snapshot: status/type dictionaries, the board rows, the ready set and stats,
 * plus the pure functions that build it from `bd serve` responses, diff two states into a
 * `Delta`, and apply journal `EventRecord`s incrementally.
 *
 * Scope (docs/bff-api.md): every issue not hidden by `bd serve` defaults in active/wip/frozen
 * statuses, plus done-category issues whose `closed_at` is within the last `closedHours` hours.
 */
import {
  type BdClient,
  type EventRecord,
  type Issue,
  type IssueDetails,
  type IssueWithCounts,
  ProblemError,
  type Stats,
} from "../api-client/index.ts";
import type { Logger } from "./log.ts";
import type { BoardIssue, Delta, StatusCategory, StatusDef } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------------------------

export const CATEGORY_ORDER: readonly StatusCategory[] = ["active", "wip", "frozen", "done"];

export const BUILTIN_STATUSES: readonly StatusDef[] = [
  { name: "open", category: "active", builtin: true },
  { name: "in_progress", category: "wip", builtin: true },
  { name: "blocked", category: "wip", builtin: true },
  { name: "hooked", category: "wip", builtin: true },
  { name: "deferred", category: "frozen", builtin: true },
  { name: "pinned", category: "frozen", builtin: true },
  { name: "closed", category: "done", builtin: true },
];

export const BUILTIN_TYPES: readonly string[] = [
  "task",
  "bug",
  "feature",
  "chore",
  "epic",
  "decision",
  "spike",
  "story",
  "milestone",
];

/** Infra types `bd serve` hides from listings by default (`include_infra`, `include_gates`). */
export const HIDDEN_TYPES: ReadonlySet<string> = new Set(["gate", "agent", "role", "message"]);

/**
 * Edge types the LIST rows count in `dependency_count` / `dependent_count`. Verified on bd
 * 1.3.0-rc.2: `GET issues` counts blocking edges only (`blocks`; `parent-child` and `related`
 * are not counted), whereas `GET issues/{id}` counts every edge. The board follows the list
 * semantics so polls and event-driven refreshes agree.
 */
export const COUNTED_EDGE_TYPES: ReadonlySet<string> = new Set([
  "blocks",
  "conditional-blocks",
  "waits-for",
]);

function countEdges(edges: readonly { dependency_type?: string }[] | undefined): number | null {
  if (!Array.isArray(edges)) return null;
  return edges.filter((e) => COUNTED_EDGE_TYPES.has(e.dependency_type ?? "")).length;
}

function isCategory(value: string): value is StatusCategory {
  return (CATEGORY_ORDER as readonly string[]).includes(value);
}

/** `status.custom` value: `name:category,name:category` (categories active|wip|done|frozen). */
export function parseCustomStatuses(value: string | undefined, log?: Logger): StatusDef[] {
  if (!value || value.trim() === "") return [];
  const out: StatusDef[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    const name = (colon === -1 ? entry : entry.slice(0, colon)).trim();
    const categoryText = colon === -1 ? "active" : entry.slice(colon + 1).trim();
    if (name === "") continue;
    let category: StatusCategory = "active";
    if (isCategory(categoryText)) category = categoryText;
    else log?.warn("status.custom: unknown category, treating as active", { entry });
    if (!out.some((s) => s.name === name)) out.push({ name, category, builtin: false });
  }
  return out;
}

/** `types.custom` value: CSV of type names. */
export function parseCustomTypes(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name !== "" && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Stable sort by category (active → wip → frozen → done); order within a category is kept. */
export function orderStatuses(defs: readonly StatusDef[]): StatusDef[] {
  return [...defs].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

/** Built-in statuses plus `status.custom` (a custom entry with a built-in name re-categorises it). */
export function buildStatuses(customValue: string | undefined, log?: Logger): StatusDef[] {
  const custom = parseCustomStatuses(customValue, log);
  const merged: StatusDef[] = BUILTIN_STATUSES.map((b) => {
    const override = custom.find((c) => c.name === b.name);
    return override ? { ...b, category: override.category } : b;
  });
  for (const c of custom) if (!merged.some((m) => m.name === c.name)) merged.push(c);
  return orderStatuses(merged);
}

export function buildTypes(customValue: string | undefined): string[] {
  const out = [...BUILTIN_TYPES];
  for (const t of parseCustomTypes(customValue)) if (!out.includes(t)) out.push(t);
  return out;
}

export function statusCategory(
  statuses: readonly StatusDef[],
  status: string | undefined,
): StatusCategory {
  const def = statuses.find((s) => s.name === status);
  return def?.category ?? "active"; // unknown statuses are treated as active work
}

export function statusNames(statuses: readonly StatusDef[], category: StatusCategory): string[] {
  return statuses.filter((s) => s.category === category).map((s) => s.name);
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const TEXT_FIELDS = ["description", "design", "acceptance_criteria", "notes"] as const;
const DETAIL_FIELDS = [
  "dependencies",
  "dependents",
  "comments",
  "comments_omitted",
  "revision",
  "epic_total_children",
  "epic_closed_children",
  "epic_closeable",
] as const;

/** Drop the long-text members a `brief=true` listing omits (and detail-only members). */
export function briefRow(row: IssueWithCounts | Issue | IssueDetails): IssueWithCounts {
  const copy: Record<string, unknown> = { ...row };
  for (const key of TEXT_FIELDS) delete copy[key];
  for (const key of DETAIL_FIELDS) delete copy[key];
  const out = copy as IssueWithCounts;
  out.dependency_count = Number(copy.dependency_count ?? 0);
  out.dependent_count = Number(copy.dependent_count ?? 0);
  out.comment_count = Number(copy.comment_count ?? 0);
  return out;
}

/** Rows `bd serve` hides unless `include_*` is sent: wisps, templates, infra types. */
export function isHiddenByDefault(row: {
  ephemeral?: boolean;
  is_template?: boolean;
  issue_type?: string;
}): boolean {
  return (
    row.ephemeral === true || row.is_template === true || HIDDEN_TYPES.has(row.issue_type ?? "")
  );
}

export function isBlocked(
  row: IssueWithCounts,
  ready: ReadonlySet<string>,
  statuses: readonly StatusDef[],
): boolean {
  const category = statusCategory(statuses, row.status);
  if (category === "done" || category === "frozen") return false;
  return !ready.has(row.id);
}

export function toBoardIssue(
  row: IssueWithCounts,
  ready: ReadonlySet<string>,
  statuses: readonly StatusDef[],
): BoardIssue {
  return { ...briefRow(row), blocked: isBlocked(row, ready, statuses) };
}

/**
 * Closed issues stay on the board while `closed_at >= closedSince`; a done-category row
 * without a `closed_at` has no date to fall inside the window and is out of scope.
 */
export function inScope(
  row: IssueWithCounts,
  statuses: readonly StatusDef[],
  closedSince: Date,
): boolean {
  if (isHiddenByDefault(row)) return false;
  if (statusCategory(statuses, row.status) !== "done") return true;
  if (!row.closed_at) return false;
  const closed = Date.parse(row.closed_at);
  return Number.isNaN(closed) ? true : closed >= closedSince.getTime();
}

export function closedSince(closedHours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - closedHours * 3_600_000);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function rowsEqual(a: BoardIssue, b: BoardIssue): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Child counters (hierarchy)
// ---------------------------------------------------------------------------------------------

export interface ChildCounts {
  total: number;
  closed: number;
}

/**
 * Direct-children counters over the rows of the snapshot: `total` = rows whose `parent` is the
 * id, `closed` = those in a done-category status. Children outside the snapshot scope (closed
 * before the window) are not counted; `IssueDetails.epic_*` stays the exact figure.
 */
export function countChildren(
  issues: ReadonlyMap<string, BoardIssue>,
  statuses: readonly StatusDef[],
  onlyFor?: ReadonlySet<string>,
): Map<string, ChildCounts> {
  const out = new Map<string, ChildCounts>();
  for (const row of issues.values()) {
    if (!row.parent || (onlyFor && !onlyFor.has(row.parent))) continue;
    const entry = out.get(row.parent) ?? { total: 0, closed: 0 };
    entry.total++;
    if (statusCategory(statuses, row.status) === "done") entry.closed++;
    out.set(row.parent, entry);
  }
  return out;
}

/** The row with `child_count` / `child_closed_count` set from `counts`, or removed when absent. */
export function withChildCounts(row: BoardIssue, counts: ChildCounts | undefined): BoardIssue {
  const next: BoardIssue = { ...row };
  if (counts && counts.total > 0) {
    next.child_count = counts.total;
    next.child_closed_count = counts.closed;
  } else {
    delete next.child_count;
    delete next.child_closed_count;
  }
  return next;
}

/** Stamp the counters on every row of `issues` in place (baseline). */
export function stampChildCounts(
  issues: Map<string, BoardIssue>,
  statuses: readonly StatusDef[],
): void {
  const counts = countChildren(issues, statuses);
  for (const [id, row] of issues) {
    const c = counts.get(id);
    if (c || row.child_count !== undefined) issues.set(id, withChildCounts(row, c));
  }
}

/**
 * Recompute the counters of the rows named in `ids` (ids absent from the state are ignored),
 * store the rows that changed and return them so the caller adds them to a delta's upserts.
 */
export function reconcileChildCounts(state: StateData, ids: Iterable<string>): BoardIssue[] {
  const wanted = new Set<string>();
  for (const id of ids) if (state.issues.has(id)) wanted.add(id);
  if (wanted.size === 0) return [];
  const counts = countChildren(state.issues, state.statuses, wanted);
  const changed: BoardIssue[] = [];
  for (const id of wanted) {
    const row = state.issues.get(id);
    if (!row) continue;
    const next = withChildCounts(row, counts.get(id));
    if (!rowsEqual(row, next)) {
      state.issues.set(id, next);
      changed.push(next);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// State and diff
// ---------------------------------------------------------------------------------------------

export interface StateData {
  statuses: StatusDef[];
  types: string[];
  issues: Map<string, BoardIssue>;
  ready: Set<string>;
  stats: Stats | null;
}

export function emptyState(): StateData {
  return {
    statuses: [...BUILTIN_STATUSES],
    types: [...BUILTIN_TYPES],
    issues: new Map(),
    ready: new Set(),
    stats: null,
  };
}

export type DeltaBody = Omit<Delta, "seq">;

/** Diff two states into the delta body, or `null` when nothing changed. */
export function computeDelta(prev: StateData, next: StateData): DeltaBody | null {
  const upserts: BoardIssue[] = [];
  const removes: string[] = [];
  for (const [id, row] of next.issues) {
    const before = prev.issues.get(id);
    if (!before || !rowsEqual(before, row)) upserts.push(row);
  }
  for (const id of prev.issues.keys()) if (!next.issues.has(id)) removes.push(id);
  const body: DeltaBody = { upserts, removes };
  if (!setsEqual(prev.ready, next.ready)) body.ready = [...next.ready];
  if (next.stats && stableStringify(prev.stats) !== stableStringify(next.stats))
    body.stats = next.stats;
  return upserts.length === 0 &&
    removes.length === 0 &&
    body.ready === undefined &&
    body.stats === undefined
    ? null
    : body;
}

export function dictionariesEqual(a: StateData, b: StateData): boolean {
  return (
    stableStringify(a.statuses) === stableStringify(b.statuses) &&
    stableStringify(a.types) === stableStringify(b.types)
  );
}

/** Recompute `blocked` for every row against a new ready set; returns the rows that flipped. */
export function applyReady(state: StateData, ready: Set<string>): BoardIssue[] {
  const flipped: BoardIssue[] = [];
  state.ready = ready;
  for (const [id, row] of state.issues) {
    const blocked = isBlocked(row, ready, state.statuses);
    if (blocked !== row.blocked) {
      const next = { ...row, blocked };
      state.issues.set(id, next);
      flipped.push(next);
    }
  }
  return flipped;
}

// ---------------------------------------------------------------------------------------------
// Baseline fetch
// ---------------------------------------------------------------------------------------------

export interface BaselineOptions {
  closedHours: number;
  now?: Date;
  log: Logger;
  signal?: AbortSignal;
}

/** `{ signal }` for the api-client, omitting the key when there is none (exactOptionalPropertyTypes). */
export function reqOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

/** `2026-09-07T11:39:39Z` — the `bd query` date form that accepted a full timestamp on the stand. */
export function queryTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Done-category issues closed since `since`. Server-side via `issues:query`
 * (`(status=a OR status=b) AND closed>=<ts>`, verified on bd 1.3.0-rc.2); if the server rejects
 * the expression, fall back to listing every done issue and filtering client-side.
 */
export async function fetchClosedWithin(
  client: BdClient,
  doneStatuses: readonly string[],
  since: Date,
  log: Logger,
  signal?: AbortSignal,
): Promise<IssueWithCounts[]> {
  if (doneStatuses.length === 0) return [];
  const statusExpr = doneStatuses.map((s) => `status=${s}`).join(" OR ");
  const q = `(${statusExpr}) AND closed>=${queryTimestamp(since)}`;
  try {
    const page = await client.queryIssues(q, { limit: 0 }, reqOpts(signal));
    return page.items;
  } catch (err) {
    if (!(err instanceof ProblemError) || err.class !== "invalid") throw err;
    log.warn(
      "issues:query rejected the closed-window expression; falling back to a full closed listing",
      {
        q,
        detail: err.problem.detail,
      },
    );
    const page = await client.listIssues(
      { status: [...doneStatuses], limit: 0, brief: true },
      reqOpts(signal),
    );
    return page.items.filter(
      (row) => row.closed_at !== undefined && Date.parse(row.closed_at) >= since.getTime(),
    );
  }
}

/** Seven loopback calls: two config keys, three listings, ready, stats. */
export async function fetchBaseline(
  client: BdClient,
  options: BaselineOptions,
): Promise<StateData> {
  const { log, signal } = options;
  const now = options.now ?? new Date();
  const [statusCustom, typesCustom] = await Promise.all([
    client.configKey("status.custom", reqOpts(signal)),
    client.configKey("types.custom", reqOpts(signal)),
  ]);
  const statuses = buildStatuses(statusCustom.value, log);
  const types = buildTypes(typesCustom.value);
  const frozen = statusNames(statuses, "frozen");
  const done = statusNames(statuses, "done");
  const since = closedSince(options.closedHours, now);

  const [activePage, frozenPage, closedRows, readyPage, statsResult] = await Promise.all([
    client.listIssues({ limit: 0, brief: true }, reqOpts(signal)),
    frozen.length > 0
      ? client.listIssues({ status: frozen, limit: 0, brief: true }, reqOpts(signal))
      : Promise.resolve({ items: [] as IssueWithCounts[] }),
    fetchClosedWithin(client, done, since, log, signal),
    client.ready({ limit: 0 }, reqOpts(signal)),
    client.stats(undefined, reqOpts(signal)).then(
      (r) => r.summary,
      (err: unknown) => {
        log.warn("stats unavailable", { error: err });
        return null;
      },
    ),
  ]);

  const ready = new Set(readyPage.items.map((r) => r.id));
  const issues = new Map<string, BoardIssue>();
  for (const row of [...activePage.items, ...frozenPage.items, ...closedRows]) {
    if (!inScope(row, statuses, since)) continue;
    issues.set(row.id, toBoardIssue(row, ready, statuses));
  }
  stampChildCounts(issues, statuses);
  return { statuses, types, issues, ready, stats: statsResult };
}

// ---------------------------------------------------------------------------------------------
// Incremental event application
// ---------------------------------------------------------------------------------------------

export interface EventEffect {
  upserts: BoardIssue[];
  removes: string[];
  /** Ids whose counts/parent should be re-read with `GET issues/{id}`. */
  refetch: string[];
  /** The ready set (and stats) should be refreshed. */
  readyDirty: boolean;
}

function upsertRow(state: StateData, row: BoardIssue, effect: EventEffect): void {
  state.issues.set(row.id, row);
  effect.upserts = effect.upserts.filter((r) => r.id !== row.id);
  effect.upserts.push(row);
}

function removeRow(state: StateData, id: string, effect: EventEffect): void {
  if (state.issues.delete(id) && !effect.removes.includes(id)) effect.removes.push(id);
}

/**
 * Apply one journal record to `state` in place. `record.issue` is the full post-mutation
 * state; counts and `parent` are not in it, so they are carried over from the previous row and
 * the ids touched by `dep_*`/`comment` are queued for a re-read. Afterwards the child counters
 * of the row, of its previous and current parent and of a `dep_*` target are recomputed and the
 * parent rows that changed join the upserts.
 */
export function applyEvent(
  state: StateData,
  record: EventRecord,
  closedSinceDate: Date,
): EventEffect {
  const id = record.issue_id;
  const dirty = new Set<string>([id]);
  const parentBefore = state.issues.get(id)?.parent;
  if (parentBefore) dirty.add(parentBefore);
  const effect = applyEventOp(state, record, closedSinceDate);
  const parentAfter = state.issues.get(id)?.parent;
  if (parentAfter) dirty.add(parentAfter);
  if (record.dep?.target) dirty.add(record.dep.target);
  for (const row of reconcileChildCounts(state, dirty)) upsertRow(state, row, effect);
  return effect;
}

function applyEventOp(state: StateData, record: EventRecord, closedSinceDate: Date): EventEffect {
  const effect: EventEffect = { upserts: [], removes: [], refetch: [], readyDirty: true };
  const id = record.issue_id;
  const prev = state.issues.get(id);

  const mergeIssue = (issue: Issue, fresh: boolean): void => {
    const merged: IssueWithCounts = {
      ...briefRow(issue),
      dependency_count: prev?.dependency_count ?? 0,
      dependent_count: prev?.dependent_count ?? 0,
      comment_count: prev?.comment_count ?? 0,
      ...(prev?.parent !== undefined ? { parent: prev.parent } : {}),
    };
    if (!inScope(merged, state.statuses, closedSinceDate)) {
      removeRow(state, id, effect);
      return;
    }
    const blocked = fresh ? false : isBlocked(merged, state.ready, state.statuses);
    upsertRow(state, { ...merged, blocked }, effect);
  };

  switch (record.op) {
    case "delete":
      removeRow(state, id, effect);
      return effect;
    case "create":
      if (record.issue) mergeIssue(record.issue, true);
      return effect;
    case "dep_add":
    case "dep_remove": {
      if (record.issue) mergeIssue(record.issue, false);
      const row = state.issues.get(id);
      const dep = record.dep;
      if (row && dep) {
        const counted = COUNTED_EDGE_TYPES.has(dep.kind);
        const delta = record.op === "dep_add" ? 1 : -1;
        const next: BoardIssue = { ...row };
        if (counted) next.dependency_count = Math.max(0, row.dependency_count + delta);
        if (dep.kind === "parent-child") {
          if (record.op === "dep_add") next.parent = dep.target;
          else if (next.parent === dep.target) delete next.parent;
        }
        upsertRow(state, next, effect);
        const target = state.issues.get(dep.target);
        if (target) {
          if (counted) {
            upsertRow(
              state,
              { ...target, dependent_count: Math.max(0, target.dependent_count + delta) },
              effect,
            );
          }
          effect.refetch.push(dep.target);
        }
      }
      effect.refetch.push(id);
      return effect;
    }
    case "comment": {
      if (record.issue) mergeIssue(record.issue, false);
      const row = state.issues.get(id);
      if (row) upsertRow(state, { ...row, comment_count: row.comment_count + 1 }, effect);
      effect.refetch.push(id);
      effect.readyDirty = false;
      return effect;
    }
    default:
      // update, close, and any op a newer bd adds that still carries the issue state
      if (record.issue) mergeIssue(record.issue, false);
      else if (record.op !== "update" && record.op !== "close") effect.refetch.push(id);
      return effect;
  }
}

/**
 * Replace a row with the authoritative detail read (`GET issues/{id}?include_dependents=true&
 * brief_deps=true`). Counts are recomputed from the edge lists with the list semantics
 * (`COUNTED_EDGE_TYPES`); when an edge list is absent the previous count is kept.
 * Returns the row if it changed.
 */
export function applyDetails(
  state: StateData,
  details: IssueDetails,
  closedSinceDate: Date,
): { upsert?: BoardIssue; remove?: string; parents?: BoardIssue[] } {
  const prev = state.issues.get(details.id);
  const row = briefRow(details);
  row.dependency_count = countEdges(details.dependencies) ?? prev?.dependency_count ?? 0;
  row.dependent_count = countEdges(details.dependents) ?? prev?.dependent_count ?? 0;
  const out: { upsert?: BoardIssue; remove?: string; parents?: BoardIssue[] } = {};
  const dirty = new Set<string>([details.id]);
  if (prev?.parent) dirty.add(prev.parent);
  if (row.parent) dirty.add(row.parent);
  if (!inScope(row, state.statuses, closedSinceDate)) {
    if (state.issues.delete(details.id)) out.remove = details.id;
  } else {
    const next = toBoardIssue(row, state.ready, state.statuses);
    if (prev?.child_count !== undefined) {
      next.child_count = prev.child_count;
      next.child_closed_count = prev.child_closed_count ?? 0;
    }
    if (!prev || !rowsEqual(prev, next)) {
      state.issues.set(details.id, next);
      out.upsert = next;
    }
  }
  // The row's own counters (if its children changed underneath) and both parents' counters.
  const parents = reconcileChildCounts(state, dirty);
  const self = parents.find((r) => r.id === details.id);
  if (self) out.upsert = self;
  const others = parents.filter((r) => r.id !== details.id);
  if (others.length > 0) out.parents = others;
  return out;
}
