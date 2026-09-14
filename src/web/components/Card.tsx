/**
 * One board card. The title is a real link to the issue route; the whole card is clickable
 * for mouse users. The id is a button that copies itself. The card is a pragmatic-dnd
 * draggable (a selected card drags the whole selection); Shift / Ctrl-click toggles selection.
 * The "⋯" menu is the keyboard alternative to dragging (move to status, set priority).
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t, tOr } from "../i18n/index.ts";
import type { BoardIssue } from "../lib/bff-types.ts";
import { clampPriority, PRIORITIES } from "../lib/board.ts";
import { copyText } from "../lib/clipboard.ts";
import { useDraggableCard } from "../lib/dnd.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { setPriority, setStatus } from "../state/actions.ts";
import { hrefFor, navigate } from "../state/route.ts";
import { cardLanes, isSelected, pending, toggleSelected } from "../state/selection.ts";
import { board, childStats } from "../state/snapshot.ts";
import { pushToast } from "../state/toasts.ts";
import { statusLabel } from "./Column.tsx";
import { Menu, MenuGroup, MenuItem } from "./Menu.tsx";

export interface CardProps {
  db: string;
  issue: BoardIssue;
  done: boolean;
  /** Swimlane key the card is rendered in (`""` = no-epic lane); absent on the flat board. */
  lane?: string | undefined;
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

function CardMenu({ db, issue }: { db: string; issue: BoardIssue }): JSX.Element {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const statuses = board.value.statuses;
  const current = issue.status ?? "open";
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={button}
        type="button"
        class="card__menu icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("card.menu", { id: issue.id })}
        title={t("card.menu.help")}
        data-testid="card-menu"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ⋯
      </button>
      <Menu
        open={open}
        onClose={close}
        anchor={button}
        label={t("card.menu", { id: issue.id })}
        testId="card-menu-panel"
      >
        <MenuGroup title={t("card.menu.moveTo")}>
          {statuses.map((s) => (
            <MenuItem
              key={s.name}
              current={s.name === current}
              testId={`menu-status-${s.name}`}
              onSelect={() => {
                close();
                if (s.name !== current) void setStatus(db, issue.id, s.name);
              }}
            >
              <span class="menu__dot" data-category={s.category} aria-hidden="true" />
              {statusLabel(s.name)}
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuGroup title={t("card.menu.setPriority")}>
          {PRIORITIES.map((p) => (
            <MenuItem
              key={p}
              current={p === clampPriority(issue.priority)}
              testId={`menu-priority-${p}`}
              onSelect={() => {
                close();
                if (p !== issue.priority) void setPriority(db, issue.id, p);
              }}
            >
              <span class="pchip pchip--outline" data-priority={p}>
                {t(`priority.${p}`)}
              </span>
              {t(`priority.name.${p}`)}
            </MenuItem>
          ))}
        </MenuGroup>
      </Menu>
    </>
  );
}

export function Card({ db, issue, done, lane }: CardProps): JSX.Element {
  const priority = clampPriority(issue.priority);
  const type = issue.issue_type ?? "task";
  const target = { kind: "issue" as const, db, issueId: issue.id };
  const derived = childStats.value.get(issue.id);
  const total = issue.child_count ?? issue.epic_total_children ?? derived?.total ?? 0;
  const closed = issue.child_closed_count ?? issue.epic_closed_children ?? derived?.closed ?? 0;
  const showProgress = total > 0 || type === "epic";
  const labels = issue.labels ?? [];
  const ref = useRef<HTMLElement>(null);
  const isPending = pending.value.has(issue.id);
  const isDragging = useDraggableCard(ref, issue.id, !isPending);
  const selected = isSelected(issue.id);
  useEffect(() => {
    if (lane === undefined) cardLanes.delete(issue.id);
    else cardLanes.set(issue.id, lane);
  }, [issue.id, lane]);

  // Mouse users may click anywhere on the card; keyboard users use the title link.
  // Shift / Ctrl / Cmd-click toggles the card in the multi-selection instead of opening it.
  const open = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      toggleSelected(issue.id);
      return;
    }
    if (event.altKey) return;
    navigate(target);
  };

  const classes = ["card"];
  if (issue.blocked) classes.push("card--blocked");
  if (done) classes.push("card--done");
  if (isDragging) classes.push("card--dragging");
  if (selected) classes.push("card--selected");
  if (isPending) classes.push("card--pending");

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the title link inside is the keyboard target
    <article
      ref={ref}
      class={classes.join(" ")}
      data-testid="card"
      data-id={issue.id}
      data-priority={priority}
      data-status={issue.status ?? "open"}
      data-selected={selected ? "true" : undefined}
      aria-busy={isPending ? "true" : undefined}
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
        <span class="pchip" title={t(`priority.name.${priority}`)} data-testid="card-priority">
          {t(`priority.${priority}`)}
        </span>
        <CardMenu db={db} issue={issue} />
      </div>
      <a
        class="card__title"
        href={hrefFor(target)}
        title={issue.title}
        data-testid="card-title"
        draggable={false}
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
