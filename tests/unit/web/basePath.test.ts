import { describe, expect, test } from "bun:test";
import { normalizeBasePath, resolveBasePath, stripBase } from "../../../src/web/lib/basePath.ts";
import { parseRoute, routePath } from "../../../src/web/lib/router.ts";

describe("base path discovery", () => {
  test("nothing configured gives the root mount", () => {
    expect(resolveBasePath({})).toBe("");
    expect(resolveBasePath({ baseHref: null, injected: null })).toBe("");
    expect(resolveBasePath({ baseHref: "/", injected: "/" })).toBe("");
  });

  test("<base href> wins over window.__BDDB__", () => {
    expect(resolveBasePath({ baseHref: "/dash/", injected: "/other" })).toBe("/dash");
  });

  test("window.__BDDB__.basePath is used when there is no <base href>", () => {
    expect(resolveBasePath({ injected: "/bddb" })).toBe("/bddb");
    expect(resolveBasePath({ baseHref: "", injected: "bddb/" })).toBe("/bddb");
  });

  test("normalization: leading slash added, trailing slashes removed, whitespace trimmed", () => {
    expect(normalizeBasePath("dash")).toBe("/dash");
    expect(normalizeBasePath("/dash///")).toBe("/dash");
    expect(normalizeBasePath("  /a/b/ ")).toBe("/a/b");
  });

  test("an absolute <base href> is reduced to its path on the same origin only", () => {
    const origin = "https://tools.example";
    expect(normalizeBasePath("https://tools.example/dash/", origin)).toBe("/dash");
    expect(normalizeBasePath("https://elsewhere.example/dash/", origin)).toBe("");
    expect(normalizeBasePath("http://[bad", origin)).toBe("");
  });

  test("stripBase removes the mount and rejects paths outside it", () => {
    expect(stripBase("/p/db/board", "")).toBe("/p/db/board");
    expect(stripBase("/dash/p/db/board", "/dash")).toBe("/p/db/board");
    expect(stripBase("/dash", "/dash")).toBe("/");
    expect(stripBase("/dashboard/p/db", "/dash")).toBeNull();
    expect(stripBase("/other", "/dash")).toBeNull();
  });
});

describe("routes", () => {
  test("parse and print every route kind", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/p/db")).toEqual({ kind: "board", db: "db" });
    expect(parseRoute("/p/db/board")).toEqual({ kind: "board", db: "db" });
    expect(parseRoute("/p/db/epics")).toEqual({ kind: "epics", db: "db" });
    expect(parseRoute("/p/db/issue/kb-1.2")).toEqual({
      kind: "issue",
      db: "db",
      issueId: "kb-1.2",
    });
    expect(parseRoute("/nope").kind).toBe("unknown");
    expect(parseRoute("/p/db/issue").kind).toBe("unknown");
    expect(routePath({ kind: "issue", db: "my db", issueId: "kb-1" })).toBe(
      "/p/my%20db/issue/kb-1",
    );
    expect(parseRoute("/p/my%20db/board")).toEqual({ kind: "board", db: "my db" });
  });
  test("a malformed percent-encoding does not throw (the segment is kept as typed)", () => {
    expect(() => parseRoute("/p/%E0%A4%A/board")).not.toThrow();
    expect(parseRoute("/p/%E0%A4%A/board")).toEqual({ kind: "board", db: "%E0%A4%A" });
    expect(parseRoute("/p/db/issue/%zz")).toEqual({ kind: "issue", db: "db", issueId: "%zz" });
  });
});
