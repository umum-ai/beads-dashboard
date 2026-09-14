# BFF API (dashboard ↔ `bddb` server)

The SPA never talks to `bd serve` directly. It talks to the `bddb` process on the same
origin. All paths below are relative to `BDDB_BASE_PATH` (default empty). This document is the
contract between `src/server/` (implementer of the API) and `src/web/` (consumer). Change it
in the same commit as either side.

Conventions:

- JSON in and out. Errors are RFC 9457 problems (`application/problem+json`) with the same
  shape as `bd serve` (`code`, `status`, `title`, `detail`, extensions). Problems coming from
  `bd serve` are passed through **unchanged** (same status, same body). Problems produced by
  `bddb` itself use codes prefixed `bddb_`:
  `bddb_database_unknown` (404), `bddb_not_ready` (503, database still starting or its
  `bd serve` is down; honours `Retry-After`), `bddb_upstream_unavailable` (502, `bd serve`
  answered with a non-problem error or the connection failed), `bddb_invalid_argument` (400).
- `<db>` is the database name as listed in `GET /api/meta`.
- `revision` is an opaque string everywhere. `metadata` is arbitrary JSON.
- All write requests carry `actor` (string) in the body. If missing, the server fills
  `BDDB_ACTOR`. Comments use `author` (same value).

## Process-level

| Method, path | Response |
|---|---|
| `GET /healthz` | `200 text/plain "ok"` — process is alive. |
| `GET /readyz` | `200` when at least one database is `ready`, else `503`. Body: JSON `{ databases: { [name]: state } }`. |
| `GET /api/meta` | `Meta` (below). |

```ts
type Meta = {
  bddb: { version: string; builtForBeads: string }; // e.g. "0.1.0", "1.3.0-rc.2"
  defaultDatabase: string;
  actorDefault: string;      // BDDB_ACTOR
  closedDays: number;        // BDDB_CLOSED_DAYS
  pollIntervalMs: number;    // BDDB_POLL_INTERVAL
  databases: DatabaseInfo[];
};
type DatabaseInfo = {
  name: string;
  state: "starting" | "ready" | "degraded" | "down";
  // degraded = bd serve answers but reports 503 db_unavailable; down = bd serve process not running
  live: "sse" | "polling" | "none";   // how the snapshot is currently kept fresh
  lastSyncAt: string | null;           // ISO timestamp of the last successful full or incremental sync
  bdVersion: string | null;            // from GET /v0/beads/context
  projectId: string | null;
  versionWarning: string | null;       // set when bd_version major/minor differs from builtForBeads
  capabilities: string[];
};
```

## Per-database snapshot

`GET /api/p/<db>/snapshot` → `Snapshot`. Everything the board needs in one payload.

```ts
type Snapshot = {
  seq: number;                 // bddb's own monotonically increasing counter per database (not bd's event seq)
  database: DatabaseInfo;
  statuses: StatusDef[];       // built-in + status.custom, ordered active → wip → frozen → done
  types: string[];             // built-in + types.custom
  issues: BoardIssue[];        // see scope below
  ready: string[];             // ids of issues returned by GET /v0/beads/ready (limit=0)
  stats: Stats | null;         // GET /v0/beads/stats summary, null if unavailable
};
type StatusDef = { name: string; category: "active" | "wip" | "frozen" | "done"; builtin: boolean };
// BoardIssue = IssueWithCounts row from GET /v0/beads/issues?brief=true (no description/design/
// acceptance_criteria/notes), plus BFF-derived fields:
type BoardIssue = IssueWithCounts & {
  blocked: boolean;            // status not in done/frozen category AND id not in `ready`
};
```

Scope of `issues`: every issue that is **not** hidden by `bd serve` defaults (no `include_*`
flags are ever sent), in every status of category active, wip and frozen, plus issues in
done-category statuses whose `closed_at` is within the last `closedDays` days. Older closed
issues are fetched on demand (see `issues` list proxy). `limit=0` is used (we are on loopback).

## Per-database live stream

`GET /api/p/<db>/events` → `text/event-stream`. Frames (`event:` name, `data:` one-line JSON):

| event | data | when |
|---|---|---|
| `snapshot` | `Snapshot` | immediately on connect, and after every re-baseline (bd `truncated`, `410`, journal disabled, database restart, poll detected drift the deltas cannot express) |
| `delta` | `Delta` | on every change detected via bd SSE or polling |
| `status` | `DatabaseInfo` | when `state`, `live` or `lastSyncAt` change (at most once per sync) |
| `heartbeat` | `{ "ts": string }` | every 20 s |

```ts
type Delta = {
  seq: number;                 // strictly increasing; a client seeing a gap re-fetches /snapshot
  upserts: BoardIssue[];       // full rows (state after the change)
  removes: string[];           // ids deleted (bd op=delete) or that left the snapshot scope
  ready?: string[];            // full replacement of the ready set when it changed
  stats?: Stats;               // when refreshed
};
```

The client keeps the snapshot in memory and applies deltas. There is no `since` parameter:
reconnecting always yields a fresh `snapshot` frame. Every browser tab opens exactly one
stream per database it displays. `id:` fields are not used.

## Per-database read proxies

Straight proxies to `bd serve`; query parameters are forwarded only if they exist in the
OpenAPI spec (`spec/openapi.v0.yaml`), everything else → `400 bddb_invalid_argument`.

| Method, path | Upstream |
|---|---|
| `GET /api/p/<db>/issues?…` | `GET /v0/beads/issues` (same params; used for "show all closed", pagination) |
| `GET /api/p/<db>/issues/<id>?include_comments=true&include_dependents=true` | `GET /v0/beads/issues/{id}` → `IssueDetails` (source of `revision`) |
| `GET /api/p/<db>/issues:query?q=…&…` | `GET /v0/beads/issues:query` (`400 param=q` passes through) |
| `GET /api/p/<db>/ready?…` | `GET /v0/beads/ready` |
| `GET /api/p/<db>/dependencies/tree?root_id=&direction=&max_depth=` | `GET /v0/beads/dependencies/tree` |
| `GET /api/p/<db>/issues/<id>/related?direction=` | `GET /v0/beads/issues/{id}/related` |
| `GET /api/p/<db>/stats` | `GET /v0/beads/stats` |
| `GET /api/p/<db>/config` | `GET /v0/beads/config` |

## Per-database write proxies

Bodies are exactly the `bd serve` bodies (see plan 2.6 / spec). Responses are the `bd serve`
responses. Colon-suffixed upstream paths are exposed with a slash to keep URLs simple.

| Method, path | Upstream |
|---|---|
| `POST /api/p/<db>/issues` | `POST /v0/beads/issues` |
| `PATCH /api/p/<db>/issues/<id>` | `PATCH /v0/beads/issues/{id}` (`{actor, patch, expected_version?, …}`) |
| `POST /api/p/<db>/issues/<id>/close` | `POST /v0/beads/issues/{id}:close` |
| `POST /api/p/<db>/issues/<id>/reopen` | `POST /v0/beads/issues/{id}:reopen` |
| `POST /api/p/<db>/issues/<id>/claim` | `POST /v0/beads/issues/{id}:claim` |
| `POST /api/p/<db>/issues/<id>/release` | `POST /v0/beads/issues/{id}:release` |
| `POST /api/p/<db>/issues/<id>/comments` | `POST /v0/beads/issues/{id}/comments` (`{author, text}`) |
| `POST /api/p/<db>/dependencies/add` | `POST /v0/beads/dependencies:add` |
| `POST /api/p/<db>/dependencies/remove` | `POST /v0/beads/dependencies:remove` |
| `POST /api/p/<db>/issues/batch-apply` | `POST /v0/beads/issues:batchApply` |

Never exposed: `issues:delete`, `issues:sweep`, config writes, memories.

After a successful write the server does **not** need to push a delta itself: the change comes
back through the bd event journal (or the next poll). Clients may optimistically update and
must reconcile with the following `delta`.

## Static assets

Everything not under `/api`, `/healthz`, `/readyz` serves the SPA (`index.html` fallback for
`/p/<db>/board`, `/p/<db>/epics`, `/p/<db>/issue/<id>`, `/`). `/` redirects to
`/p/<defaultDatabase>/board`. Asset URLs are relative so `BDDB_BASE_PATH` works; the SPA reads
its base path from `<base href>` injected by the server (or from `window.__BDDB__` — the
implementer picks one and documents it here).
