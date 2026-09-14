# UI (`src/web`)

The dashboard is a Preact SPA served by the `bddb` process. It talks only to the BFF API
described in `docs/bff-api.md`; it never sees `bd serve`. This page covers the code layout,
the state model, i18n and theming rules, and how to run the mock and the e2e suite.

## Layout

| Path | Contents |
|---|---|
| `index.html`, `main.tsx` | Bun HTML entry; mounts `<App />` into `#app`. |
| `app.tsx` | Shell: loads `/api/meta`, switches views by route, keeps one live stream per displayed database, renders header, banner, drawer and toasts. |
| `components/` | `Header` (project switcher, tabs, live indicator, board settings gear, actor, language, theme), `BoardSettings` (the gear popover: visible columns and the closed period, per database), `Toolbar` (quick filters, `extra` slot), `QueryBar` (`QueryToggle`, the `bd query` strip), `Column` (flat and swimlane cell modes, drop zones, "+"), `Card` (draggable, selection, `⋯` menu), `Menu` (portal menu), `Swimlane` (`SwimlaneBoard`, `LaneHeader` as drop zone, `GroupToggle`, `ProgressBar`), `Breadcrumbs`, `TreeView` (`HierarchySection`, `DependencyTree`), `DetailPanel` + `detail/` (`editor.ts`, `Fields`, `TextSections`, `Relations`), `editors/` (`IssuePicker`, `LabelsEditor`, `MarkdownEditor`), `CreateIssueModal`, `Dialog` (`DialogHost`), `EmptyState` (title, body, `detail` block, `hints` list, primary + secondary action, spinner), `Toasts`, `VersionBanner`, `StatusBanners` (`ConnectionBanner`, `DatabaseBanner`), `ShortcutsHelp` (the `?` dialog), `Popover`, `LiveIndicator`. |
| `views/` | `BoardView` (columns per status, swimlanes per epic, drill-down), `EpicsView` (epic list with progress and expandable children). |
| `lib/` | Pure, unit-tested logic: `basePath` (mount discovery), `router` (path ⇄ route), `filters` (query string ⇄ filters, matching), `board` (columns, priority sections, card order), `columns` (board settings: default / stored visible columns, closed-window options and filter), `hierarchy` (parent/children index, ancestors, descendants, top epic, lane grouping, progress), `delta` (snapshot state and delta application), `api` (fetch wrapper, `ApiError`, read and write proxies), `mutations` (guarded PATCH, optimistic rows), `dnd-intent` (drop → writes resolver), `dnd` (pragmatic-drag-and-drop hooks), `live` (EventSource, reconnect, server probe), `keyboard` (shortcut resolver, arrow-key card navigation over columns of ids), `board-keys` (DOM glue for it), `focus-trap` (dialog focus trap + return), `contrast` (WCAG arithmetic over `tokens.css`, used by the unit test only), `i18n-core`, `markdown` (marked + DOMPurify), `time`, `storage` (local + session), `clipboard`, `issue-meta` (type glyphs), `bff-types` (wire types of the BFF, reusing `src/api-client/types.ts`). |
| `state/` | Signals: `meta` (+ `actor`), `route` (+ filters, `detailRoute` / `closeRoute` for the view-aware drawer), `snapshot` (board state, connection, derived child counters), `prefs` (theme, actor, column widths, collapsed sections and lanes, group-by-epic, dismissed banner, per-database visible columns and closed hours), `toasts`, `dialogs` (promise-based modals), `actions` (board writes: move, close, reopen, batch), `selection` (multi-select, drag, pending), `create` (new-issue modal request), `query` (query mode). |
| `i18n/` | `en.json` (reference), `ru.json` (same keys), `index.ts` (`t`, `tOr`, language signal). |
| `styles/` | `tokens.css` (design tokens, light and dark), `app.css` (all component styles). |
| `dev/` | `mock-bff.ts` and `fixture.ts`: a `Bun.serve` implementation of the BFF API over an in-memory fixture, used for development and e2e. Not part of the product build. |

## Routing and base path

Routes: `/p/<db>/board`, `/p/<db>/epics`, `/p/<db>/issue/<id>` (board with the detail drawer
open), `/p/<db>/epics/issue/<id>` (epics view with the drawer open; the Epics tab stays current).
`/` redirects (client-side) to the default database's board (`meta.defaultDatabase`, chosen by
the server). Quick filters live in the
query string (`?q=…&type=a,b&label=…&assignee=…&priority=0,1`) and survive reloads;
project switches keep the view but drop the filters. `?epic=<id>` on the board is the
drill-down target (see Hierarchy) and `?query=<expr>` the advanced-search expression (see Query
mode); both travel with the filters but are not quick filters: "Clear filters" keeps them, the
breadcrumbs drop `epic`, the query strip's Clear drops `query`.

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
  equal one is ignored. Deltas that arrive while that refetch is in flight are queued and
  replayed onto the fetched snapshot (`applyQueued`: `seq <= snapshot.seq` dropped, the rest
  chained; a gap among them refetches once more).
- `childStats`: derived `Map<parentId, {total, closed}>` from `parent` links, used for epic
  progress on cards when the row does not carry `epic_*` counters.
- `connection`: EventSource state — `idle`, `connecting`, `open`, `closed` (the server refused
  the stream because the database is starting or down; `dbInfo.state` says which) or
  `disconnected` (the dashboard server itself is unreachable; `disconnectedSince` holds the
  timestamp and `now` ticks every second meanwhile). `dbInfo`: latest `DatabaseInfo` for the
  current database (from the snapshot, a `status` frame, or `/api/meta` re-read while the stream
  is refused). See "Connection and server states".
- Failed `/snapshot` with `bddb_not_ready`, `db_unavailable` or `busy` shows the "starting"
  state and retries after `Retry-After` (default 3 s, capped at 30 s).
- `hierarchy`: `HierarchyIndex` (`lib/hierarchy.ts`) over `allIssues`, rebuilt when the rows
  change; every parent/children lookup of the views goes through it.
- `prefs` persist in `localStorage` under `bddb.`: `theme`, `lang`, `actor`, `columnWidths`
  (per status name), `collapsed` (per `status:priority`, or `status@<lane>:priority` inside a
  swimlane), `groupByEpic` (default `true`), `collapsedLanes` (per epic id, `""` = no-epic
  lane), `columns` (per database: the visible status names; absent = defaults) and
  `closedHours` (per database: the Closed column's period). `dismissedVersionWarning` lives in
  **sessionStorage** (the banner comes back on the next visit). Every access is guarded; missing
  storage only means no persistence.

## Board rules

- Columns = the statuses of `snapshot.statuses` (active → wip → frozen → done, custom statuses
  included) that the board settings mark visible, in that order. Default: `open`,
  `in_progress`, `blocked`, `closed`; every other status — `hooked`, `deferred`, `pinned`, a
  custom one, or a status new to the workspace — stays hidden until checked in the gear (⚙ in
  the header, or `,`). Hidden statuses' issues are not on the board (they stay reachable from
  the epics view, the drawer and the card menu, whose "Move to …" lists every status); drop
  targets are the visible columns. The choice persists per database (`prefs.columns`); "Reset
  to defaults" forgets it. With every column unchecked the board shows `No columns shown`
  [`board-no-columns`] with a "Choose columns" action. Query mode ignores the setting and shows
  every status the result contains.
- Inside a column: sections P0…P4 (collapsible, empty ones hidden), cards newest first by
  `created_at`, ties by id. Section bodies carry `data-drop-status` / `data-drop-priority`
  so stage 5 can attach pragmatic-drag-and-drop targets without restructuring.
- "Blocked" badge = the BFF's `blocked` flag (open-ish status and not in `ready`).
- The Closed column (any done-category status) shows only rows whose `closed_at` lies within
  the chosen period — the gear's "Show closed from the last …" select: 1–12 h hourly, then 15,
  18, 21, 24, 36, 48, 60, 72 h (labelled "12 hours", "1 day", "1.5 days" …; default 24 h, per
  database in `prefs.closedHours`). The server keeps `meta.closedHours` (`BDDB_CLOSED_HOURS`,
  default 72) in the snapshot, so longer options are disabled with the hint "The server keeps
  N h"; a stored value above it is capped. A done row without `closed_at` is never shown. The
  column header names the window ("Closed · 24 h"); the window rolls with the 15 s `now` tick.
  Closing a card optimistically stamps `closed_at` so it lands in the column before the server's
  row arrives; reopening clears it.
- Columns are resizable by dragging the right edge (pointer events) or with the keyboard on
  the focused handle (arrows, Shift+arrows, Home). Widths are clamped to 200–640 px.
- Around 1000 cards render in well under a second; columns use `contain: layout style`,
  sections `content-visibility: auto`, cards `contain: content`.

## Detail drawer

Opened by clicking a card or pressing Enter on it (URL `/p/<db>/issue/<id>`), or by clicking a
title in the epics view (URL `/p/<db>/epics/issue/<id>`, the epics list stays underneath and the
Epics tab current); closed by Escape, the backdrop or the close button (URL returns to the view it
opened in — `/board` or `/epics` — with the filters kept, and focus returns to the card or the
epic row's title). Links inside the drawer (parent crumbs, children, dependencies, the parent
↗, a freshly created issue) stay in the current view (`state/route.ts` `detailRoute`); the
"Focus" / "Open board" buttons intentionally go to the board drill-down. It is `role="dialog" aria-modal="false"` labelled by the title (`h2`; sections are `h3`,
tree parts `h4`). Loads
`GET /api/p/<db>/issues/<id>?include_comments=true&include_dependents=true` and re-reads
silently when a delta changes the row's `updated_at`, `status` or `comment_count`. Markdown
fields (`description`, `design`, `acceptance_criteria`, `notes`, comment text) go through
`marked` (GFM) and `DOMPurify`. The Hierarchy section (parent chain, children from the snapshot,
dependency tree) is described under Hierarchy; the "Depends on" / "Blocks" lists come from the
response's `dependencies` / `dependents` without the `parent-child` edges. Editing is described
under Editing.

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
board, lane headers under them — each lane header sits in a `.lane-frame` that spans the lane's
header + body rows and is the header's sticky containing block, so a header sticks only while
its lane is in view and is pushed out by the next one (Chromium does not constrain a sticky
grid item to its grid area, hence the frame; header rows have explicit heights because the
frame is their only occupant). The lane header's content strip sticks to the left edge while
the wide grid scrolls horizontally; the page itself never scrolls (`body { overflow: hidden }`),
only the board does, in both axes.

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
drawer in place, `/p/<db>/epics/issue/<id>`), blocked badge, status, priority, assignee,
progress bar and "Open board" (drill-down on the board).
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

## Keyboard and accessibility (stage 7)

Shortcuts (`lib/keyboard.ts` decides, `app.tsx` and `Card.tsx` apply; the `?` dialog lists them):

| Where | Key | Action |
|---|---|---|
| anywhere (no text field focused, no modifier) | `/` | focus the quick filter (`#quick-filter`) |
| | `n` | New issue (pre-fills the drilled epic as parent); not in the drawer |
| | `?` | open / close the shortcuts help |
| | `,` | open / close the board settings (focus lands on the first column checkbox; `Esc` closes and returns focus to the gear) |
| | `Esc` | close a dialog, menu or the drawer; clear the multi-selection |
| on a card (`tabindex=0`) | `Tab` / `Shift+Tab` | previous / next card — the id button, menu button and title link inside are `tabindex=-1`, so a board of hundreds of cards stays tabbable |
| | `↑` `↓` | previous / next card in the column (clamped) |
| | `←` `→` | same row in the nearest non-empty column to the left / right |
| | `Home` `End` | first / last card of the column |
| | `Enter` | open the drawer |
| | `Space`, `ContextMenu`, `Shift+F10`, right click | the card menu (move to status, set priority); `↑`/`↓` inside, `Esc` closes and focus returns to the card |
| | `Shift+Space` | toggle the card in the multi-selection |
| dialogs and editors | `Ctrl+Enter` | save (markdown editors, close-reason dialog) |
| | `Esc` | cancel an inline edit; close the dialog |
| column resize handle | `←` `→` (`Shift` = 64 px), `Home` | resize / reset (unchanged from stage 3) |

Rules the components follow:

- Popovers (`Popover`: board settings, actor, type filter) are non-modal `role="dialog"`
  panels with `aria-label`; opening moves focus to `[data-autofocus]` or the first control,
  Escape and an outside click close them, and focus returns to the trigger unless the user
  already focused something else.
- Every modal (`Dialog` frames, `CreateIssueModal`, `ShortcutsHelp`) is `role="dialog"` /
  `"alertdialog"` + `aria-modal="true"` + `aria-labelledby`, installs `trapFocus`
  (`lib/focus-trap.ts`) in a layout effect: initial focus on `[data-autofocus]`, else the first
  field, else the primary button; `Tab` cycles inside; on close focus returns to the opener —
  or, when the opener was a menu item that unmounted with its menu, to the card the menu
  belongs to (`noteFocusOrigin`).
- The card is the only tab stop of a card (`aria-labelledby` its title); the biome rule
  `noNoninteractiveTabindex` is suppressed there on purpose. Arrow navigation reads the visible
  cards column by column from the DOM (`lib/board-keys.ts`), so it works in flat and swimlane
  mode and honours filters and collapsed sections.
- Live regions: toasts are `<output role="status">` (`role="alert"` for errors); the header
  indicator is `aria-live="polite" aria-atomic`, so mode changes (`Live` → `Down` →
  `Disconnected 12 s — retrying`) are announced once. Loading states are `aria-busy`.
- Every icon-only button carries `aria-label` (and `title`); the board and epics pages have an
  `sr-only` `h1`; heading levels inside the drawer are ordered.
- Focus is always visible (`:focus-visible` ring on `--focus`; cards get a ring plus a halo
  that survives the column's overflow clipping); `prefers-reduced-motion` disables
  transitions and animations (the spinner degrades to a static ring).
- Colour contrast: `tests/unit/web/contrast.test.ts` computes WCAG ratios for every text /
  background pair the stylesheet uses (body text, secondary and tertiary text on every
  surface, links, chips, banners, priority chips solid and outline, category stripes), in both
  themes, and fails under AA (4.5:1 text, 3:1 graphics). Stage 7 darkened `--ink-2/3`, `--ok`,
  `--warn`, `--p1`, `--p2`, `--p4` (light) and lightened `--ink-3` (dark); text on solid
  fills uses the `--pchip-ink` / `--danger-ink` tokens instead of hard-coded white.
- `tests/e2e/a11y.spec.ts` covers the shortcuts, focus traps and return, the states below, and
  runs `@axe-core/playwright` (WCAG 2.1 A/AA tags) on the board, the drawer, the help dialog
  and the dark theme with zero serious/critical violations.

## Empty, error and connection states

Every state says what it is, why, and offers the one action that changes it (`EmptyState`:
title, body, optional `detail` block with the raw error, `hints` list, primary and secondary
action). `data-testid` in brackets.

| Situation | Where | Shown |
|---|---|---|
| `/api/meta` fails on boot | page | `Cannot reach the dashboard server` with the error, hints (is `bddb serve` running; base path behind a proxy) and Retry [`meta-error`] |
| `/api/meta` lists no database | page | `No databases` with the checks `bddb doctor` prints (Dolt host/port, server-mode workspace, `BDDB_DATABASES`) and Reload [`no-databases`] |
| unknown database / path | page | message + "Open the board" |
| database `starting` | board | spinner, `Starting <db>` [`db-starting`]; indicator `Starting` |
| database `down`, no data yet | board | `<db> is unavailable`, body, the server's `lastError` in a code block, hints, Retry [`db-down`]; indicator red `Down` |
| database `degraded`, no data yet | board | `<db> is degraded`, `lastError`, Dolt hints (host/port, `listener.host` from a container) [`db-degraded`] |
| `down` / `degraded` while the board has data | banner under the header | one line + hints + `lastError` [`db-banner`]; the board keeps its last state |
| dashboard server unreachable | header | `Disconnected — retrying`, after 5 s with the elapsed seconds; after 10 s a banner with Reload [`connection-banner`]; both clear on reconnect |
| board with no issues | board | `No issues yet` + "Create the first issue" [`board-empty`] |
| every column unchecked in the settings | board | `No columns shown` + "Choose columns" (opens the gear) [`board-no-columns`] |
| issues exist but none in the shown columns / period | board | `Nothing in the shown columns` + "Choose columns" [`board-hidden-all`] |
| quick filters match nothing | board / epics | `No issue matches the current filters.` + "Clear filters" (keeps drill-down and query) [`filter-empty`] |
| drill-down with no descendants | board | "Create an issue in this epic" (parent pre-filled) + "All issues" [`drill-empty`] |
| query mode with no rows | board | `No matches` + "Clear" (drops `?query=`) [`query-empty`]; while running, the spinner |
| no epics | epics | `No epics yet` + "Create an epic" (type pre-filled) + Board [`epics-empty`] |
| empty column | board | `Nothing here` (flat board); an empty lane cell is a plain drop area |
| drawer for an unknown id (`404`) | drawer | `Issue <id> was not found` + "Back to board" (or "Back to epics" under `/epics/issue/<id>`) [`detail-error`, `detail-back`]; other errors show the detail with Retry and the same back action |
| version mismatch | banner | `bd X does not match … (built for Y)`, the schema-risk explanation, a link to `docs/compatibility.md`, Dismiss (per tab) [`version-banner`] |

Connection handling (`lib/live.ts`): a network failure lets `EventSource` retry by itself and
marks `disconnected`; a refused stream (`503 bddb_not_ready` — database starting or down —
or a vanished server) closes the `EventSource`, so the client probes `/api/meta`: reachable →
`connection = "closed"`, `dbInfo` refreshed from meta (state + `lastError`), stream reopened
with a backoff of 2 s → 15 s; unreachable → `disconnected` since now. A stream that survives a
`bd serve` restart receives `status` frames and a fresh `snapshot`, so nothing is reloaded. The
board keeps showing its last data in every case; only writes fail.

## i18n rules

- Every visible string, `aria-label`, `title` and placeholder goes through `t(key, params)`.
  Counts with a unit go through `tn(key, count)`, which picks `<key>.one|few|many|other` with
  `Intl.PluralRules` of the language (both files carry all four forms; English repeats
  `other`) and formats the number for the locale (`1.5 days` / `1,5 дня`).
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
in_progress, and implements the read proxies, `issues:query` (a tiny expression subset) and
every write proxy with the real guards (see "Testing the writes").

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
filters, resize, the board settings: columns, closed period, server cap, `,`) and `tests/e2e/epics.spec.ts` (swimlanes, group toggle, drill-down, epics view,
drawer hierarchy — the tests named `real:` pick an epic with children from the snapshot, so they
run against both targets; fixture-only assertions are skipped when `E2E_TARGET` is not `mock`)
and `tests/e2e/edit.spec.ts` (every write: drag-and-drop, dialogs, drawer editing, creation,
query mode; runs against both targets, see "Testing the writes") and `tests/e2e/a11y.spec.ts`
(keyboard shortcuts, focus traps, empty / error / connection states simulated with
`page.route`, axe scans — both targets), then `live` runs
`tests/e2e/live.spec.ts` (real only): while the board is open it
creates an issue through `scripts/stand.sh create-issue "<title>"` and expects the card within
10 s without a reload. `E2E_CREATE_ISSUE` replaces that command for another stand (it receives the
title as its last argument and must print the new id); `STAND_DIR` points it at a stand in
another directory.

The README screenshots come from the mock: `mise run screenshots` (`scripts/screenshots.ts`)
writes `docs/screenshots/board-{light,dark}.png` at 1440×900 and fails when a file exceeds
300 KB.

## Editing (stage 5)

Every write goes through the BFF write proxies (`docs/bff-api.md`) with the `actor` from the
header setting (`state/meta.ts` `actor`; comments send it as `author`). Errors are RFC 9457
problems; the UI dispatches on `code` only — toasts translate known codes (`error.<code>` in
`i18n/*.json`: `precondition_failed`, `not_closable`, `already_claimed`, `not_claimable`,
`not_releasable`, `dependency_cycle`, `dependency_exists`, …) and show the `detail` otherwise.
There is no delete anywhere in the UI.

### Write layer

- `lib/api.ts`: typed helpers for every proxy — `createIssue`, `patchIssue`, `closeIssue`,
  `reopenIssue`, `claimIssue`, `releaseIssue`, `addComment`, `depAdd`, `depRemove`,
  `batchApply`, `query` (`GET issues:query?q=…&limit=0`).
- `lib/mutations.ts`: `guardedPatch(transport, db, id, actor, patch, opts)` reads
  `GET issues/{id}` for `revision` (skipped when the caller already holds one), sends
  `PATCH` with `expected_version` (plus `force_close_policy` / `force_assignee_transfer` when
  asked) and returns `{ ok: true, response }`, `{ ok: false, kind: "conflict", currentRevision,
  error }` on `409 precondition_failed`, or `{ ok: false, kind: "error", error }`. The
  transport is injected so the unit tests run without a network; `patchGuarded` binds the real
  `api`. `applyOptimistic(id, guess)` writes a local guess into the board signal and returns a
  revert function; the revert is skipped when a delta has meanwhile replaced the row (the
  server state won). Every board write applies the guess first, marks the card `pending`
  (muted, not draggable), and on failure reverts and toasts.
- `state/actions.ts`: `patchRow`, `closeRows`, `reopenRow`, `moveRows` (drop / menu entry
  point), `setStatus`, `setPriority`, `setParent`. `moveRows` resolves the intent with
  `lib/dnd-intent.ts` and runs the dialogs.

### Drag-and-drop

`@atlaskit/pragmatic-drag-and-drop` (native HTML5 drag): cards are draggables, the drop zones
are the priority sections (`data-drop-status` / `data-drop-priority`), the lane cells and lane
headers (swimlanes), and the column body (flat board). While a card is in the air every
section of every column appears — empty ones as dashed "Drop here" placeholders tinted by their
priority — so any priority can be targeted; the zone under the pointer fills in. A board-wide
monitor takes the innermost zone under the pointer and calls `moveRows`. Shift / Ctrl / Cmd-click
toggles a card in the multi-selection (a bar under the toolbar shows the count; Escape clears);
dragging a selected card drags the whole selection with a count badge as preview. The `⋯` menu
on each card (`Move to …`, `Set priority …`) is the keyboard alternative and follows the same
paths.

`lib/dnd-intent.ts` (`resolveDrop(source, target, statuses)`, pure, unit-tested) decides:

| From → to | Writes |
|---|---|
| same column, other priority section | `PATCH {priority}` |
| other column, neither done-category | `PATCH {status}` (+ `priority` when the section differs — one request) |
| active/wip/frozen → done-category column | `POST :close` after the **reason dialog**; a different section or lane is patched afterwards; a done status other than the one `:close` set is patched too |
| done → non-done column | `POST :reopen`, then `PATCH {status}` when the target is not `open` (+ priority / parent in the same patch) |
| done → another done status | `PATCH {status}` |
| onto another lane (header or cell) | `PATCH {parent_id}` = the lane's epic; the "No epic" lane sends `""`; a drill-down's "Directly in <epic>" lane sends the drilled epic. A drop inside the card's own lane leaves the parent alone; an epic cannot become its own parent |
| lane + status + priority at once | one `PATCH` with every field when no close/reopen is involved |

Multi-select drops: plain patches on several cards go through one `POST issues/batch-apply`
with `update` items (status / priority; not guarded by `expected_version` because board rows
carry no revision); parent changes fall back to single guarded patches (batch-apply has no
`parent_id`); close / reopen run card by card with one reason dialog for the whole set and a
force dialog per refusal.

### Dialogs (`state/dialogs.ts`, `components/Dialog.tsx`)

Promise-based (`ask(spec)` resolves with the answer or `null` on Cancel / Escape / backdrop);
every dialog names the actor it will record.

- **Close reason** — optional reason, Ctrl+Enter or Close confirms. For N cards it says
  "N issues".
- **Force** — on `409 not_closable`: with `open_children` the text says how many open children
  the issue has, without it that an open dependency blocks it; "Close with force" retries with
  `force: true` (or `force_close_policy` for a status select), Cancel puts the card back.
- **Conflict** — on `409 precondition_failed` from the drawer: "Reload (discard mine)" re-reads
  the issue and closes the editor, "Overwrite" re-reads the revision and retries the same
  patch once. A conflict on a board drop is not a dialog: the card returns to its place and a
  toast says "Changed by someone else" with the server's detail.

### Detail drawer editing

`components/detail/editor.ts` keeps the editing session: `save(patch)` is a guarded PATCH
against the drawer's loaded `revision`; the response's issue is merged into the details and the
new revision kept. Opening an inline editor (title, a markdown section) pauses the silent
re-reads a live delta would trigger, so a concurrent write surfaces as the conflict dialog on
Save instead of silently adopting the other writer's revision; the deferred re-read runs when
the last editor closes.

- Title: Edit → input, Enter / Save, Escape cancels.
- Properties grid (`detail/Fields.tsx`): status (select; into a done status → the close dialog
  path, out of done → reopen, otherwise `PATCH status`), type (`snapshot.types`), priority,
  assignee (text with a datalist of known assignees, empty clears; Claim / Release buttons call
  `:claim` / `:release` with the actor — `already_claimed` names the holder), labels (chips,
  `add_labels` / `remove_labels`), parent (searchable picker over the snapshot, clear sends
  `""`, ↗ opens the parent), due / defer-until (`datetime-local`, clear sends `null`), estimate
  (minutes, empty → `null`), external ref (empty → `null`). Scalar controls save on change or
  blur.
- Text sections (`detail/TextSections.tsx`): description, design, acceptance criteria, notes.
  Edit swaps in the markdown editor (Write / Preview tabs through the same `marked` +
  `DOMPurify` renderer, Ctrl+Enter saves); Notes also offer Append (`append_notes`).
- Dependencies (`detail/Relations.tsx`): "Depends on" (`dependencies` minus `parent-child`) and
  "Blocks" (`dependents`) with a remove button per edge and Add through the issue picker;
  `POST dependencies/add` with `type: "blocks"` — this issue is the source for "Depends on"
  and the target for "Blocks" — and `dependencies/remove` with the same direction.
- Comments: list plus an add form (markdown editor, `author` = actor).

### Creating issues

"+ New" in the toolbar (pre-fills the parent inside a drill-down), "+" in every column header
(pre-fills the status) and in every lane header (pre-fills the parent: the lane's epic, or the
drilled epic for the "Directly in" lane). The modal (`CreateIssueModal.tsx`) has title
(required), type, priority, status, assignee, labels, parent (picker) and description
(markdown editor); `POST issues` with the actor, then the drawer opens on the new issue.

### Query mode

The toolbar's "Query" toggle opens a strip with a `bd query` expression (`state/query.ts`,
`components/QueryBar.tsx`). Run sends `GET issues:query?q=<expr>&limit=0` and the result
replaces the board's issue set: rows the live snapshot also holds are taken from the snapshot,
so deltas keep applying to them; rows outside the snapshot (older closed issues) come from the
result. The strip turns into the "Query mode: N issues match" banner with a Clear button; quick
filters still apply on top. The expression lives in the URL as `?query=<expr>` (the quick text
filter already owns `?q=`), so it survives reloads and can be shared. A `400` (`param: "q"`)
shows the translated title and the server's `detail` under the field; other failures show
their detail the same way.

## Testing the writes

Unit: `tests/unit/web/columns.test.ts` (default and stored visible columns, the hours options,
the capped effective period, the closed-window filter — `closed_at` within N hours, missing →
hidden), `tests/unit/web/mutations.test.ts` (guarded PATCH with an in-memory transport: revision
read, `expected_version`, conflict result, optimistic apply / revert) and
`tests/unit/web/dnd-intent.test.ts` (every row of the DnD table, multi-drop grouping).

E2E: `tests/e2e/edit.spec.ts` creates its own issues through the write proxies, so it runs
against the mock (in the `sandbox` database, leaving the `siam_platform` fixture untouched for
the other specs) and against a real stand (`E2E_TARGET=real E2E_DB=kb`). Drags use real pointer
events (`tests/e2e/helpers.ts` `dragCardTo`): press, small moves until the drop placeholders
appear, scroll the target into view, measure its visible box, travel there in steps, release.
Covered: priority drop, status (+ priority) drop, drop into Closed with the reason dialog
(verified through `GET issues/{id}` and, on the stand, `scripts/stand.sh show-issue <id>` =
`bd show --json`), cancel, epic with an open child → force dialog (both answers), reopen by
dragging out of Closed, lane drop → parent, multi-select drop, card menu, title edit,
stale-revision conflict (the test patches the issue behind the drawer's back, then Overwrite
and Reload), comment, labels / priority / status selects, blocks dependency add + remove, the
New issue modal, the column "+", query mode (invalid expression error, valid expression, URL
persistence) and the Russian strings.

The mock BFF (`dev/mock-bff.ts`) implements the same guards: `expected_version` →
`precondition_failed`, close policy (`open_children`, live blocker) → `not_closable`,
`dependency_cycle` / `dependency_exists`, `already_claimed` / `not_claimable` /
`not_releasable`, all-or-nothing `issues/batch-apply`, and a tiny `bd query` subset (`status=`,
`priority<=`/`<`/`>=`/`>`/`=`/`!=`, `type=`, `label=`, `assignee=`, joined by `AND`; anything
else → `400 invalid_argument param=q`).

## Deferred

- Stage-5 leftovers: drop targets in the drawer's children list, a guarded (`expected_version`)
  batch move.
- Roving `tabindex` (one tab stop per column) instead of one per card; `aria-keyshortcuts` on
  cards; a "skip to board" link.
- Epic child counters do not see children closed before the `BDDB_CLOSED_HOURS` window; the
  drill-down toolbar count is the whole board's count. Closed issues older than that window are
  not reachable from the board (the on-demand "Show all closed" loader was removed with the
  period select); `?query=` still finds them.
