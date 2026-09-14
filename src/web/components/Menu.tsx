/**
 * Small floating menu rendered in a portal (fixed position next to its trigger), so it escapes
 * columns that clip overflow. Closes on outside pointerdown, Escape, or after an item is chosen.
 * Arrow keys move between items.
 */
import type { ComponentChildren, JSX } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObjectLike;
  label: string;
  testId?: string | undefined;
  children: ComponentChildren;
  width?: number | undefined;
}

export interface RefObjectLike {
  current: HTMLElement | null;
}

export function Menu(props: MenuProps): JSX.Element | null {
  const { open, onClose, anchor } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = props.width ?? 220;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const height = panel.current?.offsetHeight ?? 240;
    const below = rect.bottom + 4;
    const top =
      below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    setPos({ top, left });
  }, [open, anchor, props.width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next =
          event.key === "ArrowDown"
            ? items[(index + 1) % items.length]
            : items[(index - 1 + items.length) % items.length];
        next?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panel}
      class="menu"
      role="menu"
      aria-label={props.label}
      data-testid={props.testId}
      style={
        pos
          ? { top: `${pos.top}px`, left: `${pos.left}px`, width: `${props.width ?? 220}px` }
          : { visibility: "hidden" }
      }
    >
      {props.children}
    </div>,
    document.body,
  );
}

export function MenuItem(props: {
  onSelect: () => void;
  children: ComponentChildren;
  current?: boolean | undefined;
  disabled?: boolean | undefined;
  testId?: string | undefined;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      class={`menu__item${props.current ? " menu__item--current" : ""}`}
      aria-current={props.current ? "true" : undefined}
      disabled={props.disabled}
      data-testid={props.testId}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect();
      }}
    >
      {props.children}
    </button>
  );
}

export function MenuGroup(props: { title: string; children: ComponentChildren }): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset inside role=menu would add form semantics
    <div class="menu__group" role="group" aria-label={props.title}>
      <p class="menu__title">{props.title}</p>
      {props.children}
    </div>
  );
}
