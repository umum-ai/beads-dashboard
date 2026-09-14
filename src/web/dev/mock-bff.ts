/**
 * Mock BFF for development and e2e. Implements docs/bff-api.md from the in-memory fixture and
 * serves the SPA through Bun HTML routes. Not part of the product build.
 *
 *   bun src/web/dev/mock-bff.ts            # http://127.0.0.1:7331
 *   MOCK_PORT=7400 MOCK_LIVE_MS=0 bun …     # other port, no periodic deltas
 *   MOCK_BULK=1000 bun …                    # add 1000 generated issues to the first database
 *
 * Simplifications versus the real server: query forwarding is validated against a small
 * allowlist; `ready` is approximated from blocking edges; only the write proxies the UI needs
 * in stage 5 (create, patch, close, reopen, comments) are implemented.
 */
import type { Problem } from "../../api-client/types.ts";
import index from "../index.html";
import type {
  BoardIssue,
  DatabaseInfo,
  Delta,
  IssueListResponse,
  Meta,
  Snapshot,
  Stats,
} from "../lib/bff-types.ts";
import {
  addBulk,
  buildFixture,
  childCounts,
  computeReady,
  type FixtureDb,
  type FixtureIssue,
  nextRevision,
  stripRevision,
  toDetails,
  walkTree,
} from "./fixture.ts";

const PORT = Number(process.env.MOCK_PORT ?? process.env.BDDB_PORT ?? 7331);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const LIVE_MS = Number(process.env.MOCK_LIVE_MS ?? 4000);
const CLOSED_DAYS = 7;
const ACTOR_DEFAULT = "bddb";
const NOW = () => Date.now();

const fixture = buildFixture();
const BULK = Number(process.env.MOCK_BULK ?? 0);
if (BULK > 0 && fixture[0]) addBulk(fixture[0], BULK);
const dbs = new Map(fixture.map((db) => [db.name, db]));
const seqs = new Map<string, number>(fixture.map((db) => [db.name, 1]));
const lastSync = new Map<string, string>(fixture.map((db) => [db.name, new Date().toISOString()]));

// ---------------------------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------------------------

function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  const body: Problem = {
    type: `https://bddb.dev/problems/${code}`,
    code,
    status,
    title: code.replace(/_/g, " "),
    detail,
    request_id: `mock-${Date.now().toString(36)}`,
    ...extra,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------------------------
// Snapshot pieces
// ---------------------------------------------------------------------------------------------

function dbInfo(db: FixtureDb): DatabaseInfo {
  return {
    name: db.name,
    state: "ready",
    live: LIVE_MS > 0 ? "sse" : "polling",
    lastSyncAt: lastSync.get(db.name) ?? null,
    bdVersion: "1.3.0-rc.2",
    projectId: `${db.prefix}-project`,
    versionWarning: process.env.MOCK_VERSION_WARNING ?? null,
    capabilities: ["events.watch", "issues.query", "dependencies.tree"],
  };
}

function isDone(db: FixtureDb, status: string): boolean {
  return db.statuses.find((s) => s.name === status)?.category === "done";
}

function isFrozen(db: FixtureDb, status: string): boolean {
  return db.statuses.find((s) => s.name === status)?.category === "frozen";
}

function inScope(db: FixtureDb, r: FixtureIssue): boolean {
  const status = r.status ?? "open";
  if (!isDone(db, status)) return true;
  if (!r.closed_at) return false;
  return NOW() - Date.parse(r.closed_at) <= CLOSED_DAYS * 24 * 3600 * 1000;
}

type Counts = ReturnType<typeof childCounts>;

function toBoard(db: FixtureDb, r: FixtureIssue, ready: Set<string>, counts: Counts): BoardIssue {
  const status = r.status ?? "open";
  const blocked = !isDone(db, status) && !isFrozen(db, status) && !ready.has(r.id);
  const out: BoardIssue = { ...stripRevision(r), blocked };
  const c = counts.get(r.id);
  if (c && c.total > 0) {
    out.child_count = c.total;
    out.child_closed_count = c.closed;
  }
  return out;
}

function countsOf(db: FixtureDb): Counts {
  return childCounts(db, (r) => inScope(db, r));
}

function stats(db: FixtureDb): Stats {
  const all = [...db.issues.values()];
  const by = (s: string) => all.filter((r) => (r.status ?? "open") === s).length;
  const ready = computeReady(db);
  return {
    total_issues: all.length,
    open_issues: by("open"),
    in_progress_issues: by("in_progress"),
    closed_issues: by("closed"),
    deferred_issues: by("deferred"),
    blocked_issues: all.filter((r) => !isDone(db, r.status ?? "open") && !ready.includes(r.id))
      .length,
    ready_issues: ready.length,
    pinned_issues: by("pinned"),
    epics_eligible_for_closure: 0,
    average_lead_time_hours: 36.5,
  };
}

function snapshot(db: FixtureDb): Snapshot {
  const ready = new Set(computeReady(db));
  const counts = countsOf(db);
  const issues = [...db.issues.values()]
    .filter((r) => inScope(db, r))
    .map((r) => toBoard(db, r, ready, counts));
  return {
    seq: seqs.get(db.name) ?? 1,
    database: dbInfo(db),
    statuses: db.statuses,
    types: db.types,
    issues,
    ready: [...ready],
    stats: stats(db),
  };
}

// ---------------------------------------------------------------------------------------------
// SSE fan-out
// ---------------------------------------------------------------------------------------------

type Client = { db: string; send: (event: string, data: unknown) => void; close: () => void };
const clients = new Set<Client>();

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(dbName: string, event: string, data: unknown): void {
  for (const c of clients) if (c.db === dbName) c.send(event, data);
}

/** Emit a delta for the given ids (upserts computed from the current fixture state). */
function emitDelta(db: FixtureDb, ids: string[], removes: string[] = []): void {
  const seq = (seqs.get(db.name) ?? 1) + 1;
  seqs.set(db.name, seq);
  lastSync.set(db.name, new Date().toISOString());
  const ready = new Set(computeReady(db));
  const counts = countsOf(db);
  const upserts: BoardIssue[] = [];
  const gone = [...removes];
  for (const id of ids) {
    const r = db.issues.get(id);
    if (!r) gone.push(id);
    else if (inScope(db, r)) upserts.push(toBoard(db, r, ready, counts));
    else gone.push(id);
  }
  const delta: Delta = { seq, upserts, removes: gone, ready: [...ready], stats: stats(db) };
  broadcast(db.name, "delta", delta);
  broadcast(db.name, "status", dbInfo(db));
}

function eventsResponse(db: FixtureDb, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let client: Client | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(frame(event, data)));
        } catch {
          client?.close();
        }
      };
      client = {
        db: db.name,
        send,
        close: () => {
          if (client) clients.delete(client);
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      clients.add(client);
      send("snapshot", snapshot(db));
      heartbeat = setInterval(() => send("heartbeat", { ts: new Date().toISOString() }), 20_000);
      signal.addEventListener("abort", () => client?.close());
    },
    cancel() {
      client?.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Live ticker: flips the demo issue between open and in_progress
// ---------------------------------------------------------------------------------------------

if (LIVE_MS > 0) {
  setInterval(() => {
    for (const db of dbs.values()) {
      if (!db.liveId) continue;
      const r = db.issues.get(db.liveId);
      if (!r) continue;
      r.status = r.status === "open" ? "in_progress" : "open";
      r.updated_at = new Date().toISOString();
      r.revision = nextRevision();
      emitDelta(db, [r.id]);
    }
  }, LIVE_MS);
}

// ---------------------------------------------------------------------------------------------
// Read proxies
// ---------------------------------------------------------------------------------------------

const LIST_PARAMS = new Set([
  "status",
  "type",
  "assignee",
  "label",
  "label_any",
  "exclude_label",
  "parent",
  "all",
  "created_before",
  "created_after",
  "sort",
  "cursor",
  "limit",
  "brief",
]);

function listIssues(db: FixtureDb, url: URL): Response {
  for (const key of url.searchParams.keys()) {
    if (!LIST_PARAMS.has(key)) {
      return problem(400, "bddb_invalid_argument", `unknown query parameter ${key}`, {
        param: key,
        reason: "unknown_parameter",
      });
    }
  }
  const statuses = url.searchParams.getAll("status");
  const all = url.searchParams.get("all") === "true";
  const type = url.searchParams.get("type");
  const assignee = url.searchParams.get("assignee");
  const labels = url.searchParams.getAll("label");
  const parent = url.searchParams.get("parent");
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const brief = url.searchParams.get("brief") === "true";
  const offset = Number(url.searchParams.get("cursor") ?? 0) || 0;

  let rows = [...db.issues.values()];
  if (statuses.length) rows = rows.filter((r) => statuses.includes(r.status ?? "open"));
  else if (!all)
    rows = rows.filter((r) => !isDone(db, r.status ?? "open") && !isFrozen(db, r.status ?? "open"));
  if (type) rows = rows.filter((r) => (r.issue_type ?? "task") === type);
  if (assignee) rows = rows.filter((r) => r.assignee === assignee);
  if (labels.length) rows = rows.filter((r) => labels.every((l) => (r.labels ?? []).includes(l)));
  if (parent) rows = rows.filter((r) => r.parent === parent);
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  const page = limit > 0 ? rows.slice(offset, offset + limit) : rows.slice(offset);
  const hasMore = limit > 0 && offset + limit < rows.length;
  const items = page.map((r) => {
    const out = stripRevision(r);
    if (brief) {
      const { description: _d, design: _g, acceptance_criteria: _a, notes: _n, ...rest } = out;
      return rest;
    }
    return out;
  });
  const body: IssueListResponse = { items, has_more: hasMore };
  if (hasMore) body.next_cursor = String(offset + limit);
  return json(body);
}

const TREE_PARAMS = new Set(["root_id", "direction", "max_depth", "status"]);

/** `GET dependencies/tree`: flat DFS `TreeNode`s (issue fields + depth/parent_id/edge). */
function dependencyTree(db: FixtureDb, url: URL): Response {
  for (const key of url.searchParams.keys()) {
    if (!TREE_PARAMS.has(key)) {
      return problem(400, "bddb_invalid_argument", `unknown query parameter ${key}`, {
        param: key,
        reason: "unknown_parameter",
      });
    }
  }
  const rootId = url.searchParams.get("root_id") ?? "";
  if (!rootId) return problem(400, "invalid_argument", "root_id is required", { param: "root_id" });
  if (!db.issues.has(rootId)) return problem(404, "not_found", `issue ${rootId} not found`);
  const direction = url.searchParams.get("direction") ?? "down";
  if (direction !== "down" && direction !== "up" && direction !== "both") {
    return problem(400, "invalid_argument", "direction must be down, up or both", {
      param: "direction",
    });
  }
  const maxDepth = Number(url.searchParams.get("max_depth") ?? 50);
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    return problem(400, "invalid_argument", "max_depth must be >= 1", { param: "max_depth" });
  }
  const items = walkTree(db, rootId, direction, maxDepth).map((item) => {
    const r = db.issues.get(item.id) as FixtureIssue;
    return { ...stripRevision(r), ...item, truncated: false };
  });
  return json({ items, has_more: false });
}

// ---------------------------------------------------------------------------------------------
// Write proxies (minimal; stage 5 grows them)
// ---------------------------------------------------------------------------------------------

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function newId(db: FixtureDb, parent?: string): string {
  if (parent) {
    const siblings = [...db.issues.values()].filter((r) => r.parent === parent).length;
    return `${parent}.${siblings + 1}`;
  }
  let id = "";
  do {
    id = `${db.prefix}-${Math.random().toString(36).slice(2, 5)}`;
  } while (db.issues.has(id));
  return id;
}

async function createIssue(db: FixtureDb, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    return problem(400, "invalid_argument", "title is required", { param: "title" });
  }
  const parent = typeof body.parent_id === "string" && body.parent_id ? body.parent_id : undefined;
  if (parent && !db.issues.has(parent)) {
    return problem(404, "not_found", `parent ${parent} not found`, { param: "parent_id" });
  }
  const now = new Date().toISOString();
  const r: FixtureIssue = {
    id: typeof body.id === "string" && body.id ? body.id : newId(db, parent),
    title: body.title,
    issue_type: typeof body.issue_type === "string" ? body.issue_type : "task",
    status: typeof body.status === "string" ? body.status : "open",
    priority: typeof body.priority === "number" ? body.priority : 2,
    created_at: now,
    updated_at: now,
    created_by: typeof body.actor === "string" ? body.actor : ACTOR_DEFAULT,
    labels: Array.isArray(body.labels) ? (body.labels as string[]) : [],
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    revision: nextRevision(),
  };
  if (typeof body.assignee === "string") r.assignee = body.assignee;
  if (typeof body.description === "string") r.description = body.description;
  if (parent) {
    r.parent = parent;
    db.dependencies.push({
      issue_id: r.id,
      depends_on_id: parent,
      type: "parent-child",
      created_at: now,
    });
  }
  db.issues.set(r.id, r);
  emitDelta(db, [r.id, ...(parent ? [parent] : [])]);
  return json(stripRevision(r), 201);
}

function guard(r: FixtureIssue, body: Record<string, unknown>): Response | null {
  const expected = body.expected_version;
  if (expected !== undefined && expected !== r.revision) {
    return problem(409, "precondition_failed", "revision mismatch", {
      expected_version: expected,
      revision: r.revision,
    });
  }
  return null;
}

async function patchIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return problem(400, "invalid_argument", "body must be a JSON object");
  const conflict = guard(r, body);
  if (conflict) return conflict;
  const patch = (body.patch ?? {}) as Record<string, unknown>;
  const before = { ...r };
  const touched = [r.id];
  if (typeof patch.title === "string") r.title = patch.title;
  for (const key of ["description", "design", "acceptance_criteria", "notes"] as const) {
    if (typeof patch[key] === "string") r[key] = patch[key] as string;
  }
  if (typeof patch.append_notes === "string") r.notes = `${r.notes ?? ""}\n${patch.append_notes}`;
  if (typeof patch.priority === "number") r.priority = patch.priority;
  if (typeof patch.issue_type === "string") r.issue_type = patch.issue_type;
  if (typeof patch.status === "string") {
    r.status = patch.status;
    if (patch.status === "closed") r.closed_at = new Date().toISOString();
    else delete r.closed_at;
  }
  if (typeof patch.assignee === "string") {
    if (patch.assignee) r.assignee = patch.assignee;
    else delete r.assignee;
  }
  if (Array.isArray(patch.labels)) r.labels = patch.labels as string[];
  if (Array.isArray(patch.add_labels))
    r.labels = [...new Set([...(r.labels ?? []), ...(patch.add_labels as string[])])];
  if (Array.isArray(patch.remove_labels))
    r.labels = (r.labels ?? []).filter((l) => !(patch.remove_labels as string[]).includes(l));
  if (typeof patch.parent_id === "string") {
    if (r.parent) touched.push(r.parent);
    db.dependencies = db.dependencies.filter(
      (d) => !(d.issue_id === r.id && d.type === "parent-child"),
    );
    if (patch.parent_id) {
      r.parent = patch.parent_id;
      touched.push(patch.parent_id);
      db.dependencies.push({
        issue_id: r.id,
        depends_on_id: patch.parent_id,
        type: "parent-child",
        created_at: new Date().toISOString(),
      });
    } else delete r.parent;
  }
  const changed = JSON.stringify(before) !== JSON.stringify(r);
  if (changed) {
    r.updated_at = new Date().toISOString();
    r.revision = nextRevision();
    emitDelta(db, touched);
  }
  return json({ issue: stripRevision(r), changed, revision: r.revision });
}

async function closeIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = (await readBody(req)) ?? {};
  const conflict = guard(r, body);
  if (conflict) return conflict;
  const alreadyClosed = r.status === "closed";
  const openChildren = [...db.issues.values()].filter(
    (c) => c.parent === r.id && c.status !== "closed",
  ).length;
  if (!alreadyClosed && openChildren > 0 && body.force !== true) {
    return problem(409, "not_closable", `${openChildren} open children`, {
      open_children: openChildren,
    });
  }
  if (!alreadyClosed) {
    r.status = "closed";
    r.closed_at = new Date().toISOString();
    r.updated_at = r.closed_at;
    if (typeof body.reason === "string") r.close_reason = body.reason;
    r.revision = nextRevision();
    emitDelta(db, [r.id, ...(r.parent ? [r.parent] : [])]);
  }
  return json({
    issue: stripRevision(r),
    already_closed: alreadyClosed,
    open_children: openChildren,
    revision: r.revision,
  });
}

async function reopenIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = (await readBody(req)) ?? {};
  const conflict = guard(r, body);
  if (conflict) return conflict;
  const alreadyOpen = r.status !== "closed";
  if (!alreadyOpen) {
    r.status = "open";
    delete r.closed_at;
    delete r.close_reason;
    r.updated_at = new Date().toISOString();
    r.revision = nextRevision();
    emitDelta(db, [r.id, ...(r.parent ? [r.parent] : [])]);
  }
  return json({ issue: stripRevision(r), already_open: alreadyOpen, revision: r.revision });
}

async function addComment(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || typeof body.text !== "string") {
    return problem(400, "invalid_argument", "text is required", { param: "text" });
  }
  const list = db.comments.get(r.id) ?? [];
  const comment = {
    id: `cm-${Math.random().toString(36).slice(2, 8)}`,
    issue_id: r.id,
    author: typeof body.author === "string" ? body.author : ACTOR_DEFAULT,
    text: body.text,
    created_at: new Date().toISOString(),
  };
  list.push(comment);
  db.comments.set(r.id, list);
  r.comment_count = list.length;
  r.updated_at = comment.created_at;
  emitDelta(db, [r.id]);
  return json(comment, 201);
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

function meta(): Meta {
  return {
    bddb: { version: "0.0.0-mock", builtForBeads: "1.3.0-rc.2" },
    defaultDatabase: fixture[0]?.name ?? "",
    actorDefault: ACTOR_DEFAULT,
    closedDays: CLOSED_DAYS,
    pollIntervalMs: 15_000,
    databases: fixture.map(dbInfo),
  };
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/meta") return json(meta());
  const m = path.match(/^\/api\/p\/([^/]+)(\/.*)?$/);
  if (!m) return problem(404, "not_found", `no route ${path}`);
  const dbName = decodeURIComponent(m[1] as string);
  const db = dbs.get(dbName);
  if (!db) return problem(404, "bddb_database_unknown", `database ${dbName} is not served`);
  const rest = m[2] ?? "/";

  if (rest === "/snapshot" && req.method === "GET") return json(snapshot(db));
  if (rest === "/events" && req.method === "GET") return eventsResponse(db, req.signal);
  if (rest === "/stats" && req.method === "GET") return json({ summary: stats(db) });
  if (rest === "/config" && req.method === "GET") {
    return json({
      items: [
        {
          key: "status.custom",
          value: db.statuses
            .filter((s) => !s.builtin)
            .map((s) => s.name)
            .join(","),
        },
      ],
    });
  }
  if (rest === "/issues") {
    if (req.method === "GET") return listIssues(db, url);
    if (req.method === "POST") return createIssue(db, req);
  }
  if (rest === "/dependencies/tree" && req.method === "GET") return dependencyTree(db, url);
  const im = rest.match(/^\/issues\/([^/]+)(\/(close|reopen|comments|claim|release))?$/);
  if (im) {
    const id = decodeURIComponent(im[1] as string);
    const action = im[3];
    const r = db.issues.get(id);
    if (!r) return problem(404, "not_found", `issue ${id} not found`);
    if (!action && req.method === "GET") return json(toDetails(db, id));
    if (!action && req.method === "PATCH") return patchIssue(db, r, req);
    if (action === "close" && req.method === "POST") return closeIssue(db, r, req);
    if (action === "reopen" && req.method === "POST") return reopenIssue(db, r, req);
    if (action === "comments" && req.method === "POST") return addComment(db, r, req);
  }
  return problem(404, "not_found", `no route ${req.method} ${path}`);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== "production" && process.env.MOCK_HMR !== "0",
  routes: {
    "/": Response.redirect(`/p/${encodeURIComponent(fixture[0]?.name ?? "")}/board`, 302),
    "/healthz": new Response("ok", { headers: { "content-type": "text/plain" } }),
    "/readyz": () =>
      json({ databases: Object.fromEntries(fixture.map((db) => [db.name, "ready"])) }),
    "/p/*": index,
    "/api/*": (req) => handleApi(req, new URL(req.url)),
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `mock-bff: http://${server.hostname}:${server.port} (databases: ${[...dbs.keys()].join(", ")}; live every ${LIVE_MS} ms)`,
);
