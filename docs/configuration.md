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
| `BDDB_DATABASES` | `--databases` | auto-discovery | CSV of database names to serve, in this order. Each must exist and contain an `issues` table; otherwise startup fails listing what exists. Unset → [discovery](#database-discovery). |
| `BDDB_DEFAULT_DATABASE` | `--default-database` | first served | Project `/` redirects to. Must be one of the served databases. |
| `BDDB_ACTOR` | `--actor` | `bddb` | `actor` (and comment `author`) filled into write requests that carry none. ≤ 256 bytes, no control characters. The UI sends its own actor; this is the fallback. |
| `BDDB_POLL_INTERVAL` | `--poll-interval` | `15s` | Interval of the full re-read that runs regardless of the events journal. Durations: `500ms`, `15s`, `2m`, `1h`, `1m30s`; a bare number is seconds. Minimum `1s`. |
| `BDDB_CLOSED_DAYS` | `--closed-days` | `7` | Closed issues newer than this many days are part of the board snapshot; older ones are fetched on demand. `0` shows none. |
| `BDDB_BD_PATH` | `--bd-path` | `bd` | Path to the `bd` binary used for `bd serve` (and `bd version` in `doctor`). |
| `BDDB_LOG_LEVEL` | `--log-level` | `info` | `debug`, `info`, `warn`, `error`. `debug` includes every `bd serve` request line. |
| `BDDB_LOG_FORMAT` | `--log-format` | `text` | `text` (human) or `json` (one object per line: `ts`, `level`, `msg`, fields). |
| `BDDB_WORK_DIR` | `--work-dir` | `$TMPDIR/bddb` (else `os.tmpdir()/bddb`) | Where the synthesized beads workspaces (`<work-dir>/<database>`) and, with a base path, the built SPA (`<work-dir>/web`) live. Must be writable. Two bddb instances serving the same database name must use different work dirs. |
| `BDDB_WEB_DIR` | `--web-dir` | assets embedded in the build, else build from `src/web` | A pre-built SPA directory (`scripts/build-web.sh DIR`, i.e. `bun build src/web/index.html --outdir DIR --production --public-path ./`). Serves files from disk; works under any `BDDB_BASE_PATH`. Not needed for the image or the release binaries — they carry the SPA. |

Logging goes to stderr. `bd serve` output is forwarded with a `[bd:<database>]` prefix
(request lines at `debug`, errors at `warn`).

## Database discovery

When `BDDB_DATABASES` is unset, bddb connects to Dolt over the MySQL protocol with the
credentials above, runs `SHOW DATABASES`, drops `information_schema`, `mysql` and `dolt`, keeps
the databases that own a table called `issues`, and puts `beads_global` (the shared-server
global database) last. The list is fixed at startup — one `bd serve` process serves one
database, so adding a database means restarting bddb.

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

# Explicit databases, custom port, behind nginx at /beads
bddb serve --dolt-host 127.0.0.1 --databases shared,siam --default-database siam \
  --port 8080 --base-path /beads

# Diagnose before starting
bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308
```
