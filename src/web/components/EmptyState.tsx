/** Centered message for empty, loading and error states. */
import type { JSX } from "preact";

export interface EmptyStateProps {
  title: string;
  body?: string | undefined;
  detail?: string | undefined;
  loading?: boolean | undefined;
  action?: { label: string; onClick: () => void } | undefined;
  testId?: string | undefined;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <section
      class={`state${props.loading ? " state--loading" : ""}`}
      aria-busy={props.loading ? "true" : undefined}
      data-testid={props.testId ?? "empty-state"}
    >
      <h2 class="state__title">{props.title}</h2>
      {props.body ? <p class="state__body">{props.body}</p> : null}
      {props.detail ? <pre class="state__detail">{props.detail}</pre> : null}
      {props.action ? (
        <button type="button" class="btn" onClick={props.action.onClick}>
          {props.action.label}
        </button>
      ) : null}
    </section>
  );
}
