/**
 * Centered message for empty, loading and error states. An empty state gives a direction:
 * what this is, why it is empty, and the one action that changes it (`action`); `hints` list
 * what to check when the cause is outside the browser (mirrors `bddb doctor`).
 */
import type { JSX } from "preact";

export interface StateAction {
  label: string;
  onClick: () => void;
  testId?: string | undefined;
}

export interface EmptyStateProps {
  title: string;
  body?: string | undefined;
  /** Monospace block: the raw error / last log line. */
  detail?: string | undefined;
  /** Things to check, one per line. */
  hints?: readonly string[] | undefined;
  loading?: boolean | undefined;
  action?: StateAction | undefined;
  secondary?: StateAction | undefined;
  tone?: "neutral" | "danger" | "warn" | undefined;
  testId?: string | undefined;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const classes = ["state"];
  if (props.loading) classes.push("state--loading");
  if (props.tone && props.tone !== "neutral") classes.push(`state--${props.tone}`);
  return (
    <section
      class={classes.join(" ")}
      aria-busy={props.loading ? "true" : undefined}
      aria-live={props.loading ? "polite" : undefined}
      data-testid={props.testId ?? "empty-state"}
    >
      {props.loading ? <span class="spinner" aria-hidden="true" /> : null}
      <h2 class="state__title">{props.title}</h2>
      {props.body ? <p class="state__body">{props.body}</p> : null}
      {props.detail ? <pre class="state__detail">{props.detail}</pre> : null}
      {props.hints && props.hints.length > 0 ? (
        <ul class="state__hints">
          {props.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      ) : null}
      {props.action || props.secondary ? (
        <div class="state__actions">
          {props.action ? (
            <button
              type="button"
              class="btn btn--primary"
              data-testid={props.action.testId}
              onClick={props.action.onClick}
            >
              {props.action.label}
            </button>
          ) : null}
          {props.secondary ? (
            <button
              type="button"
              class="btn"
              data-testid={props.secondary.testId}
              onClick={props.secondary.onClick}
            >
              {props.secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
