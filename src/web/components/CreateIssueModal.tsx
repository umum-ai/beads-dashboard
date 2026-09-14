/**
 * "New issue" modal (`state/create.ts`): title, type, priority, status, assignee, labels, parent,
 * description. `POST issues` with the actor; on success the drawer opens on the new issue.
 */
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import type { CreateIssueBody } from "../lib/bff-types.ts";
import { PRIORITIES } from "../lib/board.ts";
import { trapFocus } from "../lib/focus-trap.ts";
import { closeCreate, createRequest } from "../state/create.ts";
import { actor } from "../state/meta.ts";
import { navigate } from "../state/route.ts";
import { allIssues, board } from "../state/snapshot.ts";
import { describeError, pushToast } from "../state/toasts.ts";
import { typeLabel } from "./Card.tsx";
import { statusLabel } from "./Column.tsx";
import { IssuePicker } from "./editors/IssuePicker.tsx";
import { LabelsEditor } from "./editors/LabelsEditor.tsx";
import { MarkdownEditor } from "./editors/MarkdownEditor.tsx";

export function CreateIssueModal({ db }: { db: string }): JSX.Element | null {
  const request = createRequest.value;
  if (!request) return null;
  return <CreateForm key={JSON.stringify(request)} db={db} prefill={request} />;
}

function CreateForm({
  db,
  prefill,
}: {
  db: string;
  prefill: {
    status?: string | undefined;
    parent?: string | undefined;
    priority?: number | undefined;
    type?: string | undefined;
  };
}): JSX.Element {
  const statuses = board.value.statuses;
  const types = board.value.types.length ? board.value.types : ["task"];
  const [title, setTitle] = useState("");
  const [type, setType] = useState(
    prefill.type && types.includes(prefill.type)
      ? prefill.type
      : types.includes("task")
        ? "task"
        : (types[0] as string),
  );
  const [priority, setPriority] = useState(prefill.priority ?? 2);
  const [status, setStatus] = useState(prefill.status ?? "open");
  const [assignee, setAssignee] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [parent, setParent] = useState(prefill.parent ?? "");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const release = formRef.current ? trapFocus(formRef.current) : () => {};
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeCreate();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      release();
    };
  }, []);

  const assignees = [...new Set(allIssues.value.map((r) => r.assignee).filter(Boolean))].sort();

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError(t("create.titleRequired"));
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const body: CreateIssueBody = {
      actor: actor.value,
      title: trimmed,
      issue_type: type,
      priority,
      status,
    };
    if (assignee.trim()) body.assignee = assignee.trim();
    if (labels.length) body.labels = labels;
    if (parent) body.parent_id = parent;
    if (description.trim()) body.description = description;
    try {
      const created = await api.createIssue(db, body);
      closeCreate();
      pushToast("success", t("create.done", { id: created.id }), 3000);
      navigate({ kind: "issue", db, issueId: created.id });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="modal" data-testid="modal-backdrop">
      <button
        type="button"
        class="modal__backdrop"
        aria-label={t("dialog.cancel")}
        onClick={closeCreate}
      />
      <form
        ref={formRef}
        class="modal__panel modal__panel--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        data-testid="create-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 class="modal__title" id="create-title">
          {t("create.title")}
        </h2>
        <label class="field">
          <span class="field__label">{t("create.field.title")}</span>
          <input
            ref={titleRef}
            class="input field__input"
            type="text"
            value={title}
            required
            data-testid="create-title"
            onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="field-row">
          <label class="field">
            <span class="field__label">{t("detail.field.type")}</span>
            <select
              class="select"
              value={type}
              data-testid="create-type"
              onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value)}
            >
              {types.map((name) => (
                <option key={name} value={name}>
                  {typeLabel(name)}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">{t("detail.field.priority")}</span>
            <select
              class="select"
              value={String(priority)}
              data-testid="create-priority"
              onChange={(e) => setPriority(Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={String(p)}>
                  {t(`priority.${p}`)} · {t(`priority.name.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field__label">{t("detail.field.status")}</span>
            <select
              class="select"
              value={status}
              data-testid="create-status"
              onChange={(e) => setStatus((e.currentTarget as HTMLSelectElement).value)}
            >
              {statuses.map((s) => (
                <option key={s.name} value={s.name}>
                  {statusLabel(s.name)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div class="field-row">
          <label class="field">
            <span class="field__label">{t("detail.field.assignee")}</span>
            <input
              class="input field__input"
              type="text"
              list="create-assignees"
              value={assignee}
              data-testid="create-assignee"
              onInput={(e) => setAssignee((e.currentTarget as HTMLInputElement).value)}
            />
            <datalist id="create-assignees">
              {assignees.map((a) => (
                <option key={a} value={a as string} />
              ))}
            </datalist>
          </label>
          <div class="field">
            <span class="field__label">{t("detail.field.parent")}</span>
            <IssuePicker
              value={parent}
              onChange={setParent}
              label={t("detail.field.parent")}
              testId="create-parent"
            />
          </div>
        </div>
        <div class="field">
          <span class="field__label">{t("detail.field.labels")}</span>
          <LabelsEditor
            value={labels}
            onAdd={(l) => setLabels([...labels, l])}
            onRemove={(l) => setLabels(labels.filter((x) => x !== l))}
            testId="create-labels"
          />
        </div>
        <div class="field">
          <span class="field__label">{t("detail.section.description")}</span>
          <MarkdownEditor
            value={description}
            onChange={setDescription}
            onSubmit={() => void submit()}
            rows={6}
            label={t("detail.section.description")}
            testId="create-description"
          />
        </div>
        {error ? (
          <p class="modal__error" role="alert" data-testid="create-error">
            {error}
          </p>
        ) : null}
        <p class="modal__actor">
          {t("dialog.recordedAs")} <span class="mono">{actor.value}</span>
        </p>
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" onClick={closeCreate}>
            {t("dialog.cancel")}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            disabled={busy}
            data-testid="create-submit"
          >
            {busy ? t("create.creating") : t("create.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}
