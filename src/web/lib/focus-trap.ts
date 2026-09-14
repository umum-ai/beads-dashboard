/**
 * Focus management for modal dialogs: keep Tab inside the container, put the initial focus on
 * the first field (or `[data-autofocus]`), and give focus back to the element that had it
 * when the dialog closes.
 */
import { useEffect } from "preact/hooks";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getClientRects().length > 0,
  );
}

/** The control a freshly opened dialog should focus. */
export function initialFocusTarget(root: HTMLElement): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>("[data-autofocus]") ??
    root.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ??
    root.querySelector<HTMLElement>("button.btn--primary, button.btn--danger") ??
    focusableIn(root)[0] ??
    null
  );
}

/**
 * Where focus should go when a dialog closes and the element that opened it is gone (a menu
 * item that opened the dialog is unmounted with its menu): the menu leaves its own origin here.
 */
let fallbackOrigin: HTMLElement | null = null;

export function noteFocusOrigin(el: HTMLElement | null): void {
  fallbackOrigin = el;
}

/**
 * Trap focus in `root` until the returned cleanup runs, which restores focus to the opener —
 * the element focused when the trap was installed, or `restoreTo`; when that element has been
 * removed meanwhile, the origin noted by `noteFocusOrigin`.
 */
export function trapFocus(root: HTMLElement, restoreTo?: HTMLElement | null): () => void {
  const opener = restoreTo ?? (document.activeElement as HTMLElement | null);
  fallbackOrigin = null;
  initialFocusTarget(root)?.focus();
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const items = focusableIn(root);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (!root.contains(event.target as Node)) (focusableIn(root)[0] ?? root).focus();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocusIn);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocusIn);
    // The menu that opened this dialog may have unmounted after the trap was installed and
    // noted its origin meanwhile, so the fallback is read now, not at install time.
    const fallback = fallbackOrigin;
    fallbackOrigin = null;
    const target = [opener, fallback].find(
      (el) => el && document.contains(el) && el !== document.body,
    );
    target?.focus();
  };
}

/** Hook form of `trapFocus` for a dialog rendered while `ref.current` exists. */
export function useFocusTrap(ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    return trapFocus(root);
  }, [ref]);
}
