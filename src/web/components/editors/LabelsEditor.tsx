/**
 * Label chips with an "add" input (Enter or comma commits, Backspace on an empty input removes
 * the last chip). Suggestions come from the labels known to the snapshot (datalist).
 */
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { allIssues } from "../../state/snapshot.ts";

export interface LabelsEditorProps {
  value: readonly string[];
  onAdd: (label: string) => void;
  onRemove: (label: string) => void;
  disabled?: boolean | undefined;
  testId?: string | undefined;
}

let datalistSeq = 0;

export function LabelsEditor(props: LabelsEditorProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [listId] = useState(() => `labels-${++datalistSeq}`);
  const known = useMemo(() => {
    const out = new Set<string>();
    for (const row of allIssues.value) for (const l of row.labels ?? []) out.add(l);
    for (const l of props.value) out.delete(l);
    return [...out].sort();
  }, [props.value]);

  const commit = () => {
    const label = draft.trim().replace(/,$/, "").trim();
    if (!label) return;
    setDraft("");
    if (!props.value.includes(label)) props.onAdd(label);
  };

  return (
    <div class="labels-edit" data-testid={props.testId}>
      {props.value.map((label) => (
        <span key={label} class="chip chip--label chip--edit" title={label}>
          {label}
          {props.disabled ? null : (
            <button
              type="button"
              class="chip__x"
              aria-label={t("labels.remove", { label })}
              data-testid="label-remove"
              onClick={() => props.onRemove(label)}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {props.disabled ? null : (
        <>
          <input
            class="labels-edit__input"
            type="text"
            list={listId}
            value={draft}
            placeholder={t("labels.add")}
            aria-label={t("labels.add")}
            data-testid="label-input"
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              } else if (e.key === "Backspace" && !draft && props.value.length) {
                props.onRemove(props.value[props.value.length - 1] as string);
              }
            }}
            onBlur={commit}
          />
          <datalist id={listId}>
            {known.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}
