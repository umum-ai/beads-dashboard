# api-client — the `bd serve` HTTP client

`src/api-client/` is the only code in bddb that talks to `bd serve`. It is a thin, typed layer
over `fetch` for the `/v0/beads` API of beads `1.3.0-rc.2` (spec pinned in
`spec/openapi.v0.yaml`). Everything else — supervision, snapshots, fan-out — lives in the BFF.

## Usage

```ts
import { BdClient, Capabilities, checkVersion, isProblemCode, ProblemError } from "../api-client/index.ts";

const bd = new BdClient({
  baseUrl: "http://127.0.0.1:47313", // server root; the client appends /v0/beads
  actor: "dashboard",                // default `actor` for writes (`author` for comments)
  projectId: ctx.project_id,         // optional; sent as Bd-Project-Id
  timeoutMs: 30_000,                 // per request; not applied to watchEvents
});

const ctx = await bd.context();
const caps = Capabilities.fromContext(ctx);
caps.require("events.watch");                       // throws CapabilityError when absent
const skew = checkVersion(ctx.bd_version, "1.3.0-rc.2"); // { ok, level: same|patch|minor|major }

const page = await bd.listIssues({ status: ["open", "in_progress"], limit: 0, brief: true });
const details = await bd.getIssue(page.items[0].id, { include_comments: true });

try {
  await bd.patchIssue(details.id, {
    expected_version: details.revision,
    patch: { status: "in_progress" },
  });
} catch (err) {
  if (isProblemCode(err, "precondition_failed")) {
    /* someone else wrote first: re-read, show a conflict dialog */
  } else if (err instanceof ProblemError && err.class === "unavailable") {
    /* 503: retry after err.retryAfterMs */
  } else throw err;
}

for await (const ev of bd.watchEvents({ since: head, signal })) {
  if (ev.type === "record") apply(ev.record); // ev.seq is the checkpoint
  else if (ev.type === "truncated") await rebaseline(); // then reconnect from `floor - 1`
}
```

### Methods

Handshake: `healthz()`, `context()`.
Reads: `ready(params)`, `readyCount(params)`, `listIssues(params)`, `getIssue(id, params)`,
`queryIssues(q, params)`, `dependencyTree(params)`, `related(id, params)`,
`dependencies(params)`, `dependenciesCount(params)`, `dependenciesBlocking(params)`,
`dependencyCycles()`, `stats(params)`, `config()`, `configKey(key)`, `events(since, limit)`,
`watchEvents({ since, lastEventId?, signal? })`.
Writes: `createIssue(body)`, `patchIssue(id, body)`, `closeIssue(id, body)`,
`reopenIssue(id, body)`, `claimIssue(id, body)`, `releaseIssue(id, body)`,
`addComment(id, body)`, `depAdd(body)`, `depRemove(body)`, `batchApply(body)`,
`batchCreate(body)`, `batchClose(body)`.
Every method takes a trailing `{ signal }`; `with(overrides)` derives a client with other
defaults (e.g. the browser user's `actor`).

Deliberately absent: `issues:delete`, `issues:sweep`, `PUT/DELETE config/{key}`, `memories`,
`issues:casMetadata`, `issues:claimNext`, `issues:count`.

## Rules

- **`revision` is an opaque string.** Compare for equality, pass it back verbatim as
  `expected_version`. Never `Number()` it: it spans the full int64 range.
- **Only `code` is for dispatch.** A non-2xx response throws `ProblemError` with the RFC 9457
  document in `.problem`, plus `.status`, `.code`, `.class` (status class) and `.retryAfterMs`.
  Branch on `code` (`isProblemCode`), fall back to `.class` for unknown codes (`invalid`,
  `unauthenticated`, `not_found`, `conflict`, `gone`, `client`, `unavailable`, `server`).
  Extension members (`param`, `reason`, `open_children`, `expected_version`,
  `server_project_id`, ...) are passed through untouched — the BFF forwards the document to
  the UI as-is.
- **Non-problem responses are synthesized.** When a non-2xx body is not a problem document
  (proxy HTML, empty 504), the client builds one: `code` is `"internal"` for 5xx and
  `"non_problem_response"` otherwise, with `synthesized: true`, a `body` snippet and an
  empty `request_id`.
- **Capability gating.** Branch on `context.capabilities` for operation presence and on
  `bd_version` (`checkVersion`) for behavioural changes; never on `schema_version`.
  `events.list`/`events.watch` are build-level: the workspace may still answer
  `409 events_journal_disabled`.
- **Unknown values fall through.** `status`, `issue_type`, `dependency_type`, event `op`,
  Problem `code`/`reason` are open vocabularies typed as `"known" | ... | (string & {})`;
  every `switch` needs a default branch.
- **`metadata` is an arbitrary JSON object** (`{ [key: string]: unknown }`), not a string map.
  `Dependency.metadata` and `EventRecord.dep.metadata`, by contrast, are JSON *text*.
- **Never send a parameter that is not in the spec.** Query params are typed from the
  generated `operations[...]["parameters"]["query"]` and additionally checked at runtime
  against a per-operation table: a stray key throws `TypeError` synchronously instead of
  reaching the server (`400 unknown_parameter`) or, on a newer server, silently filtering.
  Programmer errors (missing `actor`, unknown param) are thrown synchronously; server
  refusals are rejected promises.
- **Writes carry `actor`.** From the body, else the client default; missing → `TypeError`.

## Spec facts the BFF must know (verified on bd 1.3.0-rc.2, `tests/contract/`)

- `GET issues` → `{ items, has_more, next_cursor? }` (not `issues`). Rows are `IssueWithCounts`
  with `parent`, `*_count`, **no `revision`**. `revision` comes only from `GET issues/{id}`.
- Array query params (`status`, `label`, `label_any`, `exclude_label`, `type` on related/
  dependencies, `issue_id`) are `style: form, explode: true` → the client repeats the key
  (`status=open&status=closed`). `status` on `GET issues` also accepts CSV, but `status` on
  `issues:count` and `dependencies:count` is ONE value. `ready` has no `status` at all.
- `dependencies/tree`: `direction=down` follows what the root **depends on**; a parent-child
  edge points child → parent, so `down` from an epic returns only the epic. Children are
  reached with `direction=up` (dependents) or `both` (up nodes first, then the down tree).
  `has_more` is always `false`; `max_depth` counts the root as level 1.
- `GET issues/{id}` `dependencies[]` items are full issues + `dependency_type`; the epic's
  children appear as `related?direction=in` with `dependency_type: "parent-child"`.
- Closing an epic with an open child → `409 not_closable` + `open_children`; repeat close →
  `200 already_closed: true`; repeat reopen → `200 already_open: true`.
- `PATCH` with `patch: {}` → `400 invalid_argument`. Stale `expected_version` →
  `409 precondition_failed` with `param: "expected_version"`; nothing is written.
- A wrong `Bd-Project-Id` → `400 invalid_argument`, `reason: "project_mismatch"`,
  `server_project_id: <the server's>`. `healthz` and `context` are exempt.
- `GET events?since=N` → `{ records, head }`; caught up when `records` is empty or the last
  `seq === head`. `since` is required (0 = from the start).
- `events:watch` frames: `retry: 3000`, then `id: <seq>` + one-line JSON `data:`,
  `: heartbeat` every ~20 s, `event: truncated` + Problem then close. `Last-Event-ID`
  overrides `since` (verified). `watchEvents` does **not** reconnect; the iterable ends when
  the stream does (or the signal aborts) — the BFF reconnects with its own checkpoint and
  keeps ONE stream per database (`503 events_watch_saturated`).
- `EventRecord.issue` is the full post-mutation state (`null` on delete); `dep` only on
  `dep_add`/`dep_remove`; `comment` only on `comment`. `actor` may be absent.
- `config/status.custom` answers `{ key, redacted }` **without `value`** when unset.
- Request bodies: members with a spec `default` (`ephemeral`, `no_history`, `force`,
  `inherit_labels_from_parent`, ...) are optional in the client's body types; the server
  applies the default.

## Regenerating types

```sh
mise run gen:api        # spec/openapi.v0.yaml → src/api-client/generated/openapi.d.ts (+ biome format)
mise run gen:api:check  # CI: fails when the committed file is stale
```

`spec/README.md` records the upstream tag. Hand-written code imports the generated
`components`/`operations` only through `src/api-client/types.ts`.

## Tests

- `mise run test` — unit tests with a fake `fetch`: SSE parser (recorded stream, chunk
  splitting, CRLF, heartbeat, `truncated`), Problem parsing, query serialisation,
  capabilities and version checks.
- `mise run contract` — `tests/contract/` against a real `bd serve` started by
  `scripts/stand.sh` in a fresh `.stand/contract/<run>` directory on free ports (~6 s).
  `KEEP_STAND=1` leaves the stand running; `STAND_DIR`/`STAND_DOLT_PORT`/`STAND_BD_PORT`
  pin a location. The stand never touches any dolt/bd it did not start.
