/**
 * Searchable picker over the snapshot's issues (id or title substring), used for the parent
 * field and for adding `blocks` dependencies. Renders the chosen issue as a chip with a clear
 * button; the list opens under the input and follows the keyboard (arrows, Enter, Escape).
 */
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import type { BoardIssue } from "../../lib/bff-types.ts";
import { typeGlyph } from "../../lib/issue-meta.ts";
import { allIssues } from "../../state/snapshot.ts";
import { statusLabel } from "../Column.tsx";

export interface IssuePickerProps {
  /** Chosen id, or `""` for none. */
  value: string;
  onChange: (id: string) => void;
  /** Ids to hide (the issue itself, its current relations). */
  exclude?: readonly string[] | undefined;
  /** Keep only rows passing this test (e.g. epics for a parent picker — not enforced by bd). */
  filter?: ((row: BoardIssue) => boolean) | undefined;
  placeholder?: string | undefined;
  label: string;
  testId?: string | undefined;
  disabled?: boolean | undefined;
  /** Compact chip mode (inside the props grid) versus a full-width field. */
  compact?: boolean | undefined;
  autoFocus?: boolean | undefined;
}

const LIMIT = 12;

export function IssuePicker(props: IssuePickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const rows = allIssues.value;
  const chosen = props.value ? rows.find((r) => r.id === props.value) : undefined;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const excluded = new Set(props.exclude ?? []);
    const out: BoardIssue[] = [];
    for (const row of rows) {
      if (excluded.has(row.id) || row.id === props.value) continue;
      if (props.filter && !props.filter(row)) continue;
      if (needle && !`${row.id} ${row.title}`.toLowerCase().includes(needle)) continue;
      out.push(row);
      if (out.length >= LIMIT) break;
    }
    return out;
  }, [rows, query, props.exclude, props.filter, props.value]);

  const pick = (id: string) => {
    props.onChange(id);
    setQuery("");
    setOpen(false);
  };

  if (props.value) {
    return (
      <span class="picker picker--chosen" data-testid={props.testId}>
        <span class="rel rel--static">
          <span aria-hidden="true">{typeGlyph(chosen?.issue_type)}</span>
          <span class="mono">{props.value}</span>
          {chosen ? (
            <span class="rel__title ellipsis" title={chosen.title}>
              {chosen.title}
            </span>
          ) : null}
        </span>
        {props.disabled ? null : (
          <button
            type="button"
            class="icon-btn picker__clear"
            aria-label={t("picker.clear")}
            title={t("picker.clear")}
            data-testid={props.testId ? `${props.testId}-clear` : undefined}
            onClick={() => props.onChange("")}
          >
            ×
          </button>
        )}
      </span>
    );
  }

  return (
    <div class={`picker${props.compact ? " picker--compact" : ""}`} data-testid={props.testId}>
      <input
        class="input picker__input"
        type="text"
        role="combobox"
        aria-label={props.label}
        aria-expanded={open}
        aria-controls="picker-list"
        aria-autocomplete="list"
        placeholder={props.placeholder ?? t("picker.placeholder")}
        value={query}
        disabled={props.disabled}
        // biome-ignore lint/a11y/noAutofocus: opened on demand inside an editor
        autoFocus={props.autoFocus}
        data-testid={props.testId ? `${props.testId}-input` : undefined}
        onInput={(e) => {
          setQuery((e.currentTarget as HTMLInputElement).value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setCursor((c) => Math.min(c + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            const hit = matches[cursor];
            if (open && hit) {
              e.preventDefault();
              pick(hit.id);
            }
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open ? (
        <div class="picker__list" id="picker-list" role="listbox">
          {matches.length === 0 ? (
            <p class="picker__none">{t("picker.none")}</p>
          ) : (
            matches.map((row, index) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={index === cursor}
                class={`rel picker__option${index === cursor ? " picker__option--cursor" : ""}`}
                data-id={row.id}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(row.id)}
              >
                <span aria-hidden="true">{typeGlyph(row.issue_type)}</span>
                <span class="mono">{row.id}</span>
                <span class="rel__title ellipsis" title={row.title}>
                  {row.title}
                </span>
                <span class="rel__status">{statusLabel(row.status ?? "open")}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
