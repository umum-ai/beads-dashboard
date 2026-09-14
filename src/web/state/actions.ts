/**
 * Board-level write orchestration: what a drop, a card-menu choice or a status select does.
 * Every path goes through `lib/mutations.ts` (guarded PATCH, optimistic rows), the dialogs of
 * `state/dialogs.ts` (close reason, force, conflict) and toasts by problem `code`.
 */
import { t } from "../i18n/index.ts";
import { ApiError, api } from "../lib/api.ts";
import type { ApplyItem, BoardIssue, IssuePatch } from "../lib/bff-types.ts";
import { type DropTarget, resolveDrop, resolveMultiDrop } from "../lib/dnd-intent.ts";
import {
  applyOptimistic,
  type GuardedPatchResult,
  notClosable,
  type OptimisticPatch,
  patchGuarded,
} from "../lib/mutations.ts";
import { ask } from "./dialogs.ts";
import { actor } from "./meta.ts";
import { cardLanes, clearSelection, markPending } from "./selection.ts";
import { allIssues, board } from "./snapshot.ts";
import { pushToast, toastError } from "./toasts.ts";

function rowOf(id: string): BoardIssue | undefined {
  return board.value.issues.get(id) ?? allIssues.value.find((r) => r.id === id);
}

function guessFrom(patch: IssuePatch): OptimisticPatch {
  const guess: OptimisticPatch = {};
  if (patch.status !== undefined) guess.status = patch.status;
  if (patch.priority !== undefined) guess.priority = patch.priority;
  if (patch.parent_id !== undefined) guess.parent = patch.parent_id || null;
  if (patch.assignee !== undefined) guess.assignee = patch.assignee || null;
  if (patch.title !== undefined) guess.title = patch.title;
  return guess;
}

function reportPatchFailure(result: Extract<GuardedPatchResult, { ok: false }>): void {
  if (result.kind === "conflict") {
    pushToast("error", t("toast.conflict", { detail: result.error.problem.detail ?? "" }), 6000);
  } else toastError(result.error);
}

/**
 * Guarded `PATCH` of one row with an optimistic guess on the board. Returns true on success;
 * on any failure the row is put back and a toast names the problem.
 */
export async function patchRow(
  db: string,
  id: string,
  patch: IssuePatch,
  opts: { forceClosePolicy?: boolean | undefined; silent?: boolean | undefined } = {},
): Promise<boolean> {
  const revert = applyOptimistic(id, guessFrom(patch));
  markPending([id], true);
  try {
    const result = await patchGuarded(db, id, actor.value, patch, {
      forceClosePolicy: opts.forceClosePolicy,
    });
    if (result.ok) return true;
    revert();
    // Status into done refused by close policy: offer force (same dialog as a drop into Closed).
    const refusal = notClosable(result.ok ? null : result.error);
    if (refusal && patch.status) {
      const row = rowOf(id);
      const forced = await ask({
        kind: "force",
        id,
        title: row?.title ?? id,
        openChildren: refusal.openChildren > 0 ? refusal.openChildren : null,
      });
      if (forced) return patchRow(db, id, patch, { ...opts, forceClosePolicy: true });
      return false;
    }
    if (!opts.silent) reportPatchFailure(result);
    return false;
  } finally {
    markPending([id], false);
  }
}

/**
 * Close rows with the reason dialog (one dialog for the whole set), then `POST :close` each;
 * a `409 not_closable` asks for force per row. `then` is patched afterwards (priority, parent,
 * or a done status other than the one `:close` set).
 */
export async function closeRows(
  db: string,
  ids: readonly string[],
  then: IssuePatch | null,
  targetStatus?: string,
): Promise<boolean> {
  const rows = ids.map((id) => rowOf(id)).filter((r): r is BoardIssue => Boolean(r));
  if (!rows.length) return false;
  const first = rows[0] as BoardIssue;
  const asked = await ask({
    kind: "closeReason",
    id: first.id,
    title: first.title,
    count: rows.length,
  });
  if (!asked) return false;
  let allOk = true;
  for (const row of rows) {
    const ok = await closeOne(db, row, asked.reason, then, targetStatus);
    allOk = allOk && ok;
  }
  return allOk;
}

async function closeOne(
  db: string,
  row: BoardIssue,
  reason: string,
  then: IssuePatch | null,
  targetStatus: string | undefined,
  force = false,
): Promise<boolean> {
  const done =
    targetStatus ?? board.value.statuses.find((s) => s.category === "done")?.name ?? "closed";
  const revert = applyOptimistic(row.id, {
    status: done,
    closed_at: new Date().toISOString(),
    ...guessFrom(then ?? {}),
  });
  markPending([row.id], true);
  try {
    const body: { actor: string; reason?: string; force?: boolean } = { actor: actor.value };
    if (reason) body.reason = reason;
    if (force) body.force = true;
    const res = await api.closeIssue(db, row.id, body);
    const after: IssuePatch = { ...(then ?? {}) };
    if (targetStatus && res.issue.status !== targetStatus) after.status = targetStatus;
    if (Object.keys(after).length) {
      const result = await patchGuarded(db, row.id, actor.value, after, {
        revision: res.revision,
        forceClosePolicy: force,
      });
      if (!result.ok) reportPatchFailure(result);
    }
    return true;
  } catch (err) {
    revert();
    const refusal = notClosable(err);
    if (refusal && !force) {
      const forced = await ask({
        kind: "force",
        id: row.id,
        title: row.title,
        openChildren: refusal.openChildren > 0 ? refusal.openChildren : null,
      });
      if (forced) return closeOne(db, row, reason, then, targetStatus, true);
      return false;
    }
    if (err instanceof ApiError && err.code === "precondition_failed") {
      pushToast("error", t("toast.conflict", { detail: err.problem.detail ?? "" }), 6000);
    } else toastError(err);
    return false;
  } finally {
    markPending([row.id], false);
  }
}

/** `POST :reopen`, then `PATCH` the target status / priority / parent when given. */
export async function reopenRow(db: string, id: string, then: IssuePatch | null): Promise<boolean> {
  const revert = applyOptimistic(id, {
    status: then?.status ?? "open",
    closed_at: null,
    ...guessFrom(then ?? {}),
  });
  markPending([id], true);
  try {
    const res = await api.reopenIssue(db, id, { actor: actor.value });
    if (then && Object.keys(then).length) {
      const result = await patchGuarded(db, id, actor.value, then, { revision: res.revision });
      if (!result.ok) {
        reportPatchFailure(result);
        return false;
      }
    }
    return true;
  } catch (err) {
    revert();
    toastError(err);
    return false;
  } finally {
    markPending([id], false);
  }
}

/** Set of statuses of the current board, for intent resolution. */
function statuses() {
  return board.value.statuses;
}

/**
 * A drop (or a keyboard "move to") of `ids` onto `target`. Single card: resolve and run. Many
 * cards: plain patches go through `issues:batchApply` when possible, close / reopen run one by
 * one with their dialogs.
 */
export async function moveRows(
  db: string,
  ids: readonly string[],
  target: DropTarget,
): Promise<void> {
  const sources = ids
    .map((id) => rowOf(id))
    .filter((r): r is BoardIssue => Boolean(r))
    .map((r) => ({
      id: r.id,
      status: r.status ?? "open",
      priority: r.priority,
      lane: cardLanes.get(r.id) ?? null,
    }));
  if (!sources.length) return;
  const defs = statuses();

  if (sources.length === 1) {
    const source = sources[0] as (typeof sources)[number];
    const intent = resolveDrop(source, target, defs);
    switch (intent.kind) {
      case "none":
        return;
      case "patch":
        await patchRow(db, source.id, intent.patch);
        return;
      case "close":
        await closeRows(db, [source.id], intent.after, target.status);
        return;
      case "reopen":
        await reopenRow(db, source.id, intent.after);
        return;
    }
  }

  const { patches, special, batchable } = resolveMultiDrop(sources, target, defs);
  clearSelection();
  if (patches.length) {
    if (batchable && patches.length > 1) await batchPatch(db, patches);
    else for (const p of patches) await patchRow(db, p.id, p.patch);
  }
  const closes = special.flatMap((s) =>
    s.intent.kind === "close" ? [{ id: s.id, after: s.intent.after }] : [],
  );
  const firstClose = closes[0];
  if (firstClose) {
    await closeRows(
      db,
      closes.map((c) => c.id),
      firstClose.after,
      target.status,
    );
  }
  for (const s of special) {
    if (s.intent.kind === "reopen") await reopenRow(db, s.id, s.intent.after);
  }
}

/** One `issues:batchApply` with `update` items (status / priority); reverts all on failure. */
async function batchPatch(
  db: string,
  patches: Array<{ id: string; patch: IssuePatch }>,
): Promise<void> {
  const reverts = patches.map((p) => applyOptimistic(p.id, guessFrom(p.patch)));
  const ids = patches.map((p) => p.id);
  markPending(ids, true);
  try {
    await api.batchApply(db, {
      actor: actor.value,
      items: patches.map((p): ApplyItem => {
        const patch: NonNullable<ApplyItem["update"]>["patch"] = {};
        if (p.patch.status !== undefined) patch.status = p.patch.status;
        if (p.patch.priority !== undefined) patch.priority = p.patch.priority;
        return { kind: "update", update: { target: { id: p.id }, patch } };
      }),
    });
    pushToast("success", t("toast.moved", { count: patches.length }), 3000);
  } catch (err) {
    for (const revert of reverts) revert();
    toastError(err);
  } finally {
    markPending(ids, false);
  }
}

/** Card menu / detail select: move one row to `status` (close / reopen when categories differ). */
export function setStatus(db: string, id: string, status: string): Promise<void> {
  return moveRows(db, [id], { status });
}

export function setPriority(db: string, id: string, priority: number): Promise<void> {
  return moveRows(db, [id], { priority });
}

/** Detail panel: set (or clear with `""`) the parent through the same guarded patch path. */
export function setParent(db: string, id: string, parent: string): Promise<boolean> {
  return patchRow(db, id, { parent_id: parent });
}
