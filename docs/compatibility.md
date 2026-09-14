# Compatibility

bddb talks to `bd serve` (beads ≥ 1.3.0) and ships one `bd` inside its image. The `bd` in the
image, the `bd` your agents use and the bddb release must agree on the beads **minor** version:
`bd serve` and the CLI share the schema of your Dolt databases, and bddb's `spec/openapi.v0.yaml`
is a pinned copy of that release's API. Patch releases are fine. A **newer** minor produces a
warning in the log and a banner in the UI (`versionWarning` in `/api/meta`; the banner explains
the schema risk, links here and can be dismissed for the tab). An **older** minor (no `bd serve`
before 1.3.0) or a different major makes `bddb serve` refuse to start with exit code 2
(`docs/configuration.md`, "Startup failures").

## Matrix

| bddb | beads inside the image (`org.beads.version`) | tested against (`bd serve`) | dolt (stand / CI only) | bun |
|---|---|---|---|---|
| main (unreleased) | 1.3.0-rc.2 | 1.3.0-rc.2 | 2.3.x | 1.4.x |

"Tested against" is the CI contract matrix (`beads-version` in `.github/workflows/ci.yml`): the
contract tests and the BFF tests run against a real `bd serve` of each listed release. The image
carries the newest listed release. Newer beads releases that are not listed may work (bddb branches
on `capabilities` and `bd_version`, never on `schema_version`) but were not exercised.

A running bddb reports both sides:

```sh
bddb version                       # bddb 0.1.0 (built for beads 1.3.0-rc.2)
bddb doctor                        # "bd binary … bd version 1.3.0-rc.2", "bd serve … bd_version"
curl -s localhost:7331/api/meta | jq '.bddb, .databases[].bdVersion, .databases[].versionWarning'
docker inspect ghcr.io/umum-ai/bddb --format '{{index .Config.Labels "org.beads.version"}}'
```

## Where the beads version is pinned

The version appears in four places; `scripts/check-pins.sh` (run by CI in both the `check` and the
`docker` job, and by `mise run check:pins`) fails when they disagree:

| File | Pin | Used for |
|---|---|---|
| `mise.toml` | `"github:gastownhall/beads" = "X"` | the `bd` developers and CI install; source of truth (`scripts/check-pins.sh --print`) |
| `Dockerfile` | `ARG BEADS_VERSION=X` | the `bd` downloaded into the image (default; CI passes the mise pin explicitly) and the `org.beads.version` label |
| `src/server/version.ts` | `BUILT_FOR_BEADS = "X"` | `bddb version`, `/api/meta.bddb.builtForBeads`, the minor-mismatch warning |
| `.github/workflows/ci.yml` | `beads-version: ["X", …]` | contract matrix; must contain the mise pin, may list more |

`spec/openapi.v0.yaml` is the fifth, implicit pin: it is the spec of the release in `mise.toml`
(`mise run gen:api:check` fails when the generated types drift from it).

## How a bump happens

1. **Renovate** watches `gastownhall/beads` releases (`renovate.json`, datasource
   `github-releases`, pre-releases included because beads ships `rc`s). One grouped PR "beads"
   updates `mise.toml`, the `Dockerfile` ARG and the CI matrix entry.
2. That PR fails `scripts/check-pins.sh` until `BUILT_FOR_BEADS` in `src/server/version.ts` is
   bumped by hand in the same PR — deliberate: a new beads release also needs a look at the spec.
3. In the PR: `mise install` (new `bd`), fetch the release's OpenAPI document into
   `spec/openapi.v0.yaml`, `mise run gen:api`, fix whatever the type check finds, run
   `mise run contract` and `mise run e2e` against the new `bd serve` (`scripts/stand.sh` uses
   the `bd` from mise), and add a row to the matrix above.
4. To keep testing an older release as well, leave it in `beads-version: [...]` — the matrix is
   a list so that supporting two releases is one line. The image always carries the mise pin.
5. Merge, then release by tag: bump `version` in `package.json` (`chore(release): X.Y.Z`), push,
   `git tag -a vX.Y.Z -m "bddb X.Y.Z" && git push origin vX.Y.Z`. The tag builds the image for both
   architectures (`X.Y.Z`, `X.Y`, `X`, `latest`) and the GitHub release with the binaries
   (`docs/deployment.md`, `CONTRIBUTING.md` "Releasing").

Renovate also tracks `bun` (mise pin + `oven/bun` base images, grouped), `dolt` (`aqua:dolthub/dolt`
in mise.toml; only the stand and the CI contract job use it), the base-image digests, npm
dependencies and GitHub Actions. Everything but beads releases and vulnerability alerts runs on
a weekly schedule (Monday, before 6 am). Only one group automerges (`platformAutomerge`, so
GitHub merges it when the required checks pass): minor/patch bumps of the tooling
devDependencies (typescript, `@types/bun`, openapi-typescript) — they are fully exercised by
the CI `check` job. Playwright and axe are never automerged because CI does not run the e2e
suite; runtime dependencies are grouped for a review by hand. Automerge needs branch
protection on `main` with the `check`, `contract` and `docker` jobs required.

## Runtime requirements

| | image | single binary | from source |
|---|---|---|---|
| `bd` | inside (`/usr/local/bin/bd`) | in `PATH` or `BDDB_BD_PATH`; same minor as the host | same |
| `git` | inside | in `PATH` (bd resolves its repo root through git) | same |
| bun | inside (`oven/bun:1.4-slim`) | embedded | 1.4.x via mise |
| dolt | **not** included — your `dolt sql-server` reachable over TCP, `dolt_mode: server` / shared-server workspaces only | same | same |
| OS / arch | linux/amd64, linux/arm64 | linux x64/arm64, macOS x64/arm64 | wherever bun and bd run |
