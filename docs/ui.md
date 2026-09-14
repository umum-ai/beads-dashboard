# UI (`src/web`)

The dashboard is a Preact SPA served by the `bddb` process. It talks only to the BFF API
described in `docs/bff-api.md`; it never sees `bd serve`. This page covers the code layout,
the state model, i18n and theming rules, and how to run the mock and the e2e suite.

## Layout

| Path | Contents |
|---|---|
| `index.html`, `main.tsx` | Bun HTML entry; mounts `<App />` into `#app`. |
| `app.tsx` | Shell: loads `/api/meta`, switches views by route, keeps one live stream per displayed database, renders header, banner, drawer and toasts. |
| `components/` | `Header` (project switcher, tabs, live indicator, actor, language, theme), `Toolbar` (quick filters, `extra` slot), `Column` (flat and swimlane cell modes), `Card`, `Swimlane` (`SwimlaneBoard`, `LaneHeader`, `GroupToggle`, `ProgressBar`), `Breadcrumbs`, `TreeView` (`HierarchySection`, `DependencyTree`), `DetailPanel`, `EmptyState`, `Toasts`, `VersionBanner`, `Popover`, `LiveIndicator`. |
| `views/` | `BoardView` (columns per status, swimlanes per epic, drill-down), `EpicsView` (epic list with progress and expandable children). |
| `lib/` | Pure, unit-tested logic: `basePath` (mount discovery), `router` (path ⇄ route), `filters` (query string ⇄ filters, matching), `board` (columns, priority sections, card order), `hierarchy` (parent/children index, ancestors, descendants, top epic, lane grouping, progress), `delta` (snapshot state and delta application), `api` (fetch wrapper, `ApiError`), `live` (EventSource), `i18n-core`, `markdown` (marked + DOMPurify), `time`, `storage`, `clipboard`, `issue-meta` (type glyphs), `bff-types` (wire types of the BFF, reusing `src/api-client/types.ts`). |
| `state/` | Signals: `meta`, `route` (+ filters), `snapshot` (board state, connection, extra closed rows, derived child counters), `prefs` (theme, actor, column widths, collapsed sections and lanes, group-by-epic, dismissed banner), `toasts`. |
| `i18n/` | `en.json` (reference), `ru.json` (same keys), `index.ts` (`t`, `tOr`, language signal). |
| `styles/` | `tokens.css` (design tokens, light and dark), `app.css` (all component styles). |
| `dev/` | `mock-bff.ts` and `fixture.ts`: a `Bun.serve` implementation of the BFF API over an in-memory fixture, used for development and e2e. Not part of the product build. |

## Routing and base path

Routes: `/p/<db>/board`, `/p/<db>/epics`, `/p/<db>/issue/<id>` (board with the detail drawer
open). `/` redirects (client-side) to the default database's board. Quick filters live in the
query string (`?q=…&type=a,b&label=…&assignee=…&priority=0,1`) and survive reloads;
project switches keep the view but drop the filters. `?epic=<id>` on the board is the
drill-down target (see Hierarchy); it travels with the filters but is not one of them: "Clear
filters" keeps it, the breadcrumbs drop it.

Base path discovery (`lib/basePath.ts`), in this order:

1. `<base href>` in the document (absolute hrefs are accepted on the same origin only);
2. `window.__BDDB__.basePath`;
3. `""` (root mount).

The result never has a trailing slash. Every app URL and API call goes through `withBase()`.
Asset URLs in `index.html` are relative so Bun's bundler output works under a prefix.

## State model

- `meta`: `GET /api/meta` result. `databases` is updated in place from `status` SSE frames.
- `route`, `filters`, `currentDb`: parsed from `location` on start and on `popstate`;
  `navigate()` pushes, `setFilters()` replaces.
- `board` (`lib/delta.ts` `BoardState`): `seq`, `issues: Map<id, BoardIssue>`, `ready: Set`,
  `statuses`, `types`, `stats`. `snapshot` frames replace it; `delta` frames apply only when
  `seq === board.seq + 1`. A larger `seq` is a gap and triggers `GET /snapshot`; a smaller or
  equal one is ignored.
- `extraClosed`: rows loaded by "Show all closed" (`GET issues?status=<done>&all=true&limit=0&brief=true`,
  paged by `next_cursor`). Merged into `allIssues` behind the snapshot rows.
- `childStats`: derived `Map<parentId, {total, closed}>` from `parent` links, used for epic
  progress on cards when the row does not carry `epic_*` counters.
- `connection`: EventSource state (`idle`/`connecting`/`open`/`disconnected`); `dbInfo`: latest
  `DatabaseInfo` for the current database (from the snapshot or a `status` frame).
- Failed `/snapshot` with `bddb_not_ready`, `db_unavailable` or `busy` shows the "starting"
  state and retries after `Retry-After` (default 3 s, capped at 30 s).
- `hierarchy`: `HierarchyIndex` (`lib/hierarchy.ts`) over `allIssues`, rebuilt when the rows
  change; every parent/children lookup of the views goes through it.
- `prefs` persist in `localStorage` under `bddb.`: `theme`, `lang`, `actor`, `columnWidths`
  (per status name), `collapsed` (per `status:priority`, or `status@<lane>:priority` inside a
  swimlane), `groupByEpic` (default `true`), `collapsedLanes` (per epic id, `""` = no-epic
  lane), `dismissedVersionWarning`. Every
  access is guarded; missing storage only means no persistence.

## Board rules

- Columns = `snapshot.statuses` in order (active → wip → frozen → done, custom statuses
  included). A row with a status the snapshot does not list gets an extra column at the end.
- Inside a column: sections P0…P4 (collapsible, empty ones hidden), cards newest first by
  `created_at`, ties by id. Section bodies carry `data-drop-status` / `data-drop-priority`
  so stage 5 can attach pragmatic-drag-and-drop targets without restructuring.
- "Blocked" badge = the BFF's `blocked` flag (open-ish status and not in `ready`).
- Done column shows the BFF's closed window (`meta.closedDays`); "Show all closed" loads the
  rest once per database visit.
- Columns are resizable by dragging the right edge (pointer events) or with the keyboard on
  the focused handle (arrows, Shift+arrows, Home). Widths are clamped to 200–640 px.
- Around 1000 cards render in well under a second; columns use `contain: layout style`,
  sections `content-visibility: auto`, cards `contain: content`.

## Detail drawer

Opened by clicking a card (URL `/p/<db>/issue/<id>`), closed by Escape, the backdrop or the
close button (URL returns to the board). Loads
`GET /api/p/<db>/issues/<id>?include_comments=true&include_dependents=true` and re-reads
silently when a delta changes the row's `updated_at`, `status` or `comment_count`. Markdown
fields (`description`, `design`, `acceptance_criteria`, `notes`, comment text) go through
`marked` (GFM) and `DOMPurify`. The Hierarchy section (parent chain, children from the snapshot,
dependency tree) is described under Hierarchy; the "Depends on" / "Blocks" lists come from the
response's `dependencies` / `dependents` without the `parent-child` edges. Read-only until stage 5.

## Hierarchy (stage 4)

Model (`lib/hierarchy.ts`, pure and unit-tested): the snapshot's `parent` links form the tree.
`ancestorsOf` walks up (root first) and stops at a parent missing from the snapshot or at a
repeated id; `descendantsOf` walks down once per node; `topEpicOf(issue)` is the topmost
ancestor with `issue_type === "epic"` — the issue itself when it is an epic — or `null` when
no epic is on the path (a task under a milestone is "no epic"). Epic progress (`progressOf`)
uses the BFF's `child_count` / `child_closed_count` (direct children inside the snapshot, see
`docs/bff-api.md`), falls back to `epic_*` counters if a row carries them, and last to counting
the snapshot's direct children.

Swimlanes (`components/Swimlane.tsx`, default on, toolbar toggle "Group by epic" persisted as
`prefs.groupByEpic`): one lane per top-level epic, ordered by priority then `created_at` then
id, and a final "No epic" lane. An epic's own card sits in its lane under its own status. The
lane header shows the epic's glyph, id (click copies), title (opens the drawer), blocked badge,
card count, progress bar `closed/total` from the server counters, and "Focus" (drill-down);
the caret collapses the lane (`prefs.collapsedLanes`). The lane's epic comes from the full index,
so a lane keeps its header when quick filters hide the epic row itself. Layout: the board is a
CSS grid whose columns are the status columns (shared widths, resizable as before) and whose
rows alternate lane header / lane body; every `Column` is a subgrid spanning all rows, so the DOM
stays column-major (a card's nearest `[data-testid="column"]` is still its status) while lane
headers span the full width in their own row. Column headers stick to the top of the scrolling
board, lane headers under them; the lane header's content strip sticks to the left edge while
the wide grid scrolls horizontally.

Drill-down: `/p/<db>/board?epic=<id>` shows only the descendants of `<id>` (any depth), grouped
into lanes by the epic's direct sub-epics plus a "Directly in <id>" lane; without sub-epics (or
with grouping off) the board is flat. A strip under the toolbar carries the breadcrumbs
`All issues › <epic ancestors…> › <epic>` (each crumb sets `?epic=` to that ancestor, the first
clears it), the epic's progress and a "Details" link to its drawer. Entering: the lane's
"Focus" button, "Open board" in the epics view, or the URL. Quick filters still apply inside a
drill-down; an unknown id shows a "not in the snapshot" crumb with an empty board.

Epics view (`/p/<db>/epics`, `views/EpicsView.tsx`): every epic of the snapshot (sub-epics
included) sorted by priority then `created_at`, filtered by the toolbar's quick filters and by
status chips (one per status some epic has, plus All). A row shows glyph, id, title (opens the
drawer), blocked badge, status, priority, assignee, progress bar and "Open board" (drill-down).
The caret expands the direct children as nested rows with the same columns; children with
children (sub-epics, or any parent) expand further. Expansion state is per visit.

Drawer: the "Hierarchy" section (`components/TreeView.tsx`) renders the parent chain as small
breadcrumbs (each crumb opens that ancestor), the direct children from the snapshot (status,
priority, blocked badge), then the dependency tree from
`GET /api/p/<db>/dependencies/tree?root_id=<id>&direction=both&max_depth=3`. The answer is a
flat DFS pre-order list; for `both` it is every "up" node (issues that depend on the root: its
children via `parent-child`, issues it blocks) followed by the root and its "down" subtree
(what the root depends on: its parent, its blockers). The section splits the list at the root
into "Dependents" and "Dependencies", indents by `depth` and labels each row with
`edge_from_parent` — `parent-child` edges read "child" (up) or "parent" (down) with a dashed
chip, other kinds show the type (`blocks`, `tracks`, …). A node appears once per walk at the
first path that reached it (bd's rule), so a child reachable through a blocking edge may be
labelled `blocks`. Loading, error (with retry) and empty states are explicit. The blocked badge
in the drawer header, on cards, lane headers and epic rows carries the same tooltip: open but
not in the ready set — blocked by a dependency or deferred.

## i18n rules

- Every visible string, `aria-label`, `title` and placeholder goes through `t(key, params)`.
- `en.json` is the reference; `ru.json` must have exactly the same keys with the same
  `{placeholders}` (unit-tested). Missing keys fall back to English, then to the key itself.
- Open vocabularies (statuses, types, problem codes) use `tOr(key, fallback)` so unknown values
  render as themselves (`status.<name>`, `type.<name>`, `error.<code>`).
- The initial language comes from `localStorage` (`bddb.lang`), then `navigator.languages`,
  then `en`. The toggle in the header flips en ⇄ ru and sets `<html lang>`.
- Dates use `Intl` with the language's locale (`en-US`, `ru-RU`).

## Theming

Tokens live in `styles/tokens.css` on `:root` (light) and `:root[data-theme="dark"]`. The app
always stamps `data-theme` on `<html>`: the stored preference, else `prefers-color-scheme`
(and it follows system changes until the user chooses). Token groups:

- surfaces and text: `--canvas`, `--surface`, `--surface-2/3`, `--ink`, `--ink-2/3`, `--line`,
  `--line-strong`, `--accent`, `--focus`;
- semantics: `--ok`, `--warn`, `--danger` with `*-soft` backgrounds;
- priorities `--p0`…`--p4` (exposed as `--p-color` via `[data-priority]`) and status categories
  `--cat-active/wip/frozen/done` (`--cat-color` via `[data-category]`);
- spacing `--s-1`…`--s-6` (4/8/12/16/24/32 px), radii `--r-1..3`, type scale `--fs-0..5`,
  `--font` (system UI stack), `--font-mono`.

Design intent: a dense, quiet tool. Colour is spent on two things only, the priority rail and
chip on each section/card and the category stripe on each column top; everything else is
neutral. Focus rings are always visible (`:focus-visible`), reduced motion disables
transitions, and both palettes keep body text above AA contrast.

## Running

```sh
mise run dev:mock          # SPA + mock BFF on http://127.0.0.1:7331 (HMR on)
MOCK_PORT=7400 MOCK_LIVE_MS=0 bun src/web/dev/mock-bff.ts   # other port, no live ticker
MOCK_BULK=1000 bun src/web/dev/mock-bff.ts                   # +1000 generated issues
MOCK_VERSION_WARNING="bd 1.4.0 vs 1.3.0" bun src/web/dev/mock-bff.ts   # show the banner
```

The mock serves two databases (`siam_platform`, `sandbox`), emits a `snapshot` on connect and
a `delta` every `MOCK_LIVE_MS` (default 4000) that flips `sp-d4e` between open and
in_progress, and implements the read proxies plus create / patch / close / reopen / comments
with `expected_version` guards.

e2e (Playwright, `tests/e2e`, config `playwright.config.ts`):

```sh
bunx playwright install chromium          # once (plus `--with-deps` on a bare box)
mise run e2e                              # E2E_TARGET=mock (default): starts the mock itself
```

Against the real BFF on the local stand (stage-3 acceptance; `mise run dev` brings the stand up,
seeds `kb` and serves on 7331, the default `BDDB_URL`):

```sh
mise run dev &                                              # or: scripts/stand.sh up && scripts/stand.sh seed
                                                            #     + `bun src/server/cli.ts serve` as in AGENTS.md
E2E_TARGET=real E2E_DB=kb mise run e2e                      # BDDB_URL=http://127.0.0.1:7331 by default
scripts/stand.sh down
```

Two Playwright projects: `chromium` runs `tests/e2e/board.spec.ts` (board, drawer, theme, language,
filters, resize) and `tests/e2e/epics.spec.ts` (swimlanes, group toggle, drill-down, epics view,
drawer hierarchy — the tests named `real:` pick an epic with children from the snapshot, so they
run against both targets; fixture-only assertions are skipped when `E2E_TARGET` is not `mock`), then `live` runs `tests/e2e/live.spec.ts` (real only): while the board is open it
creates an issue through `scripts/stand.sh create-issue "<title>"` and expects the card within
10 s without a reload. `E2E_CREATE_ISSUE` replaces that command for another stand (it receives the
title as its last argument and must print the new id).

## Deferred

- Stage 5: drag-and-drop (status, priority, parent) with guarded `PATCH`, close/reopen
  dialogs with reason and force, editing every field in the drawer, comments, labels,
  `blocks` edges, issue creation, `bd query` expression search, conflict dialog. The
  `actor` setting already exists for these writes.
- Stage 7: keyboard navigation between cards, full a11y pass, more empty/error states,
  documentation polish.
