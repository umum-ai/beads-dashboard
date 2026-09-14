/**
 * Kanban board: filter toolbar, one column per status of the snapshot; grouped into swimlanes
 * per top epic by default (`prefs.groupByEpic`), drilled into one epic with `?epic=<id>`.
 */
import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { Breadcrumbs, type Crumb } from "../components/Breadcrumbs.tsx";
import { Column } from "../components/Column.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { GroupToggle, ProgressBar, SwimlaneBoard } from "../components/Swimlane.tsx";
import { Toolbar } from "../components/Toolbar.tsx";
import { t } from "../i18n/index.ts";
import { loadAllClosed } from "../lib/api.ts";
import type { BoardIssue, StatusDef } from "../lib/bff-types.ts";
import { doneStatuses, groupByStatus } from "../lib/board.ts";
import { isFilterEmpty, matchesFilters } from "../lib/filters.ts";
import {
  ancestorsOf,
  groupBySubEpic,
  groupByTopEpic,
  isUnder,
  type Lane,
  progressOf,
} from "../lib/hierarchy.ts";
import { isRetryable, refetchSnapshot } from "../lib/live.ts";
import { databases, meta } from "../state/meta.ts";
import { groupByEpic, setGroupByEpic } from "../state/prefs.ts";
import { filters, hrefFor, onLinkClick, updateFilters } from "../state/route.ts";
import {
  allIssues,
  board,
  boardDb,
  boardError,
  boardLoading,
  dbInfo,
  extraClosed,
  extraClosedLoaded,
  extraClosedLoading,
  hierarchy,
} from "../state/snapshot.ts";
import { describeError, toastError } from "../state/toasts.ts";

async function showAllClosed(db: string): Promise<void> {
  if (extraClosedLoading.value || extraClosedLoaded.value) return;
  extraClosedLoading.value = true;
  try {
    const rows = await loadAllClosed(db, doneStatuses(board.value.statuses));
    if (boardDb.value !== db) return;
    const map = new Map<string, BoardIssue>();
    for (const row of rows) map.set(row.id, { ...row, blocked: false });
    extraClosed.value = map;
    extraClosedLoaded.value = true;
  } catch (err) {
    toastError(err);
  } finally {
    extraClosedLoading.value = false;
  }
}

export function BoardView({ db }: { db: string }): JSX.Element {
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  const state = board.value;
  const hasData = boardDb.value === db && state.seq >= 0;

  const visible = useComputed(() => {
    const f = filters.value;
    const rows = allIssues.value;
    return isFilterEmpty(f) ? rows : rows.filter((row) => matchesFilters(row, f));
  });
  const assignees = useComputed(() => {
    const out = new Set<string>();
    for (const row of allIssues.value) if (row.assignee) out.add(row.assignee);
    return [...out];
  });

  if (!hasData) {
    const starting = info?.state === "starting" || isRetryable(boardError.value);
    if (boardError.value && !starting) {
      return (
        <EmptyState
          title={t("error.network_error")}
          body={describeError(boardError.value)}
          action={{ label: t("state.retry"), onClick: () => void refetchSnapshot(db) }}
          testId="board-error"
        />
      );
    }
    if (starting && info?.state !== "down") {
      return (
        <EmptyState
          loading
          title={t("state.starting.title", { db })}
          body={t("state.starting.body")}
          testId="db-starting"
        />
      );
    }
    if (info?.state === "down") {
      return (
        <EmptyState
          title={t("state.down.title", { db })}
          body={t("state.down.body")}
          action={{ label: t("state.retry"), onClick: () => void refetchSnapshot(db) }}
          testId="db-down"
        />
      );
    }
    if (boardLoading.value || !info) {
      return <EmptyState loading title={t("board.loading")} testId="board-loading" />;
    }
  }

  const closedDays = meta.value?.closedDays ?? 7;
  const total = allIssues.value.length;
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
  const scoped = visible.value.filter(inScope);
  const scopeTotal = epicId ? allIssues.value.filter(inScope).length : total;
  const lanes: Lane[] | null = !grouped
    ? null
    : epicId
      ? groupBySubEpic(scoped, index, epicId)
      : groupByTopEpic(scoped, index);
  const { columns, byStatus } = groupByStatus(scoped, state.statuses);

  const columnExtras = (status: StatusDef) => ({
    closedDays: status.category === "done" ? closedDays : undefined,
    showAll:
      status.category === "done"
        ? {
            loaded: extraClosedLoaded.value,
            loading: extraClosedLoading.value,
            total: null,
            onLoad: () => void showAllClosed(db),
          }
        : undefined,
  });

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
        extra={<GroupToggle on={grouped} onChange={setGroupByEpic} />}
      />
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
      {total === 0 ? (
        <EmptyState title={t("board.empty.title")} body={t("board.empty.none")} />
      ) : epicId && scoped.length === 0 ? (
        <EmptyState
          title={t("board.empty.title")}
          body={filtered ? t("board.empty.filtered") : t("board.drill.empty")}
          action={{ label: t("board.crumbs.all"), onClick: () => updateFilters({ epic: "" }) }}
        />
      ) : filtered && scoped.length === 0 ? (
        <EmptyState title={t("board.empty.title")} body={t("board.empty.filtered")} />
      ) : lanes ? (
        <SwimlaneBoard
          db={db}
          columns={columns}
          lanes={lanes}
          progressOf={progress}
          fallbackLabel={epicId ? t("board.lane.direct", { id: epicId }) : t("board.lane.noEpic")}
          onOpenEpic={openEpic}
          columnExtras={columnExtras}
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
