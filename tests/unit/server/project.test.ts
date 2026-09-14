/**
 * DatabaseRuntime against a fake `bd serve` (a `fetch` function): the sync rules of
 * project.ts — baseline vs. live-record races (H1), flush serialisation (M3), re-read fan-out
 * cap and watchdog classification (M5), duplicate records (L1), `lastSyncAt` (L3).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  BdClient,
  type Context,
  type EventRecord,
  type IssueWithCounts,
  ProblemError,
} from "../../../src/api-client/index.ts";
import { loadConfig } from "../../../src/server/config.ts";
import { silentLogger } from "../../../src/server/log.ts";
import {
  DatabaseRuntime,
  isDbUnavailable,
  REFETCH_CONCURRENCY,
  settleWithLimit,
} from "../../../src/server/project.ts";
import type { BoardIssue, Delta, Snapshot, StreamEvent } from "../../../src/server/types.ts";

// ------------------------------------------------------------------ fake bd serve

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function problem(status: number, code: string, detail = code): Response {
  return new Response(JSON.stringify({ code, status, title: code, detail, request_id: "r" }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function row(id: string, extra: Partial<IssueWithCounts> = {}): IssueWithCounts {
  return {
    id,
    title: `Issue ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-09-14T10:00:00Z",
    updated_at: "2026-09-14T10:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...extra,
  } as IssueWithCounts;
}

function record(seq: number, op: EventRecord["op"], issue: IssueWithCounts): EventRecord {
  return { seq, ts: "t", op, issue_id: issue.id, issue } as unknown as EventRecord;
}

class FakeBd {
  rows = new Map<string, IssueWithCounts>();
  ready = new Set<string>();
  head = 10;
  requests: string[] = [];
  /** Awaited before the default (active) listing answers; rows are captured before the wait. */
  listGate: Promise<void> | null = null;
  /** Called per `GET ready`; may delay or replace the answer. */
  readyHook: ((n: number) => Promise<Response | null>) | null = null;
  /** Called per `GET issues/{id}`; may delay or replace the answer. */
  getIssueHook: ((id: string) => Promise<Response | null>) | null = null;
  /** Checked first for every request; a Response short-circuits the fake. */
  intercept: ((path: string) => Response | null) | null = null;
  concurrentGetIssue = 0;
  maxConcurrentGetIssue = 0;
  readyCalls = 0;
  private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname;
    this.requests.push(`${p}${url.search}`);
    const intercepted = this.intercept?.(p);
    if (intercepted) return intercepted;
    if (p.endsWith("/config/status.custom")) return json({ key: "status.custom", redacted: false });
    if (p.endsWith("/config/types.custom")) return json({ key: "types.custom", redacted: false });
    if (p.endsWith("/events:watch")) return this.sse(init?.signal ?? null);
    if (p.endsWith("/events")) return json({ records: [], head: this.head });
    if (p.endsWith("/issues")) {
      const statuses = url.searchParams.getAll("status");
      const items = statuses.length > 0 ? [] : [...this.rows.values()];
      if (statuses.length === 0 && this.listGate) await this.listGate;
      return json({ items, has_more: false });
    }
    if (p.endsWith("/issues:query")) return json({ items: [], has_more: false });
    if (p.endsWith("/ready")) {
      const n = ++this.readyCalls;
      const replaced = this.readyHook ? await this.readyHook(n) : null;
      if (replaced) return replaced;
      return json({ items: [...this.ready].map((id) => ({ id })), has_more: false });
    }
    if (p.endsWith("/stats")) {
      return json({ summary: { total_issues: this.rows.size, open_issues: this.rows.size } });
    }
    const detail = /\/issues\/([^/]+)$/.exec(p);
    if (detail) {
      const id = decodeURIComponent(detail[1] ?? "");
      this.concurrentGetIssue++;
      this.maxConcurrentGetIssue = Math.max(this.maxConcurrentGetIssue, this.concurrentGetIssue);
      try {
        const replaced = this.getIssueHook ? await this.getIssueHook(id) : null;
        if (replaced) return replaced;
        const r = this.rows.get(id);
        if (!r) return problem(404, "not_found");
        return json({ ...r, revision: "1", dependencies: [], dependents: [] });
      } finally {
        this.concurrentGetIssue--;
      }
    }
    return problem(404, "not_found", p);
  }) as unknown as typeof fetch;

  private sse(signal: AbortSignal | null): Response {
    const controllers = this.controllers;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retry: 3000\n\n"));
        controllers.add(controller);
        signal?.addEventListener(
          "abort",
          () => {
            controllers.delete(controller);
            try {
              controller.close();
            } catch {
              /* closed */
            }
          },
          { once: true },
        );
      },
      cancel(controller) {
        controllers.delete(controller as ReadableStreamDefaultController<Uint8Array>);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  get streams(): number {
    return this.controllers.size;
  }

  /** Push one journal record to every open `events:watch` stream. */
  emit(rec: EventRecord): void {
    const bytes = new TextEncoder().encode(`id: ${rec.seq}\ndata: ${JSON.stringify(rec)}\n\n`);
    for (const c of this.controllers) c.enqueue(bytes);
  }
}

// ------------------------------------------------------------------ runtime harness

const context: Context = {
  api_version: "v0",
  bd_version: "1.3.0-rc.2",
  schema_version: 1,
  backend: "dolt",
  dolt_mode: "server",
  database: "kb",
  project_id: "",
  capabilities: [],
};

function until(pred: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - started > ms) return reject(new Error("timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const runtimes: DatabaseRuntime[] = [];

function harness(bd: FakeBd, flushDelayMs = 20) {
  const config = loadConfig({
    argv: [],
    env: { BDDB_WORK_DIR: "/nonexistent/bddb-test-work", BDDB_POLL_INTERVAL: "3600000" },
  });
  const runtime = new DatabaseRuntime({
    name: "kb",
    wsDir: "/nonexistent/bddb-test-work/kb",
    config,
    log: silentLogger,
    flushDelayMs,
    pollIntervalMs: 3_600_000,
    createClient: (options) => new BdClient({ ...options, fetch: bd.fetch }),
  });
  const frames: StreamEvent[] = [];
  runtime.fanout.broadcast = (frame: StreamEvent) => {
    frames.push(frame);
  };
  runtimes.push(runtime);
  const deltas = () => frames.filter((f) => f.event === "delta").map((f) => f.data as Delta);
  const snapshots = () =>
    frames.filter((f) => f.event === "snapshot").map((f) => f.data as Snapshot);
  const issue = (id: string): BoardIssue | undefined =>
    runtime.snapshot()?.issues.find((i) => i.id === id);
  return { runtime, frames, deltas, snapshots, issue };
}

async function attachAndSettle(h: ReturnType<typeof harness>, bd: FakeBd): Promise<void> {
  h.runtime.attach("http://bd.fake", context);
  await until(() => h.runtime.ready && bd.streams === 1);
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

// ------------------------------------------------------------------ tests

describe("helpers", () => {
  test("isDbUnavailable: only 503 db_unavailable", () => {
    const make = (status: number, code: string) =>
      new ProblemError({ code, status, title: code, request_id: "r" } as never, {
        method: "GET",
        url: "http://x",
      });
    expect(isDbUnavailable(make(503, "db_unavailable"))).toBe(true);
    expect(isDbUnavailable(make(503, "busy"))).toBe(false);
    expect(isDbUnavailable(make(500, "db_unavailable"))).toBe(false);
    expect(isDbUnavailable(new Error("x"))).toBe(false);
  });

  test("settleWithLimit caps concurrency and keeps order and rejections", async () => {
    let running = 0;
    let max = 0;
    const results = await settleWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      max = Math.max(max, running);
      await Bun.sleep(2);
      running--;
      if (n === 4) throw new Error("four");
      return n * 10;
    });
    expect(max).toBe(3);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([
      10,
      20,
      30,
      "x",
      50,
      60,
      70,
    ]);
    expect(results[3]?.status).toBe("rejected");
  });
});

describe("DatabaseRuntime", () => {
  test("H1: a record applied during an in-flight baseline is not reverted by the baseline", async () => {
    const bd = new FakeBd();
    bd.rows.set("a", row("a"));
    const h = harness(bd);
    await attachAndSettle(h, bd);
    expect(h.issue("a")?.status).toBe("open");

    // Hold the listing of a poll baseline: it captures `a` as open, then waits.
    const g = gate();
    bd.listGate = g.promise;
    const snapshotsBefore = h.snapshots().length;
    const rebaseline = h.runtime.rebaselineNow("poll");
    await until(() => bd.requests.filter((r) => r.includes("/issues?limit=0")).length === 2);
    bd.listGate = null;

    // Meanwhile the journal delivers the newer state.
    const moved = row("a", { status: "in_progress", updated_at: "2026-09-14T10:05:00Z" });
    bd.rows.set("a", moved);
    bd.emit(record(11, "update", moved));
    await until(() => h.issue("a")?.status === "in_progress");
    const before = h.deltas().length;

    g.release();
    await rebaseline;
    expect(h.issue("a")?.status).toBe("in_progress");
    // No delta after the record moved `a` back to `open`.
    const later = h.deltas().slice(before);
    for (const d of later) {
      for (const u of d.upserts) if (u.id === "a") expect(u.status).toBe("in_progress");
    }
    // A poll baseline diffs; it never pushes a snapshot.
    expect(h.snapshots().length).toBe(snapshotsBefore);
  });

  test("H1: a record for an issue created after the baseline read is upserted, a delete removes", async () => {
    const bd = new FakeBd();
    bd.rows.set("a", row("a"));
    bd.rows.set("b", row("b"));
    const h = harness(bd);
    await attachAndSettle(h, bd);

    const g = gate();
    bd.listGate = g.promise;
    const rebaseline = h.runtime.rebaselineNow("poll");
    await until(() => bd.requests.filter((r) => r.includes("/issues?limit=0")).length === 2);
    bd.listGate = null;

    const created = row("c");
    bd.rows.set("c", created);
    bd.emit(record(11, "create", created));
    bd.rows.delete("b");
    bd.emit({ seq: 12, ts: "t", op: "delete", issue_id: "b", issue: null } as EventRecord);
    await until(() => h.issue("c") !== undefined && h.issue("b") === undefined);

    g.release();
    await rebaseline;
    expect(h.issue("c")?.id).toBe("c");
    expect(h.issue("b")).toBeUndefined();
    expect(h.issue("a")).toBeDefined();
  });

  test("M3: flushes are serialised — an older ready set never overwrites a newer one", async () => {
    const bd = new FakeBd();
    bd.rows.set("a", row("a"));
    bd.rows.set("b", row("b"));
    bd.ready.add("a");
    const h = harness(bd, 5);
    await attachAndSettle(h, bd);
    expect(h.issue("b")?.blocked).toBe(true);

    // First ready refresh is slow and answers the OLD set {a}; while it hangs, `b` becomes ready
    // and a second record makes the ready set dirty again.
    const slow = gate();
    bd.readyHook = async (n) => {
      if (n === 2) {
        await slow.promise;
        return json({ items: [{ id: "a" }], has_more: false });
      }
      return null;
    };
    bd.emit(record(11, "update", row("a", { title: "A2" })));
    await until(() => bd.readyCalls === 2);
    bd.ready.add("b");
    bd.emit(record(12, "update", row("b", { title: "B2" })));
    await Bun.sleep(30); // the second flush must NOT have started
    expect(bd.readyCalls).toBe(2);
    slow.release();
    await until(() => bd.readyCalls === 3);
    await until(() => h.issue("b")?.blocked === false);
    expect(h.runtime.snapshot()?.ready.sort()).toEqual(["a", "b"]);
    await Bun.sleep(30);
    expect(h.runtime.snapshot()?.ready.sort()).toEqual(["a", "b"]);
  });

  test("M5: the re-read fan-out is capped and a 503 busy does not degrade the database", async () => {
    const bd = new FakeBd();
    for (let i = 0; i < 25; i++) bd.rows.set(`i${i}`, row(`i${i}`));
    const h = harness(bd, 5);
    await attachAndSettle(h, bd);

    const hold = gate();
    let firstBusy = true;
    bd.getIssueHook = async (id) => {
      await hold.promise;
      if (id === "i0" && firstBusy) {
        firstBusy = false;
        return problem(503, "busy", "server is busy");
      }
      return null;
    };
    let seq = 11;
    for (let i = 0; i < 25; i++) {
      const target = `i${(i + 1) % 25}`;
      bd.emit({
        seq: seq++,
        ts: "t",
        op: "dep_add",
        issue_id: `i${i}`,
        issue: bd.rows.get(`i${i}`),
        dep: { kind: "blocks", target },
      } as unknown as EventRecord);
    }
    await until(() => bd.concurrentGetIssue >= REFETCH_CONCURRENCY, 3000);
    await Bun.sleep(20);
    expect(bd.concurrentGetIssue).toBe(REFETCH_CONCURRENCY);
    hold.release();
    await until(() => bd.requests.filter((r) => /\/issues\/i\d+\?/.test(r)).length >= 25);
    await Bun.sleep(30);
    expect(bd.maxConcurrentGetIssue).toBe(REFETCH_CONCURRENCY);
    expect(h.runtime.info.state).toBe("ready");
    expect(h.runtime.info.lastError).toBeNull();
  });

  test("L1: a record with seq <= the last applied one is skipped", async () => {
    const bd = new FakeBd();
    bd.rows.set("a", row("a"));
    const h = harness(bd);
    await attachAndSettle(h, bd);
    bd.emit(record(11, "update", row("a", { title: "new" })));
    await until(() => h.issue("a")?.title === "new");
    const n = h.deltas().length;
    bd.emit(record(11, "update", row("a", { title: "stale duplicate" })));
    bd.emit(record(5, "update", row("a", { title: "older" })));
    bd.emit(record(12, "update", row("a", { title: "newer" })));
    await until(() => h.issue("a")?.title === "newer");
    const titles = h
      .deltas()
      .slice(n)
      .flatMap((d) => d.upserts.map((u) => u.title));
    expect(titles).toEqual(["newer"]);
  });

  test("L3: lastSyncAt does not advance when every flush request failed", async () => {
    const bd = new FakeBd();
    bd.rows.set("a", row("a"));
    const h = harness(bd, 5);
    await attachAndSettle(h, bd);
    const synced = h.runtime.info.lastSyncAt;
    expect(synced).not.toBeNull();
    await Bun.sleep(5);
    bd.intercept = (p) =>
      p.endsWith("/ready") || p.endsWith("/stats") ? problem(500, "internal") : null;
    bd.emit(record(11, "update", row("a", { title: "x" })));
    await until(() => h.issue("a")?.title === "x");
    await until(() => bd.requests.filter((r) => r.endsWith("/ready?limit=0")).length >= 2);
    await Bun.sleep(30);
    expect(h.runtime.info.lastSyncAt).toBe(synced);

    // Once a request answers again, it advances.
    bd.intercept = null;
    bd.emit(record(12, "update", row("a", { title: "y" })));
    await until(() => h.runtime.info.lastSyncAt !== synced);
  });
});
