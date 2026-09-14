/**
 * Read-only issue drawer. Loads `GET issues/{id}?include_comments&include_dependents`, renders
 * every field, markdown texts, relations and comments. Re-loads when a delta touches the row.
 * Editing arrives in stage 5.
 */
import { useSignalEffect } from "@preact/signals";
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale, t } from "../i18n/index.ts";
import { ApiError, api } from "../lib/api.ts";
import type { BoardIssue, IssueDetails } from "../lib/bff-types.ts";
import { clampPriority, compareCards } from "../lib/board.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { formatDate, formatDateTime } from "../lib/time.ts";
import { navigate } from "../state/route.ts";
import { board, childrenOf } from "../state/snapshot.ts";
import { describeError } from "../state/toasts.ts";
import { copyId, typeLabel } from "./Card.tsx";
import { statusLabel } from "./Column.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { HierarchySection } from "./TreeView.tsx";

interface RelatedRow {
  id: string;
  title: string;
  status?: string | undefined;
  issue_type?: string | undefined;
  kind?: string | undefined;
}

function RelatedList({ db, rows, testId }: { db: string; rows: RelatedRow[]; testId: string }) {
  return (
    <ul class="rel-list" data-testid={testId}>
      {rows.map((row) => (
        <li key={`${row.kind ?? ""}:${row.id}`}>
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
            {row.kind && row.kind !== "parent-child" ? (
              <span class="rel__kind">{row.kind}</span>
            ) : null}
            <span class="rel__status">{statusLabel(row.status ?? "open")}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Prop({
  label,
  value,
  mono,
}: {
  label: string;
  value: JSX.Element | string | number | null | undefined;
  mono?: boolean | undefined;
}): JSX.Element {
  const empty = value === undefined || value === null || value === "";
  return (
    <>
      <dt>{label}</dt>
      <dd class={`${empty ? "muted" : ""}${mono ? " mono" : ""}`.trim()}>
        {empty ? t("detail.empty") : value}
      </dd>
    </>
  );
}

function MarkdownSection({ title, source }: { title: string; source: string | undefined }) {
  if (!source) return null;
  return (
    <section class="drawer__section">
      <h3 class="drawer__h">{title}</h3>
      <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
    </section>
  );
}

export function DetailPanel({ db, id }: { db: string; id: string }): JSX.Element {
  const [details, setDetails] = useState<IssueDetails | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const lastStamp = useRef<string | null>(null);

  const close = () => navigate({ kind: "board", db });

  const load = (silent = false) => {
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
  };

  useEffect(() => {
    setDetails(null);
    lastStamp.current = null;
    load();
    closeBtn.current?.focus();
  }, [db, id]);

  // A delta that changes this row (updated_at or status) re-reads the details silently.
  useSignalEffect(() => {
    const row: BoardIssue | undefined = board.value.issues.get(id);
    const stamp = row ? `${row.updated_at}|${row.status ?? ""}|${row.comment_count ?? 0}` : null;
    if (stamp && lastStamp.current && stamp !== lastStamp.current) load(true);
    if (stamp) lastStamp.current = stamp;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const lang = locale.value;
  const d = details;
  const children = childrenOf(id).sort(compareCards);
  // bd lists `parent-child` edges among dependencies/dependents; the drawer shows those through
  // the Parent field and the Children section, so the blocking lists keep the other kinds only.
  const dependsOn = (d?.dependencies ?? []).filter((x) => x.dependency_type !== "parent-child");
  const blocks = (d?.dependents ?? []).filter((x) => x.dependency_type !== "parent-child");
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
              <h2 class="drawer__title" id="drawer-title" data-testid="detail-title">
                {d.title}
              </h2>
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
                  >
                    {t(`priority.${priority}`)}
                  </span>
                ) : null}
                {(d.labels ?? []).map((label) => (
                  <span key={label} class="chip chip--label" title={label}>
                    {label}
                  </span>
                ))}
              </div>
              <dl class="props">
                <Prop label={t("detail.field.assignee")} value={d.assignee} />
                {d.owner ? <Prop label={t("detail.field.owner")} value={d.owner} /> : null}
                <Prop
                  label={t("detail.field.parent")}
                  value={
                    d.parent ? (
                      <button
                        type="button"
                        class="btn btn--ghost mono"
                        style="height: 22px; padding: 0 6px"
                        data-testid="detail-parent"
                        onClick={() => navigate({ kind: "issue", db, issueId: d.parent as string })}
                      >
                        {d.parent}
                      </button>
                    ) : null
                  }
                />
                {totalChildren !== undefined ? (
                  <Prop
                    label={t("detail.field.epicProgress")}
                    value={`${closedChildren ?? 0} / ${totalChildren}`}
                  />
                ) : null}
                <Prop
                  label={t("detail.field.created")}
                  value={
                    <span title={d.created_at}>
                      {formatDateTime(d.created_at, lang)}
                      {d.created_by ? ` · ${d.created_by}` : ""}
                    </span>
                  }
                />
                <Prop
                  label={t("detail.field.updated")}
                  value={<span title={d.updated_at}>{formatDateTime(d.updated_at, lang)}</span>}
                />
                {d.closed_at ? (
                  <Prop
                    label={t("detail.field.closed")}
                    value={<span title={d.closed_at}>{formatDateTime(d.closed_at, lang)}</span>}
                  />
                ) : null}
                {d.close_reason ? (
                  <Prop label={t("detail.field.closeReason")} value={d.close_reason} />
                ) : null}
                {d.due_at ? (
                  <Prop label={t("detail.field.due")} value={formatDate(d.due_at, lang)} />
                ) : null}
                {d.defer_until ? (
                  <Prop
                    label={t("detail.field.deferUntil")}
                    value={formatDate(d.defer_until, lang)}
                  />
                ) : null}
                {d.estimated_minutes ? (
                  <Prop
                    label={t("detail.field.estimate")}
                    value={t("detail.field.estimate.minutes", { minutes: d.estimated_minutes })}
                  />
                ) : null}
                {d.external_ref ? (
                  <Prop label={t("detail.field.externalRef")} value={d.external_ref} mono />
                ) : null}
                <Prop label={t("detail.field.revision")} value={d.revision} mono />
              </dl>

              <MarkdownSection title={t("detail.section.description")} source={d.description} />
              <MarkdownSection title={t("detail.section.design")} source={d.design} />
              <MarkdownSection
                title={t("detail.section.acceptance")}
                source={d.acceptance_criteria}
              />
              <MarkdownSection title={t("detail.section.notes")} source={d.notes} />

              <HierarchySection db={db} id={id} row={board.value.issues.get(id)} title={d.title} />

              {dependsOn.length ? (
                <section class="drawer__section">
                  <h3 class="drawer__h">
                    {t("detail.section.dependencies", { count: dependsOn.length })}
                  </h3>
                  <RelatedList
                    db={db}
                    testId="detail-dependencies"
                    rows={dependsOn.map((x) => ({ ...x, kind: x.dependency_type }))}
                  />
                </section>
              ) : null}

              {blocks.length ? (
                <section class="drawer__section">
                  <h3 class="drawer__h">
                    {t("detail.section.dependents", { count: blocks.length })}
                  </h3>
                  <RelatedList
                    db={db}
                    testId="detail-dependents"
                    rows={blocks.map((x) => ({ ...x, kind: x.dependency_type }))}
                  />
                </section>
              ) : null}

              <section class="drawer__section">
                <h3 class="drawer__h">
                  {t("detail.section.comments", {
                    count: d.comments?.length ?? d.comment_count ?? 0,
                  })}
                </h3>
                {d.comments_omitted ? (
                  <p class="empty-note">{t("detail.comments.omitted")}</p>
                ) : null}
                {d.comments?.length ? (
                  <div data-testid="detail-comments">
                    {d.comments.map((c) => (
                      <article key={c.id} class="comment">
                        <div class="comment__head">
                          <span class="comment__author">{c.author}</span>
                          <span title={c.created_at}>{formatDateTime(c.created_at, lang)}</span>
                        </div>
                        <div
                          class="md"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(c.text) }}
                        />
                      </article>
                    ))}
                  </div>
                ) : !d.comments_omitted ? (
                  <p class="empty-note">{t("detail.comments.none")}</p>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
