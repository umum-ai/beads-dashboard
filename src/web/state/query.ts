/**
 * Query mode: the toolbar's `bd query` expression (`filters.query`, URL `?query=`) is sent to
 * `GET issues:query` and its result replaces the board's issue set. Rows that the live snapshot
 * also holds are taken from the snapshot, so deltas keep applying to them.
 */
import { computed, effect, signal } from "@preact/signals";
import { ApiError, api } from "../lib/api.ts";
import type { BoardIssue } from "../lib/bff-types.ts";
import { currentDb, filters } from "./route.ts";
import { board } from "./snapshot.ts";

export interface QueryResult {
  db: string;
  q: string;
  rows: BoardIssue[];
  hasMore: boolean;
}

export const queryResult = signal<QueryResult | null>(null);
export const queryLoading = signal(false);
export const queryError = signal<ApiError | null>(null);
/** The query strip is shown (toggled in the toolbar, or implied by `?query=`). */
export const queryOpen = signal(false);

let inflight = 0;

export async function runQuery(db: string, q: string): Promise<void> {
  const id = ++inflight;
  queryLoading.value = true;
  queryError.value = null;
  try {
    const page = await api.query(db, q);
    if (id !== inflight) return;
    queryResult.value = {
      db,
      q,
      rows: page.items.map((row) => ({ ...row, blocked: false })),
      hasMore: page.has_more,
    };
  } catch (err) {
    if (id !== inflight) return;
    queryResult.value = null;
    queryError.value =
      err instanceof ApiError
        ? err
        : new ApiError({
            type: "about:blank",
            code: "network_error",
            status: 0,
            title: "Network error",
            detail: err instanceof Error ? err.message : String(err),
            request_id: "",
          });
  } finally {
    if (id === inflight) queryLoading.value = false;
  }
}

/** Follows the URL: a non-empty `?query=` runs (once per db + expression); empty clears. */
if (typeof window !== "undefined") {
  effect(() => {
    const db = currentDb.value;
    const q = filters.value.query;
    if (!db || !q) {
      queryResult.value = null;
      queryError.value = null;
      return;
    }
    queryOpen.value = true;
    const current = queryResult.peek();
    if (current && current.db === db && current.q === q) return;
    void runQuery(db, q);
  });
}

/** Problem `400 param=q` → the text under the field; anything else → generic detail. */
export const queryErrorText = computed<string | null>(() => {
  const err = queryError.value;
  if (!err) return null;
  return err.problem.detail ?? err.problem.title ?? err.code;
});

/** Issue set in query mode: result rows, with live snapshot rows where present. */
export const queryIssues = computed<BoardIssue[] | null>(() => {
  const result = queryResult.value;
  if (!result) return null;
  const live = board.value.issues;
  return result.rows.map((row) => live.get(row.id) ?? row);
});
