/**
 * Keyboard model of the board, kept pure so it is unit-tested without a DOM:
 * - `resolveShortcut` maps a key press on the page to a global action (`/`, `n`, `?`, Escape);
 * - `moveFocus` decides which card gets focus when an arrow key is pressed on a card, given
 *   the board as a list of columns (each a list of card ids in visual order).
 *
 * The DOM glue (`lib/board-keys.ts`, `Card.tsx`) only collects the ids and applies the result.
 */

export type ShortcutAction = "focusSearch" | "newIssue" | "help" | "escape";

/** DOM id of the toolbar's quick-filter input (`/` focuses it). */
export const QUICK_FILTER_ID = "quick-filter";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Tag names whose focused instances swallow single-key shortcuts. */
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isEditableTarget(target: { tagName?: string; isContentEditable?: boolean } | null) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return FIELD_TAGS.has(target.tagName ?? "");
}

/**
 * Global shortcuts. Escape is always reported (the caller decides whether anything is open);
 * the letter shortcuts fire only outside text fields and without Ctrl/Meta/Alt.
 */
export function resolveShortcut(event: KeyLike, inField: boolean): ShortcutAction | null {
  if (event.key === "Escape") return "escape";
  if (inField || event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "/":
      return "focusSearch";
    case "?":
      return "help";
    case "n":
    case "N":
      return event.shiftKey ? null : "newIssue";
    default:
      return null;
  }
}

export interface CardPosition {
  column: number;
  row: number;
}

/** Locate `id` in `columns`; `null` when absent. */
export function findCard(columns: readonly (readonly string[])[], id: string): CardPosition | null {
  for (let column = 0; column < columns.length; column++) {
    const row = columns[column]?.indexOf(id) ?? -1;
    if (row !== -1) return { column, row };
  }
  return null;
}

/**
 * Arrow-key navigation: Up/Down stay in the column (clamped), Left/Right go to the nearest
 * non-empty column in that direction keeping the row (clamped to its length). Home/End jump to
 * the first/last card of the column. Returns the id to focus, or `null` when the key is not a
 * navigation key or nothing changes.
 */
export function moveFocus(
  columns: readonly (readonly string[])[],
  current: string,
  key: string,
): string | null {
  const pos = findCard(columns, current);
  if (!pos) return null;
  const col = columns[pos.column] ?? [];
  let next: CardPosition | null = null;
  switch (key) {
    case "ArrowDown":
      next = { column: pos.column, row: Math.min(pos.row + 1, col.length - 1) };
      break;
    case "ArrowUp":
      next = { column: pos.column, row: Math.max(pos.row - 1, 0) };
      break;
    case "Home":
      next = { column: pos.column, row: 0 };
      break;
    case "End":
      next = { column: pos.column, row: col.length - 1 };
      break;
    case "ArrowRight":
    case "ArrowLeft": {
      const step = key === "ArrowRight" ? 1 : -1;
      for (let c = pos.column + step; c >= 0 && c < columns.length; c += step) {
        const target = columns[c] ?? [];
        if (target.length > 0) {
          next = { column: c, row: Math.min(pos.row, target.length - 1) };
          break;
        }
      }
      break;
    }
    default:
      return null;
  }
  if (!next) return null;
  const id = columns[next.column]?.[next.row];
  return id === undefined || id === current ? null : id;
}
