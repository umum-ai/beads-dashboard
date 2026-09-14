/** Quick filters: URL query to object and back, and matching against a board row. */
import type { BoardIssue } from "./bff-types.ts";

export interface Filters {
  q: string;
  types: string[];
  label: string;
  assignee: string;
  priorities: number[];
  /** Drill-down: show only the descendants of this epic (`?epic=<id>`); not a quick filter. */
  epic: string;
}

export const EMPTY_FILTERS: Filters = {
  q: "",
  types: [],
  label: "",
  assignee: "",
  priorities: [],
  epic: "",
};

export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search);
  const priorities = (params.get("priority") ?? "")
    .split(",")
    .filter((s) => s !== "")
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 4);
  return {
    q: params.get("q") ?? "",
    types: (params.get("type") ?? "").split(",").filter(Boolean),
    label: params.get("label") ?? "",
    assignee: params.get("assignee") ?? "",
    priorities: [...new Set(priorities)].sort(),
    epic: params.get("epic") ?? "",
  };
}

export function serializeFilters(f: Filters): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.types.length) params.set("type", f.types.join(","));
  if (f.label) params.set("label", f.label);
  if (f.assignee) params.set("assignee", f.assignee);
  if (f.priorities.length) params.set("priority", f.priorities.join(","));
  if (f.epic) params.set("epic", f.epic);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Quick filters only: the drill-down `epic` is not a filter the toolbar clears. */
export function isFilterEmpty(f: Filters): boolean {
  return !f.q && !f.types.length && !f.label && !f.assignee && !f.priorities.length;
}

export function matchesFilters(issue: BoardIssue, f: Filters): boolean {
  const needle = f.q.trim().toLowerCase();
  if (needle) {
    const hay = `${issue.id} ${issue.title}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.types.length && !f.types.includes(issue.issue_type ?? "")) return false;
  if (f.label) {
    const labels = issue.labels ?? [];
    const wanted = f.label.toLowerCase();
    if (!labels.some((l) => l.toLowerCase().includes(wanted))) return false;
  }
  if (f.assignee && (issue.assignee ?? "") !== f.assignee) return false;
  if (f.priorities.length && !f.priorities.includes(issue.priority)) return false;
  return true;
}
