/**
 * SSE consumer for `GET /v0/beads/events:watch`.
 *
 * Built on `fetch` + a streaming body parser rather than `EventSource`, so custom headers
 * (`Last-Event-ID` on the first connect, `Bd-Project-Id`, `Authorization`) work everywhere.
 *
 * Frames the server emits (spec, `watchEvents` 200): `retry: 3000`; `id: <seq>` + `data:
 * <EventRecord>` as an unnamed event; `: heartbeat` comments every ~20 s; and the ONE in-band
 * failure `event: truncated` + `data: <Problem>` after which the stream closes.
 *
 * This module does NOT reconnect: the iterable ends cleanly when the stream ends (server
 * shutdown, `truncated`, or the caller's `signal` aborting). The BFF owns reconnection and
 * the checkpoint (`since` / `Last-Event-ID` = last seq it durably processed).
 */
import {
  API_PREFIX,
  baseHeaders,
  buildUrl,
  type ConnectionOptions,
  serializeQuery,
} from "./http.ts";
import { type Problem, problemFromResponse } from "./problem.ts";
import type { EventRecord } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Low-level SSE parser (WHATWG "Server-sent events" event stream format)
// ---------------------------------------------------------------------------------------------

export type SseFrame =
  | { kind: "event"; event: string | undefined; data: string; id: string | undefined }
  | { kind: "comment"; text: string }
  | { kind: "retry"; ms: number };

/**
 * Incremental parser: feed decoded text chunks of any size (lines and even CRLF pairs may be
 * split across chunks), get complete frames back. `end()` flushes a final line that lacked a
 * terminator; an event without its terminating blank line is discarded, as the spec requires.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventType: string | undefined;
  private lastEventId: string | undefined;
  private first = true;

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    if (this.first && this.buffer.length > 0) {
      // A leading BOM is ignored once.
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
      this.first = false;
    }
    const frames: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const nl = this.buffer.indexOf("\n", start);
      const cr = this.buffer.indexOf("\r", start);
      let end: number;
      let next: number;
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        // CR: if it is the last char of the buffer we cannot know yet whether an LF follows.
        if (cr === this.buffer.length - 1) break;
        end = cr;
        next = this.buffer.charAt(cr + 1) === "\n" ? cr + 2 : cr + 1;
      } else if (nl !== -1) {
        end = nl;
        next = nl + 1;
      } else {
        break;
      }
      this.processLine(this.buffer.slice(start, end), frames);
      start = next;
    }
    this.buffer = this.buffer.slice(start);
    return frames;
  }

  /** Flush at end of stream: a final unterminated line is processed; a pending event is dropped. */
  end(): SseFrame[] {
    const frames: SseFrame[] = [];
    const rest = this.buffer;
    this.buffer = "";
    // A trailing bare CR is a complete terminator (the LF that might have followed never came).
    if (rest.endsWith("\r")) this.processLine(rest.slice(0, -1), frames);
    else if (rest.length > 0) this.processLine(rest, frames);
    this.dataLines = [];
    this.eventType = undefined;
    return frames;
  }

  private processLine(line: string, frames: SseFrame[]): void {
    if (line === "") {
      if (this.dataLines.length === 0) {
        this.eventType = undefined;
        return;
      }
      frames.push({
        kind: "event",
        event: this.eventType,
        data: this.dataLines.join("\n"),
        id: this.lastEventId,
      });
      this.dataLines = [];
      this.eventType = undefined;
      return;
    }
    if (line.startsWith(":")) {
      frames.push({ kind: "comment", text: line.slice(1).replace(/^ /, "") });
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) frames.push({ kind: "retry", ms: Number(value) });
        break;
      default:
        // Unknown field: ignored, per spec.
        break;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// bd serve events stream
// ---------------------------------------------------------------------------------------------

export type WatchEvent =
  /** One journal record; `seq` is taken from the `id:` field (falls back to `record.seq`). */
  | { type: "record"; record: EventRecord; seq: number }
  /** `event: truncated`: stop and re-baseline (`problem.code === "events_journal_truncated"`). */
  | { type: "truncated"; problem: Problem }
  /** `: heartbeat` (or any other comment) — the connection is alive. */
  | { type: "heartbeat" }
  /** `retry: <ms>` — the server's suggested reconnection delay. */
  | { type: "retry"; ms: number }
  /** A named event this client does not know; default-branch (log and ignore). */
  | { type: "unknown"; event: string; data: string; id: string | undefined };

export interface WatchEventsOptions extends ConnectionOptions {
  /** Required by the spec on every connect; `0` streams from the retained beginning. */
  since: number;
  /** Resume point; when present it REPLACES `since` server-side (standard SSE header). */
  lastEventId?: number | string;
  /** Aborting ends the iterable cleanly (no error is thrown for the abort itself). */
  signal?: AbortSignal;
}

/** Thrown when the 200 response is not an event stream or a frame's JSON does not parse. */
export class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseProtocolError";
  }
}

/** Map one parsed SSE frame to zero or one `WatchEvent`. Exported for unit tests. */
export function frameToWatchEvent(frame: SseFrame): WatchEvent | undefined {
  switch (frame.kind) {
    case "comment":
      return { type: "heartbeat" };
    case "retry":
      return { type: "retry", ms: frame.ms };
    case "event": {
      if (frame.event === undefined || frame.event === "" || frame.event === "message") {
        const record = parseJson<EventRecord>(frame.data, "EventRecord");
        const fromId = frame.id === undefined ? Number.NaN : Number(frame.id);
        const seq = Number.isSafeInteger(fromId) ? fromId : record.seq;
        return { type: "record", record, seq };
      }
      if (frame.event === "truncated") {
        return { type: "truncated", problem: parseJson<Problem>(frame.data, "Problem") };
      }
      return { type: "unknown", event: frame.event, data: frame.data, id: frame.id };
    }
    default:
      return undefined;
  }
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new SseProtocolError(`events:watch: ${what} frame is not JSON: ${String(err)}`);
  }
}

const WATCH_QUERY_KEYS: Record<"since", true> = { since: true };

/**
 * Open `GET /v0/beads/events:watch?since=N` and yield its frames until the stream ends.
 * A non-200 response throws `ProblemError` before the first yield (409
 * `events_journal_disabled`, 410 `events_journal_truncated`, 503 `events_watch_saturated`
 * with `retryAfterMs`, ...).
 */
export async function* watchEvents(
  options: WatchEventsOptions,
): AsyncGenerator<WatchEvent, void, undefined> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const query = serializeQuery("watchEvents", { since: options.since }, WATCH_QUERY_KEYS);
  const url = buildUrl(options.baseUrl, `${API_PREFIX}/events:watch`, query);
  const headers = baseHeaders(options, "text/event-stream");
  if (options.lastEventId !== undefined) headers["last-event-id"] = String(options.lastEventId);

  const response = await doFetch(url, {
    method: "GET",
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw await problemFromResponse(response, { method: "GET", url });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    await response.body?.cancel().catch(() => {});
    throw new SseProtocolError(
      `events:watch: expected text/event-stream, got ${contentType || "no content-type"}`,
    );
  }
  if (!response.body) throw new SseProtocolError("events:watch: response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (options.signal?.aborted) return;
        throw err;
      }
      if (chunk.done) break;
      for (const frame of parser.feed(decoder.decode(chunk.value, { stream: true }))) {
        const event = frameToWatchEvent(frame);
        if (event) yield event;
      }
    }
    const tail = decoder.decode();
    const frames = tail.length > 0 ? parser.feed(tail) : [];
    for (const frame of [...frames, ...parser.end()]) {
      const event = frameToWatchEvent(frame);
      if (event) yield event;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
