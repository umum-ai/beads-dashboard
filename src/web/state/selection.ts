/** Multi-select of cards (Shift / Ctrl-click) and the current drag, for the board. */
import { signal } from "@preact/signals";

export const selection = signal<ReadonlySet<string>>(new Set());

export function toggleSelected(id: string): void {
  const next = new Set(selection.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selection.value = next;
}

export function clearSelection(): void {
  if (selection.value.size) selection.value = new Set();
}

export function isSelected(id: string): boolean {
  return selection.value.has(id);
}

/** Ids being dragged right now (`null` when nothing is), so empty sections can show as drop zones. */
export const dragging = signal<ReadonlySet<string> | null>(null);

/** Ids with a write in flight: the card renders muted and is not draggable. */
export const pending = signal<ReadonlySet<string>>(new Set());

export function markPending(ids: readonly string[], on: boolean): void {
  const next = new Set(pending.value);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  pending.value = next;
}

/**
 * Lane key each card is currently rendered in (`""` = no-epic lane), kept by `Card` so a drop
 * knows whether the lane changed. Not a signal: it is read only at drop time.
 */
export const cardLanes = new Map<string, string>();
