/**
 * Breadcrumb trail: every crumb but the last is a button (or a link when `href` is given);
 * the last one is the current position. Used for the board drill-down (All › epic › sub-epic)
 * and for the parent chain in the detail drawer.
 */
import type { JSX } from "preact";

export interface Crumb {
  key: string;
  label: string;
  /** Monospace id shown before the label (issue crumbs). */
  id?: string | undefined;
  title?: string | undefined;
  href?: string | undefined;
  onSelect?: (() => void) | undefined;
}

export interface BreadcrumbsProps {
  items: Crumb[];
  label: string;
  testId?: string | undefined;
  /** Compact variant for the drawer. */
  small?: boolean | undefined;
}

export function Breadcrumbs({ items, label, testId, small }: BreadcrumbsProps): JSX.Element {
  const last = items.length - 1;
  return (
    <nav class={`crumbs${small ? " crumbs--small" : ""}`} aria-label={label} data-testid={testId}>
      <ol class="crumbs__list">
        {items.map((crumb, index) => {
          const current = index === last;
          const inner = (
            <>
              {crumb.id ? <span class="crumbs__id mono">{crumb.id}</span> : null}
              <span class="crumbs__label ellipsis">{crumb.label}</span>
            </>
          );
          return (
            <li key={crumb.key} class="crumbs__item" data-testid="crumb">
              {current ? (
                <span class="crumbs__current" aria-current="page" title={crumb.title}>
                  {inner}
                </span>
              ) : crumb.href ? (
                <a
                  class="crumbs__link"
                  href={crumb.href}
                  title={crumb.title}
                  onClick={(e) => {
                    if (!crumb.onSelect) return;
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    crumb.onSelect();
                  }}
                >
                  {inner}
                </a>
              ) : (
                <button
                  type="button"
                  class="crumbs__link"
                  title={crumb.title}
                  onClick={crumb.onSelect}
                >
                  {inner}
                </button>
              )}
              {current ? null : (
                <span class="crumbs__sep" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
