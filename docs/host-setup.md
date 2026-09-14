# Host setup

What your machine needs before `bddb` can show your beads: a `dolt sql-server` that bddb can
reach, workspaces in a server mode (not embedded), and — for live updates from CLI edits — the
events journal in those workspaces. `bddb doctor` checks all of it:

```sh
bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308
```

## 1. A reachable Dolt SQL server

bddb (and the `bd serve` processes it starts) connect to Dolt over TCP with the MySQL protocol.

**Same host, no Docker.** Nothing to open: `BDDB_DOLT_HOST=127.0.0.1`, port `3308` for the
beads shared server (`bd init --shared-server`), or whatever `bd dolt show` prints for a
`bd init --server` workspace.

**bddb in Docker.** The container must reach the host's Dolt. Two options:

- *Host networking*: `docker run --network host …` — the container shares the host's loopback,
  `BDDB_DOLT_HOST=127.0.0.1` works and Dolt can keep listening on `127.0.0.1`.
- *Bridge networking* (default): Dolt must listen on an address the container can reach. For
  the shared server edit `~/.beads/shared-server/dolt-server-config.yaml` (or
  `$BEADS_SHARED_SERVER_DIR/dolt-server-config.yaml`):

  ```yaml
  listener:
      host: 0.0.0.0     # was 127.0.0.1
      port: 3308
  ```

  and restart the server (`bd dolt stop && bd dolt start` in any shared-server workspace, or
  restart whatever supervises it). Then point the container at the host:
  `-e BDDB_DOLT_HOST=host.docker.internal`. Docker Desktop and OrbStack resolve that name;
  on Linux Docker Engine add `--add-host=host.docker.internal:host-gateway`.

**Warning.** The beads shared server runs as `root` **without a password**. Once it listens on
`0.0.0.0`, every process that can reach the port can read and change every database. Keep the
port firewalled to the Docker bridge (e.g. `ufw allow in on docker0 to any port 3308`) or a
trusted LAN, or set a password (`BEADS_DOLT_PASSWORD` for bd, `BDDB_DOLT_PASSWORD` for bddb)
and configure a Dolt user with it. Prefer `--network host` when in doubt.

## 2. Workspaces in server mode

`bd init` creates **embedded** workspaces by default (Dolt runs inside each `bd` process), and
`bd serve` refuses to run there:

```text
Error: operation "serve" not supported by the embedded-dolt backend: bd serve requires a Dolt SQL server
```

bddb never sees embedded data — there is no server to connect to. Supported modes:

| Mode | How | Dolt | bddb settings |
|---|---|---|---|
| shared-server | `bd init --shared-server` (or `BEADS_DOLT_SHARED_SERVER=1`) | one server for all your projects, `~/.beads/shared-server/`, port 3308 | defaults (`BDDB_DOLT_PORT=3308`) |
| server | `bd init --server --server-host H --server-port P` (`--external` when you run dolt yourself) | any `dolt sql-server` | `BDDB_DOLT_HOST/PORT` accordingly |

**Converting an embedded workspace.** bd 1.3.0-rc.2 has no in-place switch from embedded to a
server mode (`bd migrate` only converts between server, shared-server and proxied-server).
The path is export → re-init → import, with the JSONL export as your safety net:

```sh
cd my-project
bd export -o /tmp/my-project.jsonl          # issues, labels, dependencies, comments
cp -r .beads /tmp/my-project.beads.bak        # keep the embedded data too
bd init --shared-server --reinit-local        # or: bd init --server --external --server-host 127.0.0.1 --server-port 3307 --reinit-local
bd import /tmp/my-project.jsonl
bd list --all | head                          # check ids and statuses came back
```

`bd export` writes issue records, not Dolt history: branches and commit history of the
embedded database are not carried over (see `bd export --help`). Test on a copy first;
`bd help init-safety` explains the `--reinit-local` guard.

## 3. Events journal in the workspaces agents write from

Live updates come from the `bd_events_journal` table, and **the process that writes decides
whether its change is journaled**. bddb's own `bd serve` processes journal everything they
write (the UI's changes). Edits made by agents through the `bd` CLI are journaled only when
the CLI runs in a workspace with the journal enabled:

```sh
cd each-workspace-agents-write-from
bd config set events-journal true     # writes `events-journal: true` to .beads/config.yaml
```

Long-running `bd` processes (`bd serve`, daemons) must be restarted to pick it up. Without the
journal those edits still appear — on the next poll (`BDDB_POLL_INTERVAL`, default 15 s) — and
the header shows `polling` instead of `sse` only when bddb's own stream is down, so a missing
journal on the host is invisible in the UI. `bddb doctor` prints this reminder every time.

`bd dolt pull` and merges are never journaled; polling covers them.

## 4. Versions

The `bd` inside the bddb image (or the one on `PATH` for the single binary) must match your
host `bd` in major and minor: a beads schema migration on a shared Dolt is run by one client
and older clients then refuse to connect. bddb compares `bd_version` from `bd serve` with the
version it was built for and shows a warning in the header and the log when they differ.
`bddb version` prints both; `bddb doctor` checks the local `bd`.

## Checklist

1. `bddb doctor` → all ✓.
2. `bd config set events-journal true` in every agent workspace.
3. Dolt reachable only from where it should be.
4. `bddb serve` → open `http://<host>:7331/`.
