/**
 * One board card. The title is a real link to the issue route; the whole card is clickable
 * for mouse users. The id is a button that copies itself. Drag handles arrive in stage 5.
 */
import type { JSX } from "preact";
import { t, tOr } from "../i18n/index.ts";
import type { BoardIssue } from "../lib/bff-types.ts";
import { clampPriority } from "../lib/board.ts";
import { copyText } from "../lib/clipboard.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { hrefFor, navigate } from "../state/route.ts";
import { childStats } from "../state/snapshot.ts";
import { pushToast } from "../state/toasts.ts";

export interface CardProps {
  db: string;
  issue: BoardIssue;
  done: boolean;
}

export async function copyId(id: string): Promise<void> {
  const ok = await copyText(id);
  if (ok) pushToast("success", t("toast.copied", { id }), 2500);
  else pushToast("error", t("detail.copyFailed"));
}

export function typeLabel(type: string | undefined): string {
  const key = type ?? "task";
  return tOr(`type.${key}`, key);
}

export function Card({ db, issue, done }: CardProps): JSX.Element {
  const priority = clampPriority(issue.priority);
  const type = issue.issue_type ?? "task";
  const target = { kind: "issue" as const, db, issueId: issue.id };
  const derived = childStats.value.get(issue.id);
  const total = issue.child_count ?? issue.epic_total_children ?? derived?.total ?? 0;
  const closed = issue.child_closed_count ?? issue.epic_closed_children ?? derived?.closed ?? 0;
  const showProgress = total > 0 || type === "epic";
  const labels = issue.labels ?? [];

  // Mouse users may click anywhere on the card; keyboard users use the title link.
  const open = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    navigate(target);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link inside is the keyboard target
    <article
      class={`card${issue.blocked ? " card--blocked" : ""}${done ? " card--done" : ""}`}
      data-testid="card"
      data-id={issue.id}
      data-priority={priority}
      onClick={open}
    >
      <div class="card__top">
        <span class="card__type" title={typeLabel(type)} role="img" aria-label={typeLabel(type)}>
          {typeGlyph(type)}
        </span>
        <button
          type="button"
          class="card__id mono"
          title={t("card.copyId", { id: issue.id })}
          aria-label={t("card.copyId", { id: issue.id })}
          data-testid="card-id"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copyId(issue.id);
          }}
        >
          {issue.id}
        </button>
        <span class="card__spacer" />
        {issue.blocked ? (
          <span class="chip chip--blocked" title={t("card.blocked.help")}>
            {t("card.blocked")}
          </span>
        ) : null}
        <span class="pchip" title={t(`priority.name.${priority}`)}>
          {t(`priority.${priority}`)}
        </span>
      </div>
      <a
        class="card__title"
        href={hrefFor(target)}
        title={issue.title}
        data-testid="card-title"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          navigate(target);
        }}
      >
        {issue.title}
      </a>
      {labels.length || showProgress || issue.assignee ? (
        <div class="card__meta">
          {labels.length ? (
            <span class="card__labels">
              {labels.map((label) => (
                <span key={label} class="chip chip--label" title={label}>
                  {label}
                </span>
              ))}
            </span>
          ) : null}
          {showProgress ? (
            <span
              class="card__progress"
              title={t("card.epicProgress", { closed, total })}
              data-testid="epic-progress"
            >
              <span class="card__bar" aria-hidden="true">
                <i style={{ width: `${total ? Math.round((closed / total) * 100) : 0}%` }} />
              </span>
              {closed}/{total}
            </span>
          ) : null}
          {issue.assignee ? (
            <span class="card__assignee ellipsis" title={issue.assignee}>
              {issue.assignee}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
