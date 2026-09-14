/**
 * Non-blocking banners under the header:
 * - `ConnectionBanner`: the dashboard server has been unreachable for more than 10 s (the
 *   board stays visible with its last state; the header indicator already turned red);
 * - `DatabaseBanner`: the board has data but its database is `degraded` (Dolt unreachable
 *   behind `bd serve`) or `down` (`bd serve` not running) — says what to check, shows the
 *   server's last error line.
 * Without data these situations are full empty states instead (`BoardView`).
 */
import type { JSX } from "preact";
import { t } from "../i18n/index.ts";
import { databases } from "../state/meta.ts";
import { currentDb } from "../state/route.ts";
import { board, boardDb, dbInfo, disconnectedSince, now } from "../state/snapshot.ts";

export const DISCONNECT_BANNER_AFTER_MS = 10_000;

export function ConnectionBanner(): JSX.Element | null {
  const since = disconnectedSince.value;
  if (since === null) return null;
  const elapsed = now.value - since;
  if (elapsed < DISCONNECT_BANNER_AFTER_MS) return null;
  const seconds = Math.round(elapsed / 1000);
  return (
    <div class="banner banner--danger" role="status" data-testid="connection-banner">
      <span class="banner__text">{t("banner.disconnected", { seconds })}</span>
      <button type="button" class="btn btn--ghost" onClick={() => location.reload()}>
        {t("common.reload")}
      </button>
    </div>
  );
}

/** Hints shared by the banner and the full-page states, per database state. */
export function databaseHints(state: "degraded" | "down"): string[] {
  return state === "degraded"
    ? [t("state.degraded.hint.dolt"), t("state.degraded.hint.listener"), t("state.hint.doctor")]
    : [t("state.down.hint.log"), t("state.down.hint.dolt"), t("state.hint.doctor")];
}

export function DatabaseBanner(): JSX.Element | null {
  const db = currentDb.value;
  if (!db) return null;
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  if (!info || (info.state !== "degraded" && info.state !== "down")) return null;
  // Without data the board shows the full-page state; the banner is for a board that still has rows.
  if (boardDb.value !== db || board.value.seq < 0) return null;
  const text = info.state === "degraded" ? t("banner.degraded", { db }) : t("banner.down", { db });
  return (
    <div
      class={`banner banner--${info.state === "down" ? "danger" : "warn"}`}
      role="status"
      data-testid="db-banner"
      data-state={info.state}
    >
      <div class="banner__text">
        <span>{text}</span>{" "}
        <span class="banner__hint">{databaseHints(info.state).join(" · ")}</span>
        {info.lastError ? (
          <code class="banner__code" data-testid="db-banner-error">
            {info.lastError}
          </code>
        ) : null}
      </div>
    </div>
  );
}
