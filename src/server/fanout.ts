/**
 * Browser-facing SSE fan-out for one database (docs/bff-api.md "Per-database live stream"):
 * `snapshot` on connect, then `delta` / `status` as they happen and a `heartbeat` every 20 s.
 * No `since`, no `id:` fields — a reconnect always gets a fresh snapshot.
 */
import type { StreamEvent } from "./types.ts";

export const HEARTBEAT_MS = 20_000;

/** One SSE frame: `event:` name + one-line JSON `data:`; newlines inside data are impossible (JSON). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface Subscriber {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

export interface FanoutOptions {
  heartbeatMs?: number;
  now?: () => Date;
}

export class Fanout {
  private readonly subscribers = new Set<Subscriber>();
  private readonly encoder = new TextEncoder();
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(options: FanoutOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.now = options.now ?? (() => new Date());
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Build the streaming response; `first` frames (the snapshot) are written before anything else. */
  subscribe(first: StreamEvent[], signal?: AbortSignal): Response {
    if (this.closed) return new Response(null, { status: 503 });
    let subscriber: Subscriber | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        subscriber = { controller };
        controller.enqueue(this.encoder.encode("retry: 3000\n\n"));
        for (const frame of first)
          controller.enqueue(this.encoder.encode(sseFrame(frame.event, frame.data)));
        this.subscribers.add(subscriber);
        this.ensureHeartbeat();
        signal?.addEventListener("abort", () => this.drop(subscriber), { once: true });
      },
      cancel: () => this.drop(subscriber),
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  broadcast(frame: StreamEvent): void {
    if (this.subscribers.size === 0) return;
    const bytes = this.encoder.encode(sseFrame(frame.event, frame.data));
    for (const sub of [...this.subscribers]) {
      try {
        sub.controller.enqueue(bytes);
      } catch {
        this.drop(sub);
      }
    }
  }

  /** End every stream (shutdown). */
  close(): void {
    this.closed = true;
    for (const sub of [...this.subscribers]) {
      try {
        sub.controller.close();
      } catch {
        /* already closed */
      }
    }
    this.subscribers.clear();
    this.stopHeartbeat();
  }

  private drop(sub: Subscriber | null): void {
    if (!sub) return;
    if (this.subscribers.delete(sub)) {
      try {
        sub.controller.close();
      } catch {
        /* closed by the client */
      }
    }
    if (this.subscribers.size === 0) this.stopHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      this.broadcast({ event: "heartbeat", data: { ts: this.now().toISOString() } });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
