import { describe, expect, test } from "bun:test";
import { BdClient } from "../../../src/api-client/index.ts";
import { probeHead, runLiveStream } from "../../../src/server/live.ts";
import { silentLogger } from "../../../src/server/log.ts";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler): BdClient {
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init ?? {}))) as unknown as typeof fetch;
  return new BdClient({ baseUrl: "http://bd.test", fetch: fetchImpl, timeoutMs: 1000 });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ code, status, title: code, request_id: "r", ...extra }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

function record(seq: number, id: string): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ seq, ts: "t", op: "update", issue_id: id, issue: { id } })}\n\n`;
}

function sse(frames: string, signal?: AbortSignal | null, holdOpen = false): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames));
      if (!holdOpen) controller.close();
      else signal?.addEventListener("abort", () => controller.close(), { once: true });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

function until(pred: () => boolean, ms = 2000): Promise<void> {
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

describe("probeHead", () => {
  test("ok / truncated / disabled / error", async () => {
    expect(await probeHead(client(() => Response.json({ records: [], head: 42 })))).toEqual({
      kind: "ok",
      head: 42,
    });
    expect(
      await probeHead(
        client(() => problem(410, "events_journal_truncated", { head: 99, floor: 50 })),
      ),
    ).toEqual({ kind: "truncated", head: 99 });
    expect(await probeHead(client(() => problem(409, "events_journal_disabled")))).toEqual({
      kind: "disabled",
    });
    const err = await probeHead(client(() => problem(503, "db_unavailable")));
    expect(err.kind).toBe("error");
  });
});

describe("runLiveStream", () => {
  test("probe → rebaseline(start) → stream from head → reconnect from the last seq", async () => {
    const watchSince: string[] = [];
    let connects = 0;
    const bd = client((url, init) => {
      if (url.pathname.endsWith("/events")) return Response.json({ records: [], head: 10 });
      watchSince.push(url.searchParams.get("since") ?? "");
      connects++;
      if (connects === 1) return sse(`retry: 3000\n\n${record(11, "a")}${record(12, "b")}`);
      return sse(`retry: 3000\n\n${record(13, "c")}`, init.signal, true);
    });
    const seen: number[] = [];
    const rebaselines: string[] = [];
    const live: string[] = [];
    const ctrl = new AbortController();
    const done = runLiveStream({
      client: bd,
      log: silentLogger,
      signal: ctrl.signal,
      disabledRetryMs: 50,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      onRecord: (_r, seq) => seen.push(seq),
      onConnected: () => live.push("sse"),
      onDisconnected: (reason) => live.push(`off:${reason}`),
      onRebaseline: async (reason) => {
        rebaselines.push(reason);
      },
    });
    await until(() => seen.length === 3);
    ctrl.abort();
    await done;
    expect(rebaselines).toEqual(["start"]);
    expect(watchSince).toEqual(["10", "12"]);
    expect(seen).toEqual([11, 12, 13]);
    expect(live.slice(0, 3)).toEqual(["sse", "off:stream_closed", "sse"]);
  });

  test("journal disabled → rebaseline(journal_disabled), polling, retries the probe", async () => {
    let probes = 0;
    const bd = client(() => {
      probes++;
      return problem(409, "events_journal_disabled");
    });
    const rebaselines: string[] = [];
    const off: string[] = [];
    const ctrl = new AbortController();
    const done = runLiveStream({
      client: bd,
      log: silentLogger,
      signal: ctrl.signal,
      disabledRetryMs: 20,
      onRecord: () => {},
      onConnected: () => {},
      onDisconnected: (reason) => off.push(reason),
      onRebaseline: async (reason) => {
        rebaselines.push(reason);
      },
    });
    await until(() => probes >= 3);
    ctrl.abort();
    await done;
    expect(rebaselines[0]).toBe("journal_disabled");
    expect(off[0]).toBe("journal_disabled");
  });

  test("truncated frame → since = head, rebaseline(truncated), reconnect from head", async () => {
    const watchSince: string[] = [];
    let connects = 0;
    const bd = client((url, init) => {
      if (url.pathname.endsWith("/events")) return Response.json({ records: [], head: 5 });
      watchSince.push(url.searchParams.get("since") ?? "");
      connects++;
      if (connects === 1) {
        const truncated = `event: truncated\ndata: ${JSON.stringify({
          code: "events_journal_truncated",
          status: 410,
          title: "Gone",
          request_id: "r",
          since: 5,
          floor: 80,
          head: 100,
        })}\n\n`;
        return sse(`retry: 3000\n\n${record(6, "a")}${truncated}`);
      }
      return sse("retry: 3000\n\n", init.signal, true);
    });
    const rebaselines: string[] = [];
    const ctrl = new AbortController();
    const done = runLiveStream({
      client: bd,
      log: silentLogger,
      signal: ctrl.signal,
      disabledRetryMs: 50,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      onRecord: () => {},
      onConnected: () => {},
      onDisconnected: () => {},
      onRebaseline: async (reason) => {
        rebaselines.push(reason);
      },
    });
    await until(() => watchSince.length === 2);
    ctrl.abort();
    await done;
    expect(rebaselines).toEqual(["start", "truncated"]);
    expect(watchSince).toEqual(["5", "100"]);
  });
});
