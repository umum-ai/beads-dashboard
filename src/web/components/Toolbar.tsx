/** Quick filters (text, type, label, assignee, priority); state lives in the URL query string. */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { t } from "../i18n/index.ts";
import { PRIORITIES } from "../lib/board.ts";
import { EMPTY_FILTERS, isFilterEmpty } from "../lib/filters.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { filters, setFilters, updateFilters } from "../state/route.ts";
import { typeLabel } from "./Card.tsx";
import { Popover } from "./Popover.tsx";

export interface ToolbarProps {
  types: string[];
  assignees: string[];
  shown: number;
  total: number;
  /** View-specific controls rendered before the count (the board puts its lane toggle here). */
  extra?: JSX.Element | null | undefined;
}

function TypeFilter({ types }: { types: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = filters.value.types;
  const all = [...new Set([...types, ...selected])];
  const toggle = (type: string) => {
    const next = selected.includes(type) ? selected.filter((x) => x !== type) : [...selected, type];
    updateFilters({ types: next });
  };
  const summary =
    selected.length === 0
      ? t("filters.type.any")
      : selected.length === 1
        ? typeLabel(selected[0])
        : `${t("filters.type")}: ${selected.length}`;
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="left"
      label={t("filters.type")}
      testId="type-filter-popover"
      trigger={
        <button
          type="button"
          class="btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("filters.type")}
          data-testid="type-filter"
          onClick={() => setOpen(!open)}
        >
          {summary}
        </button>
      }
    >
      <p class="pop__title">{t("filters.type")}</p>
      {all.map((type) => (
        <label key={type} class="check">
          <input type="checkbox" checked={selected.includes(type)} onChange={() => toggle(type)} />
          <span aria-hidden="true">{typeGlyph(type)}</span>
          <span>{typeLabel(type)}</span>
        </label>
      ))}
    </Popover>
  );
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const f = filters.value;
  const assignees = [...new Set([...props.assignees, ...(f.assignee ? [f.assignee] : [])])].sort();
  const active = !isFilterEmpty(f);
  return (
    <search class="toolbar" data-testid="toolbar">
      <input
        class="input toolbar__search"
        type="search"
        value={f.q}
        placeholder={t("filters.search")}
        aria-label={t("filters.search")}
        data-testid="filter-text"
        onInput={(e) => updateFilters({ q: (e.currentTarget as HTMLInputElement).value })}
      />
      <TypeFilter types={props.types} />
      <input
        class="input toolbar__label"
        type="text"
        value={f.label}
        placeholder={t("filters.label")}
        aria-label={t("filters.label")}
        data-testid="filter-label"
        onInput={(e) => updateFilters({ label: (e.currentTarget as HTMLInputElement).value })}
      />
      <select
        class="select"
        value={f.assignee}
        aria-label={t("filters.assignee")}
        data-testid="filter-assignee"
        onChange={(e) => updateFilters({ assignee: (e.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">{t("filters.assignee.any")}</option>
        {assignees.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <fieldset class="pfilter" aria-label={t("filters.priority")}>
        {PRIORITIES.map((p) => {
          const on = f.priorities.includes(p);
          return (
            <button
              key={p}
              type="button"
              class="pfilter__btn"
              data-priority={p}
              aria-pressed={on}
              title={t(`priority.name.${p}`)}
              data-testid={`filter-priority-${p}`}
              onClick={() =>
                updateFilters({
                  priorities: on
                    ? f.priorities.filter((x) => x !== p)
                    : [...f.priorities, p].sort(),
                })
              }
            >
              {t(`priority.${p}`)}
            </button>
          );
        })}
      </fieldset>
      {active ? (
        <button
          type="button"
          class="btn btn--ghost"
          data-testid="filters-clear"
          onClick={() => setFilters({ ...EMPTY_FILTERS, epic: f.epic, query: f.query })}
        >
          {t("filters.clear")}
        </button>
      ) : null}
      {props.extra ?? null}
      <span class="toolbar__count" data-testid="filter-count">
        {active ? t("filters.matching", { shown: props.shown, total: props.total }) : props.total}
      </span>
    </search>
  );
}
