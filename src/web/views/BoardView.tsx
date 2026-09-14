/**
 * Kanban board: filter toolbar, one column per visible status (board settings, `lib/columns.ts`:
 * the chosen columns and the closed window narrow the snapshot rows); grouped into swimlanes
 * per top epic by default (`prefs.groupByEpic`), drilled into one epic with `?epic=<id>`. Query
 * mode shows exactly the result set: every status it contains, no closed window.
 */
import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { openSettings } from "../components/BoardSettings.tsx";
import { Breadcrumbs, type Crumb } from "../components/Breadcrumbs.tsx";
import { Column } from "../components/Column.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { QueryBar, QueryToggle } from "../components/QueryBar.tsx";
import { databaseHints } from "../components/StatusBanners.tsx";
import { GroupToggle, ProgressBar, SwimlaneBoard } from "../components/Swimlane.tsx";
import { clearFilters, Toolbar } from "../components/Toolbar.tsx";
import { t } from "../i18n/index.ts";
import type { BoardIssue, StatusDef } from "../lib/bff-types.ts";
import { doneStatuses, groupByStatus } from "../lib/board.ts";
import { boardRows, effectiveClosedHours, visibleStatuses } from "../lib/columns.ts";
import { useBoardDnd } from "../lib/dnd.ts";
import { isFilterEmpty, matchesFilters } from "../lib/filters.ts";
import type { Lane as DropLaneOf } from "../lib/hierarchy.ts";
import {
  ancestorsOf,
  groupBySubEpic,
  groupByTopEpic,
  isUnder,
  type Lane,
  progressOf,
} from "../lib/hierarchy.ts";
import { isRetryable, refetchSnapshot } from "../lib/live.ts";
import { openCreate } from "../state/create.ts";
import { databases, meta } from "../state/meta.ts";
import { groupByEpic, setGroupByEpic, storedClosedHours, storedColumns } from "../state/prefs.ts";
import { queryIssues, queryLoading, queryResult } from "../state/query.ts";
import { filters, hrefFor, onLinkClick, updateFilters } from "../state/route.ts";
import { clearSelection, selection } from "../state/selection.ts";
import {
  allIssues,
  board,
  boardDb,
  boardError,
  boardLoading,
  dbInfo,
  hierarchy,
  now,
} from "../state/snapshot.ts";
import { describeError } from "../state/toasts.ts";

export function BoardView({ db }: { db: string }): JSX.Element {
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  const state = board.value;
  const hasData = boardDb.value === db && state.seq >= 0;
  useBoardDnd(db);

  // Escape clears the multi-selection (the drawer handles its own Escape first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selection.value.size && !event.defaultPrevented)
        clearSelection();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Query mode replaces the issue set with the `issues:query` result (live rows where present)
  // and shows it whole; otherwise the board settings decide the columns and the closed window.
  // Plain derivations (not `useComputed`): they depend on `db` and on per-database preferences,
  // and every signal read here re-renders the view when it changes.
  const source = queryIssues.value ?? allIssues.value;
  const closedHours = effectiveClosedHours(storedClosedHours(db), meta.value?.closedHours ?? 72);
  const boardColumns = queryIssues.value
    ? groupByStatus(queryIssues.value, state.statuses).columns
    : visibleStatuses(state.statuses, storedColumns(db));
  const scope = queryIssues.value
    ? source
    : boardRows(source, boardColumns, closedHours, now.value);
  const visible = isFilterEmpty(filters.value)
    ? scope
    : scope.filter((row) => matchesFilters(row, filters.value));
  const assignees = useComputed(() => {
    const out = new Set<string>();
    for (const row of allIssues.value) if (row.assignee) out.add(row.assignee);
    return [...out];
  });

  if (!hasData) {
    const retry = { label: t("state.retry"), onClick: () => void refetchSnapshot(db) };
    if (info?.state === "down") {
      return (
        <EmptyState
          tone="danger"
          title={t("state.down.title", { db })}
          body={t("state.down.body")}
          detail={info.lastError ?? undefined}
          hints={databaseHints("down")}
          action={retry}
          testId="db-down"
        />
      );
    }
    if (info?.state === "degraded") {
      return (
        <EmptyState
          tone="warn"
          title={t("state.degraded.title", { db })}
          body={t("state.degraded.body")}
          detail={info.lastError ?? undefined}
          hints={databaseHints("degraded")}
          action={retry}
          testId="db-degraded"
        />
      );
    }
    const starting = info?.state === "starting" || isRetryable(boardError.value);
    if (starting) {
      return (
        <EmptyState
          loading
          title={t("state.starting.title", { db })}
          body={t("state.starting.body")}
          testId="db-starting"
        />
      );
    }
    if (boardError.value) {
      return (
        <EmptyState
          tone="danger"
          title={t("error.network_error")}
          body={describeError(boardError.value)}
          action={retry}
          testId="board-error"
        />
      );
    }
    if (boardLoading.value || !info) {
      return <EmptyState loading title={t("board.loading")} testId="board-loading" />;
    }
  }

  const inQuery = queryResult.value !== null;
  const total = scope.length;
  const filtered = !isFilterEmpty(filters.value);
  const index = hierarchy.value;
  const epicId = filters.value.epic;
  const drilled = epicId ? (index.byId.get(epicId) ?? null) : null;
  const grouped = groupByEpic.value;
  const done = new Set(doneStatuses(state.statuses));
  const progress = (epic: BoardIssue) => progressOf(epic, index, done);
  const openEpic = (id: string) => updateFilters({ epic: id });

  // Drill-down: only the descendants of the epic; lanes by sub-epic when there are any.
  const inScope = (row: BoardIssue) =>
    !epicId || (row.id !== epicId && isUnder(index, row.id, epicId));
  const scoped = visible.filter(inScope);
  const scopeTotal = epicId ? scope.filter(inScope).length : total;
  const parentIdOf = (lane: DropLaneOf) => lane.epic?.id ?? (epicId || "");
  const lanes: Lane[] | null = !grouped
    ? null
    : epicId
      ? groupBySubEpic(scoped, index, epicId)
      : groupByTopEpic(scoped, index);
  const { columns, byStatus } = groupByStatus(scoped, boardColumns);

  const columnExtras = (status: StatusDef) => ({
    closedHours: status.category === "done" && !inQuery ? closedHours : undefined,
  });
  const chooseColumns = {
    label: t("board.noColumns.action"),
    onClick: openSettings,
    testId: "board-choose-columns",
  };

  let crumbs: Crumb[] | null = null;
  if (epicId) {
    const chain = drilled ? [...ancestorsOf(index, epicId), drilled] : [];
    crumbs = [
      {
        key: "all",
        label: t("board.crumbs.all"),
        onSelect: () => updateFilters({ epic: "" }),
      },
      ...chain.map((row) => ({
        key: row.id,
        id: row.id,
        label: row.title,
        title: row.title,
        onSelect: () => openEpic(row.id),
      })),
    ];
    if (!drilled) crumbs.push({ key: epicId, id: epicId, label: t("board.drill.unknown") });
  }

  return (
    <div class="board-view" data-testid="board-view">
      <Toolbar
        types={state.types}
        assignees={assignees.value}
        shown={scoped.length}
        total={scopeTotal}
        extra={
          <>
            <GroupToggle on={grouped} onChange={setGroupByEpic} />
            <QueryToggle />
            <button
              type="button"
              class="btn btn--primary"
              data-testid="new-issue"
              onClick={() => openCreate(epicId ? { parent: epicId } : {})}
            >
              {t("create.new")}
            </button>
          </>
        }
      />
      <QueryBar />
      {selection.value.size > 1 ? (
        <div class="selbar" data-testid="selection-bar">
          {t("board.selected", { count: selection.value.size })}
          <button type="button" class="btn btn--ghost" onClick={clearSelection}>
            {t("board.selected.clear")}
          </button>
        </div>
      ) : null}
      {crumbs ? (
        <div class="drill" data-testid="drill">
          <Breadcrumbs items={crumbs} label={t("board.crumbs.label")} testId="breadcrumbs" />
          {drilled ? (
            <>
              <ProgressBar progress={progress(drilled)} wide testId="drill-progress" />
              <a
                class="btn btn--ghost"
                href={hrefFor({ kind: "issue", db, issueId: drilled.id })}
                onClick={(e) => onLinkClick(e, { kind: "issue", db, issueId: drilled.id })}
              >
                {t("board.drill.details")}
              </a>
            </>
          ) : null}
        </div>
      ) : null}
      {inQuery && total === 0 ? (
        <EmptyState
          loading={queryLoading.value}
          title={queryLoading.value ? t("query.running") : t("query.empty.title")}
          body={queryLoading.value ? undefined : t("query.empty")}
          action={
            queryLoading.value
              ? undefined
              : {
                  label: t("query.clear"),
                  onClick: () => updateFilters({ query: "" }),
                  testId: "query-empty-clear",
                }
          }
          testId="query-empty"
        />
      ) : source.length === 0 ? (
        <EmptyState
          title={t("board.empty.none.title")}
          body={t("board.empty.none")}
          action={{
            label: t("board.empty.create"),
            onClick: () => openCreate({}),
            testId: "board-empty-create",
          }}
          testId="board-empty"
        />
      ) : boardColumns.length === 0 ? (
        <EmptyState
          title={t("board.noColumns.title")}
          body={t("board.noColumns", { db })}
          action={chooseColumns}
          testId="board-no-columns"
        />
      ) : total === 0 ? (
        <EmptyState
          title={t("board.hiddenAll.title")}
          body={t("board.hiddenAll")}
          action={chooseColumns}
          testId="board-hidden-all"
        />
      ) : epicId && scoped.length === 0 ? (
        <EmptyState
          title={t("board.empty.title")}
          body={filtered ? t("board.empty.filtered") : t("board.drill.empty")}
          action={
            filtered
              ? { label: t("filters.clear"), onClick: clearFilters, testId: "empty-clear-filters" }
              : {
                  label: t("board.drill.create"),
                  onClick: () => openCreate({ parent: epicId }),
                  testId: "drill-empty-create",
                }
          }
          secondary={{ label: t("board.crumbs.all"), onClick: () => updateFilters({ epic: "" }) }}
          testId="drill-empty"
        />
      ) : filtered && scoped.length === 0 ? (
        <EmptyState
          title={t("board.empty.title")}
          body={t("board.empty.filtered")}
          action={{
            label: t("filters.clear"),
            onClick: clearFilters,
            testId: "empty-clear-filters",
          }}
          testId="filter-empty"
        />
      ) : lanes ? (
        <SwimlaneBoard
          db={db}
          columns={columns}
          lanes={lanes}
          progressOf={progress}
          fallbackLabel={epicId ? t("board.lane.direct", { id: epicId }) : t("board.lane.noEpic")}
          onOpenEpic={openEpic}
          columnExtras={columnExtras}
          parentIdOf={parentIdOf}
        />
      ) : (
        <div class="board" data-testid="board">
          {columns.map((status) => (
            <Column
              key={status.name}
              db={db}
              status={status}
              cards={byStatus.get(status.name) ?? []}
              {...columnExtras(status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
