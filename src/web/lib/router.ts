/** Pure routing helpers: path to route object and back. History wiring lives in state/route.ts. */

export type Route =
  | { kind: "home" }
  | { kind: "board"; db: string }
  | { kind: "epics"; db: string }
  | { kind: "issue"; db: string; issueId: string }
  /** The epics view with the detail drawer open (`/p/<db>/epics/issue/<id>`). */
  | { kind: "epicsIssue"; db: string; issueId: string }
  | { kind: "unknown"; path: string };

/** Route of the detail drawer for `issueId` inside the view `current` is showing. */
export function detailRouteIn(current: Route, db: string, issueId: string): Route {
  const inEpics = current.kind === "epics" || current.kind === "epicsIssue";
  return { kind: inEpics ? "epicsIssue" : "issue", db, issueId };
}

/** Where the drawer's close goes: the view it is open in, without the issue. */
export function closeRouteOf(current: Route, db: string): Route {
  return { kind: current.kind === "epicsIssue" ? "epics" : "board", db };
}

/** `decodeURIComponent` that leaves a malformed segment (`%E0%A4%A`) as it is instead of throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeSegment);
  if (parts.length === 0) return { kind: "home" };
  if (parts[0] !== "p" || parts.length < 2) return { kind: "unknown", path: pathname };
  const db = parts[1] as string;
  if (parts.length === 2) return { kind: "board", db };
  const view = parts[2];
  if (view === "board" && parts.length === 3) return { kind: "board", db };
  if (view === "epics" && parts.length === 3) return { kind: "epics", db };
  if (view === "epics" && parts.length === 5 && parts[3] === "issue") {
    return { kind: "epicsIssue", db, issueId: parts[4] as string };
  }
  if (view === "issue" && parts.length === 4) {
    return { kind: "issue", db, issueId: parts[3] as string };
  }
  return { kind: "unknown", path: pathname };
}

export function routePath(route: Route): string {
  switch (route.kind) {
    case "home":
      return "/";
    case "board":
      return `/p/${encodeURIComponent(route.db)}/board`;
    case "epics":
      return `/p/${encodeURIComponent(route.db)}/epics`;
    case "issue":
      return `/p/${encodeURIComponent(route.db)}/issue/${encodeURIComponent(route.issueId)}`;
    case "epicsIssue":
      return `/p/${encodeURIComponent(route.db)}/epics/issue/${encodeURIComponent(route.issueId)}`;
    case "unknown":
      return route.path;
  }
}

export function routeDb(route: Route): string | null {
  return "db" in route ? route.db : null;
}
