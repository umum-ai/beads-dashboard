# Security

## Reporting a vulnerability

Please report security issues privately through the "Report a vulnerability" form on this
repository (GitHub Security tab) rather than in a public issue. You should get an
acknowledgement within a week. Include the bddb and beads versions (`bddb version`) and, when
possible, a reproduction against `scripts/stand.sh` (a scratch Dolt), never against real data.

## What bddb is and is not

bddb is a **trusted-network tool**: whoever can open it can read and change every issue of
every served database, as the actor they type into the header. It adds no security layer of
its own; it relies on where you run it.

- **No authentication or authorization.** There are no users, sessions, tokens or roles. The
  `actor` shown on every write is a free-text label from the browser (`localStorage`), not an
  identity. Put the dashboard behind something that authenticates — a reverse proxy with basic
  auth or an OAuth proxy, a VPN, an SSH tunnel — or bind it to `127.0.0.1` (`BDDB_HOST`). The
  default bind is `0.0.0.0` because the image is meant to be published by Docker.
- **Network exposure.** bddb listens on one port (`BDDB_PORT`, default 7331). The `bd serve`
  processes it starts bind to `127.0.0.1` on random ports and answer only to bddb; they are
  never meant to be reached directly. Behind a reverse proxy that strips or adds a prefix, see
  `BDDB_BASE_PATH` in [docs/deployment.md](docs/deployment.md); SSE needs buffering off.
- **Your Dolt is the real attack surface.** bddb connects to `dolt sql-server` over the MySQL
  protocol with `BDDB_DOLT_USER` / `BDDB_DOLT_PASSWORD` and passes the same credentials to
  each `bd serve` (`BEADS_DOLT_SERVER_USER`, `BEADS_DOLT_PASSWORD`). The beads shared server
  runs as `root` **without a password** on `127.0.0.1:3308`; making it listen on `0.0.0.0` so a
  container can reach it exposes every database to anyone on that network. Prefer `--network
  host` on Linux, or firewall the port to the Docker bridge, or create a dedicated Dolt user with
  a password ([docs/host-setup.md](docs/host-setup.md)).
- **Password handling.** Pass the password through the environment (`BDDB_DOLT_PASSWORD`, an
  env file, a compose `secrets`/`environment` entry), not the `--dolt-password` flag — flags
  are visible in `ps` on the host. bddb never logs the password; it appears in the child
  environment of `bd serve` (readable by the same user through `/proc`, as with any process)
  and nowhere on disk: the synthesized workspaces in `BDDB_WORK_DIR` hold only `dolt_mode`,
  `dolt_database` and `events-journal: true`. Logs do contain issue ids, titles in write
  errors, and request lines at `debug` level.
- **What bddb refuses to do** regardless of who asks: `issues:delete`, `issues:sweep`, config
  writes (`PUT/DELETE config/*`) and the `memories` API are not exposed; only whitelisted query
  parameters are forwarded; request bodies are capped at 1 MiB; the only SQL it ever runs is
  `SHOW DATABASES` (plus one `information_schema` lookup) at start.
- **Content.** Markdown from issues and comments is rendered through `marked` and sanitized
  with `DOMPurify`; the SPA is same-origin with the API and sets no cookies. Problem responses
  from `bd serve` are shown as they are, so error text written by one user is visible to
  others.
- **Supply chain.** The image downloads the pinned beads release and verifies it against the
  release `checksums.txt`; base images are digest-pinned; Renovate proposes updates; release
  binaries ship with `.sha256` files and a `SHA256SUMS`. The binaries are not signed or
  notarized.

## Supported versions

Only the latest release (and `main`) receives fixes while the project is on `0.x`.
