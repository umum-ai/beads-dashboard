import { describe, expect, test } from "bun:test";
import type { BoardIssue } from "../../../src/web/lib/bff-types.ts";
import {
  EMPTY_FILTERS,
  isFilterEmpty,
  matchesFilters,
  parseFilters,
  serializeFilters,
} from "../../../src/web/lib/filters.ts";

function issue(over: Partial<BoardIssue> = {}, without: (keyof BoardIssue)[] = []): BoardIssue {
  const out: BoardIssue = {
    id: "kb-abc",
    title: "Supervisor restarts bd serve",
    issue_type: "task",
    status: "open",
    priority: 2,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    labels: ["lane:server", "iteration:2"],
    assignee: "opus",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    blocked: false,
    ...over,
  };
  for (const key of without) delete out[key];
  return out;
}

describe("filters: URL round trip", () => {
  test("empty query gives empty filters", () => {
    expect(parseFilters("")).toEqual(EMPTY_FILTERS);
    expect(isFilterEmpty(parseFilters("?"))).toBe(true);
    expect(serializeFilters(EMPTY_FILTERS)).toBe("");
  });

  test("every field survives serialize → parse", () => {
    const f = {
      q: "bd serve",
      types: ["bug", "epic"],
      label: "lane:",
      assignee: "opus",
      priorities: [0, 2],
      epic: "kb-e1",
      query: "status=open AND priority<=1",
    };
    const s = serializeFilters(f);
    expect(s.startsWith("?")).toBe(true);
    expect(parseFilters(s)).toEqual(f);
  });

  test("priorities are de-duplicated, sorted and clamped to 0..4", () => {
    expect(parseFilters("?priority=3,1,3,9,-1,x").priorities).toEqual([1, 3]);
  });

  test("empty type segments are dropped", () => {
    expect(parseFilters("?type=,bug,,").types).toEqual(["bug"]);
  });
});

describe("filters: matching", () => {
  test("text matches title or id, case-insensitively", () => {
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, q: "SUPERVISOR" })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, q: "kb-ab" })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, q: "docker" })).toBe(false);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, q: "   " })).toBe(true);
  });

  test("type is a multi-select", () => {
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, types: ["bug", "task"] })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, types: ["bug"] })).toBe(false);
    expect(matchesFilters(issue({}, ["issue_type"]), { ...EMPTY_FILTERS, types: ["task"] })).toBe(
      false,
    );
  });

  test("label is a substring match on any label", () => {
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, label: "lane:" })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, label: "ITERATION" })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, label: "docs" })).toBe(false);
    expect(matchesFilters(issue({}, ["labels"]), { ...EMPTY_FILTERS, label: "x" })).toBe(false);
  });

  test("assignee is exact", () => {
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, assignee: "opus" })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, assignee: "opu" })).toBe(false);
    expect(matchesFilters(issue({}, ["assignee"]), { ...EMPTY_FILTERS, assignee: "opus" })).toBe(
      false,
    );
  });

  test("priority is a set and filters combine with AND", () => {
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, priorities: [2, 3] })).toBe(true);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, priorities: [0] })).toBe(false);
    expect(matchesFilters(issue(), { ...EMPTY_FILTERS, q: "bd", priorities: [0] })).toBe(false);
    expect(
      matchesFilters(issue(), { ...EMPTY_FILTERS, q: "bd", assignee: "opus", priorities: [2] }),
    ).toBe(true);
  });
});
