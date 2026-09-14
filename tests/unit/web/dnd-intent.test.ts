import { describe, expect, test } from "bun:test";
import type { StatusDef } from "../../../src/web/lib/bff-types.ts";
import {
  type DragSource,
  isDoneStatus,
  resolveDrop,
  resolveMultiDrop,
} from "../../../src/web/lib/dnd-intent.ts";

const STATUSES: StatusDef[] = [
  { name: "open", category: "active", builtin: true },
  { name: "review", category: "active", builtin: false },
  { name: "in_progress", category: "wip", builtin: true },
  { name: "deferred", category: "frozen", builtin: true },
  { name: "closed", category: "done", builtin: true },
  { name: "done", category: "done", builtin: false },
];

const card = (over: Partial<DragSource> = {}): DragSource => ({
  id: "kb-1",
  status: "open",
  priority: 2,
  lane: null,
  ...over,
});

describe("resolveDrop", () => {
  test("same column and section → nothing", () => {
    expect(resolveDrop(card(), { status: "open", priority: 2 }, STATUSES)).toEqual({
      kind: "none",
    });
  });

  test("same column, other priority section → PATCH priority", () => {
    expect(resolveDrop(card(), { status: "open", priority: 0 }, STATUSES)).toEqual({
      kind: "patch",
      patch: { priority: 0 },
    });
  });

  test("other non-done column → PATCH status; with a different section both fields go in one patch", () => {
    expect(resolveDrop(card(), { status: "in_progress", priority: 2 }, STATUSES)).toEqual({
      kind: "patch",
      patch: { status: "in_progress" },
    });
    expect(resolveDrop(card(), { status: "review", priority: 1 }, STATUSES)).toEqual({
      kind: "patch",
      patch: { priority: 1, status: "review" },
    });
  });

  test("into a done column → close, the rest patched afterwards", () => {
    expect(resolveDrop(card(), { status: "closed", priority: 2 }, STATUSES)).toEqual({
      kind: "close",
      after: null,
    });
    expect(resolveDrop(card(), { status: "done", priority: 4 }, STATUSES)).toEqual({
      kind: "close",
      after: { priority: 4 },
    });
  });

  test("out of a done column → reopen; target other than open is patched afterwards", () => {
    const closed = card({ status: "closed" });
    expect(resolveDrop(closed, { status: "open", priority: 2 }, STATUSES)).toEqual({
      kind: "reopen",
      after: null,
    });
    expect(resolveDrop(closed, { status: "in_progress", priority: 1 }, STATUSES)).toEqual({
      kind: "reopen",
      after: { priority: 1, status: "in_progress" },
    });
  });

  test("done → another done status is a plain status patch", () => {
    expect(resolveDrop(card({ status: "closed" }), { status: "done" }, STATUSES)).toEqual({
      kind: "patch",
      patch: { status: "done" },
    });
  });

  test("frozen ↔ active is a plain status patch, not close/reopen", () => {
    expect(resolveDrop(card(), { status: "deferred" }, STATUSES)).toEqual({
      kind: "patch",
      patch: { status: "deferred" },
    });
    expect(resolveDrop(card({ status: "deferred" }), { status: "open" }, STATUSES)).toEqual({
      kind: "patch",
      patch: { status: "open" },
    });
  });

  test("lane change → parent_id of the lane; the no-epic lane clears it", () => {
    const inEpic = card({ lane: "kb-e1" });
    expect(
      resolveDrop(
        inEpic,
        { status: "open", priority: 2, lane: { key: "kb-e2", parentId: "kb-e2" } },
        STATUSES,
      ),
    ).toEqual({ kind: "patch", patch: { parent_id: "kb-e2" } });
    expect(
      resolveDrop(
        inEpic,
        { status: "open", priority: 2, lane: { key: "", parentId: "" } },
        STATUSES,
      ),
    ).toEqual({ kind: "patch", patch: { parent_id: "" } });
  });

  test("drill-down: the 'directly in' lane sets the drilled epic as parent", () => {
    expect(
      resolveDrop(card({ lane: "kb-e1.1" }), { lane: { key: "", parentId: "kb-e1" } }, STATUSES),
    ).toEqual({ kind: "patch", patch: { parent_id: "kb-e1" } });
  });

  test("dropping inside its own lane keeps the parent (sub-epic children stay put)", () => {
    expect(
      resolveDrop(
        card({ lane: "kb-e1" }),
        { status: "open", priority: 1, lane: { key: "kb-e1", parentId: "kb-e1" } },
        STATUSES,
      ),
    ).toEqual({ kind: "patch", patch: { priority: 1 } });
  });

  test("a card on the flat board ignores lane data; an epic cannot become its own parent", () => {
    expect(resolveDrop(card(), { lane: { key: "kb-e1", parentId: "kb-e1" } }, STATUSES)).toEqual({
      kind: "none",
    });
    expect(
      resolveDrop(
        card({ id: "kb-e1", lane: "kb-e1" }),
        { lane: { key: "", parentId: "kb-e1" } },
        STATUSES,
      ),
    ).toEqual({ kind: "none" });
  });

  test("status + priority + lane in one drop is one patch when no close/reopen is involved", () => {
    expect(
      resolveDrop(
        card({ lane: "" }),
        { status: "review", priority: 0, lane: { key: "kb-e1", parentId: "kb-e1" } },
        STATUSES,
      ),
    ).toEqual({ kind: "patch", patch: { priority: 0, parent_id: "kb-e1", status: "review" } });
  });

  test("unknown statuses count as active", () => {
    expect(isDoneStatus(STATUSES, "weird")).toBe(false);
    expect(resolveDrop(card({ status: "weird" }), { status: "closed" }, STATUSES)).toEqual({
      kind: "close",
      after: null,
    });
  });
});

describe("resolveMultiDrop", () => {
  test("groups plain patches and keeps close/reopen apart", () => {
    const out = resolveMultiDrop(
      [
        card({ id: "a" }),
        card({ id: "b", status: "in_progress" }),
        card({ id: "c", status: "closed" }),
      ],
      { status: "in_progress", priority: 2 },
      STATUSES,
    );
    expect(out.patches).toEqual([{ id: "a", patch: { status: "in_progress" } }]);
    expect(out.special).toEqual([
      { id: "c", intent: { kind: "reopen", after: { status: "in_progress" } } },
    ]);
    expect(out.batchable).toBe(true);
  });

  test("a parent change is not batchable (batch-apply has no parent_id)", () => {
    const out = resolveMultiDrop(
      [card({ id: "a", lane: "" }), card({ id: "b", lane: "" })],
      { status: "open", priority: 2, lane: { key: "kb-e1", parentId: "kb-e1" } },
      STATUSES,
    );
    expect(out.patches.length).toBe(2);
    expect(out.batchable).toBe(false);
  });

  test("dropping into a done column closes every non-done card", () => {
    const out = resolveMultiDrop(
      [card({ id: "a" }), card({ id: "b" })],
      { status: "closed" },
      STATUSES,
    );
    expect(out.patches).toEqual([]);
    expect(out.special.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
