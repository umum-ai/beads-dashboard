/**
 * One status column: header with count and a "+" (new issue in this status), priority sections
 * (collapsible, persisted), optional "show all closed" footer for done-category statuses, and a
 * drag handle on the right edge that resizes the column (persisted per status name).
 *
 * Drag-and-drop: every section body is a drop zone (`data-drop-status` / `data-drop-priority`);
 * while a card is dragged, the sections that are empty appear too, so any priority can be
 * targeted. In swimlane mode each lane cell is a zone as well (status + lane).
 */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { t, tOr } from "../i18n/index.ts";
import type { BoardIssue, StatusDef } from "../lib/bff-types.ts";
import { PRIORITIES, type Priority, type PrioritySection, sectionize } from "../lib/board.ts";
import { useDropZone } from "../lib/dnd.ts";
import type { DropLane } from "../lib/dnd-intent.ts";
import { openCreate } from "../state/create.ts";
import {
  columnWidths,
  DEFAULT_COLUMN_WIDTH,
  isSectionCollapsed,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  setColumnWidth,
  toggleSection,
} from "../state/prefs.ts";
import { dragging } from "../state/selection.ts";
import { Card } from "./Card.tsx";

export function statusLabel(name: string): string {
  return tOr(`status.${name}`, name.replace(/_/g, " "));
}

interface SectionProps {
  db: string;
  status: string;
  section: PrioritySection;
  done: boolean;
  /** Persistence key for the collapsed state; defaults to the status (swimlanes scope it). */
  collapseKey?: string | undefined;
  /** Swimlane this section belongs to (drop target parent), absent on the flat board. */
  lane?: DropLane | undefined;
  /** Rendered only because a drag is in progress (no cards of its own). */
  placeholder?: boolean | undefined;
}

export function Section(props: SectionProps): JSX.Element {
  const { db, status, section, done, collapseKey, lane } = props;
  const key = collapseKey ?? status;
  const collapsed = isSectionCollapsed(key, section.priority) && !props.placeholder;
  const p = section.priority;
  const ref = useRef<HTMLElement>(null);
  const over = useDropZone(ref, { status, priority: p, lane });
  const classes = ["section"];
  if (collapsed) classes.push("section--collapsed");
  if (over) classes.push("section--over");
  if (props.placeholder) classes.push("section--placeholder");
  return (
    <section
      ref={ref}
      class={classes.join(" ")}
      data-priority={p}
      data-testid="section"
      data-drop-status={status}
      data-drop-priority={p}
      data-over={over ? "true" : undefined}
    >
      <button
        type="button"
        class="section__head"
        aria-expanded={!collapsed}
        aria-label={
          collapsed
            ? t("board.section.expand", { priority: p })
            : t("board.section.collapse", { priority: p })
        }
        onClick={() => toggleSection(key, p)}
      >
        <span class="section__caret" aria-hidden="true" />
        <span class="pchip pchip--outline">{t(`priority.${p}`)}</span>
        <span class="section__name">{t(`priority.name.${p}`)}</span>
        <span class="section__count">{section.cards.length}</span>
      </button>
      {collapsed ? null : (
        <div class="section__cards">
          {section.cards.map((card) => (
            <Card key={card.id} db={db} issue={card} done={done} lane={lane?.key} />
          ))}
          {props.placeholder || over ? (
            <div class="section__drop" aria-hidden="true">
              {t("board.dropHere")}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Sections of `cards`; while dragging, every priority is present (empty ones as placeholders). */
function sectionsFor(
  cards: BoardIssue[],
  dragActive: boolean,
): Array<PrioritySection & { placeholder: boolean }> {
  const real = sectionize(cards);
  if (!dragActive) return real.map((s) => ({ ...s, placeholder: false }));
  const byPriority = new Map(real.map((s) => [s.priority, s]));
  return PRIORITIES.map((p: Priority) => {
    const s = byPriority.get(p);
    return s ? { ...s, placeholder: false } : { priority: p, cards: [], placeholder: true };
  });
}

export interface ColumnProps {
  db: string;
  status: StatusDef;
  cards: BoardIssue[];
  /** Done-category columns: the closed window hint and the "show all" footer. */
  closedDays?: number | undefined;
  showAll?:
    | { loaded: boolean; loading: boolean; total: number | null; onLoad: () => void }
    | undefined;
  /**
   * Swimlane mode: the column becomes a subgrid of the board and renders one cell per lane in
   * the lane's grid row (`Swimlane.tsx` places the lane headers between them). `cards` must
   * then be the union of every lane's cards (for the count).
   */
  lanes?: { key: string; parentId: string; cards: BoardIssue[]; collapsed: boolean }[] | undefined;
  /** 1-based grid column in swimlane mode (lane headers span every column, so placement is explicit). */
  gridColumn?: number | undefined;
}

/** Grid rows of the swimlane board: 1 = column headers, then (lane header, lane body) pairs. */
export function laneHeaderRow(index: number): number {
  return 2 + 2 * index;
}
export function laneBodyRow(index: number): number {
  return 3 + 2 * index;
}

function LaneCell(props: {
  db: string;
  status: StatusDef;
  lane: { key: string; parentId: string; cards: BoardIssue[]; collapsed: boolean };
  index: number;
  dragActive: boolean;
}): JSX.Element {
  const { db, status, lane, index } = props;
  const ref = useRef<HTMLDivElement>(null);
  const dropLane: DropLane = { key: lane.key, parentId: lane.parentId };
  const over = useDropZone(ref, { status: status.name, lane: dropLane }, !lane.collapsed);
  return (
    <div
      ref={ref}
      class={`lane-cell${lane.collapsed ? " lane-cell--collapsed" : ""}${over ? " lane-cell--over" : ""}`}
      style={{ gridRow: laneBodyRow(index) }}
      data-testid="lane-cell"
      data-lane={lane.key}
      data-status={status.name}
    >
      {lane.collapsed
        ? null
        : sectionsFor(lane.cards, props.dragActive).map((section) => (
            <Section
              key={section.priority}
              db={db}
              status={status.name}
              section={section}
              done={status.category === "done"}
              collapseKey={`${status.name}@${lane.key}`}
              lane={dropLane}
              placeholder={section.placeholder}
            />
          ))}
    </div>
  );
}

export function Column(props: ColumnProps): JSX.Element {
  const { db, status, cards, lanes } = props;
  const done = status.category === "done";
  const width = columnWidths.value[status.name] ?? DEFAULT_COLUMN_WIDTH;
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const dragActive = dragging.value !== null;
  const body = useRef<HTMLDivElement>(null);
  const bodyOver = useDropZone(body, { status: status.name }, !lanes);

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setColumnWidth(status.name, d.startWidth + (event.clientX - d.startX));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    setResizing(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") setColumnWidth(status.name, width - step);
    else if (event.key === "ArrowRight") setColumnWidth(status.name, width + step);
    else if (event.key === "Home") setColumnWidth(status.name, DEFAULT_COLUMN_WIDTH);
    else return;
    event.preventDefault();
  };

  const sections = sectionsFor(cards, dragActive);

  return (
    <section
      class={`column${resizing ? " column--resizing" : ""}${lanes ? " column--lanes" : ""}`}
      style={
        lanes ? { width: `${width}px`, gridColumn: props.gridColumn } : { width: `${width}px` }
      }
      data-category={status.category}
      data-status={status.name}
      data-testid="column"
      aria-label={statusLabel(status.name)}
    >
      <header class="column__head" style={lanes ? { gridRow: 1 } : undefined}>
        <h2 class="column__name ellipsis" title={status.name}>
          {statusLabel(status.name)}
        </h2>
        <span class="column__count" data-testid="column-count">
          {t("board.column.count", { count: cards.length })}
        </span>
        {done && props.closedDays !== undefined && !props.showAll?.loaded ? (
          <span class="column__hint" title={t("board.closedWindow", { days: props.closedDays })}>
            {t("board.closedWindow", { days: props.closedDays })}
          </span>
        ) : null}
        <button
          type="button"
          class="icon-btn column__add"
          aria-label={t("create.inStatus", { status: statusLabel(status.name) })}
          title={t("create.inStatus", { status: statusLabel(status.name) })}
          data-testid="column-add"
          onClick={() => openCreate({ status: status.name })}
        >
          +
        </button>
      </header>
      {lanes ? (
        lanes.map((lane, index) => (
          <LaneCell
            key={lane.key}
            db={db}
            status={status}
            lane={lane}
            index={index}
            dragActive={dragActive}
          />
        ))
      ) : (
        <div ref={body} class={`column__body${bodyOver ? " column__body--over" : ""}`}>
          {sections.length === 0 ? (
            <p class="column__empty">{t("board.column.empty")}</p>
          ) : (
            sections.map((section) => (
              <Section
                key={section.priority}
                db={db}
                status={status.name}
                section={section}
                done={done}
                placeholder={section.placeholder}
              />
            ))
          )}
        </div>
      )}
      {done && props.showAll ? (
        <footer
          class="column__foot"
          style={lanes ? { gridRow: laneHeaderRow(lanes.length) } : undefined}
        >
          {props.showAll.loaded ? (
            <span class="column__hint" style="margin-left: 0">
              {t("board.showAllClosed.loaded", { count: cards.length })}
            </span>
          ) : (
            <button
              type="button"
              class="btn btn--ghost"
              disabled={props.showAll.loading}
              data-testid="show-all-closed"
              onClick={props.showAll.onLoad}
            >
              {props.showAll.loading ? t("board.showAllClosed.loading") : t("board.showAllClosed")}
            </button>
          )}
        </footer>
      ) : null}
      <hr
        class="column__resize"
        aria-orientation="vertical"
        aria-label={t("board.column.resize", { name: statusLabel(status.name) })}
        aria-valuenow={width}
        aria-valuemin={MIN_COLUMN_WIDTH}
        aria-valuemax={MAX_COLUMN_WIDTH}
        tabIndex={0}
        data-testid="column-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
    </section>
  );
}
