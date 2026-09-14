# bddb — kanban dashboard for beads

**bddb** is a web kanban board for [beads](https://github.com/gastownhall/beads), the issue
tracker for coding agents. It reads and writes issues only through the `bd serve` HTTP API
(beads 1.3+): one process, one port, your Dolt server stays where it is.

![The board in the light theme: status columns, priority sections, swimlanes per epic](docs/screenshots/board-light.png)

## Why bddb

- Live board: edits agents make through the `bd` CLI show up via the `bd serve` events journal (SSE), with polling as the fallback.
- Several databases of one Dolt server, with a project switcher.
- Hierarchy: swimlanes per epic, drill-down into an epic, an epics view with progress, a parent / children / dependency tree.
- Full editing with drag-and-drop (status, priority, epic, multi-select); every write carries `expected_version`, so no lost updates.
- `bd query` expressions as a filter mode, next to text, type, label, assignee and priority filters.
- Keyboard-first; light and dark themes pass WCAG AA; English and Russian UI.
- Only the official HTTP API: no direct SQL to your data, no CLI scraping.
- Shipped as a Docker image (`ghcr.io/umum-ai/bddb`) and a single binary.

## Requirements

- beads 1.3.x with a Dolt SQL server: `bd init --server` or `--shared-server`. Embedded workspaces are not supported (`bd serve` needs Dolt).
- Single binary: `bd` and `git` in `PATH`. Docker: Dolt reachable from the container over TCP.
- The `bd` bddb uses (in `PATH`, or inside the image) must match your host `bd` **minor** version ([docs/compatibility.md](docs/compatibility.md)).
- With beads 1.3.x every shell and agent that runs `bd` must have the shared-server environment set, so that everything lives in one Dolt (replace the paths):

  ```sh
  export BEADS_DIR=/path/to/your/beads/share
  export BEADS_DOLT_SHARED_SERVER=1
  export BEADS_SHARED_SERVER_DIR=/path/to/your/beads/share
  ```

- Run `bd config set events-journal true` in every workspace agents write from; otherwise their changes reach the board only on the polling interval.

## Install on the host

Download `bddb-<version>-{linux,darwin}-{x64,arm64}.tar.gz` from
[GitHub Releases](https://github.com/umum-ai/beads-dashboard/releases), then:

```sh
tar -xzf bddb-<version>-linux-x64.tar.gz && install -m 0755 bddb-linux-x64 ~/.local/bin/bddb
bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308
bddb serve --dolt-host 127.0.0.1 --dolt-port 3308 --host 127.0.0.1
```

Open <http://127.0.0.1:7331>. Without `--databases` every database with an `issues` table is
attached and the largest becomes the default project.

From source (requires [mise](https://mise.jdx.dev)):

```sh
mise install && bun install && bun src/server/cli.ts serve --dolt-host 127.0.0.1 --dolt-port 3308
mise run build:binary    # dist/bddb-<os>-<arch>
```

## Install with Docker

```sh
docker run --rm -p 7331:7331 \
  --add-host=host.docker.internal:host-gateway \
  -e BDDB_DOLT_HOST=host.docker.internal -e BDDB_DOLT_PORT=3308 \
  ghcr.io/umum-ai/bddb
```

- Dolt must listen on `0.0.0.0` and have a user allowed from remote hosts (`CREATE USER 'root'@'%'`): [docs/host-setup.md](docs/host-setup.md).
- Linux alternative: `--network host` with `-e BDDB_DOLT_HOST=127.0.0.1`; Dolt stays on loopback.
- Compose: [`docker-compose.example.yml`](docker-compose.example.yml).

**Warning.** A password-less Dolt on `0.0.0.0` exposes all of its data to the network, and the
dashboard itself has no authentication — put both behind your network or a reverse proxy.

## Configuration

Every variable has a flag of the same name (`--dolt-port` ≡ `BDDB_DOLT_PORT`). Most used:

| Variable | Default | Purpose |
|---|---|---|
| `BDDB_DOLT_HOST` / `BDDB_DOLT_PORT` | `host.docker.internal` / `3308` | your Dolt SQL server |
| `BDDB_DATABASES` | auto-discovery | CSV of databases to serve |
| `BDDB_DEFAULT_DATABASE` | largest | project opened by default |
| `BDDB_CLOSED_HOURS` | `72` | the server keeps closed issues of the last N hours; the board's period selector picks 1–72 h within it |
| `BDDB_BASE_PATH` | (empty) | path prefix behind a reverse proxy, e.g. `/beads` |

Full reference: [docs/configuration.md](docs/configuration.md).

## Docs

- [docs/README.md](docs/README.md) — index
- [deployment](docs/deployment.md) — image, binary, reverse proxy, health checks, upgrades
- [host-setup](docs/host-setup.md) — reachable Dolt, server-mode workspaces, events journal
- [configuration](docs/configuration.md) — every `BDDB_*` variable, discovery, startup failures
- [compatibility](docs/compatibility.md) — bddb ↔ beads versions
- [ui](docs/ui.md) — layout, keyboard shortcuts, states, themes
- [bff-api](docs/bff-api.md) — server ↔ SPA contract
- [api-client](docs/api-client.md) — the typed `bd serve` client
- [topology](docs/topology.md) — what runs where

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md).

## Status

Pre-release `0.x`, tested against beads `1.3.0-rc.2`.

## License

[MIT](LICENSE).
