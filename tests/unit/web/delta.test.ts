import { describe, expect, test } from "bun:test";
import type { BoardIssue, Snapshot } from "../../../src/web/lib/bff-types.ts";
import {
  applyDelta,
  applyQueued,
  emptyBoardState,
  fromSnapshot,
} from "../../../src/web/lib/delta.ts";

function row(id: string, over: Partial<BoardIssue> = {}): BoardIssue {
  return {
    id,
    title: id,
    priority: 2,
    status: "open",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    blocked: false,
    ...over,
  };
}

const snapshot: Snapshot = {
  seq: 10,
  database: {
    name: "db",
    state: "ready",
    live: "sse",
    lastSyncAt: null,
    bdVersion: null,
    projectId: null,
    versionWarning: null,
    capabilities: [],
    issueCount: 0,
  },
  statuses: [{ name: "open", category: "active", builtin: true }],
  types: ["task"],
  issues: [row("a"), row("b")],
  ready: ["a"],
  stats: null,
};

describe("delta application", () => {
  test("fromSnapshot indexes issues and ready", () => {
    const state = fromSnapshot(snapshot);
    expect(state.seq).toBe(10);
    expect([...state.issues.keys()]).toEqual(["a", "b"]);
    expect(state.ready.has("a")).toBe(true);
    expect(state.ready.has("b")).toBe(false);
  });

  test("consecutive delta upserts, removes and replaces ready/stats", () => {
    const state = fromSnapshot(snapshot);
    const result = applyDelta(state, {
      seq: 11,
      upserts: [row("a", { status: "in_progress" }), row("c")],
      removes: ["b"],
      ready: ["c"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.seq).toBe(11);
    expect(result.state.issues.get("a")?.status).toBe("in_progress");
    expect(result.state.issues.has("b")).toBe(false);
    expect(result.state.issues.has("c")).toBe(true);
    expect([...result.state.ready]).toEqual(["c"]);
    // the input state is not mutated
    expect(state.issues.get("a")?.status).toBe("open");
    expect(state.issues.has("b")).toBe(true);
  });

  test("a delta without ready/stats keeps the previous values", () => {
    const state = fromSnapshot(snapshot);
    const result = applyDelta(state, { seq: 11, upserts: [], removes: [] });
    expect(result.ok && result.state.ready === state.ready).toBe(true);
    expect(result.ok && result.state.stats).toBeNull();
  });

  test("a gap in seq is reported so the caller refetches the snapshot", () => {
    const state = fromSnapshot(snapshot);
    expect(applyDelta(state, { seq: 12, upserts: [], removes: [] })).toEqual({
      ok: false,
      reason: "gap",
    });
    expect(applyDelta(state, { seq: 500, upserts: [], removes: [] })).toEqual({
      ok: false,
      reason: "gap",
    });
  });

  test("stale or duplicate deltas are ignored", () => {
    const state = fromSnapshot(snapshot);
    expect(applyDelta(state, { seq: 10, upserts: [row("z")], removes: [] })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(applyDelta(state, { seq: 3, upserts: [], removes: [] })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(state.issues.has("z")).toBe(false);
  });

  test("the first delta on an empty state is accepted whatever its seq", () => {
    const result = applyDelta(emptyBoardState(), { seq: 42, upserts: [row("a")], removes: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.seq).toBe(42);
  });

  test("deltas queued during a refetch: those inside the snapshot are dropped, the rest chain", () => {
    // The snapshot came back at seq 12; deltas 11 (already inside), 13 and 14 arrived meanwhile.
    const fresh = fromSnapshot({ ...snapshot, seq: 12, issues: [row("a", { title: "a@12" })] });
    const queued = [
      { seq: 14, upserts: [row("a", { title: "a@14" })], removes: [] },
      { seq: 11, upserts: [row("a", { title: "a@11" })], removes: [] },
      { seq: 13, upserts: [row("c")], removes: [] },
    ];
    const { state, gap } = applyQueued(fresh, queued);
    expect(gap).toBe(false);
    expect(state.seq).toBe(14);
    expect(state.issues.get("a")?.title).toBe("a@14");
    expect(state.issues.has("c")).toBe(true);
  });

  test("a queued delta that cannot chain reports a gap and keeps what did apply", () => {
    const fresh = fromSnapshot({ ...snapshot, seq: 12 });
    const { state, gap } = applyQueued(fresh, [
      { seq: 13, upserts: [row("c")], removes: [] },
      { seq: 15, upserts: [row("d")], removes: [] },
    ]);
    expect(gap).toBe(true);
    expect(state.seq).toBe(13);
    expect(state.issues.has("c")).toBe(true);
    expect(state.issues.has("d")).toBe(false);
  });

  test("nothing queued leaves the state untouched", () => {
    const fresh = fromSnapshot(snapshot);
    expect(applyQueued(fresh, [])).toEqual({ state: fresh, gap: false });
  });
});
