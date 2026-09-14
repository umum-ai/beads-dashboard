/**
 * Resilience of the BFF against a real stand: what `/api/meta`, the browser event stream and
 * `/readyz` report when the database's `bd serve` dies (→ `down`, restarted by the supervisor
 * within seconds) and when its detached `bd db-proxy-child` dies (→ `degraded`; the supervisor
 * restarts both after a minute — not awaited here to keep the run short). Run: `mise run contract`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { DatabaseInfo, Meta } from "../../src/server/types.ts";
import { cleanEnv, REPO_ROOT, type Stand, seedStand, startStand, stopStand } from "./setup.ts";

let stand: Stand;
let bddb: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let db = "";
let workDir = "";
const bddbLog: string[] = [];

async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

function collect(stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  void (async () => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) if (line.trim()) bddbLog.push(line);
    }
  })();
}

async function waitFor(url: string, status: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status === status) return;
      last = `${res.status} ${await res.text()}`;
    } catch (err) {
      last = String(err);
    }
    await Bun.sleep(200);
  }
  throw new Error(
    `${url} did not answer ${status} within ${ms} ms (last: ${last})\n${bddbLog.slice(-20).join("\n")}`,
  );
}

async function info(): Promise<DatabaseInfo> {
  const meta = (await (await fetch(`${base}/api/meta`)).json()) as Meta;
  const found = meta.databases.find((d) => d.name === db);
  if (!found) throw new Error(`database ${db} missing from meta`);
  return found;
}

/** Poll `/api/meta` until the database reaches `state`; returns the info seen. */
async function untilState(state: DatabaseInfo["state"], ms: number): Promise<DatabaseInfo> {
  const deadline = Date.now() + ms;
  let last: DatabaseInfo | null = null;
  while (Date.now() < deadline) {
    last = await info();
    if (last.state === state) return last;
    await Bun.sleep(200);
  }
  throw new Error(
    `database did not reach ${state} within ${ms} ms (last: ${JSON.stringify(last)})\n${bddbLog.slice(-20).join("\n")}`,
  );
}

/** Pids of processes whose command line contains `needle` (bddb's own children live under the work dir). */
async function pidsMatching(needle: string): Promise<{ pid: number; args: string }[]> {
  const ps = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe" });
  const text = await new Response(ps.stdout).text();
  const out: { pid: number; args: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m?.[1] && m[2]?.includes(needle)) out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

/** The `bd serve` bddb runs for our database: `ps` shows only `bd serve --addr …`, so it is told apart by its cwd (the synthesized workspace). */
async function bdServePid(): Promise<number> {
  const candidates = await pidsMatching("bd serve --addr 127.0.0.1:");
  for (const c of candidates) {
    try {
      const cwd = await Bun.$`readlink /proc/${c.pid}/cwd`.text();
      if (cwd.trim() === path.join(workDir, db)) return c.pid;
    } catch {
      /* gone */
    }
  }
  throw new Error(
    `no bd serve with cwd ${path.join(workDir, db)} (candidates: ${JSON.stringify(candidates)})`,
  );
}

async function proxyPid(): Promise<number> {
  const record = await Bun.file(path.join(workDir, db, ".beads/dolt/proxy.pid")).json();
  return Number((record as { pid: number }).pid);
}

/** Collect SSE frames of `/events` into `frames` until the signal aborts. */
function tapEvents(frames: { event: string; data: string }[], signal: AbortSignal): Promise<void> {
  return fetch(`${base}/api/p/${db}/events`, { signal })
    .then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
          if (event) frames.push({ event, data }); // skip the `retry:` preamble
          sep = buffer.indexOf("\n\n");
        }
      }
    })
    .catch(() => {});
}

beforeAll(async () => {
  stand = await startStand();
  await seedStand(stand);
  db = stand.database;
  workDir = path.join(stand.dir, "bddb-work");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  bddb = Bun.spawn(["bun", path.join(REPO_ROOT, "src/server/cli.ts"), "serve"], {
    cwd: REPO_ROOT,
    env: {
      ...cleanEnv(),
      BDDB_HOST: "127.0.0.1",
      BDDB_PORT: String(port),
      BDDB_DOLT_HOST: "127.0.0.1",
      BDDB_DOLT_PORT: String(stand.doltPort),
      BDDB_DATABASES: db,
      BDDB_POLL_INTERVAL: "2s",
      BDDB_LOG_LEVEL: "info",
      BDDB_WORK_DIR: workDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  collect(bddb.stdout as ReadableStream<Uint8Array>);
  collect(bddb.stderr as ReadableStream<Uint8Array>);
  await waitFor(`${base}/healthz`, 200, 20_000);
  await waitFor(`${base}/readyz`, 200, 40_000);
}, 90_000);

afterAll(async () => {
  if (bddb && bddb.exitCode === null) {
    bddb.kill("SIGTERM");
    const exited = await Promise.race([
      bddb.exited,
      Bun.sleep(15_000).then(() => "timeout" as const),
    ]);
    if (exited === "timeout") bddb.kill("SIGKILL");
  }
  // Nothing bddb started may survive it: neither the restarted `bd serve` nor a proxy.
  const leaked = (await pidsMatching(workDir)).filter((p) => !p.args.startsWith("ps "));
  expect(leaked).toEqual([]);
  if (stand) await stopStand(stand);
}, 60_000);

describe("startup log", () => {
  test("prints the dashboard URL and one line per database", () => {
    expect(bddbLog.some((l) => l.includes(`dashboard: ${base}/`))).toBe(true);
    expect(bddbLog.some((l) => l.includes(`database ${db}: ready`))).toBe(true);
  });
});

describe("bd serve dies", () => {
  test("meta reports down with the reason, readyz turns 503, then the supervisor brings it back", async () => {
    const frames: { event: string; data: string }[] = [];
    const tap = new AbortController();
    const tapping = tapEvents(frames, tap.signal);
    await Bun.sleep(300);
    expect(frames[0]?.event).toBe("snapshot");

    const pid = await bdServePid();
    process.kill(pid, "SIGKILL");

    const down = await untilState("down", 10_000);
    expect(down.live).toBe("none");
    expect(down.lastError).toMatch(/bd serve process exited/);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    const snapshot = await fetch(`${base}/api/p/${db}/snapshot`);
    expect(snapshot.status).toBe(503);
    expect(((await snapshot.json()) as { code: string }).code).toBe("bddb_not_ready");

    const ready = await untilState("ready", 30_000);
    expect(ready.lastError).toBeNull();
    expect(ready.bdVersion).toMatch(/^1\.3\./);
    await waitFor(`${base}/readyz`, 200, 5_000);
    const again = await fetch(`${base}/api/p/${db}/snapshot`);
    expect(again.status).toBe(200);

    // The browser stream stayed open through the restart: a `status` frame said down, and
    // the re-baseline after the restart arrived as a fresh `snapshot`.
    await Bun.sleep(500);
    tap.abort();
    await tapping;
    const statuses = frames
      .filter((f) => f.event === "status")
      .map((f) => (JSON.parse(f.data) as DatabaseInfo).state);
    expect(statuses).toContain("down");
    expect(statuses).toContain("ready");
    expect(frames.filter((f) => f.event === "snapshot").length).toBeGreaterThanOrEqual(2);
    expect(bddbLog.some((l) => l.includes(`database ${db}: down`))).toBe(true);
  }, 60_000);
});

describe("db-proxy-child dies", () => {
  test("bd serve answers 503 db_unavailable → meta reports degraded with the problem detail", async () => {
    const pid = await proxyPid();
    process.kill(pid, "SIGKILL");
    const degraded = await untilState("degraded", 15_000);
    expect(degraded.lastError).toMatch(/db_unavailable/);
    // Degraded still serves the last snapshot (readyz stays 200); writes fail upstream.
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/api/p/${db}/snapshot`)).status).toBe(200);
    // Recovery (restart of bd serve + proxy) happens after the 60 s watchdog; verified by
    // hand on the stand, not awaited here.
  }, 30_000);
});
