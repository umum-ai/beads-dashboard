/**
 * Live stream: one EventSource per displayed database. `snapshot` replaces the state, `delta`
 * is applied in sequence (a gap refetches `/snapshot`), `status` updates the database info.
 *
 * Reconnects: on a network failure EventSource retries by itself (readyState CONNECTING); when
 * the server refuses the stream (`503 bddb_not_ready` while the database is starting or down,
 * or the process is gone) the browser gives up (CLOSED) and we reopen it ourselves with a
 * backoff, probing `/api/meta` on the way so the header shows whether the dashboard server or
 * only its database is unreachable. Every reconnect yields a fresh `snapshot` frame.
 */

import { meta, updateDatabaseInfo } from "../state/meta.ts";
import {
  board,
  boardDb,
  boardError,
  boardLoading,
  connection,
  dbInfo,
  disconnectedSince,
  resetBoard,
} from "../state/snapshot.ts";
import { ApiError, api } from "./api.ts";
import type { DatabaseInfo, Delta, Snapshot } from "./bff-types.ts";
import { applyDelta, fromSnapshot } from "./delta.ts";

let source: EventSource | null = null;
let activeDb: string | null = null;
let refetching = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 15_000;

/** Problem codes that mean "come back later" rather than "something is wrong". */
const RETRY_CODES = new Set(["bddb_not_ready", "db_unavailable", "busy"]);

export function isRetryable(err: unknown): err is ApiError {
  return err instanceof ApiError && RETRY_CODES.has(err.code);
}

function parse<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(String(event.data)) as T;
  } catch {
    return null;
  }
}

function markConnected(): void {
  connection.value = "open";
  disconnectedSince.value = null;
  reconnectAttempt = 0;
}

function markDisconnected(): void {
  connection.value = "disconnected";
  if (disconnectedSince.value === null) disconnectedSince.value = Date.now();
}

function acceptSnapshot(db: string, snapshot: Snapshot): void {
  if (db !== activeDb) return;
  board.value = fromSnapshot(snapshot);
  boardDb.value = db;
  boardLoading.value = false;
  boardError.value = null;
  dbInfo.value = snapshot.database;
  updateDatabaseInfo(snapshot.database);
}

/** Fetch `/snapshot` over HTTP; used for the first paint and after a sequence gap. */
export async function refetchSnapshot(db: string): Promise<void> {
  if (refetching) return;
  refetching = true;
  try {
    const snapshot = await api.snapshot(db);
    acceptSnapshot(db, snapshot);
  } catch (err) {
    if (db === activeDb) {
      boardError.value = err;
      boardLoading.value = false;
      // A database that is still starting answers 503 bddb_not_ready: retry after Retry-After.
      if (isRetryable(err) && !retryTimer) {
        retryTimer = setTimeout(
          () => {
            retryTimer = null;
            if (db === activeDb && board.value.seq < 0) void refetchSnapshot(db);
          },
          Math.min(Math.max(err.retryAfterMs ?? 3000, 1000), 30_000),
        );
      }
    }
  } finally {
    refetching = false;
  }
}

/**
 * The stream was refused or the server vanished: find out which. A reachable `/api/meta`
 * means the dashboard server is fine and only the database is not ready — its state (and
 * `lastError`) come from meta; otherwise the server itself is unreachable.
 */
async function probeServer(db: string): Promise<void> {
  try {
    const m = await api.meta();
    if (db !== activeDb) return;
    meta.value = m;
    const info = m.databases.find((d) => d.name === db);
    if (info) dbInfo.value = info;
    connection.value = "closed";
    disconnectedSince.value = null;
  } catch {
    if (db === activeDb) markDisconnected();
  }
}

function scheduleReconnect(db: string): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_MIN_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (db === activeDb) openStream(db);
  }, delay);
}

function openStream(db: string): void {
  source?.close();
  const es = new EventSource(api.eventsUrl(db));
  source = es;
  if (connection.value !== "disconnected") connection.value = "connecting";

  es.addEventListener("open", () => {
    if (db === activeDb) markConnected();
  });
  es.addEventListener("error", () => {
    if (db !== activeDb || source !== es) return;
    if (es.readyState === EventSource.CLOSED) {
      // Refused (503 while starting/down) or the server is gone: probe, then reopen ourselves.
      void probeServer(db);
      scheduleReconnect(db);
    } else {
      // Network failure; the browser is already retrying.
      markDisconnected();
    }
    // A stream that never opened still needs data for the first paint.
    if (board.value.seq < 0 && !boardError.value) void refetchSnapshot(db);
  });
  es.addEventListener("snapshot", (event) => {
    const snapshot = parse<Snapshot>(event as MessageEvent);
    if (snapshot) acceptSnapshot(db, snapshot);
  });
  es.addEventListener("delta", (event) => {
    if (db !== activeDb) return;
    const delta = parse<Delta>(event as MessageEvent);
    if (!delta) return;
    const result = applyDelta(board.value, delta);
    if (result.ok) board.value = result.state;
    else if (result.reason === "gap") void refetchSnapshot(db);
  });
  es.addEventListener("status", (event) => {
    if (db !== activeDb) return;
    const info = parse<DatabaseInfo>(event as MessageEvent);
    if (!info) return;
    dbInfo.value = info;
    updateDatabaseInfo(info);
  });
}

export function connectLive(db: string): void {
  if (activeDb === db && source) return;
  disconnectLive();
  activeDb = db;
  resetBoard();
  boardLoading.value = true;
  connection.value = "connecting";
  disconnectedSince.value = null;
  reconnectAttempt = 0;

  if (typeof EventSource === "undefined") {
    void refetchSnapshot(db);
    return;
  }
  openStream(db);
}

export function disconnectLive(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();
  source = null;
  activeDb = null;
  connection.value = "idle";
  disconnectedSince.value = null;
}
