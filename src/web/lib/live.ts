/**
 * Live stream: one EventSource per displayed database. `snapshot` replaces the state, `delta`
 * is applied in sequence (a gap refetches `/snapshot`), `status` updates the database info.
 * EventSource reconnects on its own; every reconnect yields a fresh `snapshot` frame.
 */

import { updateDatabaseInfo } from "../state/meta.ts";
import {
  board,
  boardDb,
  boardError,
  boardLoading,
  connection,
  dbInfo,
  resetBoard,
} from "../state/snapshot.ts";
import { ApiError, api } from "./api.ts";
import type { DatabaseInfo, Delta, Snapshot } from "./bff-types.ts";
import { applyDelta, fromSnapshot } from "./delta.ts";

let source: EventSource | null = null;
let activeDb: string | null = null;
let refetching = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

export function connectLive(db: string): void {
  if (activeDb === db && source) return;
  disconnectLive();
  activeDb = db;
  resetBoard();
  boardLoading.value = true;
  connection.value = "connecting";

  if (typeof EventSource === "undefined") {
    void refetchSnapshot(db);
    return;
  }

  const es = new EventSource(api.eventsUrl(db));
  source = es;

  es.addEventListener("open", () => {
    if (db === activeDb) connection.value = "open";
  });
  es.addEventListener("error", () => {
    if (db !== activeDb) return;
    connection.value = es.readyState === EventSource.CLOSED ? "disconnected" : "connecting";
    // A stream that never opens (e.g. the server does not implement SSE) still needs data.
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

export function disconnectLive(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  source?.close();
  source = null;
  activeDb = null;
  connection.value = "idle";
}
