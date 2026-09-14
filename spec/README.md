# spec/

`openapi.v0.yaml` is the pinned `bd serve` OpenAPI document for the beads version bddb
supports. It is the source of truth for the wire contract; never hand-edit it.

| Field | Value |
|---|---|
| beads version | `1.3.0-rc.2` |
| upstream path | `internal/httpapi/spec/openapi.v0.yaml` in <https://github.com/gastownhall/beads> |
| upstream ref | tag `v1.3.0-rc.2` |
| `info.version` (document revision) | `0.1.0` |
| wire version | `/v0` (`ContextResponse.api_version`) |

Types are generated from it into `src/api-client/generated/openapi.d.ts` with
`openapi-typescript` (`mise run gen:api`; `mise run gen:api:check` fails when the committed
file is stale). To move to a newer beads: replace this file with the upstream copy at the new
tag, update the table above and `mise.toml`, regenerate, and run `mise run contract`.
