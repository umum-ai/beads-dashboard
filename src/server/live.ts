/**
 * The ONE `events:watch` stream per database (bd limits concurrent streams:
 * `503 events_watch_saturated`), with reconnect and backoff; browsers get the fan-out.
 *
 * Checkpoint rules (plan 2.7, spec `watchEvents`): `since` = the last seq we applied. Before the
 * first connect the current `head` is probed with `GET events?since=0&limit=1`, then the owner
 * re-baselines and the stream starts from `head` — records between the probe and the baseline
 * are replayed, which is harmless (every record carries the full issue state).
 *
 * - `event: truncated` / `410 events_journal_truncated` → `since` = the problem's `head`, full
 *   re-baseline.
 * - `409 events_journal_disabled` → the workspace has no journal: polling only, probe again every
 *   poll interval.
 * - A reconnect after a gap longer than `longGapMs` → full re-baseline (retention may have
 *   pruned, `bd dolt pull` is never journaled).
 * - No frame (not even a heartbeat) for `staleMs` → the connection is considered dead.
 */
import { type BdClient, type EventRecord, ProblemError } from "../api-client/index.ts";
import type { Logger } from "./log.ts";

export type RebaselineReason =
  | "start"
  | "truncated"
  | "journal_disabled"
  | "reconnect"
  | "poll"
  | "restart";

export interface LiveStreamOptions {
  client: BdClient;
  log: Logger;
  /** Aborting stops the loop for good. */
  signal: AbortSignal;
  onRecord: (record: EventRecord, seq: number) => void;
  /** The stream is connected (`live: "sse"`). */
  onConnected: () => void;
  /** The stream is gone; polling keeps the snapshot fresh until it is back. */
  onDisconnected: (reason: string) => void;
  /** A full re-read is required. Awaited; failures are the owner's business. */
  onRebaseline: (reason: RebaselineReason) => Promise<void>;
  /** Retry interval when the journal is disabled (default: the poll interval). */
  disabledRetryMs: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  staleMs?: number;
  longGapMs?: number;
  now?: () => number;
}

/** `GET events?since=0&limit=1` → the current head, or where the journal starts after a prune. */
export type HeadProbe =
  | { kind: "ok"; head: number }
  | { kind: "truncated"; head: number }
  | { kind: "disabled" }
  | { kind: "error"; error: unknown; retryAfterMs?: number };

export async function probeHead(client: BdClient, signal?: AbortSignal): Promise<HeadProbe> {
  try {
    const page = await client.events(0, 1, signal ? { signal } : {});
    return { kind: "ok", head: Number(page.head ?? 0) };
  } catch (err) {
    if (err instanceof ProblemError) {
      if (err.code === "events_journal_disabled") return { kind: "disabled" };
      if (err.status === 410) return { kind: "truncated", head: headOf(err) ?? 0 };
      return err.retryAfterMs === undefined
        ? { kind: "error", error: err }
        : { kind: "error", error: err, retryAfterMs: err.retryAfterMs };
    }
    return { kind: "error", error: err };
  }
}

/** `head` extension of a `events_journal_truncated` problem, when present and sane. */
export function headOf(source: ProblemError | { head?: unknown }): number | undefined {
  const problem = source instanceof ProblemError ? source.problem : source;
  const head = Number((problem as { head?: unknown }).head);
  return Number.isSafeInteger(head) && head >= 0 ? head : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run until `signal` aborts. Never throws: every failure is logged, reported through
 * `onDisconnected` and retried with exponential backoff (1 s → 30 s).
 */
export async function runLiveStream(options: LiveStreamOptions): Promise<void> {
  const { client, log, signal } = options;
  const minMs = options.backoffMinMs ?? 1000;
  const maxMs = options.backoffMaxMs ?? 30_000;
  const staleMs = options.staleMs ?? 60_000;
  const longGapMs = options.longGapMs ?? 30_000;
  const now = options.now ?? Date.now;

  let since = -1; // unknown until the first head probe
  let attempt = 0;
  let disconnectedAt: number | null = null;
  let everConnected = false;

  while (!signal.aborted) {
    // 1. Checkpoint unknown (first run, or after the journal came back): probe the head first,
    //    then re-baseline, so nothing between the two is lost.
    if (since < 0) {
      const probe = await probeHead(client, signal);
      if (signal.aborted) return;
      if (probe.kind === "disabled") {
        log.info("events journal disabled on this bd serve; polling only", {
          retry_in_ms: options.disabledRetryMs,
        });
        await options.onRebaseline("journal_disabled").catch(() => {});
        options.onDisconnected("journal_disabled");
        await sleep(options.disabledRetryMs, signal);
        continue;
      }
      if (probe.kind === "error") {
        const delay = probe.retryAfterMs ?? Math.min(minMs * 2 ** attempt, maxMs);
        attempt++;
        log.warn("cannot read the events head; retrying", { error: probe.error, in_ms: delay });
        options.onDisconnected("head_probe_failed");
        await sleep(delay, signal);
        continue;
      }
      since = probe.head;
      await options.onRebaseline(everConnected ? "reconnect" : "start").catch(() => {});
      if (signal.aborted) return;
    }

    // 2. Stream.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let stale: ReturnType<typeof setTimeout> | null = null;
    const armStale = () => {
      if (stale) clearTimeout(stale);
      stale = setTimeout(() => {
        log.warn("events stream silent for too long; reconnecting", { stale_ms: staleMs });
        ctrl.abort();
      }, staleMs);
    };
    let connected = false;
    let reason = "stream_closed";
    try {
      armStale();
      for await (const ev of client.watchEvents({ since, signal: ctrl.signal })) {
        armStale();
        if (!connected) {
          connected = true;
          attempt = 0;
          const gap = disconnectedAt === null ? 0 : now() - disconnectedAt;
          disconnectedAt = null;
          everConnected = true;
          options.onConnected();
          log.info("events stream connected", { since, gap_ms: gap || undefined });
          if (gap > longGapMs) await options.onRebaseline("reconnect").catch(() => {});
        }
        switch (ev.type) {
          case "record":
            since = ev.seq;
            options.onRecord(ev.record, ev.seq);
            break;
          case "truncated": {
            const head = headOf(ev.problem);
            log.warn("events journal truncated; re-baselining", { since, head });
            since = head ?? -1;
            await options.onRebaseline("truncated").catch(() => {});
            reason = "truncated";
            break;
          }
          case "unknown":
            log.debug("ignoring unknown events frame", { event: ev.event });
            break;
          default:
            break; // heartbeat, retry
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ProblemError) {
        if (err.code === "events_journal_disabled") {
          since = -1; // back to the probe → re-baseline + polling retry
          reason = "journal_disabled";
        } else if (err.status === 410) {
          since = headOf(err) ?? -1;
          reason = "truncated";
          log.warn("events stream rejected the checkpoint (410); re-baselining", { since });
          await options.onRebaseline("truncated").catch(() => {});
        } else {
          reason = err.code;
          log.warn("events stream failed", { status: err.status, code: err.code });
        }
      } else if (ctrl.signal.aborted) {
        reason = "stale";
      } else {
        reason = "connection_error";
        log.warn("events stream error", { error: err });
      }
    } finally {
      if (stale) clearTimeout(stale);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) return;
    if (disconnectedAt === null) disconnectedAt = now();
    options.onDisconnected(reason);
    if (reason === "journal_disabled") continue; // the probe branch sleeps
    const delay = connected && reason !== "stale" ? minMs : Math.min(minMs * 2 ** attempt, maxMs);
    attempt++;
    log.debug("events stream reconnect scheduled", { in_ms: delay, reason });
    await sleep(delay, signal);
  }
}
