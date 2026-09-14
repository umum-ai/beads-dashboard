/**
 * Epics view: every epic of the snapshot as a row (id, title, status, priority, assignee,
 * progress), expandable to its direct children with nested expansion for sub-epics, a link into
 * the board drill-down and the detail drawer on the title. Quick filters from the toolbar apply
 * to the epic rows; status chips narrow the list further.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { typeLabel } from "../components/Card.tsx";
import { statusLabel } from "../components/Column.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { ProgressBar } from "../components/Swimlane.tsx";
import { Toolbar } from "../components/Toolbar.tsx";
import { t } from "../i18n/index.ts";
import type { BoardIssue } from "../lib/bff-types.ts";
import { clampPriority, doneStatuses } from "../lib/board.ts";
import { isFilterEmpty, matchesFilters } from "../lib/filters.ts";
import {
  childrenOf,
  compareEpics,
  type HierarchyIndex,
  isEpic,
  progressOf,
} from "../lib/hierarchy.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { filters, hrefFor, hrefWith, navigate, onLinkClick } from "../state/route.ts";
import { allIssues, board, boardDb, hierarchy } from "../state/snapshot.ts";

interface RowProps {
  db: string;
  row: BoardIssue;
  index: HierarchyIndex;
  done: ReadonlySet<string>;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

/** One issue line of the tree: caret (when it has children), glyph, id, title, badges. */
function IssueRow(props: RowProps): JSX.Element {
  const { db, row, index, done, depth, expanded, onToggle } = props;
  const kids = childrenOf(index, row.id);
  const open = expanded.has(row.id);
  const detail = { kind: "issue" as const, db, issueId: row.id };
  const epic = isEpic(row);
  const priority = clampPriority(row.priority);
  const progress = kids.length || epic ? progressOf(row, index, done) : null;
  const isDone = done.has(row.status ?? "open");
  return (
    <li
      class={`erow${epic ? " erow--epic" : ""}${isDone ? " erow--done" : ""}`}
      data-testid={depth === 0 ? "epic-row" : "epic-child"}
      data-id={row.id}
      data-depth={depth}
    >
      <div class="erow__line" style={{ paddingLeft: `${depth * 22}px` }}>
        {kids.length ? (
          <button
            type="button"
            class="erow__toggle"
            aria-expanded={open}
            aria-label={
              open ? t("epics.collapse", { id: row.id }) : t("epics.expand", { id: row.id })
            }
            data-testid="epic-toggle"
            onClick={() => onToggle(row.id)}
          >
            <span class={`section__caret${open ? "" : " section__caret--right"}`} aria-hidden />
          </button>
        ) : (
          <span class="erow__toggle erow__toggle--none" aria-hidden="true" />
        )}
        <span class="erow__type" title={typeLabel(row.issue_type)} aria-hidden="true">
          {typeGlyph(row.issue_type)}
        </span>
        <span class="erow__id mono">{row.id}</span>
        <a
          class="erow__title ellipsis"
          href={hrefFor(detail)}
          title={row.title}
          data-testid="epic-title"
          onClick={(e) => onLinkClick(e, detail)}
        >
          {row.title}
        </a>
        {row.blocked ? (
          <span class="chip chip--blocked" title={t("card.blocked.help")} data-testid="blocked">
            {t("card.blocked")}
          </span>
        ) : null}
        <span class="chip" data-testid="epic-status">
          {statusLabel(row.status ?? "open")}
        </span>
        <span class="pchip" data-priority={priority} title={t(`priority.name.${priority}`)}>
          {t(`priority.${priority}`)}
        </span>
        <span class="erow__assignee ellipsis" title={row.assignee}>
          {row.assignee ?? ""}
        </span>
        <span class="erow__progress">
          {progress ? <ProgressBar progress={progress} wide /> : null}
        </span>
        {epic ? (
          <a
            class="btn btn--ghost erow__open"
            href={hrefWith({ kind: "board", db }, { ...filters.value, epic: row.id })}
            data-testid="epic-open-board"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              navigate({ kind: "board", db }, { filters: { ...filters.value, epic: row.id } });
            }}
          >
            {t("epics.openBoard")}
          </a>
        ) : (
          <span class="erow__open" />
        )}
      </div>
      {open && kids.length ? (
        <ul class="erow__children" data-testid="epic-children">
          {kids.map((kid) => (
            <IssueRow key={kid.id} {...props} row={kid} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function EpicsView({ db }: { db: string }): JSX.Element {
  const [status, setStatus] = useState<string>("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const state = board.value;
  const hasData = boardDb.value === db && state.seq >= 0;
  const index = hierarchy.value;
  const done = new Set(doneStatuses(state.statuses));
  const f = filters.value;
  const epics = allIssues.value.filter((row) => isEpic(row)).sort(compareEpics);
  const filtered = isFilterEmpty(f) ? epics : epics.filter((row) => matchesFilters(row, f));
  const shown = status ? filtered.filter((row) => (row.status ?? "open") === status) : filtered;

  // Status chips: the snapshot's status order, only those some epic has.
  const present = new Set(filtered.map((row) => row.status ?? "open"));
  const chips = state.statuses.filter((s) => present.has(s.name)).map((s) => s.name);
  for (const s of present) if (!chips.includes(s)) chips.push(s);
  const assignees = [
    ...new Set(allIssues.value.map((r) => r.assignee).filter(Boolean)),
  ] as string[];

  if (!hasData) return <EmptyState loading title={t("board.loading")} testId="board-loading" />;

  return (
    <div class="board-view epics-view" data-testid="epics-view">
      <Toolbar
        types={state.types}
        assignees={assignees}
        shown={shown.length}
        total={epics.length}
      />
      <div class="epics">
        <div class="epics__head">
          <h1 class="epics__title">{t("epics.title")}</h1>
          <span class="epics__count">{t("epics.count", { count: epics.length })}</span>
          <fieldset class="chips" aria-label={t("detail.field.status")}>
            <button
              type="button"
              class="chip chip--pick"
              aria-pressed={status === ""}
              data-testid="epics-status-all"
              onClick={() => setStatus("")}
            >
              {t("epics.status.all")}
            </button>
            {chips.map((name) => (
              <button
                key={name}
                type="button"
                class="chip chip--pick"
                aria-pressed={status === name}
                data-testid={`epics-status-${name}`}
                onClick={() => setStatus(status === name ? "" : name)}
              >
                {statusLabel(name)}
                <span class="chips__n">
                  {filtered.filter((row) => (row.status ?? "open") === name).length}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
        {epics.length === 0 ? (
          <EmptyState title={t("epics.title")} body={t("epics.empty")} />
        ) : shown.length === 0 ? (
          <EmptyState title={t("epics.title")} body={t("epics.empty.filtered")} />
        ) : (
          <ul class="erows" data-testid="epic-list">
            {shown.map((row) => (
              <IssueRow
                key={row.id}
                db={db}
                row={row}
                index={index}
                done={done}
                depth={0}
                expanded={expanded}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
