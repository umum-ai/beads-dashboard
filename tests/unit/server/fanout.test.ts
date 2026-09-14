import { describe, expect, test } from "bun:test";
import { Fanout, sseFrame } from "../../../src/server/fanout.ts";
import type { Snapshot } from "../../../src/server/types.ts";

const snapshot: Snapshot = {
  seq: 1,
  database: {
    name: "kb",
    state: "ready",
    live: "sse",
    lastSyncAt: null,
    bdVersion: null,
    projectId: null,
    versionWarning: null,
    issueCount: 0,
    capabilities: [],
  },
  statuses: [],
  types: [],
  issues: [],
  ready: [],
  stats: null,
};

async function readFor(response: Response, ms: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as const),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text;
}

describe("sseFrame", () => {
  test("event + one-line JSON data + blank line", () => {
    expect(sseFrame("delta", { seq: 2, upserts: [], removes: [] })).toBe(
      'event: delta\ndata: {"seq":2,"upserts":[],"removes":[]}\n\n',
    );
  });
});

describe("Fanout", () => {
  test("snapshot first, then broadcasts, heartbeats, and disconnects drop subscribers", async () => {
    const fanout = new Fanout({ heartbeatMs: 30, now: () => new Date("2026-09-14T12:00:00Z") });
    const ctrl = new AbortController();
    const res = fanout.subscribe([{ event: "snapshot", data: snapshot }], ctrl.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await Bun.sleep(5);
    expect(fanout.size).toBe(1);
    fanout.broadcast({ event: "delta", data: { seq: 2, upserts: [], removes: [] } });
    fanout.broadcast({ event: "status", data: snapshot.database });
    const text = await readFor(res, 120);
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(text.startsWith("retry: 3000\n\n")).toBe(true);
    expect(events.slice(0, 3)).toEqual(["snapshot", "delta", "status"]);
    expect(events).toContain("heartbeat");
    expect(text).toContain('data: {"ts":"2026-09-14T12:00:00.000Z"}');
    ctrl.abort();
    await Bun.sleep(5);
    expect(fanout.size).toBe(0);
    fanout.close();
  });

  test("close ends streams and refuses new subscribers", async () => {
    const fanout = new Fanout({ heartbeatMs: 0 });
    const res = fanout.subscribe([]);
    await Bun.sleep(5);
    fanout.close();
    const text = await readFor(res, 50);
    expect(text).toBe("retry: 3000\n\n");
    expect(fanout.subscribe([]).status).toBe(503);
  });
});
