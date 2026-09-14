import { describe, expect, test } from "bun:test";
import type { BoardIssue } from "../../../src/web/lib/bff-types.ts";
import {
  ancestorsOf,
  buildIndex,
  childrenOf,
  compareEpics,
  descendantsOf,
  groupBySubEpic,
  groupByTopEpic,
  isUnder,
  progressOf,
  topEpicOf,
} from "../../../src/web/lib/hierarchy.ts";

function row(id: string, extra: Partial<BoardIssue> = {}): BoardIssue {
  return {
    id,
    title: id,
    priority: 2,
    status: "open",
    issue_type: "task",
    created_at: `2026-09-${String(10 + (id.length % 10)).padStart(2, "0")}T00:00:00Z`,
    updated_at: "2026-09-14T00:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    blocked: false,
    ...extra,
  };
}

// e (epic) → e.1 (task), e.2 (epic) → e.2.1, e.2.2 (closed); m (milestone) → m.1 (task);
// loose x; orphan o (parent missing); cycle c1 ⇄ c2.
const ROWS: BoardIssue[] = [
  row("e", { issue_type: "epic", priority: 1, created_at: "2026-09-01T00:00:00Z" }),
  row("e.1", { parent: "e" }),
  row("e.2", { parent: "e", issue_type: "epic" }),
  row("e.2.1", { parent: "e.2" }),
  row("e.2.2", { parent: "e.2", status: "closed" }),
  row("m", { issue_type: "milestone" }),
  row("m.1", { parent: "m" }),
  row("x"),
  row("o", { parent: "ghost" }),
  row("c1", { parent: "c2" }),
  row("c2", { parent: "c1" }),
  row("f", { issue_type: "epic", priority: 0, created_at: "2026-09-05T00:00:00Z" }),
];
const INDEX = buildIndex(ROWS);
const DONE = new Set(["closed"]);

describe("hierarchy walks", () => {
  test("childrenOf returns direct children only", () => {
    expect(childrenOf(INDEX, "e").map((r) => r.id)).toEqual(["e.1", "e.2"]);
    expect(childrenOf(INDEX, "e.1")).toEqual([]);
    expect(childrenOf(INDEX, "nope")).toEqual([]);
  });
  test("ancestorsOf is root first and stops at missing parents and cycles", () => {
    expect(ancestorsOf(INDEX, "e.2.1").map((r) => r.id)).toEqual(["e", "e.2"]);
    expect(ancestorsOf(INDEX, "e")).toEqual([]);
    expect(ancestorsOf(INDEX, "o")).toEqual([]);
    expect(ancestorsOf(INDEX, "c1").map((r) => r.id)).toEqual(["c2"]);
  });
  test("topEpicOf picks the topmost epic, the issue itself when it is one, null otherwise", () => {
    expect(topEpicOf(INDEX, INDEX.byId.get("e.2.1") as BoardIssue)?.id).toBe("e");
    expect(topEpicOf(INDEX, INDEX.byId.get("e.2") as BoardIssue)?.id).toBe("e");
    expect(topEpicOf(INDEX, INDEX.byId.get("e") as BoardIssue)?.id).toBe("e");
    expect(topEpicOf(INDEX, INDEX.byId.get("m.1") as BoardIssue)).toBeNull();
    expect(topEpicOf(INDEX, INDEX.byId.get("x") as BoardIssue)).toBeNull();
    expect(topEpicOf(INDEX, INDEX.byId.get("c1") as BoardIssue)).toBeNull();
  });
  test("descendantsOf walks every depth once", () => {
    expect(descendantsOf(INDEX, "e").map((r) => r.id)).toEqual(["e.1", "e.2", "e.2.1", "e.2.2"]);
    expect(descendantsOf(INDEX, "c1").map((r) => r.id)).toEqual(["c2"]);
    expect(descendantsOf(INDEX, "x")).toEqual([]);
  });
  test("isUnder", () => {
    expect(isUnder(INDEX, "e.2.1", "e")).toBe(true);
    expect(isUnder(INDEX, "e", "e")).toBe(true);
    expect(isUnder(INDEX, "x", "e")).toBe(false);
  });
});

describe("lanes", () => {
  test("groupByTopEpic: one lane per top epic ordered by priority, no-epic lane last", () => {
    const lanes = groupByTopEpic(ROWS, INDEX);
    expect(lanes.map((l) => l.key)).toEqual(["f", "e", ""]);
    expect(lanes[1]?.issues.map((r) => r.id).sort()).toEqual(
      ["e", "e.1", "e.2", "e.2.1", "e.2.2"].sort(),
    );
    expect(lanes[2]?.epic).toBeNull();
    expect(lanes[2]?.issues.map((r) => r.id).sort()).toEqual(
      ["c1", "c2", "m", "m.1", "o", "x"].sort(),
    );
  });
  test("groupByTopEpic keeps the lane header when the epic row is filtered out", () => {
    const visible = ROWS.filter((r) => r.id === "e.2.1");
    const lanes = groupByTopEpic(visible, INDEX);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.epic?.id).toBe("e");
  });
  test("groupBySubEpic: sub-epic lanes plus a direct lane; null without sub-epics", () => {
    const lanes = groupBySubEpic(descendantsOf(INDEX, "e"), INDEX, "e");
    expect(lanes?.map((l) => l.key)).toEqual(["e.2", ""]);
    expect(lanes?.[0]?.issues.map((r) => r.id).sort()).toEqual(["e.2", "e.2.1", "e.2.2"]);
    expect(lanes?.[1]?.issues.map((r) => r.id)).toEqual(["e.1"]);
    expect(groupBySubEpic(descendantsOf(INDEX, "e.2"), INDEX, "e.2")).toBeNull();
  });
  test("compareEpics: priority, then created ascending, then id", () => {
    const a = row("a", { priority: 1, created_at: "2026-09-02T00:00:00Z" });
    const b = row("b", { priority: 1, created_at: "2026-09-01T00:00:00Z" });
    const c = row("c", { priority: 0, created_at: "2026-09-09T00:00:00Z" });
    expect([a, b, c].sort(compareEpics).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

describe("progressOf", () => {
  test("prefers the BFF counters, then epic_*, then the snapshot's children", () => {
    const withCounts = row("p", { child_count: 5, child_closed_count: 2 });
    expect(progressOf(withCounts, INDEX, DONE)).toEqual({ total: 5, closed: 2 });
    const withEpic = row("p", { epic_total_children: 4, epic_closed_children: 4 });
    expect(progressOf(withEpic, INDEX, DONE)).toEqual({ total: 4, closed: 4 });
    expect(progressOf(INDEX.byId.get("e.2") as BoardIssue, INDEX, DONE)).toEqual({
      total: 2,
      closed: 1,
    });
    expect(progressOf(INDEX.byId.get("x") as BoardIssue, INDEX, DONE)).toEqual({
      total: 0,
      closed: 0,
    });
  });
});
