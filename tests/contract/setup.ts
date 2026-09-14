/**
 * Contract-test harness: brings up `scripts/stand.sh` (scratch dolt + workspace + `bd serve`)
 * and tears it down after the run.
 *
 * Env:
 *   STAND_DIR        stand directory (default: a fresh `.stand/contract/<timestamp>-<pid>`)
 *   STAND_DOLT_PORT / STAND_BD_PORT   fixed ports (default: free ephemeral ports)
 *   KEEP_STAND=1     leave the stand running (and its directory) after the tests
 *
 * `scripts/stand.sh` scrubs every `BEADS_*` / `BD_*` variable itself, so the caller's real
 * store is never reachable from here; we scrub too, belt and braces.
 */
import { fileURLToPath } from "node:url";

export interface Stand {
  dir: string;
  doltPort: number;
  bdPort: number;
  /** Server root, e.g. `http://127.0.0.1:47313` — what `BdClient` takes as `baseUrl`. */
  baseUrl: string;
  /** `${baseUrl}/v0/beads` as the stand script prints it. */
  apiUrl: string;
  wsDir: string;
  database: string;
  fresh: boolean;
}

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const STAND_SH = `${REPO_ROOT}/scripts/stand.sh`;

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(BEADS_|BD_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function runStand(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bash", STAND_SH, ...args], {
    cwd: REPO_ROOT,
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`stand.sh ${args.join(" ")} failed (exit ${code})\n${stderr}\n${stdout}`);
  }
  return stdout;
}

function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? "";
  }
  return out;
}

export async function startStand(): Promise<Stand> {
  const fresh = process.env.STAND_DIR === undefined;
  const dir = process.env.STAND_DIR ?? `${REPO_ROOT}/.stand/contract/${Date.now()}-${process.pid}`;
  const doltPort = Number(process.env.STAND_DOLT_PORT ?? (await freePort()));
  const bdPort = Number(process.env.STAND_BD_PORT ?? (await freePort()));
  const out = await runStand([
    "up",
    "--dir",
    dir,
    "--dolt-port",
    String(doltPort),
    "--bd-port",
    String(bdPort),
  ]);
  const kv = parseKeyValues(out);
  const apiUrl = kv.BD_URL ?? `http://127.0.0.1:${bdPort}/v0/beads`;
  return {
    dir: kv.STAND_DIR ?? dir,
    doltPort: Number(kv.DOLT_PORT ?? doltPort),
    bdPort: Number(kv.BD_PORT ?? bdPort),
    baseUrl: apiUrl.replace(/\/v0\/beads$/, ""),
    apiUrl,
    wsDir: kv.WS_DIR ?? `${dir}/ws`,
    database: kv.DATABASE ?? "",
    fresh,
  };
}

/** `scripts/stand.sh seed` → the seeded ids (`SEED_EPIC`, `SEED_CHILD1`, `SEED_CHILD2`, `SEED_TASK`, `SEED_CLOSED`). */
export async function seedStand(stand: Stand): Promise<Record<string, string>> {
  return parseKeyValues(await runStand(["seed", "--dir", stand.dir]));
}

/** Environment for child processes that must never see the BEADS_* / BD_* variables of this shell. */
export { cleanEnv };

export async function stopStand(stand: Stand): Promise<void> {
  if (process.env.KEEP_STAND === "1") {
    console.log(`KEEP_STAND=1: stand left running in ${stand.dir} (${stand.apiUrl})`);
    return;
  }
  // Purge only a directory this run created; a caller-provided STAND_DIR is left in place.
  await runStand(["down", "--dir", stand.dir, ...(stand.fresh ? ["--purge"] : [])]);
}
