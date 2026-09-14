/**
 * Issue drawer. Loads `GET issues/{id}?include_comments&include_dependents` (the source of
 * `revision`), re-loads silently when a delta touches the row — unless an inline editor is
 * open, in which case the held revision makes a concurrent write show up as the conflict
 * dialog on Save (`detail/editor.ts`). Sub-components: `detail/Fields` (properties),
 * `detail/TextSections` (markdown fields), `detail/Relations` (comments, dependencies),
 * `TreeView` (hierarchy).
 */
import { useSignalEffect } from "@preact/signals";
import type { JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { ApiError, api } from "../lib/api.ts";
import type { BoardIssue, IssueDetails } from "../lib/bff-types.ts";
import { clampPriority, compareCards } from "../lib/board.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { navigate } from "../state/route.ts";
import { board, childrenOf } from "../state/snapshot.ts";
import { describeError } from "../state/toasts.ts";
import { copyId, typeLabel } from "./Card.tsx";
import { statusLabel } from "./Column.tsx";
import { type Editor, useEditor } from "./detail/editor.ts";
import { Fields } from "./detail/Fields.tsx";
import { Comments, Dependencies } from "./detail/Relations.tsx";
import { TextSections } from "./detail/TextSections.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { HierarchySection } from "./TreeView.tsx";

function Title({ d, editor }: { d: IssueDetails; editor: Editor }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.title);
  const input = useRef<HTMLInputElement>(null);
  const start = () => {
    setDraft(d.title);
    setEditing(true);
    editor.beginEdit();
    setTimeout(() => input.current?.select(), 0);
  };
  const stop = () => {
    setEditing(false);
    editor.endEdit();
  };
  const save = async () => {
    const next = draft.trim();
    if (!next || next === d.title) return stop();
    if ((await editor.save({ title: next })) !== "failed") stop();
  };
  if (!editing) {
    return (
      <div class="drawer__titlerow">
        <h2 class="drawer__title" id="drawer-title" data-testid="detail-title">
          {d.title}
        </h2>
        <button
          type="button"
          class="btn btn--ghost drawer__edit"
          data-testid="edit-title"
          onClick={start}
        >
          {t("detail.edit")}
        </button>
      </div>
    );
  }
  return (
    <form
      class="drawer__titleedit"
      data-testid="title-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        ref={input}
        class="input drawer__titleinput"
        type="text"
        value={draft}
        aria-label={t("create.field.title")}
        data-testid="title-input"
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            stop();
          }
        }}
      />
      <button type="button" class="btn btn--ghost" onClick={stop}>
        {t("dialog.cancel")}
      </button>
      <button
        type="submit"
        class="btn btn--primary"
        disabled={editor.saving}
        data-testid="save-title"
      >
        {t("detail.save")}
      </button>
    </form>
  );
}

export function DetailPanel({ db, id }: { db: string; id: string }): JSX.Element {
  const [details, setDetails] = useState<IssueDetails | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const lastStamp = useRef<string | null>(null);
  const pendingReload = useRef(false);

  const close = () => navigate({ kind: "board", db });

  const load = useCallback(
    (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      api
        .issue(db, id)
        .then((d) => {
          setDetails(d);
          setError(null);
        })
        .catch((err) => {
          if (!silent) setError(err);
        })
        .finally(() => setLoading(false));
    },
    [db, id],
  );
  const reload = useCallback(() => load(true), [load]);
  const editor = useEditor(db, id, details, setDetails, reload);
  const editingRef = useRef(0);
  editingRef.current = editor.editing;

  useEffect(() => {
    setDetails(null);
    lastStamp.current = null;
    load();
    closeBtn.current?.focus();
  }, [load]);

  // A delta that changes this row re-reads the details silently — deferred while an editor is
  // open so the save conflicts (and asks) instead of adopting the other writer's revision.
  useSignalEffect(() => {
    const row: BoardIssue | undefined = board.value.issues.get(id);
    const stamp = row ? `${row.updated_at}|${row.status ?? ""}|${row.comment_count ?? 0}` : null;
    if (stamp && lastStamp.current && stamp !== lastStamp.current) {
      if (editingRef.current > 0) pendingReload.current = true;
      else load(true);
    }
    if (stamp) lastStamp.current = stamp;
  });
  useEffect(() => {
    if (editor.editing === 0 && pendingReload.current) {
      pendingReload.current = false;
      load(true);
    }
  }, [editor.editing, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        const target = event.target as HTMLElement | null;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const d = details;
  const children = childrenOf(id).sort(compareCards);
  const priority = d ? clampPriority(d.priority) : null;
  const notFound = error instanceof ApiError && error.status === 404;
  const blocked = board.value.issues.get(id)?.blocked || d?.is_blocked === true;
  const totalChildren = d?.epic_total_children ?? (children.length || undefined);
  const closedChildren =
    d?.epic_closed_children ??
    (children.length ? children.filter((c) => c.status === "closed").length : undefined);

  return (
    <>
      <div class="drawer-backdrop" onClick={close} aria-hidden="true" />
      <aside
        class="drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby="drawer-title"
        data-testid="detail-panel"
        data-id={id}
        aria-busy={editor.saving ? "true" : undefined}
      >
        <header class="drawer__head">
          <button
            type="button"
            class="drawer__id mono"
            title={t("detail.copyId")}
            data-testid="detail-id"
            onClick={() => void copyId(id)}
          >
            {d ? <span aria-hidden="true">{typeGlyph(d.issue_type)}</span> : null}
            {id}
          </button>
          {blocked ? (
            <span
              class="chip chip--blocked"
              title={t("card.blocked.help")}
              data-testid="detail-blocked"
            >
              {t("detail.blocked")}
            </span>
          ) : null}
          {editor.saving ? <span class="drawer__saving">{t("detail.saving")}</span> : null}
          <span class="header__spacer" />
          <button
            type="button"
            class="icon-btn"
            ref={closeBtn}
            aria-label={t("detail.close")}
            title={t("detail.close")}
            data-testid="detail-close"
            onClick={close}
          >
            ×
          </button>
        </header>
        <div class="drawer__body">
          {!d && loading ? (
            <EmptyState loading title={t("detail.loading")} testId="detail-loading" />
          ) : null}
          {!d && error ? (
            <EmptyState
              title={notFound ? t("detail.notFound", { id }) : t("error.generic", { detail: "" })}
              body={notFound ? undefined : describeError(error)}
              action={{ label: t("state.retry"), onClick: () => load() }}
              testId="detail-error"
            />
          ) : null}
          {d ? (
            <>
              <Title d={d} editor={editor} />
              <div class="drawer__badges">
                <span class="chip" data-testid="detail-status">
                  {statusLabel(d.status ?? "open")}
                </span>
                <span class="chip">
                  <span aria-hidden="true">{typeGlyph(d.issue_type)}&nbsp;</span>
                  {typeLabel(d.issue_type)}
                </span>
                {priority !== null ? (
                  <span
                    class="pchip"
                    data-priority={priority}
                    title={t(`priority.name.${priority}`)}
                    data-testid="detail-priority"
                  >
                    {t(`priority.${priority}`)}
                  </span>
                ) : null}
                {totalChildren !== undefined ? (
                  <span class="chip" title={t("detail.field.epicProgress")}>
                    {closedChildren ?? 0} / {totalChildren}
                  </span>
                ) : null}
              </div>

              <Fields db={db} d={d} editor={editor} reload={reload} />
              <TextSections d={d} editor={editor} />
              <HierarchySection db={db} id={id} row={board.value.issues.get(id)} title={d.title} />
              <Dependencies db={db} d={d} reload={reload} />
              <Comments db={db} d={d} reload={reload} />
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
