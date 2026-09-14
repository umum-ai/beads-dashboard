/** Shared e2e settings: the database under test and whether the target is the mock BFF. */
import type { APIRequestContext } from "@playwright/test";

export const DB = process.env.E2E_DB ?? "siam_platform";
export const MOCK = (process.env.E2E_TARGET ?? "mock") === "mock";

export type SnapshotIssue = { id: string; title: string; status: string; priority: number };

/** `GET /api/p/<db>/snapshot` — the rows the board is built from. */
export async function snapshot(
  request: APIRequestContext,
): Promise<{ seq: number; issues: SnapshotIssue[] }> {
  const res = await request.get(`/api/p/${DB}/snapshot`);
  if (!res.ok()) throw new Error(`snapshot: HTTP ${res.status()}`);
  return (await res.json()) as { seq: number; issues: SnapshotIssue[] };
}
