/**
 * Modal dialogs as promises. A caller `ask`s and awaits the answer; `components/Dialog.tsx`
 * renders the current request. Only one dialog is open at a time (a second request queues).
 */
import { signal } from "@preact/signals";

export type DialogSpec =
  | {
      kind: "closeReason";
      id: string;
      title: string;
      /** Several cards dropped at once: the dialog says "N issues" and the reason applies to all. */
      count?: number | undefined;
    }
  | {
      kind: "force";
      id: string;
      title: string;
      /** Number of open children, or null when the refusal came from a live blocker. */
      openChildren: number | null;
    }
  | { kind: "conflict"; id: string; title: string }
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirmLabel: string;
      danger?: boolean | undefined;
    };

export type DialogAnswer<S extends DialogSpec> = S extends { kind: "closeReason" }
  ? { reason: string }
  : S extends { kind: "force" }
    ? { force: true }
    : S extends { kind: "conflict" }
      ? { choice: "reload" | "overwrite" }
      : { confirmed: true };

export interface DialogRequest {
  spec: DialogSpec;
  resolve: (answer: unknown) => void;
}

export const dialog = signal<DialogRequest | null>(null);
const queue: DialogRequest[] = [];

/** Open a dialog; resolves with the answer, or `null` when dismissed (Cancel / Escape). */
export function ask<S extends DialogSpec>(spec: S): Promise<DialogAnswer<S> | null> {
  return new Promise((resolve) => {
    const request: DialogRequest = { spec, resolve: (a) => resolve(a as DialogAnswer<S> | null) };
    if (dialog.value) queue.push(request);
    else dialog.value = request;
  });
}

/** Called by the component: answer the current dialog and show the next queued one. */
export function answer(value: unknown): void {
  const current = dialog.value;
  if (!current) return;
  dialog.value = queue.shift() ?? null;
  current.resolve(value);
}

export function dismiss(): void {
  answer(null);
}
