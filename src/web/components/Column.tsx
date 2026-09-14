/**
 * One status column: header with count, priority sections (collapsible, persisted), optional
 * "show all closed" footer for done-category statuses, and a drag handle on the right edge
 * that resizes the column (persisted per status name). Section bodies are the future drop
 * zones for stage 5 (`data-drop-status` / `data-drop-priority` mark them already).
 */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { t, tOr } from "../i18n/index.ts";
import type { BoardIssue, StatusDef } from "../lib/bff-types.ts";
import { type PrioritySection, sectionize } from "../lib/board.ts";
import {
  columnWidths,
  DEFAULT_COLUMN_WIDTH,
  isSectionCollapsed,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  setColumnWidth,
  toggleSection,
} from "../state/prefs.ts";
import { Card } from "./Card.tsx";

export function statusLabel(name: string): string {
  return tOr(`status.${name}`, name.replace(/_/g, " "));
}

interface SectionProps {
  db: string;
  status: string;
  section: PrioritySection;
  done: boolean;
}

function Section({ db, status, section, done }: SectionProps): JSX.Element {
  const collapsed = isSectionCollapsed(status, section.priority);
  const p = section.priority;
  return (
    <section
      class={`section${collapsed ? " section--collapsed" : ""}`}
      data-priority={p}
      data-testid="section"
      data-drop-status={status}
      data-drop-priority={p}
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
        onClick={() => toggleSection(status, p)}
      >
        <span class="section__caret" aria-hidden="true" />
        <span class="pchip pchip--outline">{t(`priority.${p}`)}</span>
        <span class="section__name">{t(`priority.name.${p}`)}</span>
        <span class="section__count">{section.cards.length}</span>
      </button>
      {collapsed ? null : (
        <div class="section__cards">
          {section.cards.map((card) => (
            <Card key={card.id} db={db} issue={card} done={done} />
          ))}
        </div>
      )}
    </section>
  );
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
}

export function Column(props: ColumnProps): JSX.Element {
  const { db, status, cards } = props;
  const done = status.category === "done";
  const width = columnWidths.value[status.name] ?? DEFAULT_COLUMN_WIDTH;
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const sections = sectionize(cards);

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

  return (
    <section
      class={`column${resizing ? " column--resizing" : ""}`}
      style={{ width: `${width}px` }}
      data-category={status.category}
      data-status={status.name}
      data-testid="column"
      aria-label={statusLabel(status.name)}
    >
      <header class="column__head">
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
      </header>
      <div class="column__body">
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
            />
          ))
        )}
      </div>
      {done && props.showAll ? (
        <footer class="column__foot">
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
