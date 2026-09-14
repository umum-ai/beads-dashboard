/**
 * Board settings logic, pure and unit-tested: which status columns are shown and how far back
 * the Closed column reaches. Persistence (per database) lives in `state/prefs.ts`, the popover
 * in `components/BoardSettings.tsx`.
 */
import type { BoardIssue, StatusDef } from "./bff-types.ts";

/** Columns shown until the user picks others; a status the workspace lacks is simply absent. */
export const DEFAULT_VISIBLE_COLUMNS: readonly string[] = [
  "open",
  "in_progress",
  "blocked",
  "closed",
];

/**
 * Statuses to render as columns, in board order. `stored` is the user's list for this database
 * (`null` = never touched → the defaults). A status new to the workspace stays hidden until it
 * is checked, whichever list applies.
 */
export function visibleStatuses(
  statuses: StatusDef[],
  stored: readonly string[] | null,
): StatusDef[] {
  const wanted = new Set(stored ?? DEFAULT_VISIBLE_COLUMNS);
  return statuses.filter((s) => wanted.has(s.name));
}

/** Toggle `name` in the visible list (`stored ?? defaults`), returning the new list to persist. */
export function toggleColumn(
  stored: readonly string[] | null,
  name: string,
  on: boolean,
): string[] {
  const current = new Set(stored ?? DEFAULT_VISIBLE_COLUMNS);
  if (on) current.add(name);
  else current.delete(name);
  return [...current];
}

export const HOUR_MS = 3_600_000;

/** Closed-window choices in hours: every hour to 12, then quarter-days to 1 day, then half-days to 3. */
export const CLOSED_HOURS_OPTIONS: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 21, 24, 36, 48, 60, 72,
];

export const DEFAULT_CLOSED_HOURS = 24;

/**
 * Window to apply: the user's choice, capped by what the server keeps (`meta.closedHours`); a
 * value outside the option list or a missing preference gives the default (capped the same way).
 */
export function effectiveClosedHours(pref: number | null | undefined, serverHours: number): number {
  const chosen =
    pref !== null && pref !== undefined && CLOSED_HOURS_OPTIONS.includes(pref)
      ? pref
      : DEFAULT_CLOSED_HOURS;
  if (!Number.isFinite(serverHours) || serverHours <= 0) return chosen;
  return Math.min(chosen, serverHours);
}

/** A done-category row is shown only when its `closed_at` lies within the last `hours`. */
export function inClosedWindow(
  row: Pick<BoardIssue, "closed_at">,
  hours: number,
  now: number = Date.now(),
): boolean {
  if (!row.closed_at) return false;
  const closedAt = Date.parse(row.closed_at);
  if (!Number.isFinite(closedAt)) return false;
  return now - closedAt <= hours * HOUR_MS;
}

/**
 * Rows the board renders: those whose status is a visible column and, for done-category
 * statuses, closed within the window. Rows with a status the snapshot does not list are shown
 * only when that status is in the visible list (it is not, unless the user checked it).
 */
export function boardRows(
  rows: Iterable<BoardIssue>,
  visible: readonly StatusDef[],
  closedHours: number,
  now: number = Date.now(),
): BoardIssue[] {
  const shown = new Map(visible.map((s) => [s.name, s]));
  const out: BoardIssue[] = [];
  for (const row of rows) {
    const def = shown.get(row.status ?? "open");
    if (!def) continue;
    if (def.category === "done" && !inClosedWindow(row, closedHours, now)) continue;
    out.push(row);
  }
  return out;
}

/** `{ unit: "hour" | "day", value }` for a label: 36 → 1.5 days, 12 → 12 hours. */
export function describeHours(hours: number): { unit: "hour" | "day"; value: number } {
  if (hours < 24) return { unit: "hour", value: hours };
  return { unit: "day", value: Math.round((hours / 24) * 100) / 100 };
}
