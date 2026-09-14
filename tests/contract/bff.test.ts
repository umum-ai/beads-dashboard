/**
 * Contract test of the BFF (`bddb serve`) against a real stand: scratch dolt + seeded workspace.
 * bddb runs as a child process exactly as a user would start it. Run: `mise run contract`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { Meta, Snapshot } from "../../src/server/types.ts";
import { cleanEnv, REPO_ROOT, type Stand, seedStand, startStand, stopStand } from "./setup.ts";

let stand: Stand;
let seed: Record<string, string>;
let bddb: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let db = "";
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

function bdCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bd", "-C", stand.wsDir, "--actor", "bff-contract", ...args], {
    env: { ...cleanEnv(), BD_NON_INTERACTIVE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([out, err, code]) => {
    if (code !== 0) throw new Error(`bd ${args.join(" ")} failed (${code}): ${err}`);
    return out.trim();
  });
}

beforeAll(async () => {
  stand = await startStand();
  seed = await seedStand(stand);
  db = stand.database;
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
      BDDB_POLL_INTERVAL: "3s",
      BDDB_LOG_LEVEL: "debug",
      BDDB_WORK_DIR: path.join(stand.dir, "bddb-work"),
      BDDB_ACTOR: "bddb-contract",
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
  // Nothing bddb started may survive it: no `bd serve` for our workspace, no db-proxy-child.
  const ps = Bun.spawn(["ps", "-eo", "args"], { stdout: "pipe" });
  const args = await new Response(ps.stdout).text();
  const leaked = args.split("\n").filter((l) => l.includes(path.join(stand.dir, "bddb-work")));
  expect(leaked).toEqual([]);
  if (stand) await stopStand(stand);
}, 60_000);

describe("process endpoints", () => {
  test("healthz / readyz / meta", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ databases: { [db]: "ready" } });
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as Meta;
    expect(meta.bddb.builtForBeads).toBe("1.3.0-rc.2");
    expect(meta.defaultDatabase).toBe(db);
    expect(meta.pollIntervalMs).toBe(3000);
    expect(meta.closedHours).toBe(72);
    expect(meta.databases).toHaveLength(1);
    const info = meta.databases[0];
    expect(info?.name).toBe(db);
    expect(info?.state).toBe("ready");
    // Discovery counted `issues` after the seed: at least the seeded rows (epic, 2 children, task, closed).
    expect(info?.issueCount).toBeGreaterThanOrEqual(Object.keys(seed).length);
    expect(info?.bdVersion).toMatch(/^1\.3\./);
    expect(info?.capabilities).toContain("events.watch");
    expect(info?.versionWarning).toBeNull();
  });
});

describe("snapshot", () => {
  test("has the seeded issues, the blocked child, the fresh closed task and the ready set", async () => {
    const res = await fetch(`${base}/api/p/${db}/snapshot`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as Snapshot;
    const byId = new Map(snap.issues.map((i) => [i.id, i]));
    expect(byId.has(seed.SEED_EPIC ?? "")).toBe(true);
    expect(byId.get(seed.SEED_CHILD1 ?? "")?.parent).toBe(seed.SEED_EPIC);
    expect(byId.get(seed.SEED_CHILD2 ?? "")?.blocked).toBe(true);
    expect(byId.get(seed.SEED_CHILD2 ?? "")?.dependency_count).toBe(1); // `blocks` only: list rows do not count parent-child
    expect(byId.get(seed.SEED_CHILD1 ?? "")?.blocked).toBe(false);
    expect(byId.get(seed.SEED_CLOSED ?? "")?.status).toBe("closed");
    expect(byId.get(seed.SEED_CLOSED ?? "")?.blocked).toBe(false);
    expect(snap.ready).toContain(seed.SEED_CHILD1 ?? "");
    expect(snap.ready).not.toContain(seed.SEED_CHILD2 ?? "");
    expect(snap.statuses.map((s) => s.name)).toEqual([
      "open",
      "in_progress",
      "blocked",
      "hooked",
      "deferred",
      "pinned",
      "closed",
    ]);
    expect(snap.types).toContain("epic");
    expect(snap.stats?.total_issues).toBeGreaterThanOrEqual(5);
    expect(snap.database.live).toBe("sse");
    for (const row of snap.issues) expect(row).not.toHaveProperty("description");
  });

  test("unknown database → 404 problem", async () => {
    const res = await fetch(`${base}/api/p/nope/snapshot`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await res.json()).code).toBe("bddb_database_unknown");
  });
});

describe("live stream", () => {
  test("snapshot on connect, then a delta after a CLI mutation in the stand workspace", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/p/${db}/events`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: { event: string; data: string }[] = [];
    const readUntil = async (pred: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new Error(`timeout; frames so far: ${frames.map((f) => f.event).join(",")}`);
        const chunk = await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]);
        if (!chunk) throw new Error("timeout waiting for SSE chunk");
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data !== undefined) frames.push({ event: ev, data });
          idx = buffer.indexOf("\n\n");
        }
      }
    };
    try {
      await readUntil(() => frames.some((f) => f.event === "snapshot"), 5000);
      const snap = JSON.parse(frames[0]?.data ?? "{}") as Snapshot;
      expect(frames[0]?.event).toBe("snapshot");
      expect(snap.issues.length).toBeGreaterThan(0);

      const title = `Live probe ${Date.now()}`;
      const id = await bdCli(["q", "--type", "task", "--priority", "1", title]);
      await readUntil(
        () =>
          frames.some(
            (f) => f.event === "delta" && f.data.includes(`"id":"${id}"`) && f.data.includes(title),
          ),
        5000,
      );
      const delta = frames
        .filter((f) => f.event === "delta")
        .map(
          (f) => JSON.parse(f.data) as { seq: number; upserts: { id: string; blocked: boolean }[] },
        )
        .find((d) => d.upserts.some((u) => u.id === id));
      expect(delta?.seq).toBeGreaterThan(snap.seq);
      // The debounced ready refresh follows: a delta carrying the ready set including the new issue.
      await readUntil(
        () =>
          frames.some(
            (f) => f.event === "delta" && /"ready":\[/.test(f.data) && f.data.includes(id),
          ),
        5000,
      );
      const seqs = frames
        .filter((f) => f.event === "delta")
        .map((f) => (JSON.parse(f.data) as { seq: number }).seq);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
    } finally {
      ctrl.abort();
      reader.cancel().catch(() => {});
    }
  }, 20_000);
});

describe("proxies", () => {
  let created = "";
  let revision = "";

  test("POST issues creates with the default actor", async () => {
    const res = await fetch(`${base}/api/p/${db}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Created through bddb", issue_type: "task", priority: 2 }),
    });
    expect(res.status).toBe(200);
    const issue = (await res.json()) as { id: string; title: string; status: string };
    expect(issue.id).toMatch(/^[a-z0-9]+-/);
    expect(issue.status).toBe("open");
    created = issue.id;
  });

  test("GET issues/{id} yields the revision; read proxy whitelists parameters", async () => {
    const res = await fetch(
      `${base}/api/p/${db}/issues/${created}?include_comments=true&include_dependents=true`,
    );
    expect(res.status).toBe(200);
    const details = (await res.json()) as { revision: string; comments?: unknown[] };
    expect(typeof details.revision).toBe("string");
    revision = details.revision;
    const bad = await fetch(`${base}/api/p/${db}/issues?updated_after=2020`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("bddb_invalid_argument");
    const list = await fetch(`${base}/api/p/${db}/issues?status=closed&limit=0&brief=true`);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { id: string }[]; has_more: boolean };
    expect(page.items.map((i) => i.id)).toContain(seed.SEED_CLOSED ?? "");
    const query = await fetch(
      `${base}/api/p/${db}/issues:query?q=${encodeURIComponent("status=open AND priority<=1")}`,
    );
    expect(query.status).toBe(200);
    const badQuery = await fetch(
      `${base}/api/p/${db}/issues:query?q=${encodeURIComponent("status=")}`,
    );
    expect(badQuery.status).toBe(400);
    expect((await badQuery.json()).param).toBe("q");
  });

  test("guarded PATCH: first write succeeds, the stale one is 409 precondition_failed unchanged", async () => {
    const first = await fetch(`${base}/api/p/${db}/issues/${created}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_version: revision, patch: { status: "in_progress" } }),
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { changed: boolean; revision: string };
    expect(body.changed).toBe(true);
    expect(body.revision).not.toBe(revision);
    const stale = await fetch(`${base}/api/p/${db}/issues/${created}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_version: revision, patch: { priority: 0 } }),
    });
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toContain("application/problem+json");
    const problem = (await stale.json()) as { code: string; param?: string; request_id: string };
    expect(problem.code).toBe("precondition_failed");
    expect(problem.param).toBe("expected_version");
    expect(problem.request_id).not.toBe("");
  });

  test("close / comments / dependencies round-trip through the slash routes", async () => {
    const comment = await fetch(`${base}/api/p/${db}/issues/${created}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "from bddb" }),
    });
    expect(comment.status).toBe(200);
    expect(((await comment.json()) as { author: string }).author).toBe("bddb-contract");
    const dep = await fetch(`${base}/api/p/${db}/dependencies/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // SEED_TASK now depends on the created issue (which stays closable: nothing blocks it).
      body: JSON.stringify({
        edges: [{ issue_id: seed.SEED_TASK, depends_on_id: created, type: "blocks" }],
      }),
    });
    expect(dep.status).toBe(200);
    const closed = await fetch(`${base}/api/p/${db}/issues/${created}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "done in contract test" }),
    });
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as { issue: { status: string } }).issue.status).toBe("closed");
    const forbidden = await fetch(`${base}/api/p/${db}/issues:delete`, {
      method: "POST",
      body: "{}",
    });
    expect(forbidden.status).toBe(404);
  });

  test("polling notices the changes even without the stream (snapshot converges)", async () => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const snap = (await (await fetch(`${base}/api/p/${db}/snapshot`)).json()) as Snapshot;
      const row = snap.issues.find((i) => i.id === created);
      if (row?.status === "closed" && row.comment_count === 1 && row.dependent_count === 1) break;
      if (Date.now() > deadline)
        throw new Error(`snapshot did not converge: ${JSON.stringify(row)}`);
      await Bun.sleep(300);
    }
  }, 15_000);
});

describe("bddb doctor", () => {
  test("exits non-zero against a wrong dolt port and zero against the stand", async () => {
    const wrongPort = await freePort();
    const run = (port: number) =>
      Bun.spawn(
        [
          "bun",
          path.join(REPO_ROOT, "src/server/cli.ts"),
          "doctor",
          "--dolt-host",
          "127.0.0.1",
          "--dolt-port",
          String(port),
        ],
        { cwd: REPO_ROOT, env: cleanEnv(), stdout: "pipe", stderr: "pipe" },
      );
    const bad = run(wrongPort);
    const [badOut, badCode] = await Promise.all([new Response(bad.stdout).text(), bad.exited]);
    expect(badCode).not.toBe(0);
    expect(badOut).toContain("✗ dolt reachable");
    const good = run(stand.doltPort);
    const [goodOut, goodCode] = await Promise.all([new Response(good.stdout).text(), good.exited]);
    expect(goodCode).toBe(0);
    expect(goodOut).toContain(`✓ bd serve (${db})`);
    expect(goodOut).toContain("events journal");
    expect(goodOut).toContain("events-journal true");
  }, 40_000);
});
