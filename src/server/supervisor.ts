/**
 * One `bd serve` per database on a loopback port, restarted with exponential backoff.
 *
 * Facts this relies on (tmp/research/facts-checked.md): `bd serve` exits 1 when dolt is
 * unreachable at start; after start it survives a dolt outage answering `503 db_unavailable`
 * and recovers by itself; it forks a detached `bd db-proxy-child` (pid in
 * `.beads/dolt/proxy.pid`) that outlives it and, once dead, is never respawned — so a
 * persistent 503 while dolt is reachable means "restart bd serve and its proxy".
 */
import path from "node:path";
import type { Context } from "../api-client/index.ts";
import { type DoltConnection, tcpReachable } from "./discovery.ts";
import { type Logger, silentLogger } from "./log.ts";
import { baseChildEnv, stopProxy, terminate } from "./workspace.ts";

export type SupervisorState = "stopped" | "starting" | "running" | "down";

export interface SupervisorOptions {
  database: string;
  wsDir: string;
  bdPath: string;
  dolt: DoltConnection;
  log: Logger;
  /** A (re)started process answers `GET /v0/beads/context`. */
  onReady?: (info: { baseUrl: string; context: Context; pid: number }) => void;
  /** The process exited (or failed to start); a restart follows unless stopping. */
  onDown?: (info: { exitCode: number | null; reason: string }) => void;
  startupTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** How long `503 db_unavailable` may persist while dolt is reachable before a restart. */
  unavailableRestartMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

/** Environment for `bd` child processes: clean base + explicit dolt connection. */
export function bdChildEnv(
  database: string,
  dolt: DoltConnection,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out = baseChildEnv(env);
  out.BD_NON_INTERACTIVE = "1";
  out.BD_EVENTS_JOURNAL = "1";
  out.BEADS_DOLT_AUTO_START = "0";
  out.BEADS_DOLT_SERVER_HOST = dolt.host;
  out.BEADS_DOLT_SERVER_PORT = String(dolt.port);
  out.BEADS_DOLT_SERVER_DATABASE = database;
  out.BEADS_DOLT_SERVER_USER = dolt.user;
  if (dolt.password !== "") out.BEADS_DOLT_PASSWORD = dolt.password;
  return out;
}

export async function freeLoopbackPort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** `bd version` → `1.3.0-rc.2`, or `null` when the binary is missing or the output is unexpected. */
export async function bdVersion(
  bdPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ version: string; raw: string } | null> {
  try {
    const proc = Bun.spawn([bdPath, "version"], {
      env: { ...baseChildEnv(env), BD_NON_INTERACTIVE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const first = stdout.split("\n")[0]?.trim() ?? "";
    const m = /bd version (\S+)/.exec(first) ?? /^v?(\d+\.\d+\.\S*)/.exec(first);
    return m?.[1] ? { version: m[1], raw: first } : null;
  } catch {
    return null;
  }
}

/** Route one line of child output to the logger: request logs are debug, errors are warn. */
export function classifyBdLine(line: string): "debug" | "info" | "warn" {
  if (/\b(error|fatal|panic|warning|unexpected EOF|refused)\b/i.test(line)) return "warn";
  if (/event=request\b/.test(line)) return "debug";
  return "info";
}

export async function pipeLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.trim() !== "") onLine(line);
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") onLine(buffer);
  } catch {
    /* stream closed */
  }
}

export class BdServeSupervisor {
  readonly database: string;
  state: SupervisorState = "stopped";
  baseUrl: string | null = null;
  pid: number | null = null;
  /** Most recent context handshake; null until the first successful start. */
  context: Context | null = null;
  /** Last stderr lines of the current/previous process, for diagnostics. */
  readonly lastLines: string[] = [];

  private readonly options: SupervisorOptions;
  private readonly log: Logger;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private restartRequested: string | null = null;
  private unavailableSince: number | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SupervisorOptions) {
    this.options = options;
    this.database = options.database;
    this.log = options.log;
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearWatchdog();
    this.wake?.();
    await this.killChild("shutdown");
    await this.loop?.catch(() => {});
    this.loop = null;
    await stopProxy(path.join(this.options.wsDir, ".beads"), this.log);
    this.state = "stopped";
  }

  /** Kill the current process; the loop restarts it right away (backoff reset). */
  async restart(reason: string, options: { killProxy?: boolean } = {}): Promise<void> {
    if (this.stopping) return;
    this.restartRequested = reason;
    this.log.warn("restarting bd serve", { reason });
    await this.killChild(reason);
    if (options.killProxy) await stopProxy(path.join(this.options.wsDir, ".beads"), this.log);
    this.wake?.();
  }

  /** Called by the sync layer on every `503 db_unavailable`. */
  noteDbUnavailable(): void {
    if (this.stopping || this.state !== "running") return;
    if (this.unavailableSince === null) this.unavailableSince = Date.now();
    if (this.watchdog) return;
    const limit = this.options.unavailableRestartMs ?? 60_000;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      void this.checkUnavailable(limit);
    }, limit);
  }

  /** Called by the sync layer on any successful database request. */
  noteDbOk(): void {
    this.unavailableSince = null;
    this.clearWatchdog();
  }

  private async checkUnavailable(limit: number): Promise<void> {
    if (this.stopping || this.unavailableSince === null) return;
    if (Date.now() - this.unavailableSince < limit) {
      this.noteDbUnavailable();
      return;
    }
    const reachable = await tcpReachable(this.options.dolt.host, this.options.dolt.port);
    if (reachable) {
      this.unavailableSince = null;
      await this.restart("db_unavailable persisted while dolt is reachable (proxy dead?)", {
        killProxy: true,
      });
    } else {
      this.log.warn("dolt unreachable; waiting for it to come back", {
        dolt: `${this.options.dolt.host}:${this.options.dolt.port}`,
      });
      this.unavailableSince = Date.now();
      this.noteDbUnavailable();
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private async killChild(reason: string): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    this.log.debug("stopping bd serve", { pid: proc.pid, reason });
    await terminate(proc.pid, 5000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    const minMs = this.options.backoffMinMs ?? 1000;
    const maxMs = this.options.backoffMaxMs ?? 30_000;
    let attempt = 0;
    while (!this.stopping) {
      const startedAt = Date.now();
      let becameReady = false;
      try {
        becameReady = await this.runOnce();
      } catch (err) {
        this.log.error("bd serve supervisor iteration failed", { error: err });
      }
      if (this.stopping) break;
      if (this.restartRequested !== null) {
        this.restartRequested = null;
        attempt = 0;
        continue;
      }
      if (becameReady && Date.now() - startedAt > 60_000) attempt = 0;
      const delay = Math.min(minMs * 2 ** attempt, maxMs);
      attempt++;
      this.log.info("bd serve restart scheduled", { in_ms: delay });
      await this.sleep(delay);
    }
    this.state = "stopped";
  }

  /** Spawn, wait for `/context`, run until exit. Returns whether it became ready. */
  private async runOnce(): Promise<boolean> {
    this.state = "starting";
    const port = await freeLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = bdChildEnv(this.database, this.options.dolt, this.options.env);
    this.log.info("starting bd serve", { addr: `127.0.0.1:${port}`, cwd: this.options.wsDir });
    const proc = Bun.spawn([this.options.bdPath, "serve", "--addr", `127.0.0.1:${port}`], {
      cwd: this.options.wsDir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.proc = proc;
    this.pid = proc.pid;
    this.lastLines.length = 0;
    const onLine = (line: string) => {
      this.lastLines.push(line);
      if (this.lastLines.length > 20) this.lastLines.shift();
      const level = classifyBdLine(line);
      this.log[level](line, { pid: proc.pid });
    };
    const pipes = Promise.all([
      pipeLines(proc.stdout as ReadableStream<Uint8Array>, onLine),
      pipeLines(proc.stderr as ReadableStream<Uint8Array>, onLine),
    ]);

    const context = await this.waitForContext(baseUrl, proc);
    let ready = false;
    if (context) {
      ready = true;
      this.baseUrl = baseUrl;
      this.context = context;
      this.state = "running";
      this.unavailableSince = null;
      this.log.info("bd serve ready", {
        pid: proc.pid,
        bd_version: context.bd_version,
        database: context.database,
        project_id: context.project_id || undefined,
      });
      this.options.onReady?.({ baseUrl, context, pid: proc.pid });
    }
    const exitCode = await proc.exited;
    await pipes;
    this.state = "down";
    this.baseUrl = null;
    this.pid = null;
    this.clearWatchdog();
    const reason = this.stopping
      ? "shutdown"
      : (this.restartRequested ?? (ready ? "process exited" : "failed to start"));
    const log = this.stopping ? this.log.info.bind(this.log) : this.log.warn.bind(this.log);
    log("bd serve exited", {
      pid: proc.pid,
      exit_code: exitCode,
      reason,
      last: this.stopping ? undefined : this.lastLines.at(-1),
    });
    if (!this.stopping) this.options.onDown?.({ exitCode, reason });
    this.proc = null;
    return ready;
  }

  private async waitForContext(
    baseUrl: string,
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<Context | null> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline && !this.stopping) {
      if (proc.exitCode !== null || proc.signalCode !== null) return null;
      try {
        const res = await fetch(`${baseUrl}/v0/beads/context`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return (await res.json()) as Context;
      } catch {
        /* not listening yet */
      }
      await Bun.sleep(200);
    }
    if (!this.stopping && proc.exitCode === null && proc.signalCode === null) {
      this.log.error("bd serve did not answer /v0/beads/context in time; killing it", {
        pid: proc.pid,
      });
      await terminate(proc.pid, 3000);
    }
    return null;
  }
}

export type OneShot =
  | { ok: true; baseUrl: string; context: Context; pid: number; stop(): Promise<void> }
  | { ok: false; exitCode: number | null; lastLines: string[] };

/**
 * Start one `bd serve` for a diagnostic (`bddb doctor`): no retries. Resolves when `/context`
 * answers, or when the process exits / the timeout passes. `stop()` kills it and its proxy.
 */
export async function spawnBdServeOnce(options: {
  database: string;
  wsDir: string;
  bdPath: string;
  dolt: DoltConnection;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<OneShot> {
  const port = await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const lastLines: string[] = [];
  const proc = Bun.spawn([options.bdPath, "serve", "--addr", `127.0.0.1:${port}`], {
    cwd: options.wsDir,
    env: bdChildEnv(options.database, options.dolt, options.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onLine = (line: string) => {
    lastLines.push(line);
    if (lastLines.length > 30) lastLines.shift();
  };
  void pipeLines(proc.stdout as ReadableStream<Uint8Array>, onLine);
  void pipeLines(proc.stderr as ReadableStream<Uint8Array>, onLine);
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/v0/beads/context`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const context = (await res.json()) as Context;
        return {
          ok: true,
          baseUrl,
          context,
          pid: proc.pid,
          async stop() {
            await terminate(proc.pid, 5000);
            await stopProxy(path.join(options.wsDir, ".beads"), silentLogger);
          },
        };
      }
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(200);
  }
  if (proc.exitCode === null && proc.signalCode === null) await terminate(proc.pid, 3000);
  await Bun.sleep(100);
  return { ok: false, exitCode: proc.exitCode, lastLines };
}
