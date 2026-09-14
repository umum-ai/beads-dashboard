/**
 * Advanced search strip under the toolbar: a `bd query` expression, run against
 * `GET issues:query`. The expression lives in the URL (`?query=`); while a result is active the
 * strip doubles as the "query mode" banner with a Clear button. A `400 param=q` shows its
 * `detail` under the field.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t, tOr } from "../i18n/index.ts";
import {
  queryError,
  queryErrorText,
  queryLoading,
  queryOpen,
  queryResult,
} from "../state/query.ts";
import { filters, updateFilters } from "../state/route.ts";

export function QueryToggle(): JSX.Element {
  const on = queryOpen.value;
  return (
    <button
      type="button"
      class="btn btn--toggle"
      aria-pressed={on}
      title={t("query.toggle.help")}
      data-testid="query-toggle"
      onClick={() => {
        if (on && filters.value.query) updateFilters({ query: "" });
        queryOpen.value = !on;
      }}
    >
      <span class="btn__dot" aria-hidden="true" />
      {t("query.toggle")}
    </button>
  );
}

export function QueryBar(): JSX.Element | null {
  const active = filters.value.query;
  const [draft, setDraft] = useState(active);
  useEffect(() => setDraft(active), [active]);
  if (!queryOpen.value) return null;
  const err = queryError.value;
  const errorText = queryErrorText.value;
  const result = queryResult.value;
  const submit = (event: Event) => {
    event.preventDefault();
    const q = draft.trim();
    if (q) updateFilters({ query: q });
    else updateFilters({ query: "" });
  };
  return (
    <form
      class={`querybar${result ? " querybar--active" : ""}`}
      data-testid="query-bar"
      onSubmit={submit}
    >
      <label class="querybar__label" for="query-input">
        {t("query.label")}
      </label>
      <input
        id="query-input"
        class="input mono querybar__input"
        type="text"
        value={draft}
        placeholder={t("query.placeholder")}
        aria-invalid={err ? "true" : undefined}
        aria-describedby={err ? "query-error" : undefined}
        data-testid="query-input"
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        spellcheck={false}
      />
      <button
        type="submit"
        class="btn btn--primary"
        disabled={queryLoading.value}
        data-testid="query-run"
      >
        {queryLoading.value ? t("query.running") : t("query.run")}
      </button>
      {active ? (
        <button
          type="button"
          class="btn btn--ghost"
          data-testid="query-clear"
          onClick={() => {
            setDraft("");
            updateFilters({ query: "" });
          }}
        >
          {t("query.clear")}
        </button>
      ) : null}
      {result ? (
        <span class="querybar__status" data-testid="query-status">
          {t("query.mode", { count: result.rows.length })}
          {result.hasMore ? ` ${t("query.truncated")}` : ""}
        </span>
      ) : null}
      {err ? (
        <p class="querybar__error" id="query-error" role="alert" data-testid="query-error">
          <strong>{tOr(`error.${err.code}.title`, err.problem.title ?? err.code)}</strong>
          {errorText ? ` — ${errorText}` : ""}
        </p>
      ) : null}
    </form>
  );
}
