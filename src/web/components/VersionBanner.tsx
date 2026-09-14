/**
 * Warns when the current database's `bd serve` differs from the beads version bddb was built
 * for: `bd serve` and the CLI share the Dolt schema, so a mixed pair may fail on writes or
 * after a migration. Dismissed per tab (sessionStorage) — it comes back on the next visit.
 */
import type { JSX } from "preact";
import { t } from "../i18n/index.ts";
import { databases, meta } from "../state/meta.ts";
import { dismissedVersionWarning, dismissVersionWarning } from "../state/prefs.ts";
import { currentDb } from "../state/route.ts";
import { dbInfo } from "../state/snapshot.ts";

export const COMPATIBILITY_DOC =
  "https://github.com/umum-ai/beads-dashboard/blob/main/docs/compatibility.md";

export function VersionBanner(): JSX.Element | null {
  const db = currentDb.value;
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  const warning = info?.versionWarning;
  if (!warning || dismissedVersionWarning.value === warning) return null;
  const builtFor = meta.value?.bddb.builtForBeads ?? "";
  const bd = info?.bdVersion ?? "";
  return (
    <div class="banner banner--warn" role="status" data-testid="version-banner">
      <span class="banner__text">
        <strong>{t("banner.versionWarning.title", { bd, builtFor })}</strong>{" "}
        {t("banner.versionWarning.body")}{" "}
        <a href={COMPATIBILITY_DOC} target="_blank" rel="noreferrer">
          {t("banner.versionWarning.link")}
        </a>
      </span>
      <button
        type="button"
        class="btn btn--ghost"
        data-testid="version-banner-dismiss"
        onClick={() => dismissVersionWarning(warning)}
      >
        {t("banner.dismiss")}
      </button>
    </div>
  );
}
