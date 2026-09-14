/**
 * Live status of the current database: how the snapshot is kept fresh (`sse`/`polling`/`none`),
 * the process state and the relative time of the last sync. Tone: ok / warn / danger / none.
 */
import type { JSX } from "preact";
import { locale, t } from "../i18n/index.ts";
import type { DatabaseInfo } from "../lib/bff-types.ts";
import { formatDateTime, formatRelative } from "../lib/time.ts";
import { databases, meta } from "../state/meta.ts";
import { currentDb } from "../state/route.ts";
import { type Connection, connection, dbInfo, disconnectedSince, now } from "../state/snapshot.ts";

export type LiveTone = "ok" | "warn" | "danger" | "none";

export interface LiveDescriptor {
  tone: LiveTone;
  label: string;
  tooltip: string;
  mode: string;
}

/** Pure mapping so the header and tests agree on the wording. */
export function describeLive(
  info: DatabaseInfo | null,
  conn: Connection,
  pollIntervalMs: number,
  /** Seconds since the server became unreachable (`disconnected` only). */
  offlineSeconds = 0,
): LiveDescriptor {
  if (conn === "disconnected") {
    return {
      tone: "danger",
      label:
        offlineSeconds >= 5
          ? t("live.disconnected.for", { seconds: offlineSeconds })
          : t("live.disconnected"),
      tooltip: t("live.tooltip.disconnected"),
      mode: "disconnected",
    };
  }
  if (!info) {
    return { tone: "none", label: t("live.connecting"), tooltip: "", mode: "connecting" };
  }
  if (info.state === "down") {
    return {
      tone: "danger",
      label: t("live.down"),
      tooltip: info.lastError ? `${t("state.down.body")}\n${info.lastError}` : t("state.down.body"),
      mode: "down",
    };
  }
  if (info.state === "starting") {
    return {
      tone: "warn",
      label: t("live.starting"),
      tooltip: t("state.starting.body"),
      mode: "starting",
    };
  }
  if (info.state === "degraded") {
    return {
      tone: "warn",
      label: t("live.degraded"),
      tooltip: t("state.degraded.body"),
      mode: "degraded",
    };
  }
  switch (info.live) {
    case "sse":
      return { tone: "ok", label: t("live.live"), tooltip: t("live.tooltip.sse"), mode: "sse" };
    case "polling":
      return {
        tone: "warn",
        label: t("live.polling"),
        tooltip: t("live.tooltip.polling", { seconds: Math.round(pollIntervalMs / 1000) }),
        mode: "polling",
      };
    default:
      return {
        tone: "danger",
        label: t("live.offline"),
        tooltip: t("live.tooltip.none"),
        mode: "none",
      };
  }
}

export function LiveIndicator(): JSX.Element | null {
  const db = currentDb.value;
  if (!db) return null;
  const info = dbInfo.value ?? databases.value.find((d) => d.name === db) ?? null;
  const since = disconnectedSince.value;
  const offline = since === null ? 0 : Math.max(0, Math.round((now.value - since) / 1000));
  const live = describeLive(info, connection.value, meta.value?.pollIntervalMs ?? 15_000, offline);
  const lang = locale.value;
  const when = info?.lastSyncAt
    ? t("live.lastSync", { when: formatRelative(info.lastSyncAt, now.value, lang) })
    : t("live.never");
  const tooltip = [
    live.tooltip,
    info?.lastSyncAt ? `${when} (${formatDateTime(info.lastSyncAt, lang)})` : when,
    info?.bdVersion ? `bd ${info.bdVersion}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <output
      class="live"
      data-tone={live.tone}
      data-mode={live.mode}
      data-testid="live-indicator"
      title={tooltip}
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${live.label}. ${when}`}
    >
      <span class="live__dot" aria-hidden="true" />
      <span class="live__label">{live.label}</span>
      <span class="live__when">{when}</span>
    </output>
  );
}
