/**
 * Write layer over the BFF proxies (docs/bff-api.md). Two concerns live here:
 *
 * - `guardedPatch`: the concurrency rule of plan 3.3 — read `GET issues/{id}` for `revision`,
 *   send `PATCH` with `expected_version`, and turn `409 precondition_failed` into a typed
 *   conflict result instead of an exception so callers can offer "reload / overwrite".
 * - optimistic rows: `applyOptimistic` writes a local guess into the board state and returns a
 *   function that puts the previous row back (`revert`). The next server `delta` reconciles
 *   either way (the mock and the real BFF both emit one after a write).
 *
 * The functions take the transport as an argument (`deps`) so unit tests can run them without a
 * network; `mutations` (bottom) binds them to the real `api` and the `board` signal.
 */
import { board } from "../state/snapshot.ts";
import { ApiError, api } from "./api.ts";
import type {
  BoardIssue,
  IssueDetails,
  IssuePatch,
  PatchIssueBody,
  PatchIssueResponse,
} from "./bff-types.ts";
import type { BoardState } from "./delta.ts";

export interface PatchTransport {
  getIssue(db: string, id: string): Promise<IssueDetails>;
  patchIssue(db: string, id: string, body: PatchIssueBody): Promise<PatchIssueResponse>;
}

export type GuardedPatchResult =
  | { ok: true; response: PatchIssueResponse }
  | {
      ok: false;
      kind: "conflict";
      /** The revision the server holds now (from the problem), when it reported one. */
      currentRevision: string | null;
      error: ApiError;
    }
  | { ok: false; kind: "error"; error: unknown };

export interface GuardedPatchOptions {
  /** Skip the read and use this revision as `expected_version` (a detail panel already has it). */
  revision?: string | undefined;
  /** Send `force_close_policy` (status crossing into done with open children / a live blocker). */
  forceClosePolicy?: boolean | undefined;
  /** Send `force_assignee_transfer` (take an issue from another live owner). */
  forceAssigneeTransfer?: boolean | undefined;
}

function revisionFromProblem(err: ApiError): string | null {
  const p = err.problem as Record<string, unknown>;
  for (const key of ["revision", "current_version", "actual_version"]) {
    const v = p[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * Read the current `revision`, then `PATCH` with `expected_version`. A `409 precondition_failed`
 * is returned as `{ ok: false, kind: "conflict" }`; every other failure as `kind: "error"`.
 */
export async function guardedPatch(
  deps: PatchTransport,
  db: string,
  id: string,
  actor: string,
  patch: IssuePatch,
  opts: GuardedPatchOptions = {},
): Promise<GuardedPatchResult> {
  try {
    const revision = opts.revision ?? (await deps.getIssue(db, id)).revision;
    const body: PatchIssueBody = { actor, patch, expected_version: revision };
    if (opts.forceClosePolicy) body.force_close_policy = true;
    if (opts.forceAssigneeTransfer) body.force_assignee_transfer = true;
    const response = await deps.patchIssue(db, id, body);
    return { ok: true, response };
  } catch (err) {
    if (err instanceof ApiError && err.code === "precondition_failed") {
      return { ok: false, kind: "conflict", currentRevision: revisionFromProblem(err), error: err };
    }
    return { ok: false, kind: "error", error: err };
  }
}

/** Fields of a board row a drag or an inline edit can guess locally before the server answers. */
export interface OptimisticPatch {
  status?: string | undefined;
  priority?: number | undefined;
  title?: string | undefined;
  labels?: string[] | undefined;
  /** `null` / `""` clear; `undefined` (key absent) leaves the field alone. */
  parent?: string | null | undefined;
  assignee?: string | null | undefined;
}

/**
 * Apply `patch` to row `id` of `state` (a new state object; maps copied). Rows the state does not
 * hold are left alone. Returns the previous row so the caller can restore it.
 */
export function applyOptimisticTo(
  state: BoardState,
  id: string,
  patch: OptimisticPatch,
): { state: BoardState; previous: BoardIssue | null } {
  const previous = state.issues.get(id) ?? null;
  if (!previous) return { state, previous: null };
  const next: BoardIssue = { ...previous, updated_at: new Date().toISOString() };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.title !== undefined) next.title = patch.title;
  if ("parent" in patch) {
    if (patch.parent) next.parent = patch.parent;
    else delete next.parent;
  }
  if ("assignee" in patch) {
    if (patch.assignee) next.assignee = patch.assignee;
    else delete next.assignee;
  }
  if (patch.labels !== undefined) next.labels = patch.labels;
  const issues = new Map(state.issues);
  issues.set(id, next);
  return { state: { ...state, issues }, previous };
}

/**
 * Restore `previous` for `id` unless the server has since delivered a newer row (a delta with a
 * later `updated_at` than the one we guessed means the server state already won).
 */
export function revertOptimisticTo(
  state: BoardState,
  id: string,
  previous: BoardIssue | null,
  guessedAt: string,
): BoardState {
  const current = state.issues.get(id);
  if (!current || current.updated_at !== guessedAt) return state; // reconciled by a delta
  const issues = new Map(state.issues);
  if (previous) issues.set(id, previous);
  else issues.delete(id);
  return { ...state, issues };
}

/** Apply an optimistic guess to the live board signal; the returned function reverts it. */
export function applyOptimistic(id: string, patch: OptimisticPatch): () => void {
  const { state, previous } = applyOptimisticTo(board.value, id, patch);
  if (state === board.value) return () => {};
  const guessedAt = state.issues.get(id)?.updated_at ?? "";
  board.value = state;
  return () => {
    board.value = revertOptimisticTo(board.value, id, previous, guessedAt);
  };
}

/** Bound to the real transport. */
export const liveTransport: PatchTransport = {
  getIssue: (db, id) => api.issue(db, id),
  patchIssue: (db, id, body) => api.patchIssue(db, id, body),
};

export function patchGuarded(
  db: string,
  id: string,
  actor: string,
  patch: IssuePatch,
  opts?: GuardedPatchOptions,
): Promise<GuardedPatchResult> {
  return guardedPatch(liveTransport, db, id, actor, patch, opts);
}

/** Problem code of an unknown error, or `null`. */
export function codeOf(err: unknown): string | null {
  return err instanceof ApiError ? err.code : null;
}

/** `409 not_closable` details: `open_children` (children) or none (a live blocker). */
export function notClosable(err: unknown): { openChildren: number } | null {
  if (!(err instanceof ApiError) || err.code !== "not_closable") return null;
  const n = (err.problem as Record<string, unknown>).open_children;
  return { openChildren: typeof n === "number" ? n : 0 };
}
