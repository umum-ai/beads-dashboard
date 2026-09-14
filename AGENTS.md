# AGENTS.md — notes for the agent maintaining this repository

bddb is developed by agents. This file is the operating manual; the detailed working plan
with the owner's decisions lives in `tmp/PLAN.md` (not committed, `tmp/` is git-ignored). If
`tmp/PLAN.md` is present, read it first and keep its progress section current.

## Stack

- Runtime and bundler: bun 1.4.x (`Bun.serve`, HTML routes, `bun test`, `bun build`).
- Frontend: Preact + `@preact/signals`, `@atlaskit/pragmatic-drag-and-drop`, plain CSS,
  `marked` + `dompurify` for markdown.
- Tooling via mise (`mise.toml`): bun, biome 2, `bd` (`github:gastownhall/beads`),
  `dolt` (`aqua:dolthub/dolt`), actionlint, hadolint.
- Data access: only the `bd serve` HTTP API (`/v0/beads/...`). No direct SQL against issue
  tables, no `bd --json` as a data source. `Bun.SQL` over the MySQL protocol is used solely
  for database discovery (`SHOW DATABASES`, `information_schema.tables`, and one
  `SELECT COUNT(*) FROM <db>.issues` per database — the count only orders the list, picks the
  default database and fills `DatabaseInfo.issueCount`; never read issue rows over SQL).

## Commands

```sh
mise install            # toolchain
bun install             # dependencies (bun.lock is committed)
mise run lint           # biome check .
mise run lint:fix       # biome check --write .
mise run typecheck      # tsc --noEmit
mise run test           # bun test tests/unit
mise run contract       # bun test tests/contract (needs bd + dolt)
mise run e2e            # Playwright (stage 3+)
mise run dev            # scripts/dev.sh: stand up if needed, then bun --hot src/server/main.ts against it
mise run doctor         # bddb doctor against the local stand (dolt 3399)
mise run build          # dist/web (SPA, relative asset URLs) + dist/server (self-contained bundle)
mise run build:binary   # dist/bddb-<os>-<arch>; --target bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64
mise run check:pins     # beads version agrees in mise.toml, Dockerfile, version.ts, ci.yml
mise run docker:lint    # hadolint Dockerfile
mise run docker:build   # docker build with BEADS_VERSION from mise.toml
mise run docker:smoke   # build the image and run it against a scratch stand (scripts/docker-smoke.sh)
mise run screenshots    # docs/screenshots/board-{light,dark}.png from the mock (README images, ≤ 300 KB each)
```

Acceptance for any change: `mise run lint && mise run typecheck && mise run test && mise run
build` pass. Workflow files must pass `actionlint`, the Dockerfile `hadolint`, shell scripts
`shellcheck`; `scripts/check-pins.sh` must stay green.

### Running the server against the stand

```sh
scripts/stand.sh up && scripts/stand.sh seed        # dolt 127.0.0.1:3399, database `kb`, bd serve 47313
BDDB_DOLT_HOST=127.0.0.1 BDDB_DOLT_PORT=3399 BDDB_HOST=127.0.0.1 BDDB_PORT=7331 \
  BDDB_WORK_DIR=.stand/bddb-work bun src/server/cli.ts serve            # or: mise run dev
curl -s localhost:7331/api/meta | jq .
curl -s localhost:7331/api/p/kb/snapshot | jq '.issues | length'
curl -N localhost:7331/api/p/kb/events &                                # snapshot, then deltas…
(cd .stand/ws && bd q "from the CLI")                                    # …this arrives as a delta
bun src/server/cli.ts doctor --dolt-host 127.0.0.1 --dolt-port 3399
scripts/stand.sh create-issue "Live from CLI"                            # one issue via bd, prints its id
E2E_TARGET=real BDDB_URL=http://127.0.0.1:7331 E2E_DB=kb mise run e2e   # e2e against this server (docs/ui.md)
scripts/stand.sh down [--purge]
```

Rules for anything that spawns `bd`: strip every `BEADS_*` / `BD_*` variable from the
environment (the agent shell binds `bd` to the real store on 127.0.0.1:3308 — never touch it),
set the connection explicitly (`BEADS_DOLT_SERVER_HOST/PORT/DATABASE/USER`, `BEADS_DOLT_PASSWORD`,
`BEADS_DOLT_AUTO_START=0`, `BD_EVENTS_JOURNAL=1`), run `bd serve` with `cwd` in the workspace, and
stop the detached `bd db-proxy-child` (`.beads/dolt/proxy.pid`) together with `bd serve`
(`src/server/workspace.ts`, `supervisor.ts`). Use a dedicated `BDDB_WORK_DIR` per running
instance: two bddb processes sharing `<work-dir>/<db>` would also share the proxy pid file —
`ensureWorkspace` enforces it with `<work-dir>/<db>/bddb.lock` (owner pid; a live owner →
`StartupError`, exit 2; a dead one is taken over; released on shutdown).

## Layout

| Path | Contents |
|---|---|
| `src/server/` | BFF: `cli.ts` (`bddb serve` / `doctor` / `version`), `main.ts` (start + signals, startup error reporting: exit 2 with hints for config / discovery / preflight, 1 otherwise), `preflight.ts` (`bd` present and supported before anything starts), `app.ts` (routes, startup log lines), `config.ts`, `discovery.ts` (Bun.SQL: list, `issues` row count per database, `rankDatabases` / `pickDefaultDatabase`), `workspace.ts` + `supervisor.ts` (`bd serve` per database), `snapshot.ts` (baseline, diff, event application), `live.ts` (one `events:watch` per database), `project.ts` (per-database runtime, `DatabaseInfo.lastError`), `fanout.ts` (browser SSE), `proxy.ts` (whitelisted read/write proxies), `static.ts` (SPA), `doctor.ts`, `errors.ts` (`StartupError`, import-cycle free), `types.ts` (wire types of docs/bff-api.md) |
| `src/web/` | Preact SPA (`index.html`, `main.tsx`); layout in `docs/ui.md`. Keyboard: `lib/keyboard.ts` (pure) + `lib/board-keys.ts`; dialogs use `lib/focus-trap.ts`; states in `components/EmptyState.tsx`, `StatusBanners.tsx`; `lib/contrast.ts` backs the WCAG unit test |
| `src/api-client/` | Types generated from the spec, HTTP client, Problem handling, capability gating |
| `spec/openapi.v0.yaml` | Pinned copy of the `bd serve` OpenAPI spec for the supported beads version. Source of truth for the contract; never hand-edit |
| `tests/unit/` | `bun test` unit tests, including `server/project.test.ts` (`DatabaseRuntime` against a fake `bd serve` `fetch`: baseline/record races, flush serialisation, re-read cap), `server/workspace.test.ts` (lock), `web/contrast.test.ts` (AA for every text/background pair of `tokens.css`, both themes), `web/keyboard.test.ts`, `server/config-docs.test.ts` (`BDDB_*` in config.ts ↔ docs/configuration.md ↔ README), `server/preflight.test.ts` |
| `tests/contract/` | Tests against a real `bd serve` + `dolt sql-server`: `bd-serve.test.ts` (api-client), `bff.test.ts` (bddb as a child process), `bff-resilience.test.ts` (kill `bd serve` → `down` → `ready`; kill the db-proxy → `degraded`) |
| `tests/e2e/` | Playwright: `board`, `epics`, `edit`, `a11y` (keyboard, focus traps, simulated server states via `page.route`, axe), `live` (real only); `helpers.ts` |
| `Dockerfile`, `.dockerignore`, `docker/bddb` | Multi-stage image (bd download + checksum, bun build, `oven/bun:1.4-slim` runtime); `docker/bddb` is the entry-point wrapper |
| `docker-compose.example.yml` | Compose example with the commented env block |
| `scripts/` | `stand.sh` (scratch dolt + bd serve; `status`/`down` read the ports `up` recorded in `stand.env`), `dev.sh`, `gen-api.sh`, `build-web.sh`, `build-server.sh`, `build-binary.sh`, `check-pins.sh`, `release-check.sh` (tag ↔ package.json), `docker-smoke.sh`, `screenshots.ts` |
| `dist/` | Build output (git-ignored): `web/`, `server/`, `bddb-<os>-<arch>` |
| `docs/` | `README.md` (index), topology, configuration, bff-api, api-client, ui, host-setup, deployment, compatibility, `screenshots/` (README PNGs) |
| `.github/workflows/` | `ci.yml` (lint, typecheck, unit, build, pins, contract matrix, hadolint + image build), `docker.yml` (GHCR amd64+arm64, pushes only from a `vX.Y.Z` tag), `release.yml` (on a `vX.Y.Z` tag: verify, binaries, GitHub release) |

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, ...). Releases only on a
  pushed tag `vX.Y.Z` by the owner ("Build and release"); never on a push to `main`.
- Formatting and linting: biome, 2-space indent, line width 100. Do not add ESLint/Prettier.
- Types are generated from `spec/openapi.v0.yaml` (`openapi-typescript`) and committed.
- `revision` is an opaque **string**: compare for equality only, never parse it as a number.
- `Issue.metadata` is `unknown` (arbitrary JSON object), not a string map.
- Unknown `status`, `issue_type` or Problem `code` must fall into a default branch; branch
  on `capabilities` and `bd_version`, never on `schema_version`.
- Never send `bd serve` a parameter that is not in the spec; every write carries `actor`.
- Never call `issues:delete`, `issues:sweep`, `PUT/DELETE config/{key}` or `memories`.
- Problem documents (RFC 9457) from `bd serve` are passed to the UI as-is; do not invent a
  second error vocabulary.
- If the plan or docs contradict observed `bd` behavior, `bd` is right: verify with a command
  and fix the document.
- Do not commit `tmp/`. Do not commit secrets. Keep `bun.lock` in sync (`bun install`).
- UI rules (details in `docs/ui.md`): every string through `t()` in both `en.json` and
  `ru.json`; every icon-only button has `aria-label`; every new mouse interaction has a
  keyboard path (cards: Enter / Space / arrows; dialogs: `trapFocus`, Escape, focus back to the
  opener); every new colour pairing gets a row in `tests/unit/web/contrast.test.ts`; an empty
  or error state names the cause and offers the one action that changes it (`EmptyState`).
- A new `BDDB_*` variable goes into `config.ts`, `docs/configuration.md` and the README table
  together (`tests/unit/server/config-docs.test.ts` fails otherwise). Startup problems the
  operator can fix throw `ConfigError` / `DiscoveryError` / `StartupError` with hints and exit 2;
  never start with every database `down`.

## Build and release

- **SPA**: `scripts/build-web.sh` → `bun build src/web/index.html --outdir dist/web --production
  --public-path ./`. Relative asset URLs on purpose: `src/server/static.ts` serves any pre-built
  or embedded SPA in *files mode* — rewrites asset URLs to `./<file>` and injects
  `<base href="<BDDB_BASE_PATH>/">` (`/` at the root), so one build works under every prefix.
  Bun HTML routes (root-absolute asset URLs, HMR) are used only when running from source at the
  root. The SPA must never use document-relative URLs (`href="#x"`), they break under `<base>`.
- **Server**: `scripts/build-server.sh` → `bun build --target=bun --production src/server/cli.ts
  --outdir dist/server`. Self-contained (`package.json` is inlined, so `BDDB_VERSION` survives; no
  `node_modules`/`src` at runtime). The `index.html` import becomes a manifest (`HTMLBundle.files`)
  of files next to `cli.js`; static.ts resolves them relative to `import.meta.url`, **not** via
  `Bun.serve` routes — those resolve manifest paths against the cwd and fail from another
  directory.
- **Binary**: `scripts/build-binary.sh [--target …]` → `bun build --compile --production
  --target=bun-<os>-<arch> src/server/cli.ts --outfile dist/bddb-<os>-<arch>`. The HTML import
  compiles into `/$bunfs/root/*` files listed in `HTMLBundle.files` (absolute paths, readable with
  `Bun.file`), served the same way. Cross-compiling downloads the target bun once. Needs `bd` and
  `git` in `PATH` at runtime.
- **Image**: `Dockerfile` — stage `bd` downloads `beads_${BEADS_VERSION}_linux_${TARGETARCH}.tar.gz`
  and verifies it with `checksums.txt`; stage `build` runs `scripts/build-server.sh`; runtime
  `oven/bun:1.4-slim` + git + bd + `/app/server`, uid 1000, `ENTRYPOINT ["bddb"]` (`docker/bddb`
  wrapper) `CMD ["serve"]`. Base images are digest-pinned (Renovate updates them). Labels
  `org.beads.version`, `org.opencontainers.image.{source,version,licenses}`. `HEALTHCHECK` on
  `/healthz` via `bun -e`. No `BDDB_WEB_DIR` needed: the bundle carries the SPA.
- **Pins**: the beads version lives in `mise.toml` (source of truth), `Dockerfile` ARG,
  `src/server/version.ts` `BUILT_FOR_BEADS` and the `ci.yml` matrix; `scripts/check-pins.sh`
  enforces agreement (`--print` outputs the mise pin for scripts/CI). Renovate bumps all but
  version.ts (`docs/compatibility.md` has the bump procedure).
- **CI**: `ci.yml` — `check` (lint, typecheck, gen:api:check, unit, build, pins, actionlint),
  `contract` (matrix over beads versions against a real `bd serve`), `docker` (hadolint, pins,
  image build for the runner arch, label check). `docker.yml` — buildx amd64+arm64 →
  `ghcr.io/umum-ai/bddb`; pushes only on a `vX.Y.Z` tag (tags `X.Y.Z`, `X.Y`, `X` — `0` for 0.x,
  `latest` unless the version has a `-pre` suffix, `sha-<7>`); pushes to `main` and PRs build both
  platforms without publishing. `release.yml` — on a `vX.Y.Z` tag: `verify` (tag == package.json
  via `scripts/release-check.sh`, pins, lint, typecheck, unit), a matrix builds the four binaries
  (`actions/upload-artifact`), `release` creates the GitHub release "bddb X.Y.Z" (`--generate-notes`,
  `--prerelease` for 0.x / `-pre`) with the `.tar.gz`, `.sha256` and `SHA256SUMS`; on an existing
  release it re-uploads with `--clobber` (workflow_dispatch input `tag`).
- **Release procedure** (owner): set `"version"` in `package.json`, commit `chore(release): X.Y.Z`,
  push `main`; `mise run release:check -- vX.Y.Z`; `git tag -a vX.Y.Z -m "bddb X.Y.Z" && git push
  origin vX.Y.Z`. The pushed tag fires both workflows; nothing is released from `main` itself.
- **Smoke**: `scripts/docker-smoke.sh` builds the image and runs it with `--network host`
  against `scripts/stand.sh` (dolt bound via `STAND_DOLT_BIND`, `root@%` created when not
  loopback); checks readyz, meta, snapshot, redirect, asset loading, label, doctor exit codes,
  healthcheck probe. From a Linux VM under OrbStack/Docker Desktop: `SMOKE_DOLT_HOST=<VM IP>
  SMOKE_HOST=host.docker.internal`.

## Compatibility

Supported beads: `1.3.0-rc.2` and newer. The CI contract job is a matrix over
`beads-version`; adding a version is one line. The `bd` inside the image must match the
host's `bd` minor version (shared Dolt schema). Matrix and bump procedure:
`docs/compatibility.md`.
