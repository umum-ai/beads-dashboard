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
  for database discovery (`SHOW DATABASES`).

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
mise run dev            # bun --hot src/server/main.ts
mise run docker:build   # docker build -t bddb .
```

Acceptance for any change: `mise run lint && mise run typecheck && mise run test` pass.
Workflow files must pass `actionlint`, Dockerfiles `hadolint`.

## Layout

| Path | Contents |
|---|---|
| `src/server/` | BFF: `main.ts` (server), `cli.ts` (`bddb serve` / `bddb doctor`), supervisor for `bd serve`, discovery, snapshot, SSE fan-out, polling |
| `src/web/` | Preact SPA (`index.html`, `main.tsx`) |
| `src/api-client/` | Types generated from the spec, HTTP client, Problem handling, capability gating |
| `spec/openapi.v0.yaml` | Pinned copy of the `bd serve` OpenAPI spec for the supported beads version. Source of truth for the contract; never hand-edit |
| `tests/unit/` | `bun test` unit tests |
| `tests/contract/` | Tests against a real `bd serve` + `dolt sql-server` |
| `docker/` | Dockerfile and compose example (stage 6) |
| `docs/` | topology, configuration, compatibility, host-setup |
| `.github/workflows/` | `ci.yml`, later `docker.yml`, `release.yml` |

## Conventions

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, ...). Releases via
  release-please.
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

## Compatibility

Supported beads: `1.3.0-rc.2` and newer. The CI contract job is a matrix over
`beads-version`; adding a version is one line. The `bd` inside the image must match the
host's `bd` minor version (shared Dolt schema).
