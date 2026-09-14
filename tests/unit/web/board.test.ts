import { describe, expect, test } from "bun:test";
import type { BoardIssue, StatusDef } from "../../../src/web/lib/bff-types.ts";
import {
  clampPriority,
  compareCards,
  doneStatuses,
  groupByStatus,
  sectionize,
} from "../../../src/web/lib/board.ts";

function row(id: string, priority: number, created_at: string, status = "open"): BoardIssue {
  return {
    id,
    title: id,
    priority,
    status,
    created_at,
    updated_at: created_at,
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    blocked: false,
  };
}

const STATUSES: StatusDef[] = [
  { name: "open", category: "active", builtin: true },
  { name: "in_progress", category: "wip", builtin: true },
  { name: "closed", category: "done", builtin: true },
];

describe("board: priority sections", () => {
  test("cards are bucketed P0..P4 in order and empty sections are omitted", () => {
    const sections = sectionize([
      row("a", 4, "2026-09-01T00:00:00Z"),
      row("b", 0, "2026-09-01T00:00:00Z"),
      row("c", 2, "2026-09-01T00:00:00Z"),
    ]);
    expect(sections.map((s) => s.priority)).toEqual([0, 2, 4]);
    expect(sections.map((s) => s.cards.map((c) => c.id))).toEqual([["b"], ["c"], ["a"]]);
  });

  test("within a section cards are newest first, ties broken by id", () => {
    const sections = sectionize([
      row("old", 1, "2026-09-01T00:00:00Z"),
      row("new", 1, "2026-09-10T00:00:00Z"),
      row("tie-b", 1, "2026-09-05T00:00:00Z"),
      row("tie-a", 1, "2026-09-05T00:00:00Z"),
    ]);
    expect(sections[0]?.cards.map((c) => c.id)).toEqual(["new", "tie-a", "tie-b", "old"]);
  });

  test("out-of-range priorities are clamped so no card is lost", () => {
    expect(clampPriority(-3)).toBe(0);
    expect(clampPriority(7)).toBe(4);
    expect(clampPriority(Number.NaN)).toBe(0);
    expect(clampPriority(2.4)).toBe(2);
    const sections = sectionize([row("x", 9, "2026-09-01T00:00:00Z")]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.priority).toBe(4);
  });

  test("compareCards is antisymmetric", () => {
    const a = row("a", 1, "2026-09-01T00:00:00Z");
    const b = row("b", 1, "2026-09-02T00:00:00Z");
    expect(Math.sign(compareCards(a, b))).toBe(-Math.sign(compareCards(b, a)));
    expect(compareCards(a, a)).toBe(0);
  });
});

describe("board: columns", () => {
  test("columns follow the snapshot's status order and every status gets a bucket", () => {
    const { columns, byStatus } = groupByStatus(
      [row("a", 1, "2026-09-01T00:00:00Z", "closed"), row("b", 1, "2026-09-01T00:00:00Z")],
      STATUSES,
    );
    expect(columns.map((c) => c.name)).toEqual(["open", "in_progress", "closed"]);
    expect(byStatus.get("in_progress")).toEqual([]);
    expect(byStatus.get("closed")?.map((r) => r.id)).toEqual(["a"]);
  });

  test("an unknown status becomes an extra column at the end instead of dropping cards", () => {
    const { columns, byStatus } = groupByStatus(
      [row("a", 1, "2026-09-01T00:00:00Z", "review")],
      STATUSES,
    );
    expect(columns.at(-1)).toEqual({ name: "review", category: "active", builtin: false });
    expect(byStatus.get("review")?.map((r) => r.id)).toEqual(["a"]);
  });

  test("a missing status defaults to open", () => {
    const issue = row("a", 1, "2026-09-01T00:00:00Z");
    delete issue.status;
    const { byStatus } = groupByStatus([issue], STATUSES);
    expect(byStatus.get("open")?.map((r) => r.id)).toEqual(["a"]);
  });

  test("doneStatuses lists the done category only", () => {
    expect(doneStatuses(STATUSES)).toEqual(["closed"]);
  });
});
