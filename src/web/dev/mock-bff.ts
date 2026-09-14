/**
 * Mock BFF for development and e2e. Implements docs/bff-api.md from the in-memory fixture and
 * serves the SPA through Bun HTML routes. Not part of the product build.
 *
 *   bun src/web/dev/mock-bff.ts            # http://127.0.0.1:7331
 *   MOCK_PORT=7400 MOCK_LIVE_MS=0 bun …     # other port, no periodic deltas
 *   MOCK_BULK=1000 bun …                    # add 1000 generated issues to the first database
 *
 * Simplifications versus the real server: query forwarding is validated against a small
 * allowlist; `ready` is approximated from blocking edges; `issues:query` understands a tiny
 * subset of the `bd query` language (`status=`, `priority<=` and friends, `type=`, `label=`,
 * `assignee=`, joined by `AND`; anything else is `400 invalid_argument param=q`). Writes follow
 * the real guards: `expected_version` → `precondition_failed`, close policy → `not_closable`
 * (+ `open_children`), edges → `dependency_cycle` / `dependency_exists`, claim / release →
 * `already_claimed` / `not_claimable` / `not_releasable`, and `issues/batch-apply` is
 * all-or-nothing.
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
  recount,
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
    lastError: null,
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

const QUERY_PARAMS = new Set(["q", "all", "sort", "reverse", "limit"]);

type Term = (r: FixtureIssue) => boolean;

/** Tiny `bd query` subset: `field op value` terms joined by `AND`; null = syntax error. */
function compileQuery(q: string): Term | null {
  const parts = q.trim().split(/\s+AND\s+/i);
  const terms: Term[] = [];
  for (const raw of parts) {
    const m = raw
      .trim()
      .match(
        /^\(?\s*(status|priority|type|label|assignee)\s*(<=|>=|!=|=|<|>)\s*([A-Za-z0-9_.:-]+)\s*\)?$/,
      );
    if (!m) return null;
    const [, field, op, value] = m as [string, string, string, string];
    if (field === "priority") {
      const n = Number(value);
      if (!Number.isInteger(n)) return null;
      terms.push((r) => {
        switch (op) {
          case "<=":
            return r.priority <= n;
          case ">=":
            return r.priority >= n;
          case "<":
            return r.priority < n;
          case ">":
            return r.priority > n;
          case "!=":
            return r.priority !== n;
          default:
            return r.priority === n;
        }
      });
      continue;
    }
    if (op !== "=" && op !== "!=") return null;
    const eq = op === "=";
    switch (field) {
      case "status":
        terms.push((r) => ((r.status ?? "open") === value) === eq);
        break;
      case "type":
        terms.push((r) => ((r.issue_type ?? "task") === value) === eq);
        break;
      case "assignee":
        terms.push((r) => ((r.assignee ?? "") === value) === eq);
        break;
      case "label":
        terms.push((r) => (r.labels ?? []).includes(value) === eq);
        break;
      default:
        return null;
    }
  }
  return (r) => terms.every((t) => t(r));
}

function queryIssues(db: FixtureDb, url: URL): Response {
  for (const key of url.searchParams.keys()) {
    if (!QUERY_PARAMS.has(key)) {
      return problem(400, "bddb_invalid_argument", `unknown query parameter ${key}`, {
        param: key,
        reason: "unknown_parameter",
      });
    }
  }
  const q = url.searchParams.get("q") ?? "";
  const term = q.trim() ? compileQuery(q) : null;
  if (!term) {
    return problem(400, "invalid_argument", `cannot parse query expression: ${q}`, {
      param: "q",
      reason: "invalid_value",
    });
  }
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  const rows = [...db.issues.values()].filter(term);
  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  const items = (limit > 0 ? rows.slice(0, limit) : rows).map((r) => stripRevision(r));
  return json({ items, has_more: limit > 0 && rows.length > limit });
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
      param: "expected_version",
    });
  }
  return null;
}

class WriteError extends Error {
  constructor(readonly response: Response) {
    super("write refused");
  }
}

const BLOCKING_TYPES = new Set(["blocks", "conditional-blocks", "waits-for", "parent-child"]);

/** Would an edge `issue → dependsOn` close a cycle? (Is `issue` reachable from `dependsOn`?) */
function wouldCycle(db: FixtureDb, issue: string, dependsOn: string): boolean {
  if (issue === dependsOn) return true;
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === issue) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of db.dependencies) if (d.issue_id === id) stack.push(d.depends_on_id);
  }
  return false;
}

/** Close policy: open children → `open_children`, else a live blocking edge → plain refusal. */
function closePolicy(db: FixtureDb, r: FixtureIssue): Response | null {
  const openChildren = [...db.issues.values()].filter(
    (c) => c.parent === r.id && !isDone(db, c.status ?? "open"),
  ).length;
  if (openChildren > 0) {
    return problem(
      409,
      "not_closable",
      `issue has ${openChildren} open children; close them first or close with force`,
      {
        open_children: openChildren,
      },
    );
  }
  const blocker = db.dependencies.find((d) => {
    if (d.issue_id !== r.id || d.type === "parent-child" || !BLOCKING_TYPES.has(d.type))
      return false;
    const target = db.issues.get(d.depends_on_id);
    return target ? !isDone(db, target.status ?? "open") : false;
  });
  if (blocker) {
    return problem(
      409,
      "not_closable",
      `issue is blocked by open dependency ${blocker.depends_on_id}`,
      {
        blocker_id: blocker.depends_on_id,
      },
    );
  }
  return null;
}

function setParent(db: FixtureDb, r: FixtureIssue, parentId: string, touched: string[]): void {
  if (parentId) {
    const parent = db.issues.get(parentId);
    if (!parent) throw new WriteError(problem(404, "not_found", `parent ${parentId} not found`));
    if (wouldCycle(db, r.id, parentId)) {
      throw new WriteError(
        problem(409, "dependency_cycle", `${parentId} is a descendant of ${r.id}`, {
          issue_id: r.id,
          blocker_id: parentId,
        }),
      );
    }
    const other = db.dependencies.find(
      (d) => d.issue_id === r.id && d.depends_on_id === parentId && d.type !== "parent-child",
    );
    if (other) {
      throw new WriteError(
        problem(
          409,
          "dependency_exists",
          `edge ${r.id} → ${parentId} exists with type ${other.type}`,
          {
            existing_type: other.type,
            requested_type: "parent-child",
          },
        ),
      );
    }
  }
  if (r.parent) touched.push(r.parent);
  db.dependencies = db.dependencies.filter(
    (d) => !(d.issue_id === r.id && d.type === "parent-child"),
  );
  if (parentId) {
    r.parent = parentId;
    touched.push(parentId);
    db.dependencies.push({
      issue_id: r.id,
      depends_on_id: parentId,
      type: "parent-child",
      created_at: new Date().toISOString(),
    });
  } else delete r.parent;
}

/** Apply an `IssuePatchBody` (or the batch `ApplyPatchBody`) to a row; returns touched ids. */
function applyPatch(
  db: FixtureDb,
  r: FixtureIssue,
  patch: Record<string, unknown>,
  forceClose: boolean,
): { changed: boolean; touched: string[] } {
  if (Object.keys(patch).length === 0) {
    throw new WriteError(
      problem(400, "invalid_argument", "patch must not be empty", { param: "patch" }),
    );
  }
  const before = JSON.stringify(r);
  const touched = [r.id];
  if (typeof patch.title === "string") r.title = patch.title;
  for (const key of ["description", "design", "acceptance_criteria", "notes"] as const) {
    if (typeof patch[key] === "string") r[key] = patch[key] as string;
  }
  if (typeof patch.append_notes === "string") {
    r.notes = r.notes ? `${r.notes}\n${patch.append_notes}` : patch.append_notes;
  }
  if (typeof patch.priority === "number") r.priority = patch.priority;
  if (typeof patch.issue_type === "string") r.issue_type = patch.issue_type;
  if (typeof patch.status === "string" && patch.status !== (r.status ?? "open")) {
    const wasDone = isDone(db, r.status ?? "open");
    if (isDone(db, patch.status) && !wasDone && !forceClose) {
      const refused = closePolicy(db, r);
      if (refused) throw new WriteError(refused);
    }
    r.status = patch.status;
    if (isDone(db, patch.status)) r.closed_at = new Date().toISOString();
    else {
      delete r.closed_at;
      delete r.close_reason;
    }
    if (r.parent) touched.push(r.parent);
  }
  if (typeof patch.assignee === "string") {
    if (patch.assignee) r.assignee = patch.assignee;
    else delete r.assignee;
  }
  if (Array.isArray(patch.labels)) r.labels = patch.labels as string[];
  else if (patch.labels && typeof patch.labels === "object") {
    // batch-apply `ApplyLabelPatch`
    const lp = patch.labels as { replace?: string[]; add?: string[]; remove?: string[] };
    if (lp.replace) r.labels = [...lp.replace];
    if (lp.add) r.labels = [...new Set([...(r.labels ?? []), ...lp.add])];
    if (lp.remove) r.labels = (r.labels ?? []).filter((l) => !(lp.remove as string[]).includes(l));
  }
  if (Array.isArray(patch.add_labels))
    r.labels = [...new Set([...(r.labels ?? []), ...(patch.add_labels as string[])])];
  if (Array.isArray(patch.remove_labels))
    r.labels = (r.labels ?? []).filter((l) => !(patch.remove_labels as string[]).includes(l));
  if (typeof patch.parent_id === "string") setParent(db, r, patch.parent_id, touched);
  for (const key of ["estimated_minutes", "external_ref", "due_at", "defer_until"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null) delete r[key];
    else if (key === "estimated_minutes" && typeof value === "number") r.estimated_minutes = value;
    else if (key !== "estimated_minutes" && typeof value === "string") r[key] = value;
  }
  const changed = before !== JSON.stringify(r);
  if (changed) {
    r.updated_at = new Date().toISOString();
    r.revision = nextRevision();
  }
  return { changed, touched };
}

async function patchIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return problem(400, "invalid_argument", "body must be a JSON object");
  const conflict = guard(r, body);
  if (conflict) return conflict;
  const patch = (body.patch ?? {}) as Record<string, unknown>;
  const snapshotState = { row: { ...r }, deps: [...db.dependencies] };
  try {
    const { changed, touched } = applyPatch(db, r, patch, body.force_close_policy === true);
    if (changed) {
      recount(db.issues, db.dependencies);
      emitDelta(db, [...new Set(touched)]);
    }
    return json({ issue: stripRevision(r), changed, revision: r.revision });
  } catch (err) {
    if (err instanceof WriteError) {
      Object.assign(r, snapshotState.row);
      for (const key of Object.keys(r))
        if (!(key in snapshotState.row)) delete (r as unknown as Record<string, unknown>)[key];
      db.dependencies = snapshotState.deps;
      return err.response;
    }
    throw err;
  }
}

async function closeIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = (await readBody(req)) ?? {};
  const conflict = guard(r, body);
  if (conflict) return conflict;
  const alreadyClosed = isDone(db, r.status ?? "open");
  const openChildren = [...db.issues.values()].filter(
    (c) => c.parent === r.id && !isDone(db, c.status ?? "open"),
  ).length;
  if (!alreadyClosed && body.force !== true) {
    const refused = closePolicy(db, r);
    if (refused) return refused;
  }
  if (!alreadyClosed) {
    r.status = "closed";
    r.closed_at = new Date().toISOString();
    r.updated_at = r.closed_at;
    if (typeof body.reason === "string" && body.reason) r.close_reason = body.reason;
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
  const alreadyOpen = !isDone(db, r.status ?? "open");
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

async function claimIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = (await readBody(req)) ?? {};
  const who = typeof body.actor === "string" && body.actor ? body.actor : ACTOR_DEFAULT;
  const status = r.status ?? "open";
  if (isDone(db, status) || isFrozen(db, status)) {
    return problem(409, "not_claimable", `issue is ${status}`, { issue_status: status });
  }
  if (r.assignee && r.assignee !== who) {
    return problem(409, "already_claimed", `claimed by ${r.assignee}`, { assignee: r.assignee });
  }
  const already = r.assignee === who && status === "in_progress";
  if (!already) {
    r.assignee = who;
    r.status = "in_progress";
    r.started_at = r.started_at ?? new Date().toISOString();
    r.updated_at = new Date().toISOString();
    r.revision = nextRevision();
    emitDelta(db, [r.id]);
  }
  return json({ issue: stripRevision(r), already_claimed: already });
}

async function releaseIssue(db: FixtureDb, r: FixtureIssue, req: Request): Promise<Response> {
  const body = (await readBody(req)) ?? {};
  const who = typeof body.actor === "string" && body.actor ? body.actor : ACTOR_DEFAULT;
  if (!r.assignee) return problem(409, "not_releasable", "issue is not claimed");
  if (r.assignee !== who && body.force !== true) {
    return problem(409, "not_releasable", `claimed by ${r.assignee}, not ${who}`, {
      assignee: r.assignee,
    });
  }
  delete r.assignee;
  if (r.status === "in_progress") r.status = "open";
  r.updated_at = new Date().toISOString();
  r.revision = nextRevision();
  emitDelta(db, [r.id]);
  return json({ issue: stripRevision(r), released: true });
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

interface EdgeBody {
  issue_id: string;
  depends_on_id: string;
  type: string;
}

function addEdge(db: FixtureDb, edge: EdgeBody, touched: string[]): void {
  const source = db.issues.get(edge.issue_id);
  if (!source) {
    throw new WriteError(
      problem(400, "invalid_argument", `unknown source ${edge.issue_id}`, { param: "issue_id" }),
    );
  }
  if (edge.issue_id === edge.depends_on_id) {
    throw new WriteError(
      problem(400, "invalid_argument", "an issue cannot depend on itself", {
        param: "depends_on_id",
      }),
    );
  }
  if (edge.type === "parent-child") {
    setParent(db, source, edge.depends_on_id, touched);
    source.revision = nextRevision();
    return;
  }
  const existing = db.dependencies.find(
    (d) => d.issue_id === edge.issue_id && d.depends_on_id === edge.depends_on_id,
  );
  if (existing && existing.type !== edge.type) {
    throw new WriteError(
      problem(409, "dependency_exists", `edge exists with type ${existing.type}`, {
        existing_type: existing.type,
        requested_type: edge.type,
      }),
    );
  }
  if (existing) return;
  if (BLOCKING_TYPES.has(edge.type) && wouldCycle(db, edge.issue_id, edge.depends_on_id)) {
    throw new WriteError(
      problem(
        409,
        "dependency_cycle",
        `${edge.issue_id} → ${edge.depends_on_id} would form a cycle`,
        {
          issue_id: edge.issue_id,
          blocker_id: edge.depends_on_id,
        },
      ),
    );
  }
  db.dependencies.push({ ...edge, created_at: new Date().toISOString() });
  touched.push(edge.issue_id, edge.depends_on_id);
  source.updated_at = new Date().toISOString();
  source.revision = nextRevision();
}

async function dependenciesAdd(db: FixtureDb, req: Request): Promise<Response> {
  const body = await readBody(req);
  const edges = body?.edges;
  if (!Array.isArray(edges) || edges.length === 0) {
    return problem(400, "invalid_argument", "edges must be a non-empty array", { param: "edges" });
  }
  const before = {
    deps: [...db.dependencies],
    rows: new Map([...db.issues].map(([k, v]) => [k, { ...v }])),
  };
  const touched: string[] = [];
  try {
    for (const raw of edges as unknown[]) {
      const e = raw as Partial<EdgeBody>;
      if (
        typeof e.issue_id !== "string" ||
        typeof e.depends_on_id !== "string" ||
        typeof e.type !== "string"
      ) {
        throw new WriteError(
          problem(400, "invalid_argument", "edge needs issue_id, depends_on_id, type", {
            param: "edges",
          }),
        );
      }
      addEdge(db, e as EdgeBody, touched);
    }
  } catch (err) {
    if (!(err instanceof WriteError)) throw err;
    db.dependencies = before.deps;
    for (const [k, v] of before.rows) db.issues.set(k, v);
    return err.response;
  }
  recount(db.issues, db.dependencies);
  emitDelta(db, [...new Set(touched)]);
  return json({ added: edges });
}

async function dependenciesRemove(db: FixtureDb, req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body || typeof body.issue_id !== "string" || typeof body.depends_on_id !== "string") {
    return problem(400, "invalid_argument", "issue_id and depends_on_id are required");
  }
  const n = db.dependencies.length;
  db.dependencies = db.dependencies.filter(
    (d) => !(d.issue_id === body.issue_id && d.depends_on_id === body.depends_on_id),
  );
  const removed = db.dependencies.length !== n;
  if (removed) {
    const source = db.issues.get(body.issue_id);
    if (source?.parent === body.depends_on_id) delete source.parent;
    if (source) {
      source.updated_at = new Date().toISOString();
      source.revision = nextRevision();
    }
    recount(db.issues, db.dependencies);
    emitDelta(db, [body.issue_id, body.depends_on_id]);
  }
  return json({ removed });
}

/** `issues:batchApply`: ordered items, all-or-nothing (state is restored on the first refusal). */
async function batchApply(db: FixtureDb, req: Request): Promise<Response> {
  const body = await readBody(req);
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return problem(400, "invalid_argument", "items must be a non-empty array", { param: "items" });
  }
  const before = {
    deps: [...db.dependencies],
    rows: new Map([...db.issues].map(([k, v]) => [k, { ...v }])),
    ids: new Set(db.issues.keys()),
  };
  const touched: string[] = [];
  const keys: Record<string, string> = {};
  const resolve = (ref: { id?: string; key?: string } | undefined): FixtureIssue => {
    const id = ref?.id ?? (ref?.key ? keys[ref.key] : undefined);
    const r = id ? db.issues.get(id) : undefined;
    if (!r)
      throw new WriteError(problem(404, "not_found", `no issue for ref ${JSON.stringify(ref)}`));
    return r;
  };
  try {
    for (const [index, raw] of (items as Record<string, unknown>[]).entries()) {
      const item = raw as {
        kind?: string;
        update?: Record<string, unknown>;
        close?: Record<string, unknown>;
        create?: Record<string, unknown>;
        dep_add?: Record<string, unknown>;
      };
      switch (item.kind) {
        case "update": {
          const u = item.update ?? {};
          const r = resolve(u.target as { id?: string; key?: string });
          const conflict = guard(r, u);
          if (conflict) throw new WriteError(conflict);
          const { touched: t } = applyPatch(
            db,
            r,
            (u.patch ?? {}) as Record<string, unknown>,
            u.force_close_policy === true,
          );
          touched.push(...t);
          break;
        }
        case "close": {
          const c = item.close ?? {};
          const r = resolve(c.target as { id?: string; key?: string });
          const conflict = guard(r, c);
          if (conflict) throw new WriteError(conflict);
          if (!isDone(db, r.status ?? "open")) {
            if (c.force !== true) {
              const refused = closePolicy(db, r);
              if (refused) throw new WriteError(refused);
            }
            r.status = "closed";
            r.closed_at = new Date().toISOString();
            r.updated_at = r.closed_at;
            if (typeof c.reason === "string" && c.reason) r.close_reason = c.reason;
            r.revision = nextRevision();
            touched.push(r.id, ...(r.parent ? [r.parent] : []));
          }
          break;
        }
        case "create": {
          const c = item.create ?? {};
          if (typeof c.title !== "string" || !c.title.trim()) {
            throw new WriteError(
              problem(400, "invalid_argument", `items[${index}].create.title is required`, {
                item_index: index,
                item_kind: "create",
              }),
            );
          }
          const now = new Date().toISOString();
          const r: FixtureIssue = {
            id: typeof c.id === "string" && c.id ? c.id : newId(db),
            title: c.title,
            issue_type: typeof c.issue_type === "string" ? c.issue_type : "task",
            status: typeof c.status === "string" ? c.status : "open",
            priority: typeof c.priority === "number" ? c.priority : 2,
            created_at: now,
            updated_at: now,
            created_by: typeof body?.actor === "string" ? body.actor : ACTOR_DEFAULT,
            labels: Array.isArray(c.labels) ? (c.labels as string[]) : [],
            dependency_count: 0,
            dependent_count: 0,
            comment_count: 0,
            revision: nextRevision(),
          };
          if (db.issues.has(r.id))
            throw new WriteError(problem(409, "already_exists", `${r.id} exists`));
          db.issues.set(r.id, r);
          if (typeof c.key === "string") keys[c.key] = r.id;
          touched.push(r.id);
          break;
        }
        case "dep_add": {
          const d = item.dep_add ?? {};
          const source = resolve(d.issue as { id?: string; key?: string });
          const target = resolve(d.depends_on as { id?: string; key?: string });
          addEdge(
            db,
            {
              issue_id: source.id,
              depends_on_id: target.id,
              type: typeof d.type === "string" ? d.type : "blocks",
            },
            touched,
          );
          break;
        }
        default:
          throw new WriteError(
            problem(400, "invalid_argument", `items[${index}].kind is unknown`, {
              item_index: index,
            }),
          );
      }
    }
  } catch (err) {
    if (!(err instanceof WriteError)) throw err;
    db.dependencies = before.deps;
    for (const id of [...db.issues.keys()]) if (!before.ids.has(id)) db.issues.delete(id);
    for (const [k, v] of before.rows) db.issues.set(k, v);
    return err.response;
  }
  recount(db.issues, db.dependencies);
  emitDelta(db, [...new Set(touched)]);
  return json({ applied: items.length, keys });
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
  if (rest === "/issues:query" && req.method === "GET") return queryIssues(db, url);
  if (rest === "/issues/batch-apply" && req.method === "POST") return batchApply(db, req);
  if (rest === "/dependencies/tree" && req.method === "GET") return dependencyTree(db, url);
  if (rest === "/dependencies/add" && req.method === "POST") return dependenciesAdd(db, req);
  if (rest === "/dependencies/remove" && req.method === "POST") return dependenciesRemove(db, req);
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
    if (action === "claim" && req.method === "POST") return claimIssue(db, r, req);
    if (action === "release" && req.method === "POST") return releaseIssue(db, r, req);
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
