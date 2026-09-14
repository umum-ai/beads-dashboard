/** Epics view placeholder (stage 4 builds the real one): lists the snapshot's epics. */
import type { JSX } from "preact";
import { statusLabel } from "../components/Column.tsx";
import { t } from "../i18n/index.ts";
import { compareCards } from "../lib/board.ts";
import { typeGlyph } from "../lib/issue-meta.ts";
import { hrefFor, onLinkClick } from "../state/route.ts";
import { allIssues, childStats } from "../state/snapshot.ts";

export function EpicsView({ db }: { db: string }): JSX.Element {
  const epics = allIssues.value.filter((row) => row.issue_type === "epic").sort(compareCards);
  return (
    <div class="page" data-testid="epics-view">
      <h1 class="page__title">{t("epics.title")}</h1>
      <p class="page__lead">{t("epics.placeholder")}</p>
      <p class="page__lead">{t("epics.count", { count: epics.length })}</p>
      <ul class="epic-list">
        {epics.map((epic) => {
          const derived = childStats.value.get(epic.id);
          const total = epic.epic_total_children ?? derived?.total ?? 0;
          const closed = epic.epic_closed_children ?? derived?.closed ?? 0;
          const target = { kind: "issue" as const, db, issueId: epic.id };
          return (
            <li key={epic.id} class="epic-list__item" data-priority={epic.priority}>
              <span aria-hidden="true">{typeGlyph("epic")}</span>
              <span class="mono">{epic.id}</span>
              <a class="ellipsis" href={hrefFor(target)} onClick={(e) => onLinkClick(e, target)}>
                {epic.title}
              </a>
              <span class="header__spacer" />
              <span class="chip">{statusLabel(epic.status ?? "open")}</span>
              <span class="card__progress" title={t("card.epicProgress", { closed, total })}>
                <span class="card__bar" aria-hidden="true">
                  <i style={{ width: `${total ? Math.round((closed / total) * 100) : 0}%` }} />
                </span>
                {closed}/{total}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
