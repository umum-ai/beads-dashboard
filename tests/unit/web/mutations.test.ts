import { describe, expect, test } from "bun:test";
import { ApiError } from "../../../src/web/lib/api.ts";
import type {
  BoardIssue,
  IssueDetails,
  PatchIssueBody,
  Problem,
} from "../../../src/web/lib/bff-types.ts";
import { emptyBoardState } from "../../../src/web/lib/delta.ts";
import {
  applyOptimistic,
  applyOptimisticTo,
  guardedPatch,
  notClosable,
  type PatchTransport,
  revertOptimisticTo,
} from "../../../src/web/lib/mutations.ts";
import { board } from "../../../src/web/state/snapshot.ts";

const row = (over: Partial<BoardIssue> = {}): BoardIssue => ({
  id: "kb-1",
  title: "One",
  status: "open",
  priority: 2,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  labels: ["a"],
  dependency_count: 0,
  dependent_count: 0,
  comment_count: 0,
  blocked: false,
  ...over,
});

const details = (revision: string): IssueDetails => ({
  ...row(),
  revision,
  dependencies: [],
  dependents: [],
  comments: [],
});

function problem(status: number, code: string, extra: Record<string, unknown> = {}): ApiError {
  const body: Problem = {
    type: "about:blank",
    code,
    status,
    title: code,
    detail: `${code} detail`,
    request_id: "r1",
    ...extra,
  };
  return new ApiError(body);
}

function transport(opts: {
  revision?: string;
  patch?: (body: PatchIssueBody) => Promise<unknown>;
}): PatchTransport & { calls: PatchIssueBody[]; reads: number } {
  const calls: PatchIssueBody[] = [];
  const t = {
    calls,
    reads: 0,
    async getIssue() {
      t.reads++;
      return details(opts.revision ?? "rev-1");
    },
    async patchIssue(_db: string, _id: string, body: PatchIssueBody) {
      calls.push(body);
      if (opts.patch) await opts.patch(body);
      const { status, priority, title } = body.patch;
      const issue = row();
      if (status !== undefined) issue.status = status;
      if (priority !== undefined) issue.priority = priority;
      if (title !== undefined) issue.title = title;
      return { issue, changed: true, revision: "rev-2" };
    },
  };
  return t;
}

describe("guardedPatch", () => {
  test("reads the revision, sends it as expected_version with the actor, returns the response", async () => {
    const t = transport({ revision: "abc" });
    const result = await guardedPatch(t, "kb", "kb-1", "alice", { status: "in_progress" });
    expect(result.ok).toBe(true);
    expect(t.reads).toBe(1);
    expect(t.calls).toEqual([
      { actor: "alice", patch: { status: "in_progress" }, expected_version: "abc" },
    ]);
    if (result.ok) expect(result.response.revision).toBe("rev-2");
  });

  test("a known revision skips the read; force flags are forwarded", async () => {
    const t = transport({});
    await guardedPatch(
      t,
      "kb",
      "kb-1",
      "alice",
      { status: "closed" },
      {
        revision: "known",
        forceClosePolicy: true,
      },
    );
    expect(t.reads).toBe(0);
    expect(t.calls[0]).toEqual({
      actor: "alice",
      patch: { status: "closed" },
      expected_version: "known",
      force_close_policy: true,
    });
  });

  test("409 precondition_failed becomes a typed conflict carrying the server's revision", async () => {
    const t = transport({
      patch: async () => {
        throw problem(409, "precondition_failed", { expected_version: "old", revision: "new-7" });
      },
    });
    const result = await guardedPatch(t, "kb", "kb-1", "alice", { title: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("conflict");
      if (result.kind === "conflict") {
        expect(result.currentRevision).toBe("new-7");
        expect(result.error.code).toBe("precondition_failed");
      }
    }
  });

  test("other problems (and read failures) are errors, not conflicts", async () => {
    const t = transport({
      patch: async () => {
        throw problem(409, "not_closable", { open_children: 2 });
      },
    });
    const result = await guardedPatch(t, "kb", "kb-1", "alice", { status: "closed" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("error");
      expect(notClosable(result.error)).toEqual({ openChildren: 2 });
    }
    const failingRead: PatchTransport = {
      getIssue: async () => {
        throw problem(404, "not_found");
      },
      patchIssue: async () => {
        throw new Error("unreachable");
      },
    };
    const r2 = await guardedPatch(failingRead, "kb", "kb-1", "alice", { title: "x" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.kind).toBe("error");
  });

  test("notClosable distinguishes open children from a live blocker", () => {
    expect(notClosable(problem(409, "not_closable"))).toEqual({ openChildren: 0 });
    expect(notClosable(problem(409, "dependency_cycle"))).toBeNull();
    expect(notClosable(new Error("x"))).toBeNull();
  });
});

describe("optimistic rows", () => {
  test("applyOptimisticTo patches the row in a copied map and hands back the previous row", () => {
    const state = { ...emptyBoardState(), seq: 3, issues: new Map([["kb-1", row()]]) };
    const { state: next, previous } = applyOptimisticTo(state, "kb-1", {
      status: "in_progress",
      priority: 0,
      parent: "kb-e1",
      assignee: null,
    });
    expect(previous).toEqual(row());
    expect(next).not.toBe(state);
    expect(state.issues.get("kb-1")?.status).toBe("open");
    const guessed = next.issues.get("kb-1") as BoardIssue;
    expect(guessed.status).toBe("in_progress");
    expect(guessed.priority).toBe(0);
    expect(guessed.parent).toBe("kb-e1");
    expect("assignee" in guessed).toBe(false);
    expect(guessed.updated_at).not.toBe(row().updated_at);
  });

  test("a close guess stamps closed_at so the row lands in the Closed window; reopen clears it", () => {
    const state = { ...emptyBoardState(), issues: new Map([["kb-1", row()]]) };
    const closed = applyOptimisticTo(state, "kb-1", {
      status: "closed",
      closed_at: "2026-09-15T10:00:00.000Z",
    }).state;
    expect(closed.issues.get("kb-1")?.closed_at).toBe("2026-09-15T10:00:00.000Z");
    const reopened = applyOptimisticTo(closed, "kb-1", { status: "open", closed_at: null }).state;
    expect("closed_at" in (reopened.issues.get("kb-1") as BoardIssue)).toBe(false);
    // a patch without the key leaves the stamp alone
    const other = applyOptimisticTo(closed, "kb-1", { priority: 1 }).state;
    expect(other.issues.get("kb-1")?.closed_at).toBe("2026-09-15T10:00:00.000Z");
  });

  test("an unknown id is left alone", () => {
    const state = emptyBoardState();
    const out = applyOptimisticTo(state, "nope", { status: "x" });
    expect(out.state).toBe(state);
    expect(out.previous).toBeNull();
  });

  test("revert restores the previous row unless a delta has replaced the guess", () => {
    const state = { ...emptyBoardState(), issues: new Map([["kb-1", row()]]) };
    const { state: guessed, previous } = applyOptimisticTo(state, "kb-1", { status: "closed" });
    const guessedAt = guessed.issues.get("kb-1")?.updated_at as string;
    const reverted = revertOptimisticTo(guessed, "kb-1", previous, guessedAt);
    expect(reverted.issues.get("kb-1")).toEqual(row());

    // the server answered first: a delta row with its own updated_at stays
    const fromServer = row({ status: "closed", updated_at: "2026-09-03T00:00:00Z" });
    const withDelta = { ...guessed, issues: new Map([["kb-1", fromServer]]) };
    expect(revertOptimisticTo(withDelta, "kb-1", previous, guessedAt).issues.get("kb-1")).toBe(
      fromServer,
    );
  });

  test("applyOptimistic works on the live board signal and its revert undoes the guess", () => {
    board.value = { ...emptyBoardState(), seq: 1, issues: new Map([["kb-1", row()]]) };
    const revert = applyOptimistic("kb-1", { priority: 0 });
    expect(board.value.issues.get("kb-1")?.priority).toBe(0);
    revert();
    expect(board.value.issues.get("kb-1")?.priority).toBe(2);
    board.value = emptyBoardState();
  });
});
