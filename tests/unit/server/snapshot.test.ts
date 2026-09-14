import { describe, expect, test } from "bun:test";
import type { EventRecord, IssueWithCounts } from "../../../src/api-client/index.ts";
import {
  applyDetails,
  applyEvent,
  applyReady,
  buildStatuses,
  buildTypes,
  closedSince,
  computeDelta,
  emptyState,
  inScope,
  parseCustomStatuses,
  queryTimestamp,
  type StateData,
  toBoardIssue,
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

function state(rows: IssueWithCounts[], ready: string[] = []): StateData {
  const s = emptyState();
  s.ready = new Set(ready);
  for (const r of rows) s.issues.set(r.id, toBoardIssue(r, s.ready, s.statuses));
  return s;
}

const SINCE = new Date("2026-09-07T00:00:00Z");

describe("dictionaries", () => {
  test("built-in statuses are ordered active → wip → frozen → done", () => {
    const names = buildStatuses(undefined).map((s) => `${s.name}:${s.category}`);
    expect(names).toEqual([
      "open:active",
      "in_progress:wip",
      "blocked:wip",
      "hooked:wip",
      "deferred:frozen",
      "pinned:frozen",
      "closed:done",
    ]);
  });
  test("status.custom is parsed and merged in category order", () => {
    const defs = buildStatuses("review:wip, done_done:done ,triage:active,weird:nope");
    const names = defs.map((s) => s.name);
    expect(names.indexOf("triage")).toBeLessThan(names.indexOf("in_progress"));
    expect(names.indexOf("review")).toBeLessThan(names.indexOf("deferred"));
    expect(names.at(-1)).toBe("done_done");
    expect(defs.find((s) => s.name === "weird")?.category).toBe("active");
    expect(defs.find((s) => s.name === "review")?.builtin).toBe(false);
    expect(defs.find((s) => s.name === "open")?.builtin).toBe(true);
  });
  test("a custom entry may re-categorise a built-in status", () => {
    const defs = buildStatuses("blocked:frozen");
    expect(defs.find((s) => s.name === "blocked")?.category).toBe("frozen");
    expect(defs.filter((s) => s.name === "blocked")).toHaveLength(1);
  });
  test("parseCustomStatuses tolerates empty and duplicate entries", () => {
    expect(parseCustomStatuses("")).toEqual([]);
    expect(parseCustomStatuses("a:wip,,a:done")).toEqual([
      { name: "a", category: "wip", builtin: false },
    ]);
  });
  test("types.custom appends unique names", () => {
    expect(buildTypes("research, task ,ops")).toEqual([
      "task",
      "bug",
      "feature",
      "chore",
      "epic",
      "decision",
      "spike",
      "story",
      "milestone",
      "research",
      "ops",
    ]);
  });
});

describe("scope and blocked", () => {
  const statuses = buildStatuses(undefined);
  test("a done row without closed_at is out of the closed window", () => {
    expect(inScope(row("a", { status: "closed" }), statuses, SINCE)).toBe(false);
    expect(inScope(row("b", { status: "open" }), statuses, SINCE)).toBe(true);
  });
  test("closed issues stay while closed_at is within the window", () => {
    expect(
      inScope(row("a", { status: "closed", closed_at: "2026-09-10T00:00:00Z" }), statuses, SINCE),
    ).toBe(true);
    expect(
      inScope(row("b", { status: "closed", closed_at: "2026-09-01T00:00:00Z" }), statuses, SINCE),
    ).toBe(false);
    expect(inScope(row("c", { status: "open" }), statuses, SINCE)).toBe(true);
    expect(inScope(row("d", { issue_type: "gate" }), statuses, SINCE)).toBe(false);
    expect(
      inScope(row("e", { ephemeral: true } as Partial<IssueWithCounts>), statuses, SINCE),
    ).toBe(false);
  });
  test("blocked = open and not ready; done/frozen never blocked", () => {
    const ready = new Set(["a"]);
    expect(toBoardIssue(row("a"), ready, statuses).blocked).toBe(false);
    expect(toBoardIssue(row("b"), ready, statuses).blocked).toBe(true);
    expect(toBoardIssue(row("c", { status: "closed" }), ready, statuses).blocked).toBe(false);
    expect(toBoardIssue(row("d", { status: "deferred" }), ready, statuses).blocked).toBe(false);
  });
  test("closedSince and the query timestamp", () => {
    const now = new Date("2026-09-14T12:00:00.123Z");
    expect(closedSince(7, now).toISOString()).toBe("2026-09-07T12:00:00.123Z");
    expect(queryTimestamp(closedSince(7, now))).toBe("2026-09-07T12:00:00Z");
  });
});

describe("computeDelta", () => {
  test("upserts changed/new rows, removes missing ones, ready and stats only when changed", () => {
    const prev = state([row("a"), row("b"), row("c")], ["a", "b", "c"]);
    const next = state([row("a"), row("b", { title: "renamed" }), row("d")], ["a", "d"]);
    const delta = computeDelta(prev, next);
    expect(delta?.upserts.map((r) => r.id).sort()).toEqual(["b", "d"]);
    expect(delta?.removes).toEqual(["c"]);
    expect(delta?.ready?.sort()).toEqual(["a", "d"]);
    expect(delta?.stats).toBeUndefined();
  });
  test("identical states → null", () => {
    const a = state([row("a")], ["a"]);
    const b = state([row("a")], ["a"]);
    expect(computeDelta(a, b)).toBeNull();
  });
});

function record(op: string, id: string, extra: Partial<EventRecord> = {}): EventRecord {
  return {
    seq: 1,
    ts: "2026-09-14T12:00:00Z",
    op,
    issue_id: id,
    actor: "t",
    issue: null,
    ...extra,
  } as EventRecord;
}

describe("applyEvent", () => {
  test("create adds the row (not blocked until ready refresh) and asks for a ready refresh", () => {
    const s = state([]);
    const eff = applyEvent(s, record("create", "n", { issue: row("n") }), SINCE);
    expect(eff.upserts.map((r) => r.id)).toEqual(["n"]);
    expect(s.issues.get("n")?.blocked).toBe(false);
    expect(eff.readyDirty).toBe(true);
    expect(eff.refetch).toEqual([]);
  });
  test("update keeps counts and parent from the previous row", () => {
    const s = state([
      row("a", { dependency_count: 2, comment_count: 1, parent: "p" } as Partial<IssueWithCounts>),
    ]);
    const eff = applyEvent(s, record("update", "a", { issue: row("a", { title: "new" }) }), SINCE);
    const after = s.issues.get("a") as BoardIssue;
    expect(after.title).toBe("new");
    expect(after.dependency_count).toBe(2);
    expect(after.comment_count).toBe(1);
    expect(after.parent).toBe("p");
    expect(after.blocked).toBe(true); // not in ready
    expect(eff.upserts).toHaveLength(1);
  });
  test("close inside the window upserts; an old closed_at removes", () => {
    const s = state([row("a"), row("b")]);
    applyEvent(
      s,
      record("close", "a", {
        issue: row("a", { status: "closed", closed_at: "2026-09-13T00:00:00Z" }),
      }),
      SINCE,
    );
    expect(s.issues.get("a")?.status).toBe("closed");
    expect(s.issues.get("a")?.blocked).toBe(false);
    const eff = applyEvent(
      s,
      record("close", "b", {
        issue: row("b", { status: "closed", closed_at: "2026-01-01T00:00:00Z" }),
      }),
      SINCE,
    );
    expect(eff.removes).toEqual(["b"]);
    expect(s.issues.has("b")).toBe(false);
  });
  test("delete removes", () => {
    const s = state([row("a")]);
    const eff = applyEvent(s, record("delete", "a"), SINCE);
    expect(eff.removes).toEqual(["a"]);
    expect(eff.upserts).toEqual([]);
  });
  test("dep_add parent-child sets parent without touching counts; blocks bumps both ends", () => {
    const s = state([row("child"), row("epic", { issue_type: "epic" }), row("blocker")]);
    const eff = applyEvent(
      s,
      record("dep_add", "child", {
        issue: row("child"),
        dep: { kind: "parent-child", target: "epic", metadata: "{}" },
      }),
      SINCE,
    );
    expect(s.issues.get("child")?.parent).toBe("epic");
    expect(s.issues.get("child")?.dependency_count).toBe(0);
    expect(s.issues.get("epic")?.dependent_count).toBe(0);
    expect(eff.refetch.sort()).toEqual(["child", "epic"]);
    const blocks = applyEvent(
      s,
      record("dep_add", "child", {
        issue: row("child"),
        dep: { kind: "blocks", target: "blocker", metadata: "{}" },
      }),
      SINCE,
    );
    expect(s.issues.get("child")?.dependency_count).toBe(1);
    expect(s.issues.get("blocker")?.dependent_count).toBe(1);
    expect(blocks.upserts.map((r) => r.id).sort()).toEqual(["blocker", "child"]);
    applyEvent(
      s,
      record("dep_remove", "child", {
        issue: row("child"),
        dep: { kind: "parent-child", target: "epic", metadata: "{}" },
      }),
      SINCE,
    );
    expect(s.issues.get("child")?.parent).toBeUndefined();
    expect(s.issues.get("child")?.dependency_count).toBe(1);
  });
  test("comment bumps comment_count, refetches, no ready refresh", () => {
    const s = state([row("a")]);
    const eff = applyEvent(s, record("comment", "a", { issue: row("a") }), SINCE);
    expect(s.issues.get("a")?.comment_count).toBe(1);
    expect(eff.refetch).toEqual(["a"]);
    expect(eff.readyDirty).toBe(false);
  });
  test("unknown op with an issue payload is treated like an update", () => {
    const s = state([row("a")]);
    const eff = applyEvent(
      s,
      record("frobnicate", "a", { issue: row("a", { priority: 0 }) }),
      SINCE,
    );
    expect(s.issues.get("a")?.priority).toBe(0);
    expect(eff.upserts).toHaveLength(1);
  });
});

describe("applyReady / applyDetails", () => {
  test("applyReady flips blocked only where it changed", () => {
    const s = state(
      [row("a"), row("b"), row("c", { status: "closed", closed_at: "2026-09-13T00:00:00Z" })],
      ["a"],
    );
    const flipped = applyReady(s, new Set(["b"]));
    expect(flipped.map((r) => `${r.id}:${r.blocked}`).sort()).toEqual(["a:true", "b:false"]);
    expect(s.issues.get("c")?.blocked).toBe(false);
  });
  test("applyDetails recounts edges with list semantics and strips detail-only members", () => {
    const s = state([row("a", { dependent_count: 4 })], ["a"]);
    const details = {
      ...row("a", { dependency_count: 9, parent: "p" } as Partial<IssueWithCounts>),
      revision: "123",
      dependencies: [
        { id: "p", dependency_type: "parent-child" },
        { id: "x", dependency_type: "blocks" },
        { id: "y", dependency_type: "related" },
      ],
      description: "long text",
    };
    const change = applyDetails(s, details as never, SINCE);
    expect(change.upsert?.dependency_count).toBe(1); // only the `blocks` edge counts
    expect(change.upsert?.dependent_count).toBe(4); // no `dependents` list → previous value kept
    expect(change.upsert?.parent).toBe("p");
    expect((change.upsert as Record<string, unknown>).revision).toBeUndefined();
    expect((change.upsert as Record<string, unknown>).description).toBeUndefined();
    expect(applyDetails(s, details as never, SINCE)).toEqual({});
  });
});
