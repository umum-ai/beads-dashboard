# bddb — kanban dashboard for beads

**bddb** is a web kanban board for [beads](https://github.com/gastownhall/beads), the
issue tracker for coding agents. It reads and writes issues exclusively through the
`bd serve` HTTP API (beads 1.3.0+). Know the limits before you start: **embedded-mode
workspaces are not supported**, because `bd serve` requires a Dolt SQL server (`bd init
--server` or `--shared-server`); **the dashboard has no authentication** — protect it with
your network or a reverse proxy; and **live updates from changes made by agents through the
CLI require `bd config set events-journal true`** in each workspace they write from, otherwise
those changes appear only on the next polling cycle.

## Status

Early development. Nothing below is guaranteed to work yet. Target compatibility: beads
`1.3.0-rc.2` and later.

## What it does (planned)

- Kanban board per workspace: columns by status (built-in plus `status.custom`), cards grouped
  into priority sections, light and dark themes, English and Russian UI.
- Hierarchy: swimlanes per epic, drill-down into an epic, an epics view with progress, and a
  parent/children/blockers tree in the issue panel.
- Editing: create issues, drag-and-drop between statuses, priorities and parents, close/reopen
  with a reason, comments, labels, `blocks` dependencies — all with optimistic-concurrency
  guards (`expected_version`).
- Live updates through the `bd serve` events journal (SSE), with full-reread polling as a
  fallback.
- Several databases of one Dolt server with a project switcher.
- Shipped as a Docker image (`ghcr.io/umum-ai/bddb`) and a single binary.

## Quick start (Docker)

The image `ghcr.io/umum-ai/bddb` (linux/amd64, linux/arm64) contains only the dashboard and the
`bd` binary. Your `dolt sql-server` and data stay on your host; the container connects to Dolt
over TCP.

```sh
docker run --rm -p 7331:7331 \
  --add-host=host.docker.internal:host-gateway \
  -e BDDB_DOLT_HOST=host.docker.internal \
  -e BDDB_DOLT_PORT=3308 \
  ghcr.io/umum-ai/bddb
```

Then open <http://localhost:7331>. `docker run --rm … ghcr.io/umum-ai/bddb doctor` checks the
connection first (`version` prints the bddb and beads versions).

Your Dolt server must accept connections from the container: `listener.host: 0.0.0.0` in
`dolt-server-config.yaml` of the shared server **and** a user allowed from remote hosts (a fresh
dolt has `root@localhost` only — see [docs/host-setup.md](docs/host-setup.md)). On Linux you can
instead use `--network host` with `-e BDDB_DOLT_HOST=127.0.0.1` and keep Dolt on loopback.
`--add-host` is needed on Linux Docker Engine only (Docker Desktop and OrbStack resolve
`host.docker.internal` themselves). A password-less Dolt listening on `0.0.0.0` exposes all of
its data to your network — restrict it accordingly.

The `bd` inside the image must match your host's `bd` **minor** version: the image label
`org.beads.version` and `bddb version` say which beads it was built for
([docs/compatibility.md](docs/compatibility.md)). Compose file, reverse-proxy setup with
`BDDB_BASE_PATH`, health checks and upgrade notes: [docs/deployment.md](docs/deployment.md).

## Single binary

GitHub Releases carry `bddb-<version>-{linux,darwin}-{x64,arm64}.tar.gz` with a `.sha256` each.
The binary embeds the dashboard and the bun runtime; it needs `bd` (same minor as your host
beads) and `git` in `PATH`:

```sh
tar -xzf bddb-0.1.0-linux-x64.tar.gz && install -m 0755 bddb-linux-x64 ~/.local/bin/bddb
bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308      # all ✓ ?
bddb serve  --dolt-host 127.0.0.1 --dolt-port 3308      # → http://localhost:7331
```

## Running from source

```sh
bddb serve  [flags]     # start the dashboard (BFF + SPA); flags mirror the BDDB_* variables
bddb doctor [flags]     # check dolt, databases, bd, bd serve and the events journal
bddb version            # bddb version and the beads version it was built for
bddb help
```

`bddb` is `bun src/server/cli.ts` in a checkout (`bun run serve`, `bun run doctor`); the same
flags work for the single binary and inside the container. `mise run build` produces a
self-contained `dist/server` (`bun dist/server/cli.js serve`), `mise run build:binary` the single
executable.

`doctor` prints a ✓/✗ table — `bd` binary and version, `git`, Dolt reachability, discovered
databases, a temporary `bd serve` for the first database, the events journal — with a hint
under every failed row, and exits non-zero when a critical check fails:

```text
  ✓ bd binary            bd version 1.3.0-rc.2 (bd)
  ✓ git binary           git version 2.55.0
  ✗ dolt reachable       cannot connect to 127.0.0.1:3390
                         → is `dolt sql-server` running? shared-server mode: `bd dolt status` …
```

`serve` discovers the databases (or takes `BDDB_DATABASES`), starts one `bd serve` per
database on a loopback port, and serves the board on `BDDB_HOST:BDDB_PORT`. Process endpoints:
`/healthz` (alive), `/readyz` (200 once a database is ready), `/api/meta`. Stop with Ctrl-C;
every `bd serve` it started is stopped too.

### Configuration

Full reference with flags and semantics: [docs/configuration.md](docs/configuration.md).

| Variable | Default | Purpose |
|---|---|---|
| `BDDB_HOST` / `BDDB_PORT` | `0.0.0.0` / `7331` | dashboard bind address |
| `BDDB_BASE_PATH` | (empty) | path prefix behind a reverse proxy, e.g. `/beads` |
| `BDDB_DOLT_HOST` / `BDDB_DOLT_PORT` | `host.docker.internal` / `3308` | your Dolt SQL server |
| `BDDB_DOLT_USER` / `BDDB_DOLT_PASSWORD` | `root` / (empty) | Dolt credentials |
| `BDDB_DATABASES` | auto-discovery | CSV of databases to serve |
| `BDDB_DEFAULT_DATABASE` | first in list | project opened by default |
| `BDDB_ACTOR` | `bddb` | default `actor` for writes |
| `BDDB_POLL_INTERVAL` | `15s` | polling fallback interval |
| `BDDB_CLOSED_DAYS` | `7` | window of closed issues shown on the board |
| `BDDB_BD_PATH` | `bd` from `PATH` | path to the `bd` binary |
| `BDDB_LOG_LEVEL` | `info` | log verbosity |

### Host setup

Details in [docs/host-setup.md](docs/host-setup.md); the short version:

- Move an embedded workspace to server mode: `bd export`, then `bd init --shared-server
  --reinit-local` (one Dolt for all your projects) or `bd init --server --external …`, then
  `bd import`.
- Enable the events journal in every workspace your agents write from:
  `bd config set events-journal true`. Without it the dashboard falls back to polling for
  those changes.
- Run `bddb doctor` to check Dolt connectivity, discovered databases, the `bd` version and
  the journal.

How the pieces fit together: [docs/topology.md](docs/topology.md). The HTTP contract between
the server and the SPA: [docs/bff-api.md](docs/bff-api.md).

## Development

Requires [mise](https://mise.jdx.dev).

```sh
mise install
bun install
mise run lint
mise run typecheck
mise run test
mise run dev
```

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE).
