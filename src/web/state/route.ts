/** History API wiring: current route and filters as signals, navigation helpers. */
import { computed, signal } from "@preact/signals";
import { basePath, stripBase, withBase } from "../lib/basePath.ts";
import { EMPTY_FILTERS, type Filters, parseFilters, serializeFilters } from "../lib/filters.ts";
import { parseRoute, type Route, routeDb, routePath } from "../lib/router.ts";

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

function sync(): void {
  const next = readLocation();
  route.value = next.route;
  filters.value = next.filters;
}

if (typeof window !== "undefined") window.addEventListener("popstate", sync);

export function navigate(
  next: Route,
  opts: { replace?: boolean; keepFilters?: boolean } = {},
): void {
  const keep = opts.keepFilters ?? true;
  const search = keep ? serializeFilters(filters.value) : "";
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

/** Intercept plain left clicks on internal links so the SPA handles them. */
export function onLinkClick(event: MouseEvent, next: Route): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(next);
}
