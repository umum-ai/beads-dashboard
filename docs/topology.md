# Topology

```text
browser (Preact SPA)
   │  same origin: GET/POST/PATCH /api/p/<db>/…   and   SSE /api/p/<db>/events
   ▼
bddb — one process, one port (BDDB_HOST:BDDB_PORT, under BDDB_BASE_PATH)
   ├─ SPA static assets
   ├─ discovery at start: Bun.SQL → dolt, SHOW DATABASES + SELECT COUNT(*) FROM <db>.issues (the only
   │    direct SQL bddb ever runs; the counts order the list and pick the default database)
   ├─ per database
   │    ├─ synthesized workspace  <work-dir>/<db>/.beads  (dolt_mode: server, events-journal: true)
   │    ├─ supervisor: bd serve --addr 127.0.0.1:<free port>, restart with backoff
   │    ├─ snapshot in memory (issues, ready set, statuses/types, stats)
   │    ├─ ONE events:watch stream to bd serve  +  full re-read every BDDB_POLL_INTERVAL
   │    └─ fan-out to browsers (snapshot / delta / status / heartbeat)
   ├─ read proxies (query parameters whitelisted against the OpenAPI spec)
   ├─ write proxies (actor filled in; bd serve problems passed through unchanged)
   └─ /healthz, /readyz, /api/meta
   ▼
bd serve × N (loopback, one per database)  ──TCP (MySQL protocol)──▶  dolt sql-server (your host)
                                                                        └─ databases: shared, siam, …
```

## Where things run

| Component | Where | Notes |
|---|---|---|
| `dolt sql-server` and the data | your host (or wherever your beads shared server lives) | bddb never ships or starts dolt. |
| `bd` CLI used by you and your agents | your host | Same Dolt, its own workspaces. |
| `bddb` + `bd serve` × N | container or host process | The container image carries only `bd`, `git` and bddb. No volumes, no data. |
| browser | anywhere that can reach bddb | Talks to bddb only; `bd serve` ports are loopback. |

## Why a backend at all

`bd serve` binds loopback, answers only to `Host` values it knows, has no CORS and requires
`Content-Type: application/json` — a browser on another origin cannot talk to it. bddb is the
same-origin backend (BFF) that owns the `bd serve` processes, keeps one events stream per
database (bd caps concurrent streams), and hands browsers a ready-made snapshot plus deltas.

## Why one `bd serve` per database

`bd serve` serves the workspace it was started in — one database. Several databases mean
several processes on different ports; bddb hides that behind `/api/p/<db>/…`. The database list
is therefore fixed at startup.

## Synthesized workspaces

bddb does not run `bd init`. For each database it creates `<work-dir>/<db>` with `git init -q`
(bd resolves its repo root through git), `.beads/metadata.json` =
`{ "dolt_mode": "server", "dolt_database": "<db>" }` and `.beads/config.yaml` =
`events-journal: true`, then starts `bd serve` with the connection in the environment:
`BEADS_DOLT_SERVER_HOST/PORT/DATABASE/USER`, `BEADS_DOLT_PASSWORD`, `BEADS_DOLT_AUTO_START=0`,
`BD_EVENTS_JOURNAL=1`, `BD_NON_INTERACTIVE=1`. Every `BEADS_*` / `BD_*` variable of bddb's own
environment is dropped first, so a shell bound to another store can never leak into the child.
No `project_id` is written (a mismatch would make bd refuse to connect), so
`context.project_id` is empty and `Bd-Project-Id` is not sent.

## Process lifecycle

- Before anything else bddb checks that `bd` runs and is a supported version, and that Dolt
  answers discovery; otherwise it exits 2 with hints (`docs/configuration.md`, "Startup
  failures") instead of serving a board of `down` databases.
- `bd serve` exits with code 1 when Dolt is unreachable at start → the supervisor retries with
  exponential backoff (1 s → 30 s); the database is `down` and `DatabaseInfo.lastError` carries
  the exit code and the last telling line `bd serve` printed.
- Dolt disappearing after start → `bd serve` stays up and answers `503 db_unavailable`; the
  database is reported `degraded` (`lastError` = the problem code and detail), the last
  snapshot keeps being served; bd recovers by itself when Dolt is back.
- `bd serve` talks to Dolt through a detached `bd db-proxy-child` it forks (pid in
  `.beads/dolt/proxy.pid`). The proxy outlives `bd serve` and is never respawned; if it dies,
  every request is `503` forever. bddb therefore restarts `bd serve` **and** the proxy when
  `503` persists for more than a minute while Dolt is reachable, and kills both on shutdown.
- On shutdown (`SIGINT`/`SIGTERM`/`SIGHUP`) browsers' streams are closed, each `bd serve` gets
  `SIGTERM` (then `SIGKILL` after 5 s), its proxy likewise, and the process exits.

## Live updates

Per database bddb holds one `GET events:watch` stream. Journal records carry the full issue
state, so they are applied to the snapshot directly; after ~300 ms of quiet the ready set,
stats and the rows touched by dependency/comment events are refreshed and one `delta` goes out.
Polling (`BDDB_POLL_INTERVAL`) always runs as well, because the journal does not see
`bd dolt pull`/merges or edits from workspaces without `events-journal: true`. `truncated`,
`410`, `409 events_journal_disabled`, a `bd serve` restart or a long reconnect gap trigger a
full re-baseline pushed as a fresh `snapshot`. The header indicator shows `sse` while the
stream is connected and `polling` otherwise.
