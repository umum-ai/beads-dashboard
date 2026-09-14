# Contributing

Thanks for your interest in bddb. The project is in early development and maintained mostly by
agents (their operating manual is [AGENTS.md](AGENTS.md)); small, focused pull requests are the
easiest to review.

## Setup

```sh
mise install          # bun, biome, bd, dolt, actionlint, hadolint (mise.toml)
bun install           # dependencies; bun.lock is committed
bunx playwright install chromium   # once, for the e2e suite (add --with-deps on a bare box)
```

## Running things locally

| What | How |
|---|---|
| SPA on the mock BFF (fast UI work, deterministic fixture) | `mise run dev:mock` → <http://127.0.0.1:7331> |
| real server against a scratch stand | `mise run dev` (starts `scripts/stand.sh` if needed: dolt on 3399, database `kb`, `bd serve` 47313; then `bun --hot src/server/main.ts`) |
| a stand by hand | `scripts/stand.sh up && scripts/stand.sh seed`, then `scripts/stand.sh status`, `create-issue "…"`, `show-issue ID`, `down [--purge]`. Several stands: `STAND_DIR=.stand-x scripts/stand.sh up --dolt-port 3799 --bd-port 47713` |
| doctor against the stand | `mise run doctor` |

The stand scrubs every `BEADS_*` / `BD_*` variable, so a shell bound to a real beads store
never leaks into it. Never point the stand or the tests at a Dolt you care about.

## Tests

| Command | Runs | Needs |
|---|---|---|
| `mise run test` | unit tests (`tests/unit`: pure web logic, server modules, i18n key parity, docs ↔ config parity, WCAG contrast of the tokens) | nothing |
| `mise run contract` | `tests/contract`: the api-client against a real `bd serve`, the BFF as a child process (`bff.test.ts`), and its behaviour when `bd serve` / the db-proxy die (`bff-resilience.test.ts`) — each file brings up its own scratch stand on free ports | `bd`, `dolt`, `git` |
| `mise run e2e` | Playwright against the mock (`tests/e2e`, ~60 tests, ~15 s): board, hierarchy, every write, keyboard / a11y / states, axe scans | Chromium |
| `E2E_TARGET=real BDDB_URL=http://127.0.0.1:7331 E2E_DB=kb mise run e2e` | the same suite against a running bddb + stand (plus the `live` project: an issue created through the CLI shows up without reload) | a stand and a server (`mise run dev`) |
| `mise run build` | SPA + server bundle (`dist/`) | nothing |
| `mise run check:pins`, `actionlint`, `hadolint Dockerfile`, `shellcheck scripts/*.sh` | pins agree, workflows, image, shell scripts | the tools from mise |

Adding a UI string: add the key to `src/web/i18n/en.json` **and** `ru.json` (the unit test
checks parity and placeholders). Adding a `BDDB_*` variable: `src/server/config.ts`,
`docs/configuration.md` and the README table (the unit test checks all three agree). Adding a
colour pairing: a row in `tests/unit/web/contrast.test.ts`.

## Before opening a pull request

```sh
mise run lint && mise run typecheck && mise run test && mise run build
mise run e2e                 # when src/web changed
mise run contract            # when src/server or src/api-client changed
```

- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
  `chore:`, `ci:`, `refactor:`, `test:`). GitHub's generated release notes list the merged PRs;
  the version is bumped by hand in the release commit (see "Releasing").
- Formatting and linting are biome (`mise run lint:fix`); no ESLint or Prettier.
- `spec/openapi.v0.yaml` is a pinned copy of the `bd serve` spec and `src/api-client/generated`
  is generated from it (`mise run gen:api`); never hand-edit either. If the plan or a document
  contradicts what `bd` does, `bd` is right: verify with a command and fix the document.
- Keep the docs in step with the code in the same PR: `docs/bff-api.md` when the server ↔ SPA
  contract changes, `docs/configuration.md` for variables, `docs/ui.md` for shortcuts / states.
- Do not add `bd serve` calls outside the spec, never call `issues:delete`, `issues:sweep`,
  config writes or `memories`, and never talk to Dolt directly for issue data.

PR checklist:

- [ ] lint, typecheck, unit tests and build pass locally; e2e / contract where relevant
- [ ] new behaviour has a test (unit for pure logic, e2e for UI, contract for the BFF)
- [ ] docs updated (see above); README table and `docs/configuration.md` for a new variable
- [ ] strings in both languages; icon-only buttons have `aria-label`; keyboard path exists for
      any new mouse-only interaction
- [ ] conventional commit messages; no `tmp/`, secrets or stand directories in the diff

## Releasing

Releases happen only on a pushed git tag — never on a push to `main`. Only the owner tags.

```sh
# 1. bump the version and land it on main (through a PR, or directly by the owner)
sed -i 's/"version": ".*"/"version": "0.1.0"/' package.json
git commit -am "chore(release): 0.1.0" && git push
# 2. tag that commit; the tag must equal package.json (scripts/release-check.sh checks it)
mise run release:check -- v0.1.0
git tag -a v0.1.0 -m "bddb 0.1.0" && git push origin v0.1.0
```

The tag `vX.Y.Z` triggers two workflows:

- `release.yml` — `verify` (tag == `package.json`, pins, lint, typecheck, unit tests), then the
  four binaries (`bddb-<version>-{linux,darwin}-{x64,arm64}.tar.gz` + `.sha256`), then a GitHub
  release "bddb X.Y.Z" with generated notes, the archives and `SHA256SUMS`. `0.x` and `-rc`
  versions are marked pre-release. Re-running (workflow_dispatch with the tag) replaces the assets.
- `docker.yml` — the image `ghcr.io/umum-ai/bddb` for amd64 + arm64 with tags `X.Y.Z`, `X.Y`, `X`
  (so `0.1.0`, `0.1`, `0`), `latest` (not for a `-rc`), `sha-<short>`.

Pushes to `main` and pull requests build the image but publish nothing.

## Reporting issues

Open a GitHub issue with the beads version (`bd version`), the dashboard version
(`bddb version`), the output of `bddb doctor`, and the steps to reproduce. For security issues
see [SECURITY.md](SECURITY.md).
