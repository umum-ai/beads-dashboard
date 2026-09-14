import { describe, expect, test } from "bun:test";
import type { BoardIssue, StatusDef } from "../../../src/web/lib/bff-types.ts";
import {
  boardRows,
  CLOSED_HOURS_OPTIONS,
  DEFAULT_CLOSED_HOURS,
  DEFAULT_VISIBLE_COLUMNS,
  describeHours,
  effectiveClosedHours,
  HOUR_MS,
  inClosedWindow,
  toggleColumn,
  visibleStatuses,
} from "../../../src/web/lib/columns.ts";

const STATUSES: StatusDef[] = [
  { name: "open", category: "active", builtin: true },
  { name: "review", category: "active", builtin: false },
  { name: "in_progress", category: "wip", builtin: true },
  { name: "blocked", category: "wip", builtin: true },
  { name: "hooked", category: "wip", builtin: true },
  { name: "deferred", category: "frozen", builtin: true },
  { name: "pinned", category: "frozen", builtin: true },
  { name: "closed", category: "done", builtin: true },
];

const NOW = Date.parse("2026-09-15T12:00:00Z");

function row(id: string, status: string, closedHoursAgo?: number): BoardIssue {
  const r: BoardIssue = {
    id,
    title: id,
    priority: 2,
    status,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    blocked: false,
  };
  if (closedHoursAgo !== undefined) {
    r.closed_at = new Date(NOW - closedHoursAgo * HOUR_MS).toISOString();
  }
  return r;
}

describe("visible columns", () => {
  test("defaults: open, in_progress, blocked, closed in board order; custom statuses hidden", () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toEqual(["open", "in_progress", "blocked", "closed"]);
    expect(visibleStatuses(STATUSES, null).map((s) => s.name)).toEqual([
      "open",
      "in_progress",
      "blocked",
      "closed",
    ]);
  });
  test("a default the workspace lacks is simply absent", () => {
    const few = STATUSES.filter((s) => s.name !== "blocked");
    expect(visibleStatuses(few, null).map((s) => s.name)).toEqual([
      "open",
      "in_progress",
      "closed",
    ]);
  });
  test("a stored list wins and keeps board order; unknown names are ignored", () => {
    expect(visibleStatuses(STATUSES, ["closed", "review", "gone"]).map((s) => s.name)).toEqual([
      "review",
      "closed",
    ]);
    expect(visibleStatuses(STATUSES, [])).toEqual([]);
  });
  test("toggleColumn starts from the defaults when nothing is stored", () => {
    expect(toggleColumn(null, "review", true).sort()).toEqual(
      ["open", "in_progress", "blocked", "closed", "review"].sort(),
    );
    expect(toggleColumn(null, "blocked", false).sort()).toEqual(
      ["open", "in_progress", "closed"].sort(),
    );
    expect(toggleColumn(["open"], "open", false)).toEqual([]);
    expect(toggleColumn(["open"], "open", true)).toEqual(["open"]);
  });
});

describe("closed window", () => {
  test("options: every hour to 12, quarter days to 24, half days to 72; default 24", () => {
    expect(CLOSED_HOURS_OPTIONS).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 21, 24, 36, 48, 60, 72,
    ]);
    expect(DEFAULT_CLOSED_HOURS).toBe(24);
    expect(CLOSED_HOURS_OPTIONS).toContain(DEFAULT_CLOSED_HOURS);
  });
  test("effective hours: preference capped by the server, default when unset or invalid", () => {
    expect(effectiveClosedHours(null, 72)).toBe(24);
    expect(effectiveClosedHours(undefined, 72)).toBe(24);
    expect(effectiveClosedHours(48, 72)).toBe(48);
    expect(effectiveClosedHours(72, 24)).toBe(24);
    expect(effectiveClosedHours(13, 72)).toBe(24); // not an option
    expect(effectiveClosedHours(48, 0)).toBe(48); // no usable server value
    expect(effectiveClosedHours(48, Number.NaN)).toBe(48);
  });
  test("inClosedWindow: closed_at within N hours; missing or malformed → hidden", () => {
    expect(inClosedWindow(row("a", "closed", 2), 24, NOW)).toBe(true);
    expect(inClosedWindow(row("a", "closed", 24), 24, NOW)).toBe(true); // inclusive edge
    expect(inClosedWindow(row("a", "closed", 25), 24, NOW)).toBe(false);
    expect(inClosedWindow(row("a", "closed"), 24, NOW)).toBe(false);
    expect(inClosedWindow({ closed_at: "yesterday" }, 24, NOW)).toBe(false);
  });
  test("boardRows keeps visible statuses and windowed done rows only", () => {
    const rows = [
      row("o", "open"),
      row("r", "review"),
      row("d", "deferred"),
      row("c2", "closed", 2),
      row("c20", "closed", 20),
      row("c50", "closed", 50),
      row("cx", "closed"),
      row("weird", "someday"),
    ];
    const visible = visibleStatuses(STATUSES, null);
    expect(boardRows(rows, visible, 24, NOW).map((r) => r.id)).toEqual(["o", "c2", "c20"]);
    expect(boardRows(rows, visible, 72, NOW).map((r) => r.id)).toEqual(["o", "c2", "c20", "c50"]);
    expect(boardRows(rows, visible, 1, NOW).map((r) => r.id)).toEqual(["o"]);
    const withReview = visibleStatuses(STATUSES, ["open", "review", "deferred"]);
    expect(boardRows(rows, withReview, 24, NOW).map((r) => r.id)).toEqual(["o", "r", "d"]);
  });
  test("describeHours: hours below a day, fractional days above", () => {
    expect(describeHours(1)).toEqual({ unit: "hour", value: 1 });
    expect(describeHours(21)).toEqual({ unit: "hour", value: 21 });
    expect(describeHours(24)).toEqual({ unit: "day", value: 1 });
    expect(describeHours(36)).toEqual({ unit: "day", value: 1.5 });
    expect(describeHours(60)).toEqual({ unit: "day", value: 2.5 });
    expect(describeHours(72)).toEqual({ unit: "day", value: 3 });
  });
});
