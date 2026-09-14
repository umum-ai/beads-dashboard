# Deployment

bddb ships two ways: a container image `ghcr.io/umum-ai/bddb` (linux/amd64, linux/arm64) and a
single-file binary per platform in GitHub Releases. Both contain the same server and SPA. The
image also contains the `bd` binary; the single binary expects `bd` (and `git`) in `PATH`.

In every case **`dolt sql-server` and your data stay where they are** — on the host that runs
your beads shared server. bddb only connects to it over TCP and starts one `bd serve` per
database ([topology](topology.md)). Embedded-mode workspaces are not supported
([host-setup](host-setup.md)).

## Image

```text
ghcr.io/umum-ai/bddb:latest      last release on main
ghcr.io/umum-ai/bddb:0.1         latest 0.1.x
ghcr.io/umum-ai/bddb:0.1.0       exact release
ghcr.io/umum-ai/bddb:sha-<7>     every commit on main
```

Contents: `oven/bun:1.4-slim` (Debian bookworm) + `git` + `ca-certificates` + `/usr/local/bin/bd`
(the beads release for the image's architecture, verified against the release `checksums.txt`) +
`/app/server` (the bundled dashboard). Runs as uid 1000 (`bun`); `bd serve` workspaces are
synthesized in `BDDB_WORK_DIR=/tmp/bddb`. About 620 MB, of which `bd` is 137 MB and `bun` 76 MB.

Labels: `org.beads.version` — the beads release inside (`docker inspect … --format
'{{index .Config.Labels "org.beads.version"}}'`), `org.opencontainers.image.version` — the bddb
release, `org.opencontainers.image.source`, `.licenses=MIT`.

Defaults baked into the image (override with `-e`): `BDDB_HOST=0.0.0.0`, `BDDB_PORT=7331`,
`BDDB_DOLT_HOST=host.docker.internal`, `BDDB_DOLT_PORT=3308`, `BDDB_WORK_DIR=/tmp/bddb`,
`BDDB_BD_PATH=/usr/local/bin/bd`. Full list: [configuration](configuration.md).

Entry point is `bddb`, default command `serve`:

```sh
docker run --rm ghcr.io/umum-ai/bddb version
docker run --rm --add-host=host.docker.internal:host-gateway ghcr.io/umum-ai/bddb doctor
```

### Reaching your dolt from the container

A container does not see the host's `127.0.0.1`. Two ways, pick one:

**Bridge networking (default) + `host.docker.internal`.** Docker Desktop and OrbStack resolve the
name; Linux Docker Engine needs `--add-host=host.docker.internal:host-gateway`. Your dolt must
then *listen on an address the container can reach* and *have a user allowed from remote hosts*:

1. `listener.host: 0.0.0.0` in the shared server's `dolt-server-config.yaml` (details and the
   security warning in [host-setup](host-setup.md#1-a-reachable-dolt-sql-server)).
2. A freshly initialised dolt only has `root@localhost`. Connections from another host are
   refused with `Access denied for user 'root'` until a remote user exists:

   ```sh
   dolt --host 127.0.0.1 --port 3308 --user root --password "" --no-tls sql \
     -q "CREATE USER IF NOT EXISTS 'root'@'%'; GRANT ALL ON *.* TO 'root'@'%' WITH GRANT OPTION;"
   ```

   Prefer a dedicated user with a password and set `BDDB_DOLT_USER` / `BDDB_DOLT_PASSWORD`.

```sh
docker run -d --name bddb --restart unless-stopped \
  -p 7331:7331 \
  --add-host=host.docker.internal:host-gateway \
  -e BDDB_DOLT_HOST=host.docker.internal -e BDDB_DOLT_PORT=3308 \
  ghcr.io/umum-ai/bddb
```

**Host networking (Linux).** The container shares the host's network namespace: dolt may keep
listening on `127.0.0.1`, `root@localhost` is enough, and `-p` is not needed (bddb listens on
`BDDB_PORT` of the host directly):

```sh
docker run -d --name bddb --restart unless-stopped --network host \
  -e BDDB_DOLT_HOST=127.0.0.1 -e BDDB_DOLT_PORT=3308 \
  ghcr.io/umum-ai/bddb
```

On Docker Desktop / OrbStack `--network host` puts the container on the VM's network, not on
your machine's loopback — use bridge + `host.docker.internal` there.

### Compose

[`docker-compose.example.yml`](../docker-compose.example.yml) has the full env block with
comments, the Linux `extra_hosts` entry and the `network_mode: host` alternative:

```sh
cp docker-compose.example.yml docker-compose.yml   # edit the environment block
docker compose up -d
docker compose exec bddb bddb doctor
```

### Health checks

- `GET /healthz` → `200 ok` (text) while the process runs.
- `GET /readyz` → `200` once at least one database is `ready`, `503` before / when every
  database is down. Use it as the readiness probe.
- The image's `HEALTHCHECK` polls `/healthz` (30 s interval, 20 s start period) with `bun`
  itself — no curl in the image. It honours `BDDB_PORT` and `BDDB_BASE_PATH`.
- `GET /api/meta` shows every database with `state` (`starting|ready|degraded|down`), `live`
  (`sse|polling`), the `bd serve` version and a `versionWarning` when it differs from the beads
  release bddb was built for.

### Behind a reverse proxy

Set `BDDB_BASE_PATH=/beads` (no trailing slash) and forward `/beads/` to the container **without
stripping the prefix** — bddb expects to see `/beads/...` and injects `<base href="/beads/">` into
the page. SSE (`/beads/api/p/<db>/events`) needs response buffering off and a long read timeout.

nginx:

```nginx
location /beads/ {
    proxy_pass         http://127.0.0.1:7331;   # no trailing slash: keep the prefix
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   Connection "";
    proxy_buffering    off;                     # SSE
    proxy_read_timeout 1h;
}
```

Caddy: `handle_path` strips the prefix — use `reverse_proxy /beads/* 127.0.0.1:7331` instead
(Caddy flushes SSE by default). Traefik: a ``PathPrefix(`/beads`)`` router without the
`StripPrefix` middleware.

The dashboard has **no authentication** — put the proxy's auth (basic auth, OAuth proxy, VPN) in
front of it. Anyone who reaches bddb can read and edit every served database.

## Single binary

Releases carry `bddb-<version>-<os>-<arch>.tar.gz` for `linux-x64`, `linux-arm64`,
`darwin-x64`, `darwin-arm64`, each with a `.sha256`, plus one `SHA256SUMS`. The archive holds one
executable, `bddb-<os>-<arch>` (~80 MB — it embeds the bun runtime and the SPA).

```sh
curl -fsSLO https://github.com/umum-ai/beads-dashboard/releases/download/v0.1.0/bddb-0.1.0-linux-x64.tar.gz
curl -fsSLO https://github.com/umum-ai/beads-dashboard/releases/download/v0.1.0/bddb-0.1.0-linux-x64.tar.gz.sha256
sha256sum -c bddb-0.1.0-linux-x64.tar.gz.sha256
tar -xzf bddb-0.1.0-linux-x64.tar.gz && install -m 0755 bddb-linux-x64 ~/.local/bin/bddb

bddb doctor --dolt-host 127.0.0.1 --dolt-port 3308     # bd and git must be in PATH (or BDDB_BD_PATH)
bddb serve  --dolt-host 127.0.0.1 --dolt-port 3308     # → http://localhost:7331
```

The binary needs `bd` (the same minor as your host beads — normally the very `bd` you already
use) and `git` in `PATH`; `bddb doctor` reports both on its first two lines. Run it as a
systemd service, a launchd agent, or under any supervisor; it stops every `bd serve` it started
on `SIGTERM`. Each running instance needs its own `BDDB_WORK_DIR` (default `$TMPDIR/bddb`).

macOS: the binaries are not signed or notarized; Gatekeeper will quarantine a download made with a
browser (`xattr -d com.apple.quarantine bddb-darwin-arm64`). `curl` downloads are not quarantined.

## Upgrading

- **Keep the beads minor in step.** The `bd` inside the image (label `org.beads.version`, and
  `bddb version`) must match the minor of the `bd` your agents use on the host; `bd serve` and the
  CLI share the Dolt schema. bddb logs a warning and shows a banner in the header when
  `bd_version` from `bd serve` differs in major/minor from what it was built for. The mapping of
  bddb releases to beads releases is in [compatibility](compatibility.md).
- Pull the new tag, stop the old container, start the new one — bddb keeps no state (the
  workspaces in `BDDB_WORK_DIR` are recreated). Browsers reconnect to the SSE stream by
  themselves and receive a fresh snapshot.
- A different beads version than the one shipped: `docker build --build-arg BEADS_VERSION=X.Y.Z
  -t bddb .` from a checkout (the release must exist on `github.com/gastownhall/beads` with a
  `checksums.txt`). `bddb` itself may refuse or misbehave on a major/minor it was not built for.

## Building locally

```sh
mise run build            # dist/web (SPA) + dist/server (bundle): bun dist/server/cli.js serve
mise run build:binary     # dist/bddb-<os>-<arch>; --target bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64
mise run docker:build     # docker build with BEADS_VERSION from mise.toml
mise run docker:smoke     # build + run the image against a scratch stand (scripts/docker-smoke.sh)
```

`scripts/docker-smoke.sh` runs the container with `--network host` against a stand started by
`scripts/stand.sh`; from a Linux VM under Docker Desktop / OrbStack set `SMOKE_DOLT_HOST=<the
VM's IP> SMOKE_HOST=host.docker.internal` (see the script header).
