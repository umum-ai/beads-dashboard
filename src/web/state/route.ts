/** History API wiring: current route and filters as signals, navigation helpers. */
import { computed, signal } from "@preact/signals";
import { basePath, stripBase, withBase } from "../lib/basePath.ts";
import { EMPTY_FILTERS, type Filters, parseFilters, serializeFilters } from "../lib/filters.ts";
import {
  closeRouteOf,
  detailRouteIn,
  parseRoute,
  type Route,
  routeDb,
  routePath,
} from "../lib/router.ts";

function readLocation(): { route: Route; filters: Filters } {
  if (typeof location === "undefined") return { route: { kind: "home" }, filters: EMPTY_FILTERS };
  const inner = stripBase(location.pathname, basePath());
  const route =
    inner === null ? { kind: "unknown" as const, path: location.pathname } : parseRoute(inner);
  return { route, filters: parseFilters(location.search) };
}

const initial = readLocation();
export const route = signal<Route>(initial.route);
export const filters = signal<Filters>(initial.filters);
export const currentDb = computed(() => routeDb(route.value));
/** The drawer is open (board or epics view). */
export const drawerOpen = computed(
  () => route.value.kind === "issue" || route.value.kind === "epicsIssue",
);

/** Drawer route for `issueId` in the current view: links inside the drawer stay where they are. */
export function detailRoute(db: string, issueId: string): Route {
  return detailRouteIn(route.value, db, issueId);
}

/** Route the drawer returns to when closed (the current view, filters kept by `navigate`). */
export function closeRoute(db: string): Route {
  return closeRouteOf(route.value, db);
}

function sync(): void {
  const next = readLocation();
  route.value = next.route;
  filters.value = next.filters;
}

if (typeof window !== "undefined") window.addEventListener("popstate", sync);

export function navigate(
  next: Route,
  opts: { replace?: boolean; keepFilters?: boolean; filters?: Filters } = {},
): void {
  const keep = opts.keepFilters ?? true;
  const search = serializeFilters(opts.filters ?? (keep ? filters.value : EMPTY_FILTERS));
  const url = withBase(routePath(next)) + search;
  if (opts.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  sync();
}

export function setFilters(next: Filters): void {
  const url = withBase(routePath(route.value)) + serializeFilters(next);
  history.replaceState(null, "", url);
  sync();
}

export function updateFilters(patch: Partial<Filters>): void {
  setFilters({ ...filters.value, ...patch });
}

export function hrefFor(next: Route, keepFilters = true): string {
  return withBase(routePath(next)) + (keepFilters ? serializeFilters(filters.value) : "");
}

/** Href for `next` with an explicit filter set (e.g. the board drilled into an epic). */
export function hrefWith(next: Route, withFilters: Filters): string {
  return withBase(routePath(next)) + serializeFilters(withFilters);
}

/** Intercept plain left clicks on internal links so the SPA handles them. */
export function onLinkClick(event: MouseEvent, next: Route): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(next);
}
