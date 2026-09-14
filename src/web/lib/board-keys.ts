/**
 * DOM glue for the board's card navigation: read the visible card ids column by column (in DOM
 * order, which is the visual order inside a column) and move focus with `lib/keyboard.ts`.
 */
import { moveFocus } from "./keyboard.ts";

export function cardElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="card"][data-id=${CSS.escape(id)}]`);
}

/** Card ids per status column, as currently rendered. */
export function visibleColumns(): string[][] {
  const out: string[][] = [];
  for (const column of document.querySelectorAll<HTMLElement>('[data-testid="column"]')) {
    const ids: string[] = [];
    for (const card of column.querySelectorAll<HTMLElement>('[data-testid="card"]')) {
      const id = card.dataset.id;
      if (id) ids.push(id);
    }
    out.push(ids);
  }
  return out;
}

/** Handle an arrow/Home/End press on the card `id`; returns whether focus moved. */
export function navigateCards(id: string, key: string): boolean {
  const next = moveFocus(visibleColumns(), id, key);
  if (!next) return false;
  const el = cardElement(next);
  if (!el) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/** Give focus back to a card (after the drawer or a menu closes); false when it is gone. */
export function focusCard(id: string): boolean {
  const el = cardElement(id);
  if (!el) return false;
  el.focus({ preventScroll: true });
  return true;
}
