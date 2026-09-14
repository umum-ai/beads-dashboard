/** Toast stack at the bottom of the viewport; errors are announced assertively. */
import type { JSX } from "preact";
import { t } from "../i18n/index.ts";
import { dismissToast, toasts } from "../state/toasts.ts";

export function Toasts(): JSX.Element {
  return (
    <div class="toasts" data-testid="toasts">
      {toasts.value.map((toast) => (
        <output
          key={toast.id}
          class={`toast toast--${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
          data-kind={toast.kind}
        >
          <span>{toast.text}</span>
          <button
            type="button"
            class="toast__close"
            aria-label={t("toast.dismiss")}
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </output>
      ))}
    </div>
  );
}
