/** Transient notifications. Errors are translated by problem `code` when a key exists. */
import { signal } from "@preact/signals";
import { t, tOr } from "../i18n/index.ts";
import { ApiError } from "../lib/api.ts";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

export function pushToast(kind: ToastKind, text: string, ttlMs = 4000): void {
  const toast: Toast = { id: nextId++, kind, text };
  toasts.value = [...toasts.value, toast];
  if (ttlMs > 0) setTimeout(() => dismissToast(toast.id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/** Human text for an error: `error.<code>` when translated, else the problem detail. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = err.problem.detail ?? err.problem.title ?? err.code;
    return tOr(`error.${err.code}`, t("error.generic", { detail }), { detail });
  }
  const detail = err instanceof Error ? err.message : String(err);
  return t("error.generic", { detail });
}

export function toastError(err: unknown): void {
  pushToast("error", describeError(err), 6000);
}
