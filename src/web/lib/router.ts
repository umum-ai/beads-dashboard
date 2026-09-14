/** Pure routing helpers: path to route object and back. History wiring lives in state/route.ts. */

export type Route =
  | { kind: "home" }
  | { kind: "board"; db: string }
  | { kind: "epics"; db: string }
  | { kind: "issue"; db: string; issueId: string }
  | { kind: "unknown"; path: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { kind: "home" };
  if (parts[0] !== "p" || parts.length < 2) return { kind: "unknown", path: pathname };
  const db = parts[1] as string;
  if (parts.length === 2) return { kind: "board", db };
  const view = parts[2];
  if (view === "board" && parts.length === 3) return { kind: "board", db };
  if (view === "epics" && parts.length === 3) return { kind: "epics", db };
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
    case "unknown":
      return route.path;
  }
}

export function routeDb(route: Route): string | null {
  return "db" in route ? route.db : null;
}
