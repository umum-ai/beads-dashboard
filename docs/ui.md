# UI (`src/web`)

The dashboard is a Preact SPA served by the `bddb` process. It talks only to the BFF API
described in `docs/bff-api.md`; it never sees `bd serve`. This page covers the code layout,
the state model, i18n and theming rules, and how to run the mock and the e2e suite.

## Layout

| Path | Contents |
|---|---|
| `index.html`, `main.tsx` | Bun HTML entry; mounts `<App />` into `#app`. |
| `app.tsx` | Shell: loads `/api/meta`, switches views by route, keeps one live stream per displayed database, renders header, banner, drawer and toasts. |
| `components/` | `Header` (project switcher, tabs, live indicator, actor, language, theme), `Toolbar` (quick filters), `Column`, `Card`, `DetailPanel`, `EmptyState`, `Toasts`, `VersionBanner`, `Popover`, `LiveIndicator`. |
| `views/` | `BoardView` (columns per status), `EpicsView` (stage 4 placeholder listing epics with progress). |
| `lib/` | Pure, unit-tested logic: `basePath` (mount discovery), `router` (path ⇄ route), `filters` (query string ⇄ filters, matching), `board` (columns, priority sections, card order), `delta` (snapshot state and delta application), `api` (fetch wrapper, `ApiError`), `live` (EventSource), `i18n-core`, `markdown` (marked + DOMPurify), `time`, `storage`, `clipboard`, `issue-meta` (type glyphs), `bff-types` (wire types of the BFF, reusing `src/api-client/types.ts`). |
| `state/` | Signals: `meta`, `route` (+ filters), `snapshot` (board state, connection, extra closed rows, derived child counters), `prefs` (theme, actor, column widths, collapsed sections, dismissed banner), `toasts`. |
| `i18n/` | `en.json` (reference), `ru.json` (same keys), `index.ts` (`t`, `tOr`, language signal). |
| `styles/` | `tokens.css` (design tokens, light and dark), `app.css` (all component styles). |
| `dev/` | `mock-bff.ts` and `fixture.ts`: a `Bun.serve` implementation of the BFF API over an in-memory fixture, used for development and e2e. Not part of the product build. |

## Routing and base path

Routes: `/p/<db>/board`, `/p/<db>/epics`, `/p/<db>/issue/<id>` (board with the detail drawer
open). `/` redirects (client-side) to the default database's board. Quick filters live in the
query string (`?q=…&type=a,b&label=…&assignee=…&priority=0,1`) and survive reloads and
project switches keep the view but drop the filters.

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
- `prefs` persist in `localStorage` under `bddb.`: `theme`, `lang`, `actor`, `columnWidths`
  (per status name), `collapsed` (per `status:priority`), `dismissedVersionWarning`. Every
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
`marked` (GFM) and `DOMPurify`. Children come from the snapshot (`parent === id`), dependencies
and dependents from the response. Read-only in stage 3.

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
E2E_TARGET=real BDDB_URL=http://127.0.0.1:7331 E2E_DB=<db> mise run e2e   # against a running BFF
```

Fixture-specific assertions are skipped when `E2E_TARGET` is not `mock`.

## Deferred

- Stage 4: epic swimlanes and drill-down on the board, the real epics view, the
  parent/children/blockers tree in the drawer (`dependencies/tree`), breadcrumbs.
- Stage 5: drag-and-drop (status, priority, parent) with guarded `PATCH`, close/reopen
  dialogs with reason and force, editing every field in the drawer, comments, labels,
  `blocks` edges, issue creation, `bd query` expression search, conflict dialog. The
  `actor` setting already exists for these writes.
- Stage 7: keyboard navigation between cards, full a11y pass, more empty/error states,
  documentation polish.
