/**
 * Pure resolver for drag-and-drop: given where a card came from and where it was dropped,
 * decide which writes the board makes (plan 3.3). No I/O, no signals — unit-tested directly.
 *
 * - same column, other priority section → `PATCH priority`
 * - other status column (non-done) → `PATCH status` (+ `priority` when the section differs)
 * - into a done-category column → `POST :close` (reason dialog), then `PATCH` the rest if any
 * - out of a done-category column → `POST :reopen`, then `PATCH status` when the target is not
 *   `open` (+ priority / parent in the same patch)
 * - onto another lane → `parent_id` = the lane's epic (`""` for the "no epic" lane, the drilled
 *   epic for its "directly in" lane); a card dropped inside its own lane keeps its parent
 */
import type { IssuePatch, StatusDef } from "./bff-types.ts";

export interface DragSource {
  id: string;
  status: string;
  priority: number;
  /** Key of the swimlane the card is shown in (`""` = no-epic lane); `null` on the flat board. */
  lane: string | null;
}

export interface DropLane {
  /** Lane key as rendered: the epic id, or `""` for the "no epic" / "directly in" lane. */
  key: string;
  /** Parent to set when a card lands here: the lane's epic, the drilled epic, or `""` to clear. */
  parentId: string;
}

export interface DropTarget {
  /** Status column the card landed in; `undefined` when only the lane changed. */
  status?: string | undefined;
  /** Priority section; `undefined` for a lane header or a column without sections. */
  priority?: number | undefined;
  /** Swimlane the card landed in; `undefined` when lanes are not involved. */
  lane?: DropLane | undefined;
}

export type DropIntent =
  | { kind: "none" }
  | { kind: "patch"; patch: IssuePatch }
  | { kind: "close"; after: IssuePatch | null }
  | { kind: "reopen"; after: IssuePatch | null };

export function categoryOf(statuses: readonly StatusDef[], status: string): StatusDef["category"] {
  return statuses.find((s) => s.name === status)?.category ?? "active";
}

export function isDoneStatus(statuses: readonly StatusDef[], status: string): boolean {
  return categoryOf(statuses, status) === "done";
}

/** Resolve one card's drop into an intent. */
export function resolveDrop(
  source: DragSource,
  target: DropTarget,
  statuses: readonly StatusDef[],
): DropIntent {
  const patch: IssuePatch = {};
  const statusChanged = target.status !== undefined && target.status !== source.status;
  if (target.priority !== undefined && target.priority !== source.priority) {
    patch.priority = target.priority;
  }
  if (target.lane !== undefined && source.lane !== null && target.lane.key !== source.lane) {
    if (target.lane.parentId === source.id) return { kind: "none" }; // not its own parent
    patch.parent_id = target.lane.parentId;
  }

  if (!statusChanged) {
    return Object.keys(patch).length ? { kind: "patch", patch } : { kind: "none" };
  }
  const targetStatus = target.status as string;
  const fromDone = isDoneStatus(statuses, source.status);
  const toDone = isDoneStatus(statuses, targetStatus);
  const rest = Object.keys(patch).length ? patch : null;

  if (toDone && !fromDone) return { kind: "close", after: rest };
  if (fromDone && !toDone) {
    const after: IssuePatch = { ...(rest ?? {}) };
    if (targetStatus !== "open") after.status = targetStatus;
    return { kind: "reopen", after: Object.keys(after).length ? after : null };
  }
  // active/wip/frozen ↔ active/wip/frozen, or done → done (another done status): plain patch
  return { kind: "patch", patch: { ...patch, status: targetStatus } };
}

/**
 * Resolve a multi-card drop. Cards whose intent is a plain patch are grouped for one
 * `issues:batchApply`; close / reopen intents are returned per card so the caller can run the
 * dialogs. `batchable` is false when any patch touches `parent_id` (batch-apply has no
 * `parent_id` member; it is applied as single guarded patches instead).
 */
export function resolveMultiDrop(
  sources: readonly DragSource[],
  target: DropTarget,
  statuses: readonly StatusDef[],
): {
  patches: Array<{ id: string; patch: IssuePatch }>;
  special: Array<{ id: string; intent: DropIntent }>;
  batchable: boolean;
} {
  const patches: Array<{ id: string; patch: IssuePatch }> = [];
  const special: Array<{ id: string; intent: DropIntent }> = [];
  let batchable = true;
  for (const source of sources) {
    const intent = resolveDrop(source, target, statuses);
    if (intent.kind === "none") continue;
    if (intent.kind === "patch") {
      patches.push({ id: source.id, patch: intent.patch });
      if (intent.patch.parent_id !== undefined) batchable = false;
    } else special.push({ id: source.id, intent });
  }
  return { patches, special, batchable };
}
