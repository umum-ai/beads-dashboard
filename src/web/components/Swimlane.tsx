/**
 * Swimlanes: the board grouped by epic. The board is one CSS grid whose columns are the status
 * columns (their widths are the shared column widths) and whose rows alternate lane header /
 * lane body. Each `Column` is a subgrid spanning every row, so the DOM stays column-major
 * (a card's nearest `[data-testid="column"]` is still its status) while lane headers span all
 * columns in their own row. Collapse state per lane persists in localStorage.
 *
 * A lane header is a drop zone: a card dropped on it gets the lane's epic as parent (the "no
 * epic" lane clears the parent; a drill-down's "directly in" lane sets the drilled epic). The
 * "+" in the header creates an issue with that parent.
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { t } from "../i18n/index.ts";
import type { BoardIssue, StatusDef } from "../lib/bff-types.ts";
import { clampPriority } from "../lib/board.ts";
import { useDropZone } from "../lib/dnd.ts";
import type { Lane, Progress } from "../lib/hierarchy.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { openCreate } from "../state/create.ts";
import { columnWidths, DEFAULT_COLUMN_WIDTH, isLaneCollapsed, toggleLane } from "../state/prefs.ts";
import { hrefFor, navigate } from "../state/route.ts";
import { copyId } from "./Card.tsx";
import { Column, type ColumnProps, laneHeaderRow } from "./Column.tsx";

export function ProgressBar({
  progress,
  wide,
  testId,
}: {
  progress: Progress;
  wide?: boolean | undefined;
  testId?: string | undefined;
}): JSX.Element {
  const { total, closed } = progress;
  const pct = total ? Math.round((closed / total) * 100) : 0;
  return (
    <span
      class={`card__progress${wide ? " card__progress--wide" : ""}`}
      title={t("card.epicProgress", { closed, total })}
      data-testid={testId ?? "epic-progress"}
    >
      <span class="card__bar" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span class="card__ratio">
        {closed}/{total}
      </span>
    </span>
  );
}

/** Toolbar switch between swimlanes and the flat board. */
export function GroupToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class="btn btn--toggle"
      aria-pressed={on}
      title={t("board.groupByEpic.help")}
      data-testid="group-by-epic"
      onClick={() => onChange(!on)}
    >
      <span class="btn__dot" aria-hidden="true" />
      {t("board.groupByEpic")}
    </button>
  );
}

interface LaneHeaderProps {
  db: string;
  lane: Lane;
  collapsed: boolean;
  progress: Progress | null;
  /** Label of the no-epic lane: "No epic" on the full board, "Directly in <id>" in a drill-down. */
  fallbackLabel: string;
  /** Drill-down target for the lane's epic; omitted when the lane has no epic. */
  onOpen?: (() => void) | undefined;
  /** Parent an issue gets when dropped on / created in this lane (`""` = none). */
  parentId: string;
}

export function LaneHeader(props: LaneHeaderProps): JSX.Element {
  const { db, lane, collapsed, progress } = props;
  const epic = lane.epic;
  const name = epic ? epic.title : props.fallbackLabel;
  const count = lane.issues.length;
  const detail = epic ? { kind: "issue" as const, db, issueId: epic.id } : null;
  const ref = useRef<HTMLElement>(null);
  const over = useDropZone(ref, { lane: { key: lane.key, parentId: props.parentId } });
  return (
    <header
      ref={ref}
      class={`lane-head${collapsed ? " lane-head--collapsed" : ""}${epic ? "" : " lane-head--loose"}${over ? " lane-head--over" : ""}`}
      data-testid="lane"
      data-lane={lane.key}
      data-priority={epic ? clampPriority(epic.priority) : undefined}
      data-over={over ? "true" : undefined}
    >
      <div class="lane-head__in">
        <button
          type="button"
          class="lane-head__toggle"
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? t("board.lane.expand", { name }) : t("board.lane.collapse", { name })
          }
          data-testid="lane-toggle"
          onClick={() => toggleLane(lane.key)}
        >
          <span class="section__caret" aria-hidden="true" />
        </button>
        {epic ? (
          <>
            <span class="lane-head__type" aria-hidden="true">
              {typeGlyph(epic.issue_type)}
            </span>
            <button
              type="button"
              class="lane-head__id mono"
              title={t("card.copyId", { id: epic.id })}
              onClick={() => void copyId(epic.id)}
            >
              {epic.id}
            </button>
            <a
              class="lane-head__title ellipsis"
              href={detail ? hrefFor(detail) : undefined}
              title={epic.title}
              data-testid="lane-title"
              onClick={(e) => {
                if (!detail) return;
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                navigate(detail);
              }}
            >
              {epic.title}
            </a>
            {epic.blocked ? (
              <span class="chip chip--blocked" title={t("card.blocked.help")}>
                {t("card.blocked")}
              </span>
            ) : null}
          </>
        ) : (
          <span class="lane-head__title lane-head__title--loose ellipsis" data-testid="lane-title">
            {props.fallbackLabel}
          </span>
        )}
        <span class="lane-head__count" data-testid="lane-count">
          {t("board.lane.count", { count })}
        </span>
        {progress ? <ProgressBar progress={progress} wide testId="lane-progress" /> : null}
        <button
          type="button"
          class="icon-btn lane-head__add"
          aria-label={t("create.inLane", { name })}
          title={t("create.inLane", { name })}
          data-testid="lane-add"
          onClick={() => openCreate({ parent: props.parentId || undefined })}
        >
          +
        </button>
        {props.onOpen ? (
          <button
            type="button"
            class="btn btn--ghost lane-head__open"
            title={t("board.lane.open.help")}
            data-testid="lane-open"
            onClick={props.onOpen}
          >
            {t("board.lane.open")}
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** Lane header row heights: `.lane-head` height + margins (`app.css`). */
export const LANE_HEAD_PX = 48;
export const LANE_HEAD_COLLAPSED_PX = 44;

export interface SwimlaneBoardProps {
  db: string;
  columns: StatusDef[];
  lanes: Lane[];
  progressOf: (epic: BoardIssue) => Progress;
  fallbackLabel: string;
  onOpenEpic: (id: string) => void;
  /** Per-status extras (the closed window) passed straight to `Column`. */
  columnExtras: (status: StatusDef) => Pick<ColumnProps, "closedHours">;
  /** Parent id a card gets when it lands in the lane (`""` clears it). */
  parentIdOf: (lane: Lane) => string;
}

export function SwimlaneBoard(props: SwimlaneBoardProps): JSX.Element {
  const { db, columns, lanes } = props;
  const widths = columnWidths.value;
  const template = columns.map((c) => `${widths[c.name] ?? DEFAULT_COLUMN_WIDTH}px`).join(" ");
  // Header rows get an explicit height: the lane header spans header + body rows (see
  // LaneHeader), so nothing else would give the header row a size.
  const rows = `auto ${lanes
    .map((lane) => `${isLaneCollapsed(lane.key) ? LANE_HEAD_COLLAPSED_PX : LANE_HEAD_PX}px auto`)
    .join(" ")} auto`;

  // cards per (status, lane), sharing the lane order of `lanes`
  const byLaneStatus = new Map<string, Map<string, BoardIssue[]>>();
  for (const lane of lanes) {
    const perStatus = new Map<string, BoardIssue[]>();
    for (const row of lane.issues) {
      const status = row.status ?? "open";
      const list = perStatus.get(status);
      if (list) list.push(row);
      else perStatus.set(status, [row]);
    }
    byLaneStatus.set(lane.key, perStatus);
  }

  return (
    <div
      class="board board--lanes"
      data-testid="board"
      style={{ gridTemplateColumns: template, gridTemplateRows: rows }}
    >
      {columns.map((status, columnIndex) => {
        const cells = lanes.map((lane) => ({
          key: lane.key,
          parentId: props.parentIdOf(lane),
          cards: byLaneStatus.get(lane.key)?.get(status.name) ?? [],
          collapsed: isLaneCollapsed(lane.key),
        }));
        return (
          <Column
            key={status.name}
            db={db}
            status={status}
            cards={cells.flatMap((c) => c.cards)}
            lanes={cells}
            gridColumn={columnIndex + 1}
            {...props.columnExtras(status)}
          />
        );
      })}
      {lanes.map((lane, index) => (
        // The frame spans the lane's header + body rows and is the sticky header's containing
        // block, so a header sticks only while its own lane is in view and is pushed out by the
        // next lane instead of piling up under the column heads. It is transparent to the pointer.
        <div
          key={lane.key}
          class="lane-frame"
          style={{ gridRow: `${laneHeaderRow(index)} / span 2` }}
          data-testid="lane-frame"
        >
          <LaneHeader
            db={db}
            lane={lane}
            collapsed={isLaneCollapsed(lane.key)}
            progress={lane.epic ? props.progressOf(lane.epic) : null}
            fallbackLabel={props.fallbackLabel}
            onOpen={lane.epic ? () => props.onOpenEpic((lane.epic as BoardIssue).id) : undefined}
            parentId={props.parentIdOf(lane)}
          />
        </div>
      ))}
    </div>
  );
}
