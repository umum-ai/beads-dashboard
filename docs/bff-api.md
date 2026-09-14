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
  `bd serve` is down; honours `Retry-After`, currently `2`), `bddb_upstream_unavailable` (502,
  `bd serve` answered with a non-problem error or the connection failed),
  `bddb_invalid_argument` (400), `bddb_not_found` (404, no such route under `/api`),
  `bddb_payload_too_large` (413, a write body above 1 MiB — `bd serve`'s own limit; carries
  `limit_bytes`). The limit is measured in UTF-8 bytes and checked against `Content-Length`
  before the body is read; a body far above it (limit + 64 KiB) is cut off by the server itself
  with a bare `413`.
- `<db>` is the database name as listed in `GET /api/meta`.
- `revision` is an opaque string everywhere. `metadata` is arbitrary JSON.
- All write requests carry `actor` (string) in the body. If missing, the server fills
  `BDDB_ACTOR`. Comments use `author` (same value).

## Process-level

| Method, path | Response |
|---|---|
| `GET /healthz` | `200 text/plain "ok"` — process is alive. |
| `GET /readyz` | `200` when at least one database is `ready` or `degraded` (it has a snapshot to serve), else `503`. Body: JSON `{ databases: { [name]: state } }`. |
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
  lastError?: string | null;           // why the database is down/degraded (below); null while ready
};
```

`lastError` is the diagnostic the UI shows in its "down" / "degraded" states and banners:
for `down` it is `bd serve <reason> (exit N | killed): <last telling line of bd serve output>`
(the reason is the supervisor's — `process exited`, `failed to start`, or a restart cause such as
`db_unavailable persisted while dolt is reachable (proxy dead?)`); for `degraded` it is
`<code>: <detail>` of the upstream `503` problem (`db_unavailable: database temporarily
unavailable; retry`). It is cleared (`null`) by the next successful baseline. A database is
`ready` again within seconds of its `bd serve` dying (restart with backoff 1 s → 30 s); a dead
`db-proxy-child` keeps it `degraded` for about a minute until the supervisor restarts both.

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
  child_count?: number;        // direct children (rows with `parent === id`) inside the snapshot
  child_closed_count?: number; // of those, in a done-category status
};
```

`child_count` / `child_closed_count` are present only on rows that have at least one child in
the snapshot (absent = no children). They are derived from the snapshot rows — children closed
before the closed window are not counted — so the board and the epics list need no per-epic
detail call; `IssueDetails.epic_total_children` / `epic_closed_children` remain the exact
figures. The counters are recomputed on every baseline and whenever a delta touches a child
(create, status change, parent change, removal); the affected parent rows are included in that
delta's `upserts`.

Scope of `issues`: every issue that is **not** hidden by `bd serve` defaults (no `include_*`
flags are ever sent), in every status of category active, wip and frozen, plus issues in
done-category statuses whose `closed_at` is within the last `closedDays` days. Older closed
issues are fetched on demand (see `issues` list proxy). `limit=0` is used (we are on loopback).

Implementation notes (server side, verified on bd 1.3.0-rc.2):

- Consistency of the server-side state: one baseline (full re-read) runs at a time. Journal
  records that arrive while it is in flight are applied to the current state and buffered, then
  replayed onto the baseline result before it is diffed — a baseline read may predate a record,
  and replaying keeps the newer state (an issue created after the read is upserted, one deleted
  after it is removed). The debounced ready/stats/counts refresh is serialised as well (one at
  a time, re-run once when work queued up meanwhile, and re-queued when a baseline replaced the
  state underneath it), so an older ready set never lands after a newer one. Per-row re-reads
  after a `dep_*`/`comment` burst run at most 8 in parallel. Records with a `seq` at or below
  the last applied one are skipped. `lastSyncAt` only advances when at least one request of the
  sync succeeded. Only `503 db_unavailable` counts as "database unavailable" (state `degraded`,
  proxy watchdog); a `503 busy` is retried like any other failure.
- With the events journal disabled (`409 events_journal_disabled`), bddb re-baselines **once**
  (pushed as a `snapshot`), then keeps diffing on the poll timer only; the journal is re-probed
  every poll interval without another re-baseline until it comes back.
- Done-category rows without a `closed_at` are outside the closed window (not in `issues`).
- A full re-baseline is 7 loopback calls: `config/status.custom`, `config/types.custom`,
  `issues?limit=0&brief=true` (active + wip: the server default), `issues?status=<frozen
  names>&limit=0&brief=true`, the closed window, `ready?limit=0`, `stats`. The closed window is
  bounded **server-side** with `issues:query?q=(status=closed OR …) AND closed>=<ISO timestamp>
  &limit=0` (the `bd query` language accepts `closed>=2026-09-07T12:00:00Z`; the timestamp is
  `now - closedDays`); if a server ever rejects that expression with `400`, bddb falls back to
  `issues?status=<done names>&limit=0&brief=true` filtered by `closed_at` client-side.
- `dependency_count` / `dependent_count` follow the **list** semantics of `GET issues`, which
  counts blocking edges only (`blocks`, `conditional-blocks`, `waits-for`; `parent-child` and
  `related` are not counted). `GET issues/{id}` counts every edge — bddb recounts from the edge
  lists of the detail when it re-reads a row, so polls and event-driven refreshes agree.
- `projectId` is `null` for now: bddb does not write `project_id` into the synthesized
  workspace, so `bd serve` reports `project_id: ""` and no `Bd-Project-Id` is sent upstream.

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

The client keeps the snapshot in memory and applies deltas. Deltas that arrive while a
`/snapshot` refetch is in flight are queued and replayed onto the fetched snapshot: those with
`seq <= snapshot.seq` are already inside it and are dropped, the rest chain from it (a gap among
them triggers one more refetch). There is no `since` parameter: reconnecting always yields a
fresh `snapshot` frame. Every browser tab opens exactly one
stream per database it displays. `id:` fields are not used. The stream starts with
`retry: 3000` (the browser's reconnect delay after a network failure).

While the database is `starting` or `down` the stream is **refused** with `503 bddb_not_ready`
(`Retry-After: 2`), which makes `EventSource` give up (`readyState CLOSED`); the SPA then
probes `GET /api/meta` — reachable: the database is the problem, its `state`/`lastError` are
shown and the stream is reopened with a backoff of 2 s → 15 s; unreachable: the header turns
"Disconnected — retrying" and, after 10 s, a banner says the dashboard server is gone. A stream
that was already open survives a `bd serve` restart: the client receives `status` frames
(`down`, then `ready`) and a fresh `snapshot`.

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
`/p/<defaultDatabase>/board`. Unknown paths outside `/p/*` are `404 text/plain`.

Base path mechanism — **`<base href>`** (decided; `window.__BDDB__` is not emitted):

- Running from a checkout with `BDDB_BASE_PATH` empty and no `BDDB_WEB_DIR`: `src/web/index.html`
  is served through Bun HTML routes on `/p/*`. Bun rewrites asset URLs to root-absolute paths
  (`/chunk-<hash>.js`), no `<base>` tag is injected, and the SPA resolves its base path to `""`.
- Everything else — a prefix, a pre-built `BDDB_WEB_DIR`, or bddb running as a `bun build`
  bundle / compiled binary (the image and the release binaries): **files mode**. The server
  takes `index.html` plus the hashed assets from `BDDB_WEB_DIR` (built by `scripts/build-web.sh`
  with `--public-path ./`), else from the assets `bun build` embedded next to / inside the server
  (`HTMLBundle.files`), else builds them from `src/web` into `<work-dir>/web` at start. It
  rewrites every asset URL in `index.html` to `./<file>` and injects `<base href="<prefix>/">`
  right after `<head>` (`<base href="/">` for the root mount), so one build serves under any
  prefix. Assets are served at `<prefix>/<file>` (hashed names get `Cache-Control: immutable`),
  `<prefix>/p/*` returns `index.html`, `<prefix>` redirects to the default board, and any request
  outside `<prefix>` is `404`.

The SPA derives its base path from `document.querySelector("base[href]")` when present (`/` →
`""`), else `""`, and prefixes every `/api/…` and `/p/…` URL with it (`src/web/lib/basePath.ts`).
It must therefore never rely on document-relative URLs (`href="#…"`, `fetch("x")`): with a
`<base>` tag they resolve against the base, not the page.
