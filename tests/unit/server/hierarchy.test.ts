import { describe, expect, test } from "bun:test";
import type { EventRecord, Issue, IssueWithCounts } from "../../../src/api-client/index.ts";
import {
  applyDetails,
  applyEvent,
  computeDelta,
  countChildren,
  emptyState,
  reconcileChildCounts,
  type StateData,
  stampChildCounts,
  toBoardIssue,
  withChildCounts,
} from "../../../src/server/snapshot.ts";
import type { BoardIssue } from "../../../src/server/types.ts";

function row(id: string, extra: Partial<IssueWithCounts> = {}): IssueWithCounts {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-09-14T10:00:00Z",
    updated_at: "2026-09-14T10:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...extra,
  } as IssueWithCounts;
}

/** State with counters stamped, as `fetchBaseline` produces it. */
function state(rows: IssueWithCounts[], ready: string[] = []): StateData {
  const s = emptyState();
  s.ready = new Set(ready);
  for (const r of rows) s.issues.set(r.id, toBoardIssue(r, s.ready, s.statuses));
  stampChildCounts(s.issues, s.statuses);
  return s;
}

function issueOf(r: IssueWithCounts): Issue {
  const { dependency_count: _a, dependent_count: _b, comment_count: _c, parent: _p, ...rest } = r;
  return rest as Issue;
}

function record(op: EventRecord["op"], issue: IssueWithCounts, extra: Partial<EventRecord> = {}) {
  return {
    seq: 1,
    ts: "2026-09-14T12:00:00Z",
    op,
    issue_id: issue.id,
    actor: "test",
    issue: issueOf(issue),
    ...extra,
  } as EventRecord;
}

const SINCE = new Date("2026-09-07T00:00:00Z");

const EPIC = row("e", { issue_type: "epic" });
const C1 = row("e.1", { parent: "e" });
const C2 = row("e.2", { parent: "e", status: "closed", closed_at: "2026-09-13T00:00:00Z" });
const SUB = row("e.3", { parent: "e", issue_type: "epic" });
const G1 = row("e.3.1", { parent: "e.3" });
const LOOSE = row("x");

describe("child counters on the baseline", () => {
  test("countChildren counts direct children only, closed = done category", () => {
    const s = state([EPIC, C1, C2, SUB, G1, LOOSE]);
    const counts = countChildren(s.issues, s.statuses);
    expect(counts.get("e")).toEqual({ total: 3, closed: 1 });
    expect(counts.get("e.3")).toEqual({ total: 1, closed: 0 });
    expect(counts.has("x")).toBe(false);
    expect(counts.has("e.1")).toBe(false);
  });
  test("stampChildCounts sets the fields on parents and leaves other rows untouched", () => {
    const s = state([EPIC, C1, C2, SUB, G1, LOOSE]);
    expect(s.issues.get("e")).toMatchObject({ child_count: 3, child_closed_count: 1 });
    expect(s.issues.get("e.3")).toMatchObject({ child_count: 1, child_closed_count: 0 });
    expect(s.issues.get("x")?.child_count).toBeUndefined();
    expect(s.issues.get("e.1")?.child_closed_count).toBeUndefined();
  });
  test("a custom done status counts as closed", () => {
    const s = emptyState();
    s.statuses = [
      { name: "open", category: "active", builtin: true },
      { name: "shipped", category: "done", builtin: false },
    ];
    for (const r of [EPIC, row("e.1", { parent: "e", status: "shipped" })]) {
      s.issues.set(r.id, toBoardIssue(r, s.ready, s.statuses));
    }
    stampChildCounts(s.issues, s.statuses);
    expect(s.issues.get("e")).toMatchObject({ child_count: 1, child_closed_count: 1 });
  });
  test("withChildCounts removes the fields when the row has no children left", () => {
    const withCounts: BoardIssue = { ...toBoardIssue(EPIC, new Set(), []), child_count: 2 };
    const cleared = withChildCounts(withCounts, { total: 0, closed: 0 });
    expect("child_count" in cleared).toBe(false);
    expect("child_closed_count" in cleared).toBe(false);
  });
  test("a poll re-baseline diff carries the changed parent row", () => {
    const before = state([EPIC, C1, C2]);
    const after = state([EPIC, C1, { ...C2, status: "open" }, row("e.9", { parent: "e" })]);
    const delta = computeDelta(before, after);
    const epic = delta?.upserts.find((r) => r.id === "e");
    expect(epic).toMatchObject({ child_count: 3, child_closed_count: 0 });
  });
});

describe("child counters follow journal events", () => {
  test("closing a child updates the parent's closed count in the same effect", () => {
    const s = state([EPIC, C1, C2]);
    const closed = { ...C1, status: "closed", closed_at: "2026-09-14T11:00:00Z" };
    const effect = applyEvent(s, record("close", closed), SINCE);
    const epic = effect.upserts.find((r) => r.id === "e");
    expect(epic).toMatchObject({ child_count: 2, child_closed_count: 2 });
    expect(s.issues.get("e")).toMatchObject({ child_count: 2, child_closed_count: 2 });
  });
  test("an update to the parent itself keeps its counters (record.issue lacks them)", () => {
    const s = state([EPIC, C1, C2]);
    const effect = applyEvent(s, record("update", { ...EPIC, title: "renamed" }), SINCE);
    const epic = effect.upserts.find((r) => r.id === "e");
    expect(epic?.title).toBe("renamed");
    expect(epic).toMatchObject({ child_count: 2, child_closed_count: 1 });
  });
  test("creating a child under an epic bumps the epic", () => {
    const s = state([EPIC, C1]);
    // `create` carries no parent; the parent arrives with the dep_add that follows.
    applyEvent(s, record("create", row("e.7")), SINCE);
    const effect = applyEvent(
      s,
      record("dep_add", row("e.7"), {
        dep: { target: "e", kind: "parent-child" },
      } as Partial<EventRecord>),
      SINCE,
    );
    expect(s.issues.get("e.7")?.parent).toBe("e");
    expect(effect.upserts.find((r) => r.id === "e")).toMatchObject({
      child_count: 2,
      child_closed_count: 0,
    });
  });
  test("moving a child to another parent updates both parents", () => {
    const other = row("f", { issue_type: "epic" });
    const s = state([EPIC, other, C1, C2]);
    applyEvent(
      s,
      record("dep_remove", C1, {
        dep: { target: "e", kind: "parent-child" },
      } as Partial<EventRecord>),
      SINCE,
    );
    const effect = applyEvent(
      s,
      record("dep_add", C1, { dep: { target: "f", kind: "parent-child" } } as Partial<EventRecord>),
      SINCE,
    );
    expect(s.issues.get("e")).toMatchObject({ child_count: 1, child_closed_count: 1 });
    expect(effect.upserts.find((r) => r.id === "f")).toMatchObject({
      child_count: 1,
      child_closed_count: 0,
    });
  });
  test("deleting the last child clears the parent's counters", () => {
    const s = state([EPIC, C1]);
    const effect = applyEvent(s, record("delete", C1, { issue: null }), SINCE);
    expect(effect.removes).toEqual(["e.1"]);
    const epic = effect.upserts.find((r) => r.id === "e");
    expect(epic).toBeDefined();
    expect(epic?.child_count).toBeUndefined();
  });
  test("a child leaving the closed window through a re-read drops out of the count", () => {
    const s = state([EPIC, C1, C2]);
    const details = {
      ...C2,
      closed_at: "2026-08-01T00:00:00Z",
      revision: "1",
      dependencies: [],
      dependents: [],
    };
    const change = applyDetails(s, details as never, SINCE);
    expect(change.remove).toBe("e.2");
    expect(change.parents?.map((r) => r.id)).toEqual(["e"]);
    expect(change.parents?.[0]).toMatchObject({ child_count: 1, child_closed_count: 0 });
  });
  test("applyDetails keeps the row's own counters and reports a parent change", () => {
    const s = state([EPIC, SUB, G1]);
    const details = {
      ...SUB,
      title: "sub renamed",
      revision: "1",
      dependencies: [{ id: "e", dependency_type: "parent-child" }],
      dependents: [{ id: "e.3.1", dependency_type: "parent-child" }],
    };
    const change = applyDetails(s, details as never, SINCE);
    expect(change.upsert).toMatchObject({ title: "sub renamed", child_count: 1 });
    expect(change.parents).toBeUndefined();
  });
  test("reconcileChildCounts ignores unknown ids and reports only changed rows", () => {
    const s = state([EPIC, C1, C2]);
    expect(reconcileChildCounts(s, ["nope", "e", "e.1"])).toEqual([]);
    s.issues.set("e.2", { ...(s.issues.get("e.2") as BoardIssue), status: "open" });
    expect(reconcileChildCounts(s, ["e"]).map((r) => r.child_closed_count)).toEqual([0]);
  });
});
