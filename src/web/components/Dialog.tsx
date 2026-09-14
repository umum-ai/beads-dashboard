/**
 * Modal host for `state/dialogs.ts`: close reason, force close, conflict, plain confirm.
 * Focus lands on the first control and is trapped in the dialog until it closes, then returns
 * to the opener (`lib/focus-trap.ts`); Escape and the backdrop dismiss (answer `null`).
 */
import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { trapFocus } from "../lib/focus-trap.ts";
import { answer, type DialogSpec, dialog, dismiss } from "../state/dialogs.ts";
import { actor } from "../state/meta.ts";

function Frame({
  title,
  testId,
  children,
  onSubmit,
  danger,
}: {
  title: string;
  testId: string;
  children: ComponentChildren;
  onSubmit: () => void;
  danger?: boolean | undefined;
}): JSX.Element {
  const root = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const release = root.current ? trapFocus(root.current) : () => {};
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      release();
    };
  }, []);
  return (
    <div class="modal" data-testid="modal-backdrop">
      <button
        type="button"
        class="modal__backdrop"
        aria-label={t("dialog.cancel")}
        onClick={dismiss}
      />
      <form
        ref={root}
        class={`modal__panel${danger ? " modal__panel--danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        data-testid={testId}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <h2 class="modal__title" id="modal-title">
          {title}
        </h2>
        {children}
      </form>
    </div>
  );
}

function Actor(): JSX.Element {
  return (
    <p class="modal__actor" data-testid="dialog-actor">
      {t("dialog.recordedAs")} <span class="mono">{actor.value}</span>
    </p>
  );
}

function CloseReason({ spec }: { spec: Extract<DialogSpec, { kind: "closeReason" }> }) {
  const [reason, setReason] = useState("");
  const submit = () => answer({ reason: reason.trim() });
  const subject =
    spec.count && spec.count > 1 ? t("dialog.close.many", { count: spec.count }) : spec.title;
  return (
    <Frame title={t("dialog.close.title")} testId="close-dialog" onSubmit={submit}>
      <p class="modal__subject">
        {spec.count && spec.count > 1 ? null : <span class="mono">{spec.id}</span>} {subject}
      </p>
      <label class="modal__label">
        {t("dialog.close.reason")}
        <textarea
          class="input modal__textarea"
          rows={3}
          value={reason}
          placeholder={t("dialog.close.reason.placeholder")}
          data-testid="close-reason"
          onInput={(e) => setReason((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
      </label>
      <Actor />
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" onClick={dismiss}>
          {t("dialog.cancel")}
        </button>
        <button type="submit" class="btn btn--primary" data-testid="close-confirm">
          {t("dialog.close.confirm")}
        </button>
      </div>
    </Frame>
  );
}

function Force({ spec }: { spec: Extract<DialogSpec, { kind: "force" }> }) {
  const body =
    spec.openChildren !== null && spec.openChildren > 0
      ? t("dialog.force.children", { count: spec.openChildren })
      : t("dialog.force.blocker");
  return (
    <Frame
      title={t("dialog.force.title")}
      testId="force-dialog"
      onSubmit={() => answer({ force: true })}
      danger
    >
      <p class="modal__subject">
        <span class="mono">{spec.id}</span> {spec.title}
      </p>
      <p class="modal__body" data-testid="force-body">
        {body}
      </p>
      <Actor />
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" data-autofocus onClick={dismiss}>
          {t("dialog.cancel")}
        </button>
        <button type="submit" class="btn btn--danger" data-testid="force-confirm">
          {t("dialog.force.confirm")}
        </button>
      </div>
    </Frame>
  );
}

function Conflict({ spec }: { spec: Extract<DialogSpec, { kind: "conflict" }> }) {
  return (
    <Frame
      title={t("dialog.conflict.title")}
      testId="conflict-dialog"
      onSubmit={() => answer({ choice: "reload" })}
    >
      <p class="modal__subject">
        <span class="mono">{spec.id}</span> {spec.title}
      </p>
      <p class="modal__body">{t("dialog.conflict.body")}</p>
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" onClick={dismiss}>
          {t("dialog.cancel")}
        </button>
        <button
          type="button"
          class="btn"
          data-testid="conflict-overwrite"
          onClick={() => answer({ choice: "overwrite" })}
        >
          {t("dialog.conflict.overwrite")}
        </button>
        <button type="submit" class="btn btn--primary" data-testid="conflict-reload">
          {t("dialog.conflict.reload")}
        </button>
      </div>
    </Frame>
  );
}

function Confirm({ spec }: { spec: Extract<DialogSpec, { kind: "confirm" }> }) {
  return (
    <Frame
      title={spec.title}
      testId="confirm-dialog"
      onSubmit={() => answer({ confirmed: true })}
      danger={spec.danger}
    >
      <p class="modal__body">{spec.body}</p>
      <Actor />
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" onClick={dismiss}>
          {t("dialog.cancel")}
        </button>
        <button
          type="submit"
          class={`btn ${spec.danger ? "btn--danger" : "btn--primary"}`}
          data-testid="confirm-ok"
        >
          {spec.confirmLabel}
        </button>
      </div>
    </Frame>
  );
}

export function DialogHost(): JSX.Element | null {
  const current = dialog.value;
  if (!current) return null;
  const spec = current.spec;
  switch (spec.kind) {
    case "closeReason":
      return <CloseReason key={spec.id} spec={spec} />;
    case "force":
      return <Force key={spec.id} spec={spec} />;
    case "conflict":
      return <Conflict key={spec.id} spec={spec} />;
    case "confirm":
      return <Confirm key={spec.title} spec={spec} />;
  }
}
