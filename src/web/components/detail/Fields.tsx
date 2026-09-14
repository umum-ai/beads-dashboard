/**
 * Editable properties of the drawer: status, type, priority, assignee (+ claim / release),
 * labels, parent, due / defer dates, estimate, external ref. Scalar controls save on change
 * through `editor.save`; status crossing into or out of the done category goes through the
 * board actions (close dialog, reopen) instead of a bare PATCH.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { locale, t } from "../../i18n/index.ts";
import { ApiError, api } from "../../lib/api.ts";
import type { IssueDetails } from "../../lib/bff-types.ts";
import { clampPriority, PRIORITIES } from "../../lib/board.ts";
import { isDoneStatus } from "../../lib/dnd-intent.ts";
import { formatDateTime } from "../../lib/time.ts";
import { closeRows, reopenRow } from "../../state/actions.ts";
import { actor } from "../../state/meta.ts";
import { detailRoute, navigate } from "../../state/route.ts";
import { allIssues, board } from "../../state/snapshot.ts";
import { pushToast, toastError } from "../../state/toasts.ts";
import { typeLabel } from "../Card.tsx";
import { statusLabel } from "../Column.tsx";
import { IssuePicker } from "../editors/IssuePicker.tsx";
import { LabelsEditor } from "../editors/LabelsEditor.tsx";
import type { Editor } from "./editor.ts";

function toLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function Row({
  label,
  children,
  testId,
}: {
  label: string;
  children: JSX.Element | JSX.Element[] | string | null;
  testId?: string | undefined;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>{children}</dd>
    </>
  );
}

/** Text input that saves on blur / Enter and restores on Escape. */
function TextField(props: {
  value: string;
  onSave: (next: string) => void;
  placeholder?: string | undefined;
  list?: string | undefined;
  mono?: boolean | undefined;
  type?: "text" | "number" | undefined;
  min?: number | undefined;
  testId: string;
  disabled?: boolean | undefined;
  /** Accessible name (the row's `dt` is not associated with the control). */
  label: string;
}): JSX.Element {
  const [draft, setDraft] = useState(props.value);
  const [base, setBase] = useState(props.value);
  if (props.value !== base) {
    setBase(props.value);
    setDraft(props.value);
  }
  const commit = () => {
    if (draft !== props.value) props.onSave(draft);
  };
  return (
    <input
      class={`field-inline${props.mono ? " mono" : ""}`}
      type={props.type ?? "text"}
      min={props.min}
      value={draft}
      list={props.list}
      placeholder={props.placeholder ?? t("detail.empty")}
      aria-label={props.label}
      disabled={props.disabled}
      data-testid={props.testId}
      onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(props.value);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function DateField(props: {
  value: string | undefined | null;
  onSave: (iso: string | null) => void;
  testId: string;
  disabled?: boolean | undefined;
  label: string;
}): JSX.Element {
  return (
    <span class="field-date">
      <input
        class="field-inline"
        type="datetime-local"
        value={toLocalInput(props.value)}
        aria-label={props.label}
        disabled={props.disabled}
        data-testid={props.testId}
        onChange={(e) => props.onSave(fromLocalInput((e.currentTarget as HTMLInputElement).value))}
      />
      {props.value ? (
        <button
          type="button"
          class="icon-btn field-date__clear"
          aria-label={t("detail.clear")}
          title={t("detail.clear")}
          data-testid={`${props.testId}-clear`}
          onClick={() => props.onSave(null)}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

export function Fields({
  db,
  d,
  editor,
  reload,
}: {
  db: string;
  d: IssueDetails;
  editor: Editor;
  reload: () => void;
}): JSX.Element {
  const lang = locale.value;
  const statuses = board.value.statuses;
  const types = board.value.types.length ? board.value.types : [d.issue_type ?? "task"];
  const status = d.status ?? "open";
  const priority = clampPriority(d.priority);
  const busy = editor.saving;
  const me = actor.value;
  const assignees = [...new Set(allIssues.value.map((r) => r.assignee).filter(Boolean))].sort();
  const currentType = d.issue_type ?? "task";

  const onStatus = async (next: string) => {
    if (next === status) return;
    const fromDone = isDoneStatus(statuses, status);
    const toDone = isDoneStatus(statuses, next);
    if (toDone && !fromDone) await closeRows(db, [d.id], null, next);
    else if (fromDone && !toDone)
      await reopenRow(db, d.id, next === "open" ? null : { status: next });
    else await editor.save({ status: next });
    reload();
  };

  const claim = async () => {
    try {
      await api.claimIssue(db, d.id, { actor: me });
      pushToast("success", t("toast.claimed", { actor: me }), 2500);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "already_claimed") {
        const holder = (err.problem as Record<string, unknown>).assignee;
        pushToast("error", t("error.already_claimed", { assignee: String(holder ?? "") }), 5000);
      } else toastError(err);
    }
  };
  const release = async () => {
    try {
      await api.releaseIssue(db, d.id, { actor: me });
      pushToast("success", t("toast.released"), 2500);
      reload();
    } catch (err) {
      toastError(err);
      reload(); // `not_releasable`: the row moved under us, show the current holder
    }
  };

  return (
    <dl class="props props--edit">
      <Row label={t("detail.field.status")} testId="field-status">
        <select
          class="field-select"
          value={status}
          disabled={busy}
          aria-label={t("detail.field.status")}
          data-testid="detail-status-select"
          data-category={statuses.find((s) => s.name === status)?.category ?? "active"}
          onChange={(e) => void onStatus((e.currentTarget as HTMLSelectElement).value)}
        >
          {!statuses.some((s) => s.name === status) ? (
            <option value={status}>{statusLabel(status)}</option>
          ) : null}
          {statuses.map((s) => (
            <option key={s.name} value={s.name}>
              {statusLabel(s.name)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("detail.field.type")}>
        <select
          class="field-select"
          value={currentType}
          disabled={busy}
          aria-label={t("detail.field.type")}
          data-testid="detail-type-select"
          onChange={(e) =>
            void editor.save({ issue_type: (e.currentTarget as HTMLSelectElement).value })
          }
        >
          {!types.includes(currentType) ? (
            <option value={currentType}>{typeLabel(currentType)}</option>
          ) : null}
          {types.map((name) => (
            <option key={name} value={name}>
              {typeLabel(name)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("detail.field.priority")}>
        <select
          class="field-select"
          value={String(priority)}
          disabled={busy}
          data-priority={priority}
          aria-label={t("detail.field.priority")}
          data-testid="detail-priority-select"
          onChange={(e) =>
            void editor.save({ priority: Number((e.currentTarget as HTMLSelectElement).value) })
          }
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={String(p)}>
              {t(`priority.${p}`)} · {t(`priority.name.${p}`)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("detail.field.assignee")} testId="field-assignee">
        <span class="field-group">
          <TextField
            label={t("detail.field.assignee")}
            value={d.assignee ?? ""}
            list="detail-assignees"
            placeholder={t("detail.assignee.none")}
            testId="detail-assignee"
            disabled={busy}
            onSave={(next) => void editor.save({ assignee: next.trim() })}
          />
          <datalist id="detail-assignees">
            {assignees.map((a) => (
              <option key={a} value={a as string} />
            ))}
          </datalist>
          {d.assignee === me ? (
            <button
              type="button"
              class="btn btn--ghost"
              data-testid="detail-release"
              disabled={busy}
              onClick={() => void release()}
            >
              {t("detail.release")}
            </button>
          ) : (
            <button
              type="button"
              class="btn btn--ghost"
              data-testid="detail-claim"
              disabled={busy}
              onClick={() => void claim()}
            >
              {t("detail.claim")}
            </button>
          )}
        </span>
      </Row>
      {d.owner ? (
        <Row label={t("detail.field.owner")}>
          <span>{d.owner}</span>
        </Row>
      ) : null}
      <Row label={t("detail.field.labels")} testId="field-labels">
        <LabelsEditor
          value={d.labels ?? []}
          disabled={busy}
          testId="detail-labels"
          onAdd={(label) => void editor.save({ add_labels: [label] })}
          onRemove={(label) => void editor.save({ remove_labels: [label] })}
        />
      </Row>
      <Row label={t("detail.field.parent")} testId="field-parent">
        <span class="field-group">
          <IssuePicker
            value={d.parent ?? ""}
            exclude={[d.id]}
            compact
            label={t("detail.field.parent")}
            testId="detail-parent"
            disabled={busy}
            onChange={(id) => void editor.save({ parent_id: id })}
          />
          {d.parent ? (
            <button
              type="button"
              class="icon-btn field-open"
              title={t("detail.openParent")}
              aria-label={t("detail.openParent")}
              data-testid="detail-parent-open"
              onClick={() => navigate(detailRoute(db, d.parent as string))}
            >
              ↗
            </button>
          ) : null}
        </span>
      </Row>
      <Row label={t("detail.field.due")}>
        <DateField
          label={t("detail.field.due")}
          value={d.due_at}
          testId="detail-due"
          disabled={busy}
          onSave={(iso) => void editor.save({ due_at: iso })}
        />
      </Row>
      <Row label={t("detail.field.deferUntil")}>
        <DateField
          label={t("detail.field.deferUntil")}
          value={d.defer_until}
          testId="detail-defer"
          disabled={busy}
          onSave={(iso) => void editor.save({ defer_until: iso })}
        />
      </Row>
      <Row label={t("detail.field.estimate")}>
        <span class="field-group">
          <TextField
            label={t("detail.field.estimate")}
            type="number"
            min={0}
            value={d.estimated_minutes ? String(d.estimated_minutes) : ""}
            placeholder={t("detail.empty")}
            testId="detail-estimate"
            disabled={busy}
            onSave={(next) => {
              const n = Number(next);
              void editor.save({
                estimated_minutes: next.trim() === "" || !Number.isFinite(n) ? null : Math.round(n),
              });
            }}
          />
          <span class="muted">{t("detail.field.estimate.unit")}</span>
        </span>
      </Row>
      <Row label={t("detail.field.externalRef")}>
        <TextField
          label={t("detail.field.externalRef")}
          mono
          value={d.external_ref ?? ""}
          testId="detail-external-ref"
          disabled={busy}
          onSave={(next) => void editor.save({ external_ref: next.trim() || null })}
        />
      </Row>
      <Row label={t("detail.field.created")}>
        <span title={d.created_at}>
          {formatDateTime(d.created_at, lang)}
          {d.created_by ? ` · ${d.created_by}` : ""}
        </span>
      </Row>
      <Row label={t("detail.field.updated")}>
        <span title={d.updated_at}>{formatDateTime(d.updated_at, lang)}</span>
      </Row>
      {d.closed_at ? (
        <Row label={t("detail.field.closed")}>
          <span title={d.closed_at}>{formatDateTime(d.closed_at, lang)}</span>
        </Row>
      ) : null}
      {d.close_reason ? (
        <Row label={t("detail.field.closeReason")} testId="detail-close-reason">
          <span>{d.close_reason}</span>
        </Row>
      ) : null}
      <Row label={t("detail.field.revision")}>
        <span class="mono muted" data-testid="detail-revision">
          {d.revision}
        </span>
      </Row>
    </dl>
  );
}
