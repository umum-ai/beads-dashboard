/** Anchored panel that closes on outside click or Escape. The trigger is rendered by the caller. */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  trigger: ComponentChildren;
  children: ComponentChildren;
  align?: "left" | "right" | undefined;
  label?: string | undefined;
  testId?: string | undefined;
}

export function Popover(props: PopoverProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div class="pop" ref={root}>
      {props.trigger}
      {open ? (
        <div
          class={`pop__panel${props.align === "left" ? " pop__panel--left" : ""}`}
          role="dialog"
          aria-label={props.label}
          data-testid={props.testId}
        >
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
