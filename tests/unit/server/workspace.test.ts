import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StartupError } from "../../../src/server/errors.ts";
import { silentLogger } from "../../../src/server/log.ts";
import { ensureWorkspace, LOCK_FILE } from "../../../src/server/workspace.ts";

const roots: string[] = [];

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bddb-ws-test-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ensureWorkspace lock", () => {
  test("a second instance on the same <root>/<db> fails fast and names BDDB_WORK_DIR", async () => {
    const root = await tmpRoot();
    const alive = new Set([1001, 1002]);
    const isAlive = (pid: number) => alive.has(pid);
    const first = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 1001,
      isAlive,
    });
    expect(first.dir).toBe(path.join(root, "kb"));
    expect((await readFile(path.join(first.dir, LOCK_FILE), "utf8")).trim()).toBe("1001");
    expect((await stat(path.join(first.dir, ".git"))).isDirectory()).toBe(true);

    let error: unknown;
    try {
      await ensureWorkspace({ root, database: "kb", log: silentLogger, pid: 1002, isAlive });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StartupError);
    const startup = error as StartupError;
    expect(startup.message).toContain("pid 1001");
    expect(startup.hints.join("\n")).toContain("BDDB_WORK_DIR");
    // The loser did not disturb the holder's lock.
    expect((await readFile(path.join(first.dir, LOCK_FILE), "utf8")).trim()).toBe("1001");

    // Another database under the same root is independent.
    const other = await ensureWorkspace({
      root,
      database: "kb2",
      log: silentLogger,
      pid: 1002,
      isAlive,
    });
    expect(other.dir).toBe(path.join(root, "kb2"));

    // Release removes the file; the next instance acquires it.
    await first.release();
    await first.release(); // idempotent
    await expect(stat(path.join(first.dir, LOCK_FILE))).rejects.toBeDefined();
    const again = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 1002,
      isAlive,
    });
    expect((await readFile(path.join(again.dir, LOCK_FILE), "utf8")).trim()).toBe("1002");
    await again.release();
    await other.release();
  });

  test("a lock left by a dead process is taken over", async () => {
    const root = await tmpRoot();
    const alive = new Set([2002]);
    const isAlive = (pid: number) => alive.has(pid);
    const dead = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 2001,
      isAlive,
    });
    // pid 2001 "dies" without releasing.
    const taken = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 2002,
      isAlive,
    });
    expect(taken.dir).toBe(dead.dir);
    expect((await readFile(path.join(taken.dir, LOCK_FILE), "utf8")).trim()).toBe("2002");
    // The dead owner's stale release must not remove the new owner's lock.
    await dead.release();
    expect((await readFile(path.join(taken.dir, LOCK_FILE), "utf8")).trim()).toBe("2002");
    await taken.release();
  });

  test("the same pid re-entering its own workspace keeps the lock", async () => {
    const root = await tmpRoot();
    const isAlive = () => true;
    const a = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 3001,
      isAlive,
    });
    const b = await ensureWorkspace({
      root,
      database: "kb",
      log: silentLogger,
      pid: 3001,
      isAlive,
    });
    expect(b.dir).toBe(a.dir);
    expect((await readFile(path.join(a.dir, LOCK_FILE), "utf8")).trim()).toBe("3001");
    await b.release();
  });
});
