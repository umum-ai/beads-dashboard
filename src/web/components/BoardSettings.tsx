/**
 * Board settings (the gear in the header), per database: which status columns the board shows
 * and how far back the Closed column reaches. Both persist in localStorage keyed by database
 * (`state/prefs.ts`); the logic is in `lib/columns.ts`. Opened with the button or `,`.
 */
import { signal } from "@preact/signals";
import type { JSX } from "preact";
import { t } from "../i18n/index.ts";
import {
  CLOSED_HOURS_OPTIONS,
  effectiveClosedHours,
  toggleColumn,
  visibleStatuses,
} from "../lib/columns.ts";
import { meta } from "../state/meta.ts";
import {
  setClosedHours,
  setVisibleColumns,
  storedClosedHours,
  storedColumns,
  visibleColumnsPref,
} from "../state/prefs.ts";
import { board, boardDb } from "../state/snapshot.ts";
import { closedPeriodLabel, statusLabel } from "./Column.tsx";
import { Popover } from "./Popover.tsx";

export const settingsOpen = signal(false);

export function openSettings(): void {
  settingsOpen.value = true;
}

export function closeSettings(): void {
  settingsOpen.value = false;
}

export function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}

function GearIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M3.5 12.5l1.2-1.2M11.3 4.7l1.2-1.2"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
      <circle
        cx="8"
        cy="8"
        r="5"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="2.6 1.35"
      />
    </svg>
  );
}

export function BoardSettings({ db }: { db: string }): JSX.Element {
  const open = settingsOpen.value;
  const serverHours = meta.value?.closedHours ?? 72;
  const hasSnapshot = boardDb.value === db && board.value.seq >= 0;
  const statuses = hasSnapshot ? board.value.statuses : [];
  const stored = storedColumns(db);
  const shown = new Set(visibleStatuses(statuses, stored).map((s) => s.name));
  const hours = effectiveClosedHours(storedClosedHours(db), serverHours);
  const capped = CLOSED_HOURS_OPTIONS.some((h) => h > serverHours);
  const customised = visibleColumnsPref.value[db] !== undefined;

  return (
    <Popover
      open={open}
      onClose={closeSettings}
      label={t("settings.open", { db })}
      testId="settings-popover"
      trigger={
        <button
          type="button"
          class="icon-btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("settings.open", { db })}
          title={t("settings.title")}
          data-testid="settings-button"
          onClick={toggleSettings}
        >
          <GearIcon />
        </button>
      }
    >
      <div class="settings" data-testid="settings">
        <header class="settings__head">
          <p class="pop__title settings__title">{t("settings.title")}</p>
          <span class="settings__db mono ellipsis" title={db}>
            {db}
          </span>
        </header>
        <section class="settings__group" aria-labelledby="settings-columns">
          <div class="settings__row">
            <h3 class="settings__h" id="settings-columns">
              {t("settings.columns")}
            </h3>
            <span class="settings__count" data-testid="settings-columns-count">
              {t("settings.columns.count", { shown: shown.size, total: statuses.length })}
            </span>
          </div>
          {statuses.length === 0 ? (
            <p class="pop__help">{t("settings.columns.waiting")}</p>
          ) : (
            <ul class="settings__list">
              {statuses.map((s, i) => (
                <li key={s.name}>
                  <label class="check settings__check" data-category={s.category}>
                    <input
                      type="checkbox"
                      checked={shown.has(s.name)}
                      data-autofocus={i === 0 ? true : undefined}
                      data-testid={`settings-column-${s.name}`}
                      onChange={(e) =>
                        setVisibleColumns(
                          db,
                          toggleColumn(
                            stored,
                            s.name,
                            (e.currentTarget as HTMLInputElement).checked,
                          ),
                        )
                      }
                    />
                    <span class="settings__dot" aria-hidden="true" />
                    <span class="ellipsis">{statusLabel(s.name)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p class="pop__help settings__help">{t("settings.columns.help")}</p>
          <button
            type="button"
            class="btn btn--ghost settings__reset"
            disabled={!customised}
            data-testid="settings-columns-reset"
            onClick={() => setVisibleColumns(db, null)}
          >
            {t("settings.columns.reset")}
          </button>
        </section>
        <section class="settings__group">
          <label class="settings__row settings__select">
            <span class="settings__h">{t("settings.closed")}</span>
            <select
              class="select"
              value={String(hours)}
              data-testid="settings-closed-hours"
              onChange={(e) =>
                setClosedHours(db, Number((e.currentTarget as HTMLSelectElement).value))
              }
            >
              {CLOSED_HOURS_OPTIONS.map((h) => (
                <option key={h} value={String(h)} disabled={h > serverHours}>
                  {closedPeriodLabel(h)}
                </option>
              ))}
            </select>
          </label>
          {capped ? (
            <p class="pop__help settings__help" data-testid="settings-closed-cap">
              {t("settings.closed.serverCap", { hours: serverHours })}
            </p>
          ) : null}
        </section>
      </div>
    </Popover>
  );
}
