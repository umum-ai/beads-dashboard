/**
 * Comments (list + add form, `author` = actor) and blocking dependencies ("Depends on" /
 * "Blocks", add through the issue picker with `POST dependencies/add` type `blocks`, remove with
 * `dependencies/remove`). `dependency_cycle` / `dependency_exists` surface as toasts by code.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { locale, t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { IssueDetails } from "../../lib/bff-types.ts";
import { typeGlyph } from "../../lib/issue-meta.ts";
import { renderMarkdown } from "../../lib/markdown.ts";
import { formatDateTime } from "../../lib/time.ts";
import { actor } from "../../state/meta.ts";
import { navigate } from "../../state/route.ts";
import { pushToast, toastError } from "../../state/toasts.ts";
import { statusLabel } from "../Column.tsx";
import { IssuePicker } from "../editors/IssuePicker.tsx";
import { MarkdownEditor } from "../editors/MarkdownEditor.tsx";

interface RelatedRow {
  id: string;
  title: string;
  status?: string | undefined;
  issue_type?: string | undefined;
  dependency_type?: string | undefined;
}

export function Comments({
  db,
  d,
  reload,
}: {
  db: string;
  d: IssueDetails;
  reload: () => void;
}): JSX.Element {
  const lang = locale.value;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.addComment(db, d.id, { author: actor.value, text: body });
      setText("");
      reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const count = d.comments?.length ?? d.comment_count ?? 0;
  return (
    <section class="drawer__section" data-testid="section-comments">
      <h3 class="drawer__h">{t("detail.section.comments", { count })}</h3>
      {d.comments_omitted ? <p class="empty-note">{t("detail.comments.omitted")}</p> : null}
      {d.comments?.length ? (
        <div data-testid="detail-comments">
          {d.comments.map((c) => (
            <article key={c.id} class="comment" data-testid="comment">
              <div class="comment__head">
                <span class="comment__author">{c.author}</span>
                <span title={c.created_at}>{formatDateTime(c.created_at, lang)}</span>
              </div>
              <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.text) }} />
            </article>
          ))}
        </div>
      ) : !d.comments_omitted ? (
        <p class="empty-note">{t("detail.comments.none")}</p>
      ) : null}
      <form
        class="comment-form"
        data-testid="comment-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <MarkdownEditor
          value={text}
          onChange={setText}
          onSubmit={() => void submit()}
          rows={3}
          label={t("detail.comment.add")}
          placeholder={t("detail.comment.placeholder")}
          testId="comment-editor"
        />
        <div class="text-section__actions">
          <span class="modal__actor">
            {t("dialog.recordedAs")} <span class="mono">{actor.value}</span>
          </span>
          <button
            type="submit"
            class="btn btn--primary"
            disabled={busy || !text.trim()}
            data-testid="comment-submit"
          >
            {t("detail.comment.add")}
          </button>
        </div>
      </form>
    </section>
  );
}

function RelList({
  db,
  rows,
  testId,
  onRemove,
}: {
  db: string;
  rows: RelatedRow[];
  testId: string;
  onRemove: (row: RelatedRow) => void;
}): JSX.Element | null {
  if (!rows.length) return null;
  return (
    <ul class="rel-list" data-testid={testId}>
      {rows.map((row) => (
        <li key={`${row.dependency_type ?? ""}:${row.id}`} class="rel-row" data-id={row.id}>
          <button
            type="button"
            class="rel"
            onClick={() => navigate({ kind: "issue", db, issueId: row.id })}
          >
            <span aria-hidden="true">{typeGlyph(row.issue_type)}</span>
            <span class="mono">{row.id}</span>
            <span class="rel__title ellipsis" title={row.title}>
              {row.title}
            </span>
            {row.dependency_type && row.dependency_type !== "blocks" ? (
              <span class="rel__kind">{row.dependency_type}</span>
            ) : null}
            <span class="rel__status">{statusLabel(row.status ?? "open")}</span>
          </button>
          <button
            type="button"
            class="icon-btn rel-row__x"
            aria-label={t("detail.dep.remove", { id: row.id })}
            title={t("detail.dep.remove", { id: row.id })}
            data-testid="dep-remove"
            onClick={() => onRemove(row)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * `dependsOn`: edges where this issue is the source (`issue_id = this`), so removing one sends
 * `{issue_id: this, depends_on_id: row}`; `blocks`: this issue is the target.
 */
export function Dependencies({
  db,
  d,
  reload,
}: {
  db: string;
  d: IssueDetails;
  reload: () => void;
}): JSX.Element {
  const [adding, setAdding] = useState<"dependsOn" | "blocks" | null>(null);
  const [busy, setBusy] = useState(false);
  const dependsOn = (d.dependencies ?? []).filter((x) => x.dependency_type !== "parent-child");
  const blocks = (d.dependents ?? []).filter((x) => x.dependency_type !== "parent-child");
  const related = [
    d.id,
    ...dependsOn.map((x) => x.id),
    ...blocks.map((x) => x.id),
    ...(d.parent ? [d.parent] : []),
  ];

  const run = async (op: () => Promise<unknown>, okText: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await op();
      pushToast("success", okText, 2000);
      setAdding(null);
      reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const add = (kind: "dependsOn" | "blocks", other: string) => {
    if (!other) return;
    const edge =
      kind === "dependsOn"
        ? { issue_id: d.id, depends_on_id: other }
        : { issue_id: other, depends_on_id: d.id };
    void run(
      () => api.depAdd(db, { actor: actor.value, edges: [{ ...edge, type: "blocks" }] }),
      t("toast.depAdded"),
    );
  };
  const remove = (kind: "dependsOn" | "blocks", row: RelatedRow) => {
    const edge =
      kind === "dependsOn"
        ? { issue_id: d.id, depends_on_id: row.id }
        : { issue_id: row.id, depends_on_id: d.id };
    void run(() => api.depRemove(db, { actor: actor.value, ...edge }), t("toast.depRemoved"));
  };

  const block = (
    kind: "dependsOn" | "blocks",
    title: string,
    rows: RelatedRow[],
    testId: string,
  ) => (
    <section class="drawer__section" data-testid={`section-${kind}`}>
      <div class="text-section__head">
        <h3 class="drawer__h">{title}</h3>
        {adding === kind ? null : (
          <button
            type="button"
            class="btn btn--ghost"
            data-testid={`add-${kind}`}
            disabled={busy}
            onClick={() => setAdding(kind)}
          >
            {t("detail.dep.add")}
          </button>
        )}
      </div>
      <RelList db={db} rows={rows} testId={testId} onRemove={(row) => remove(kind, row)} />
      {rows.length === 0 && adding !== kind ? (
        <p class="empty-note">{t("detail.dep.none")}</p>
      ) : null}
      {adding === kind ? (
        <div class="field-group" data-testid={`picker-${kind}`}>
          <IssuePicker
            value=""
            exclude={related}
            label={t("detail.dep.pick")}
            placeholder={t("detail.dep.pick")}
            testId={`dep-picker-${kind}`}
            onChange={(id) => add(kind, id)}
            autoFocus
          />
          <button type="button" class="btn btn--ghost" onClick={() => setAdding(null)}>
            {t("dialog.cancel")}
          </button>
        </div>
      ) : null}
    </section>
  );

  return (
    <>
      {block(
        "dependsOn",
        t("detail.section.dependencies", { count: dependsOn.length }),
        dependsOn,
        "detail-dependencies",
      )}
      {block(
        "blocks",
        t("detail.section.dependents", { count: blocks.length }),
        blocks,
        "detail-dependents",
      )}
    </>
  );
}
