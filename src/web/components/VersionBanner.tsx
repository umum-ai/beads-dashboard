/** Warns when the current database's bd version differs from what bddb was built for. */
import type { JSX } from "preact";
import { t } from "../i18n/index.ts";
import { databases } from "../state/meta.ts";
import { dismissedVersionWarning, dismissVersionWarning } from "../state/prefs.ts";
import { currentDb } from "../state/route.ts";
import { dbInfo } from "../state/snapshot.ts";

export function VersionBanner(): JSX.Element | null {
  const db = currentDb.value;
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  const warning = info?.versionWarning;
  if (!warning || dismissedVersionWarning.value === warning) return null;
  return (
    <div class="banner" role="status" data-testid="version-banner">
      <span class="banner__text">{t("banner.versionWarning", { warning })}</span>
      <button type="button" class="btn btn--ghost" onClick={() => dismissVersionWarning(warning)}>
        {t("banner.dismiss")}
      </button>
    </div>
  );
}
