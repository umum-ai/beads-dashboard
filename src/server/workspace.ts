/**
 * Synthesized beads workspaces: one writable git repository per database with
 * `.beads/metadata.json` (`dolt_mode: server`, `dolt_database`) and `.beads/config.yaml`
 * (`events-journal: true`). No `bd init` is run and no `project_id` is written (a mismatch
 * makes bd refuse to connect); host/port/user/password reach `bd serve` through the
 * environment (see supervisor.ts). Verified recipe: tmp/research/facts-checked.md §d.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./log.ts";

/** `$BDDB_WORK_DIR`, else `$TMPDIR/bddb`, else `os.tmpdir()/bddb`. */
export function workspaceRoot(
  configured: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (configured) return path.resolve(configured);
  const tmp = env.TMPDIR && env.TMPDIR !== "" ? env.TMPDIR : os.tmpdir();
  return path.join(tmp, "bddb");
}

/** Every `BEADS_*` / `BD_*` variable of the parent is dropped; only the basics survive. */
export function baseChildEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "USER",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    const value = env[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  out.NO_COLOR = "1";
  return out;
}

async function exists(p: string): Promise<boolean> {
  return await stat(p).then(
    () => true,
    () => false,
  );
}

export interface WorkspaceOptions {
  root: string;
  database: string;
  log: Logger;
}

/** Create or refresh the workspace for `database`; returns its directory. */
export async function ensureWorkspace(options: WorkspaceOptions): Promise<string> {
  const dir = path.join(options.root, options.database);
  const beads = path.join(dir, ".beads");
  await mkdir(beads, { recursive: true, mode: 0o700 });
  if (!(await exists(path.join(dir, ".git")))) {
    const proc = Bun.spawn(["git", "init", "-q", "."], {
      cwd: dir,
      env: baseChildEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) {
      throw new Error(
        `git init failed in ${dir} (exit ${code}): ${stderr.trim()} — bd serve needs the git binary and a git repository`,
      );
    }
  }
  // bd may rewrite metadata.json at runtime; make sure our two keys are what it sees at start.
  await writeFile(
    path.join(beads, "metadata.json"),
    `${JSON.stringify({ dolt_mode: "server", dolt_database: options.database }, null, 2)}\n`,
  );
  await writeFile(path.join(beads, "config.yaml"), "events-journal: true\n");
  await clearStaleProxy(beads, options.log);
  return dir;
}

/** `{ pid, port }` of the detached `bd db-proxy-child`, if the pid file exists and parses. */
export async function readProxyPid(
  beadsDir: string,
): Promise<{ pid: number; port: number | null } | null> {
  const text = await readFile(path.join(beadsDir, "dolt", "proxy.pid"), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; port?: unknown };
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = Number(parsed.port);
    return { pid, port: Number.isInteger(port) ? port : null };
  } catch {
    const m = /"pid"\s*:\s*(\d+)/.exec(text);
    return m ? { pid: Number(m[1]), port: null } : null;
  }
}

/** Command line of a live process, or `null` when it does not exist (Linux /proc, else `ps`). */
export async function processCommandLine(pid: number): Promise<string | null> {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  const proc = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
  if (proc) return proc.toString("utf8").replaceAll("\0", " ").trim();
  const ps = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
  return code === 0 && text.trim() !== "" ? text.trim() : null;
}

/** Is `pid` the `bd db-proxy-child` rooted at this workspace's `.beads/dolt`? */
export async function isOurProxy(beadsDir: string, pid: number): Promise<boolean> {
  const cmd = await processCommandLine(pid);
  if (cmd === null) return false;
  return cmd.includes("db-proxy-child") && cmd.includes(`--root ${path.join(beadsDir, "dolt")}`);
}

/**
 * A pid file left by a dead proxy would make `bd serve` wait for a proxy that never answers;
 * remove it (and only it) when the recorded process is gone or is not our proxy.
 */
async function clearStaleProxy(beadsDir: string, log: Logger): Promise<void> {
  const info = await readProxyPid(beadsDir);
  if (!info) return;
  if (await isOurProxy(beadsDir, info.pid)) return;
  log.debug("removing stale db-proxy-child pid file", { pid: info.pid });
  await rm(path.join(beadsDir, "dolt", "proxy.pid"), { force: true });
}

/**
 * Terminate the workspace's detached `bd db-proxy-child` (it outlives `bd serve`, see
 * facts-checked.md §c). Never touches a process whose command line is not our proxy.
 */
export async function stopProxy(beadsDir: string, log: Logger, graceMs = 3000): Promise<void> {
  const info = await readProxyPid(beadsDir);
  if (!info) return;
  if (!(await isOurProxy(beadsDir, info.pid))) return;
  log.info("stopping bd db-proxy-child", { pid: info.pid });
  await terminate(info.pid, graceMs);
  await rm(path.join(beadsDir, "dolt", "proxy.pid"), { force: true });
}

/** SIGTERM, wait up to `graceMs`, then SIGKILL. */
export async function terminate(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
