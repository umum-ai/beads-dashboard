/**
 * `bddb doctor`: is this machine able to run the dashboard against the configured dolt?
 *
 * Checks, in order: `bd` binary and version (minor must match the build), `git` binary
 * (bd serve needs it), dolt TCP reachability, `SHOW DATABASES` + discovery, a temporary
 * `bd serve` for the first database (`/context`), and the events journal on it
 * (`events?since=0` must not be `409 events_journal_disabled`). Critical failures make the
 * exit code non-zero. Everything it starts is stopped again; the temporary workspace is removed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BdClient, checkVersion } from "../api-client/index.ts";
import type { Config } from "./config.ts";
import { DiscoveryError, discoverDatabases, doltConnection, tcpReachable } from "./discovery.ts";
import { probeHead } from "./live.ts";
import { silentLogger } from "./log.ts";
import { bdVersion, spawnBdServeOnce } from "./supervisor.ts";
import { BDDB_VERSION, BUILT_FOR_BEADS } from "./version.ts";
import { baseChildEnv, ensureWorkspace } from "./workspace.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "note";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Printed under the row when the check is not ok. */
  hints: string[];
  critical: boolean;
}

export interface DoctorReport {
  checks: CheckResult[];
  /** Non-zero when a critical check failed. */
  exitCode: number;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", note: "i" };

export function formatReport(report: DoctorReport): string {
  const lines = [`bddb doctor — bddb ${BDDB_VERSION}, built for beads ${BUILT_FOR_BEADS}`, ""];
  const width = Math.max(...report.checks.map((c) => c.name.length));
  for (const check of report.checks) {
    lines.push(`  ${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.status !== "ok")
      for (const hint of check.hints) lines.push(`${" ".repeat(width + 6)}→ ${hint}`);
  }
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail");
  const warned = report.checks.filter((c) => c.status === "warn");
  lines.push(
    failed.length === 0
      ? `Result: all checks passed${warned.length > 0 ? ` (${warned.length} warning${warned.length === 1 ? "" : "s"})` : ""}.`
      : `Result: ${failed.length} check${failed.length === 1 ? "" : "s"} failed.`,
  );
  return lines.join("\n");
}

async function gitVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "--version"], {
      env: baseChildEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

export interface DoctorOptions {
  config: Config;
  /** Progress callback (one line per finished check). */
  onCheck?: (check: CheckResult) => void;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { config } = options;
  const checks: CheckResult[] = [];
  const push = (check: CheckResult) => {
    checks.push(check);
    options.onCheck?.(check);
  };
  const ok = (name: string, detail: string, critical = true) =>
    push({ name, status: "ok", detail, hints: [], critical });
  const fail = (name: string, detail: string, hints: string[] = [], critical = true) =>
    push({ name, status: "fail", detail, hints, critical });
  const warn = (name: string, detail: string, hints: string[] = []) =>
    push({ name, status: "warn", detail, hints, critical: false });

  // 1. bd
  const bd = await bdVersion(config.bdPath);
  if (!bd) {
    fail("bd binary", `cannot run "${config.bdPath} version"`, [
      "install beads (https://github.com/gastownhall/beads/releases) or set BDDB_BD_PATH",
    ]);
  } else {
    const skew = checkVersion(bd.version, BUILT_FOR_BEADS);
    if (skew.level === "same" || skew.level === "patch") {
      ok("bd binary", `${bd.raw} (${config.bdPath})`);
    } else {
      warn(
        "bd binary",
        `${bd.raw} differs from the build target ${BUILT_FOR_BEADS} (${skew.level})`,
        [
          "keep the host bd and bddb on the same minor: a mixed fleet on one shared dolt breaks on schema migration",
        ],
      );
    }
  }

  // 2. git
  const git = await gitVersion();
  if (git) ok("git binary", git);
  else {
    fail("git binary", "git not found in PATH", [
      "bd serve resolves its workspace with `git rev-parse`; install git",
    ]);
  }

  // 3. dolt TCP
  const dolt = doltConnection(config);
  const where = `${dolt.host}:${dolt.port}`;
  const reachable = await tcpReachable(dolt.host, dolt.port, 3000);
  if (reachable) ok("dolt reachable", where);
  else {
    fail("dolt reachable", `cannot connect to ${where}`, [
      "is `dolt sql-server` running? shared-server mode: `bd dolt status` in a workspace, default port 3308",
      "from a container: dolt must listen on 0.0.0.0 (`listener.host` in dolt-server-config.yaml) or use --network host",
      "check BDDB_DOLT_HOST / BDDB_DOLT_PORT",
    ]);
  }

  // 4. databases
  let databases: string[] = [];
  if (reachable) {
    try {
      databases = await discoverDatabases({ connection: dolt, requested: config.databases });
      ok("databases", databases.join(", "));
    } catch (err) {
      const hints = err instanceof DiscoveryError ? err.hints : [];
      fail("databases", err instanceof Error ? err.message : String(err), hints);
    }
  } else {
    fail("databases", "skipped (dolt unreachable)");
  }

  // 5. bd serve + 6. events journal, on the first database
  const first = databases[0];
  if (bd && git && first) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "bddb-doctor-"));
    try {
      const wsDir = await ensureWorkspace({ root: tmp, database: first, log: silentLogger });
      const started = await spawnBdServeOnce({
        database: first,
        wsDir,
        bdPath: config.bdPath,
        dolt,
        timeoutMs: 20_000,
      });
      if (!started.ok) {
        fail(`bd serve (${first})`, `did not start (exit ${started.exitCode ?? "timeout"})`, [
          ...started.lastLines.slice(-3).map((l) => `bd: ${l}`),
          "check BDDB_DOLT_USER / BDDB_DOLT_PASSWORD and that the database is a beads database",
        ]);
      } else {
        try {
          const ctx = started.context;
          ok(
            `bd serve (${first})`,
            `context ok: bd ${ctx.bd_version}, database ${ctx.database}, ${ctx.capabilities.length} capabilities${ctx.project_id ? `, project ${ctx.project_id}` : ""}`,
          );
          const client = new BdClient({ baseUrl: started.baseUrl, timeoutMs: 10_000 });
          const probe = await probeHead(client);
          switch (probe.kind) {
            case "ok":
              ok(`events journal (${first})`, `events?since=0 → 200, head ${probe.head}`);
              break;
            case "truncated":
              ok(
                `events journal (${first})`,
                `events?since=0 → 410 (retention pruned), head ${probe.head}`,
              );
              break;
            case "disabled":
              fail(
                `events journal (${first})`,
                "events?since=0 → 409 events_journal_disabled",
                [
                  "bddb starts bd serve with BD_EVENTS_JOURNAL=1; this bd build ignores it — live updates will fall back to polling",
                ],
                false,
              );
              break;
            default:
              fail(
                `events journal (${first})`,
                `events?since=0 failed: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`,
                [],
                false,
              );
          }
          try {
            await client.ready({ limit: 1 });
            ok(`database ready (${first})`, "ready?limit=1 → 200");
          } catch (err) {
            fail(`database ready (${first})`, err instanceof Error ? err.message : String(err), [
              "bd serve is up but the database does not answer (dolt dropped?)",
            ]);
          }
        } finally {
          await started.stop();
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    fail("bd serve", "skipped (prerequisites failed)");
  }

  push({
    name: "host workspaces",
    status: "note",
    critical: false,
    detail:
      "live updates from CLI edits need the events journal in EVERY workspace agents write from",
    hints: [
      "run `bd config set events-journal true` in each host workspace (restart long-running bd processes)",
    ],
  });

  const exitCode = checks.some((c) => c.status === "fail" && c.critical) ? 1 : 0;
  return { checks, exitCode };
}
