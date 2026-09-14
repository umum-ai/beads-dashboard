/** Kanban board: filter toolbar plus one column per status of the snapshot. */
import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import { Column } from "../components/Column.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Toolbar } from "../components/Toolbar.tsx";
import { t } from "../i18n/index.ts";
import { loadAllClosed } from "../lib/api.ts";
import type { BoardIssue } from "../lib/bff-types.ts";
import { doneStatuses, groupByStatus } from "../lib/board.ts";
import { isFilterEmpty, matchesFilters } from "../lib/filters.ts";
import { isRetryable, refetchSnapshot } from "../lib/live.ts";
import { databases, meta } from "../state/meta.ts";
import { filters } from "../state/route.ts";
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

  const { columns, byStatus } = groupByStatus(visible.value, state.statuses);
  const closedDays = meta.value?.closedDays ?? 7;
  const total = allIssues.value.length;
  const filtered = !isFilterEmpty(filters.value);

  return (
    <div class="board-view" data-testid="board-view">
      <Toolbar
        types={state.types}
        assignees={assignees.value}
        shown={visible.value.length}
        total={total}
      />
      {total === 0 ? (
        <EmptyState title={t("board.empty.title")} body={t("board.empty.none")} />
      ) : filtered && visible.value.length === 0 ? (
        <EmptyState title={t("board.empty.title")} body={t("board.empty.filtered")} />
      ) : (
        <div class="board" data-testid="board">
          {columns.map((status) => (
            <Column
              key={status.name}
              db={db}
              status={status}
              cards={byStatus.get(status.name) ?? []}
              closedDays={status.category === "done" ? closedDays : undefined}
              showAll={
                status.category === "done"
                  ? {
                      loaded: extraClosedLoaded.value,
                      loading: extraClosedLoading.value,
                      total: null,
                      onLoad: () => void showAllClosed(db),
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
