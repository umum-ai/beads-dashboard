/**
 * One database at runtime: its `bd serve` (supervisor), the in-memory snapshot, the single
 * upstream events stream, the poll timer and the browser fan-out. `app.ts` only reads
 * `info`/`snapshot()` and forwards proxies to `target()`.
 *
 * Sync model (plan 3.2, docs/bff-api.md):
 * - full re-baseline (7 loopback calls) at start, on every poll tick, and whenever the journal
 *   cannot be trusted (`truncated`, `410`, `409 disabled`, bd restart, reconnect after a gap);
 *   the result is diffed → `delta`, or pushed as a fresh `snapshot` when the dictionaries
 *   changed or the reason demands it;
 * - journal records are applied incrementally and coalesced: after ~300 ms of quiet the ready
 *   set and stats are refreshed and rows touched by `dep_*`/`comment` events are re-read for
 *   their counts, all in one `delta`.
 */
import { BdClient, type Context, type EventRecord, ProblemError } from "../api-client/index.ts";
import type { Config } from "./config.ts";
import { type DoltConnection, doltConnection } from "./discovery.ts";
import { Fanout } from "./fanout.ts";
import { type RebaselineReason, runLiveStream } from "./live.ts";
import type { Logger } from "./log.ts";
import {
  applyDetails,
  applyEvent,
  applyReady,
  closedSince,
  computeDelta,
  type DeltaBody,
  dictionariesEqual,
  fetchBaseline,
  reconcileChildCounts,
  type StateData,
} from "./snapshot.ts";
import { BdServeSupervisor } from "./supervisor.ts";
import type { BoardIssue, DatabaseInfo, Delta, Snapshot } from "./types.ts";
import { versionWarning } from "./version.ts";

export interface DatabaseRuntimeOptions {
  name: string;
  wsDir: string;
  config: Config;
  log: Logger;
  /** Debounce for the ready/stats/counts refresh after journal records (default 300 ms). */
  flushDelayMs?: number;
  /** Overrides for tests. */
  dolt?: DoltConnection;
  pollIntervalMs?: number;
}

/** Reasons that make the owner push a fresh `snapshot` frame instead of a `delta`. */
const SNAPSHOT_REASONS: ReadonlySet<RebaselineReason> = new Set([
  "truncated",
  "journal_disabled",
  "restart",
  "reconnect",
]);

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

interface Pending {
  refetch: Set<string>;
  readyDirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class DatabaseRuntime {
  readonly name: string;
  readonly info: DatabaseInfo;
  readonly fanout = new Fanout();
  /** bddb's own per-database counter (`Snapshot.seq`, `Delta.seq`). */
  seq = 0;

  private readonly options: DatabaseRuntimeOptions;
  private readonly log: Logger;
  private readonly supervisor: BdServeSupervisor;
  private state: StateData | null = null;
  private client: BdClient | null = null;
  private baseUrl: string | null = null;
  private liveAbort: AbortController | null = null;
  private liveDone: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private lastPublished = "";
  private readonly pending: Pending = { refetch: new Set(), readyDirty: false, timer: null };

  constructor(options: DatabaseRuntimeOptions) {
    this.options = options;
    this.name = options.name;
    this.log = options.log;
    this.info = {
      name: options.name,
      state: "starting",
      live: "none",
      lastSyncAt: null,
      bdVersion: null,
      projectId: null,
      versionWarning: null,
      capabilities: [],
    };
    this.supervisor = new BdServeSupervisor({
      database: options.name,
      wsDir: options.wsDir,
      bdPath: options.config.bdPath,
      dolt: options.dolt ?? doltConnection(options.config),
      log: options.log.child(`[bd:${options.name}]`),
      onReady: (ready) => this.onBdReady(ready.baseUrl, ready.context),
      onDown: (down) => this.onBdDown(down.reason),
    });
  }

  start(): void {
    this.stopped = false;
    this.supervisor.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopLive();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.pending.timer) clearTimeout(this.pending.timer);
    this.pending.timer = null;
    this.fanout.close();
    await this.supervisor.stop();
    if (this.liveDone) await this.liveDone.catch(() => {});
  }

  /** `bd serve` answers and the first baseline is loaded. */
  get ready(): boolean {
    return this.state !== null && (this.info.state === "ready" || this.info.state === "degraded");
  }

  /** Where proxies go; `null` while `bd serve` is not up. */
  target(): { baseUrl: string; projectId: string | null } | null {
    if (!this.baseUrl || !this.ready) return null;
    return { baseUrl: this.baseUrl, projectId: this.info.projectId || null };
  }

  snapshot(): Snapshot | null {
    if (!this.state || !this.ready) return null;
    return {
      seq: this.seq,
      database: { ...this.info },
      statuses: this.state.statuses,
      types: this.state.types,
      issues: [...this.state.issues.values()],
      ready: [...this.state.ready],
      stats: this.state.stats,
    };
  }

  /** Browser SSE stream: the current snapshot first, then deltas. */
  subscribe(signal?: AbortSignal): Response {
    const snapshot = this.snapshot();
    if (!snapshot) return new Response(null, { status: 503 });
    return this.fanout.subscribe([{ event: "snapshot", data: snapshot }], signal);
  }

  /** Testing hook: force a full re-read now. */
  rebaselineNow(reason: RebaselineReason = "poll"): Promise<void> {
    return this.rebaseline(reason);
  }

  // ------------------------------------------------------------------ bd serve lifecycle

  private onBdReady(baseUrl: string, context: Context): void {
    if (this.stopped) return;
    const restarted = this.state !== null;
    this.baseUrl = baseUrl;
    this.client = new BdClient({
      baseUrl,
      actor: this.options.config.actor,
      timeoutMs: 60_000,
      ...(context.project_id ? { projectId: context.project_id } : {}),
    });
    this.info.bdVersion = context.bd_version;
    this.info.projectId = context.project_id || null;
    this.info.capabilities = [...context.capabilities];
    this.info.versionWarning = versionWarning(context.bd_version);
    if (this.info.versionWarning) this.log.warn(this.info.versionWarning, { database: this.name });
    this.publishStatus();
    this.startLive(restarted);
    if (!this.pollTimer) {
      const every = this.options.pollIntervalMs ?? this.options.config.pollIntervalMs;
      this.pollTimer = setInterval(() => void this.rebaseline("poll"), every);
    }
  }

  private onBdDown(reason: string): void {
    if (this.stopped) return;
    this.stopLive();
    this.baseUrl = null;
    this.client = null;
    this.info.state = "down";
    this.info.live = "none";
    this.log.warn("database is down", { database: this.name, reason });
    this.publishStatus();
  }

  private startLive(restarted: boolean): void {
    this.stopLive();
    const client = this.client;
    if (!client) return;
    const ctrl = new AbortController();
    this.liveAbort = ctrl;
    this.liveDone = runLiveStream({
      client,
      log: this.log.child(`[live:${this.name}]`),
      signal: ctrl.signal,
      disabledRetryMs: this.options.pollIntervalMs ?? this.options.config.pollIntervalMs,
      onRecord: (record, seq) => this.applyRecord(record, seq),
      onConnected: () => {
        if (this.info.live !== "sse") {
          this.info.live = "sse";
          this.publishStatus();
        }
      },
      onDisconnected: () => {
        if (this.info.live === "sse") {
          this.info.live = this.ready ? "polling" : "none";
          this.publishStatus();
        }
      },
      onRebaseline: (reason) =>
        this.rebaseline(reason === "start" && restarted ? "restart" : reason),
    });
  }

  private stopLive(): void {
    this.liveAbort?.abort();
    this.liveAbort = null;
  }

  // ------------------------------------------------------------------ full re-read

  private rebaseline(reason: RebaselineReason): Promise<void> {
    if (this.inflight) return this.inflight;
    const client = this.client;
    if (!client || this.stopped) return Promise.resolve();
    this.inflight = this.doRebaseline(client, reason).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRebaseline(client: BdClient, reason: RebaselineReason): Promise<void> {
    const started = Date.now();
    try {
      const next = await fetchBaseline(client, {
        closedDays: this.options.config.closedDays,
        log: this.log,
      });
      if (this.stopped || this.client !== client) return;
      this.supervisor.noteDbOk();
      const prev = this.state;
      this.state = next;
      this.info.state = "ready";
      if (this.info.live !== "sse") this.info.live = "polling";
      this.info.lastSyncAt = new Date().toISOString();
      const fresh = !prev || SNAPSHOT_REASONS.has(reason) || !dictionariesEqual(prev, next);
      if (fresh) {
        this.seq++;
        const snapshot = this.snapshot();
        if (snapshot) this.fanout.broadcast({ event: "snapshot", data: snapshot });
      } else {
        const body = computeDelta(prev, next);
        if (body) this.emitDelta(body);
      }
      this.log.debug("baseline loaded", {
        database: this.name,
        reason,
        issues: next.issues.size,
        ready: next.ready.size,
        ms: Date.now() - started,
        pushed: fresh ? "snapshot" : "delta",
      });
    } catch (err) {
      if (this.stopped || this.client !== client) return;
      if (err instanceof ProblemError && err.status === 503) {
        this.supervisor.noteDbUnavailable();
        if (this.state) this.info.state = "degraded";
        this.log.warn("baseline failed: database unavailable", {
          database: this.name,
          code: err.code,
          reason,
        });
      } else {
        this.log.warn("baseline failed", { database: this.name, reason, error: err });
      }
    }
    this.publishStatus();
  }

  // ------------------------------------------------------------------ incremental

  private applyRecord(record: EventRecord, seq: number): void {
    const state = this.state;
    if (!state || this.stopped) return;
    const effect = applyEvent(state, record, this.closedSinceNow());
    this.log.debug("event applied", {
      database: this.name,
      seq,
      op: record.op,
      issue: record.issue_id,
    });
    if (effect.upserts.length > 0 || effect.removes.length > 0) {
      this.emitDelta({ upserts: effect.upserts, removes: effect.removes });
    }
    for (const id of effect.refetch) this.pending.refetch.add(id);
    if (effect.readyDirty) this.pending.readyDirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.pending.timer) return;
    this.pending.timer = setTimeout(() => {
      this.pending.timer = null;
      void this.flush();
    }, this.options.flushDelayMs ?? 300);
  }

  /** Ready set + stats + re-read of rows whose counts changed → one delta. */
  private async flush(): Promise<void> {
    const client = this.client;
    const state = this.state;
    if (!client || !state || this.stopped) return;
    const ids = [...this.pending.refetch];
    const readyDirty = this.pending.readyDirty;
    this.pending.refetch.clear();
    this.pending.readyDirty = false;
    if (ids.length === 0 && !readyDirty) return;

    const body: DeltaBody = { upserts: [], removes: [] };
    const upsert = (row: BoardIssue) => {
      body.upserts = body.upserts.filter((r) => r.id !== row.id);
      body.upserts.push(row);
    };
    const since = this.closedSinceNow();
    const [readyResult, statsResult, detailResults] = await Promise.all([
      settle(readyDirty ? client.ready({ limit: 0 }) : Promise.resolve(null)),
      settle(readyDirty ? client.stats() : Promise.resolve(null)),
      Promise.allSettled(
        ids.map((id) => client.getIssue(id, { include_dependents: true, brief_deps: true })),
      ),
    ]);
    if (this.stopped || this.client !== client || this.state !== state) return;

    let dbOk = false;
    let dbUnavailable = false;
    const note = (result: PromiseSettledResult<unknown>) => {
      if (result.status === "fulfilled") dbOk = true;
      else if (result.reason instanceof ProblemError && result.reason.status === 503) {
        dbUnavailable = true;
      }
    };

    note(readyResult);
    if (readyResult.status === "fulfilled" && readyResult.value) {
      const ready = new Set(readyResult.value.items.map((r) => r.id));
      for (const row of applyReady(state, ready)) upsert(row);
      body.ready = [...ready];
    } else if (readyResult.status === "rejected") {
      this.log.warn("ready refresh failed", { database: this.name, error: readyResult.reason });
      this.pending.readyDirty = true;
    }

    note(statsResult);
    if (statsResult.status === "fulfilled" && statsResult.value) {
      state.stats = statsResult.value.summary;
      body.stats = state.stats;
    }

    detailResults.forEach((result, index) => {
      const id = ids[index] ?? "";
      note(result);
      if (result.status === "fulfilled") {
        const change = applyDetails(state, result.value, since);
        if (change.upsert) upsert(change.upsert);
        if (change.remove) body.removes.push(change.remove);
        for (const parent of change.parents ?? []) upsert(parent);
        return;
      }
      if (result.reason instanceof ProblemError && result.reason.status === 404) {
        const parent = state.issues.get(id)?.parent;
        if (state.issues.delete(id)) body.removes.push(id);
        if (parent) for (const row of reconcileChildCounts(state, [parent])) upsert(row);
        return;
      }
      this.log.debug("row re-read failed; will retry on next event or poll", {
        database: this.name,
        id,
        error: result.reason,
      });
    });

    if (dbOk) this.supervisor.noteDbOk();
    if (dbUnavailable && !dbOk) this.supervisor.noteDbUnavailable();
    if (body.upserts.length > 0 || body.removes.length > 0 || body.ready || body.stats) {
      this.emitDelta(body);
    }
    this.info.lastSyncAt = new Date().toISOString();
    if (this.pending.readyDirty) this.scheduleFlush();
    this.publishStatus();
  }

  // ------------------------------------------------------------------ helpers

  private emitDelta(body: DeltaBody): void {
    this.seq++;
    const delta: Delta = { seq: this.seq, ...body };
    this.fanout.broadcast({ event: "delta", data: delta });
  }

  private publishStatus(): void {
    const text = JSON.stringify(this.info);
    if (text === this.lastPublished) return;
    this.lastPublished = text;
    this.fanout.broadcast({ event: "status", data: { ...this.info } });
  }

  private closedSinceNow(): Date {
    return closedSince(this.options.config.closedDays);
  }
}
