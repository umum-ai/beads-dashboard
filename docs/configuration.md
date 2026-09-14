# Configuration

`bddb serve` and `bddb doctor` read `BDDB_*` environment variables; every variable has a CLI
flag of the same meaning (`--dolt-port 3308` ≡ `BDDB_DOLT_PORT=3308`). Flags win over the
environment, the environment over the defaults. Invalid values stop the process with a message
and exit code 2 (`bddb: BDDB_PORT must be an integer between 1 and 65535, got "70000"`).

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `BDDB_HOST` | `--host` | `0.0.0.0` | Bind address of the dashboard. Use `127.0.0.1` when a reverse proxy on the same machine fronts it. |
| `BDDB_PORT` | `--port` | `7331` | Dashboard port. |
| `BDDB_BASE_PATH` | `--base-path` | (empty) | Path prefix when the dashboard is served under a sub-path of a reverse proxy, e.g. `/beads`. Normalised to a leading slash and no trailing slash; `/` means empty. See [Base path](#base-path). |
| `BDDB_DOLT_HOST` | `--dolt-host` | `host.docker.internal` | Host of your `dolt sql-server`. Outside Docker set `127.0.0.1`. |
| `BDDB_DOLT_PORT` | `--dolt-port` | `3308` | Dolt MySQL port (`3308` is the beads shared-server default; `bd init --server` defaults to `3307`). |
| `BDDB_DOLT_USER` | `--dolt-user` | `root` | Dolt MySQL user, used for discovery and passed to `bd serve` as `BEADS_DOLT_SERVER_USER`. |
| `BDDB_DOLT_PASSWORD` | `--dolt-password` | (empty) | Dolt password, passed to `bd serve` as `BEADS_DOLT_PASSWORD`. Prefer the environment over the flag (flags show up in `ps`). |
| `BDDB_DATABASES` | `--databases` | auto-discovery | CSV of database names to serve, listed in this order. Each must exist and contain an `issues` table; otherwise startup fails listing what exists. Unset → [discovery](#database-discovery), which orders the list by size. |
| `BDDB_DEFAULT_DATABASE` | `--default-database` | the largest database | Project `/` redirects to (`Meta.defaultDatabase`). Must be one of the served databases. Unset → the database with the most rows in its `issues` table at startup, whether the list came from discovery or from `BDDB_DATABASES` (ties → the first in list order; `beads_global` only when it is the only database). |
| `BDDB_ACTOR` | `--actor` | `bddb` | `actor` (and comment `author`) filled into write requests that carry none. ≤ 256 bytes, no control characters. The UI sends its own actor; this is the fallback. |
| `BDDB_POLL_INTERVAL` | `--poll-interval` | `15s` | Interval of the full re-read that runs regardless of the events journal. Durations: `500ms`, `15s`, `2m`, `1h`, `1m30s`; a bare number is seconds. Minimum `1s`. |
| `BDDB_CLOSED_HOURS` | `--closed-hours` | `72` | Closed (done-category) issues whose `closed_at` is within the last N hours are part of the board snapshot (`Meta.closedHours`); older ones are fetched on demand. Integer, `1`–`720`. This is the server-side upper bound: the UI lets the user narrow the Done column to 1–72 h within it. |
| `BDDB_BD_PATH` | `--bd-path` | `bd` | Path to the `bd` binary used for `bd serve` (and `bd version` in `doctor`). |
| `BDDB_LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, `error`. `debug` includes every `bd serve` request line. |
| `BDDB_LOG_FORMAT` | `--log-format` | `text` | `text` (human) or `json` (one object per line: `ts`, `level`, `msg`, fields). |
| `BDDB_WORK_DIR` | `--work-dir` | `$TMPDIR/bddb` (else `os.tmpdir()/bddb`) | Where the synthesized beads workspaces (`<work-dir>/<database>`) and, with a base path, the built SPA (`<work-dir>/web`) live. Must be writable. Two bddb instances serving the same database name must use different work dirs: each workspace is locked by `<work-dir>/<database>/bddb.lock` (owner pid, removed on shutdown); a lock held by a live process makes the second instance exit 2, a lock left by a dead one is taken over. |
| `BDDB_WEB_DIR` | `--web-dir` | assets embedded in the build, else build from `src/web` | A pre-built SPA directory (`scripts/build-web.sh DIR`, i.e. `bun build src/web/index.html --outdir DIR --production --public-path ./`). Serves files from disk; works under any `BDDB_BASE_PATH`. Not needed for the image or the release binaries — they carry the SPA. |

Logging goes to stderr. `bd serve` output is forwarded with a `[bd:<database>]` prefix
(request lines at `debug`, errors at `warn`). At start bddb prints one line for the `bd` it
found, the databases with their `issues` row counts and the default (`databases: shared (312),
siam (75) default=shared`), the `dashboard: http://…/` URL to open (the loopback address when
bound to `0.0.0.0`) and one line per database (`database kb: starting (starting bd serve)` →
`database kb: bd serve 127.0.0.1:<port> (bd 1.3.0-rc.2), loading snapshot` →
`database kb: ready — 5 issues, live sse`); a database that dies logs `database kb: down — bd
serve process exited (exit 137): …`.

## Startup failures

`bddb serve` refuses to start, prints a multi-line message with the same hints `bddb doctor`
gives, and exits with code **2** when the operator has something to fix; unexpected errors
exit **1** with a stack trace. Verified messages:

| Situation | Message (first line) and hints |
|---|---|
| invalid value | `bddb: BDDB_PORT must be an integer between 1 and 65535, got "70000"` → `see bddb help and docs/configuration.md` |
| dolt unreachable (wrong host/port, not running, firewalled) | `bddb: cannot start: cannot query dolt at 127.0.0.1:3798 as root: Failed to connect` → `is dolt sql-server running and reachable from here? (try bddb doctor)`, `from a container the host's dolt must listen on 0.0.0.0 … or use --network host`, `check BDDB_DOLT_USER / BDDB_DOLT_PASSWORD` |
| `BDDB_DATABASES` names a missing database | `bddb: cannot start: BDDB_DATABASES names a database that does not exist on the dolt server: nope` → `databases present: kb` |
| `BDDB_DEFAULT_DATABASE` is not served | `bddb: cannot start: BDDB_DEFAULT_DATABASE "nope" is not among the served databases` → `databases: shared, siam` |
| a named database has no `issues` table | `… names a database without an issues table (not a beads database?): x` → `beads databases present: …` |
| nothing to serve (auto-discovery) | `bddb: cannot start: no beads database found on the dolt server` → `databases present but without an issues table: …` / `the server has no user databases at all`, `is this the right dolt? check BDDB_DOLT_HOST / BDDB_DOLT_PORT (shared-server default: 3308)`, `a beads workspace must have been initialised in server mode against it (bd init --server / --shared-server)`, `or list databases explicitly with BDDB_DATABASES=name1,name2` |
| `bd` missing | `bddb: cannot start: cannot run "/nonexistent version": bd binary not found or not executable` → `install beads (…) so that bd is in PATH, or set BDDB_BD_PATH`, `the release binary and a source checkout need bd and git on the host; the container image already carries both`, `bddb doctor runs this and the other startup checks` |
| workspace in use by another bddb | `bddb: cannot start: workspace /tmp/bddb/kb is in use by another bddb process (pid 4242, lock file /tmp/bddb/kb/bddb.lock)` → `two bddb instances must not share a workspace …`, `give this instance its own BDDB_WORK_DIR (--work-dir), or stop the other process`, `if pid 4242 is not bddb any more, remove the lock file and start again` |
| `bd` too old / other major | `bddb: cannot start: bd 1.2.9 at bd is not supported by this bddb (built for beads 1.3.0-rc.2): minor version mismatch` → `bd serve needs beads 1.3.0-rc.2 or newer in the same major; upgrade bd …`, `docs/compatibility.md lists which bddb goes with which beads`. A **newer** minor only logs a warning (and the UI shows the version banner). |

A database that becomes unreachable *after* start is not a startup failure: it is reported as
`down` / `degraded` in `/api/meta` and in the UI while the supervisor restarts `bd serve`
([bff-api](bff-api.md), `DatabaseInfo.lastError`).

## Database discovery

When `BDDB_DATABASES` is unset, bddb connects to Dolt over the MySQL protocol with the
credentials above, runs `SHOW DATABASES`, drops `information_schema`, `mysql` and `dolt`, and
keeps the databases that own a table called `issues`. It then counts the rows of every
selected database (`SELECT COUNT(*) FROM <db>.issues`, one query per database over the same
connection) and orders the list largest first; `beads_global` (the shared-server global
database) goes last whatever its size. The list is fixed at startup — one `bd serve` process
serves one database, so adding a database means restarting bddb.

The counts also pick the **default database** when `BDDB_DEFAULT_DATABASE` is unset: the
largest one (ties → the first in list order; `beads_global` only when nothing else is served).
With `BDDB_DATABASES` the list keeps the operator's order, but the default is still the
largest — set `BDDB_DEFAULT_DATABASE` to pin it. The counts are reported as
`DatabaseInfo.issueCount` in `GET /api/meta`, in the startup log line (`databases: shared
(312), siam (75), beads_global (3) default=shared`) and in `bddb doctor` (`databases  shared
(312), siam (75), beads_global (3)` and `default database  shared (largest; set
BDDB_DEFAULT_DATABASE to override)`). They are taken once at startup and not kept live.

An empty result stops the process with hints: check `BDDB_DOLT_HOST` / `BDDB_DOLT_PORT`, make sure
a workspace was initialised in server mode against this Dolt (`bd init --server` /
`--shared-server`), or name the databases with `BDDB_DATABASES`. `bddb doctor` runs the same
discovery and prints what it found.

## Base path

Behind a reverse proxy that does **not** strip the prefix (`https://tools.example.com/beads/…`
→ `bddb` sees `/beads/…`), set `BDDB_BASE_PATH=/beads`. Every route — `/beads/healthz`,
`/beads/api/meta`, `/beads/p/<db>/board` and the asset files — then lives under the prefix,
and requests outside it are answered `404`. `/beads` redirects to the default board.

With a base path the SPA cannot use Bun's HTML routes (they always emit root-absolute asset
URLs), so at start bddb builds the SPA with `Bun.build({ publicPath: "/beads/" })` into
`<work-dir>/web` (a few hundred ms) and injects `<base href="/beads/">` into `index.html`. The
SPA reads its base path from that tag. See docs/bff-api.md "Static assets".

If the proxy strips the prefix instead, leave `BDDB_BASE_PATH` empty.

## Ports and processes

bddb binds one port (`BDDB_PORT`). Per served database it starts one `bd serve` on a free
loopback port (`127.0.0.1:<random>`) — those are never meant to be reached directly. Each
`bd serve` in turn forks a detached `bd db-proxy-child` (pid in
`<work-dir>/<db>/.beads/dolt/proxy.pid`); bddb stops both on shutdown (`SIGINT`, `SIGTERM`,
`SIGHUP`).

## Examples

```sh
# Host install, shared-server dolt on the default port, everything auto-discovered
BDDB_DOLT_HOST=127.0.0.1 bddb serve

# The same, with a one-day closed window on the board instead of the default 72 h
BDDB_DOLT_HOST=127.0.0.1 BDDB_CLOSED_HOURS=24 bddb serve

# Explicit databases (siam pinned as default — otherwise the largest wins), custom port, nginx at /beads
bddb serve --dolt-host 127.0.0.1 --databases shared,siam --default-database siam \
  --port 8080 --base-path /beads

# Diagnose before starting
bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308
```
