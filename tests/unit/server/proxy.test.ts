import { describe, expect, test } from "bun:test";
import { filterQuery, matchProxyRoute, withAttribution } from "../../../src/server/proxy.ts";

describe("matchProxyRoute", () => {
  test("read routes", () => {
    const list = matchProxyRoute("GET", ["issues"]);
    expect(list.kind).toBe("read");
    if (list.kind === "read") {
      expect(list.route.upstream).toBe("/issues");
      expect(Object.keys(list.route.allowed)).toContain("cursor");
    }
    const get = matchProxyRoute("GET", ["issues", "kb-a.1"]);
    if (get.kind !== "read") throw new Error("expected read");
    expect(get.route.upstream).toBe("/issues/kb-a.1");
    expect(Object.keys(get.route.allowed).sort()).toEqual([
      "brief_deps",
      "include_comments",
      "include_dependents",
    ]);
    expect(matchProxyRoute("GET", ["issues:query"]).kind).toBe("read");
    expect(matchProxyRoute("GET", ["ready"]).kind).toBe("read");
    expect(matchProxyRoute("GET", ["stats"]).kind).toBe("read");
    expect(matchProxyRoute("GET", ["config"]).kind).toBe("read");
    const tree = matchProxyRoute("GET", ["dependencies", "tree"]);
    if (tree.kind !== "read") throw new Error("expected read");
    expect(tree.route.upstream).toBe("/dependencies/tree");
    const related = matchProxyRoute("GET", ["issues", "x y", "related"]);
    if (related.kind !== "read") throw new Error("expected read");
    expect(related.route.upstream).toBe("/issues/x%20y/related");
  });

  test("write routes map slash actions to colon operations", () => {
    const cases: [string, string[], string, "actor" | "author"][] = [
      ["POST", ["issues"], "/issues", "actor"],
      ["PATCH", ["issues", "kb-1"], "/issues/kb-1", "actor"],
      ["POST", ["issues", "kb-1", "close"], "/issues/kb-1:close", "actor"],
      ["POST", ["issues", "kb-1", "reopen"], "/issues/kb-1:reopen", "actor"],
      ["POST", ["issues", "kb-1", "claim"], "/issues/kb-1:claim", "actor"],
      ["POST", ["issues", "kb-1", "release"], "/issues/kb-1:release", "actor"],
      ["POST", ["issues", "kb-1", "comments"], "/issues/kb-1/comments", "author"],
      ["POST", ["dependencies", "add"], "/dependencies:add", "actor"],
      ["POST", ["dependencies", "remove"], "/dependencies:remove", "actor"],
      ["POST", ["issues", "batch-apply"], "/issues:batchApply", "actor"],
    ];
    for (const [method, parts, upstream, attribution] of cases) {
      const m = matchProxyRoute(method, parts);
      expect(m.kind).toBe("write");
      if (m.kind === "write") {
        expect(m.route.upstream).toBe(upstream);
        expect(m.route.attribution).toBe(attribution);
        expect(m.route.method).toBe(method as "POST" | "PATCH");
      }
    }
  });

  test("never exposes delete, sweep, config writes or memories", () => {
    expect(matchProxyRoute("POST", ["issues:delete"]).kind).toBe("none");
    expect(matchProxyRoute("POST", ["issues", "delete"]).kind).toBe("none");
    expect(matchProxyRoute("POST", ["issues:sweep"]).kind).toBe("none");
    expect(matchProxyRoute("PUT", ["config", "x"]).kind).toBe("none");
    expect(matchProxyRoute("DELETE", ["config", "x"]).kind).toBe("none");
    expect(matchProxyRoute("GET", ["memories"]).kind).toBe("none");
    expect(matchProxyRoute("DELETE", ["issues", "kb-1"]).kind).toBe("none");
    expect(matchProxyRoute("GET", ["events"]).kind).toBe("none");
  });
});

describe("filterQuery", () => {
  test("keeps known keys (repeated too), reports the first unknown", () => {
    const ok = filterQuery(new URLSearchParams("status=open&status=closed&limit=0"), {
      status: true,
      limit: true,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.query.getAll("status")).toEqual(["open", "closed"]);
    const bad = filterQuery(new URLSearchParams("limit=1&updated_after=x"), { limit: true });
    expect(bad).toEqual({ ok: false, param: "updated_after" });
  });
});

describe("withAttribution", () => {
  test("fills actor/author only when missing or empty", () => {
    expect(withAttribution({ title: "t" }, "actor", "bddb")).toEqual({ title: "t", actor: "bddb" });
    expect(withAttribution({ actor: "" }, "actor", "bddb")).toEqual({ actor: "bddb" });
    expect(withAttribution({ actor: "me" }, "actor", "bddb")).toEqual({ actor: "me" });
    expect(withAttribution({ text: "hi" }, "author", "bddb")).toEqual({
      text: "hi",
      author: "bddb",
    });
    expect(withAttribution([], "actor", "bddb")).toBeNull();
    expect(withAttribution("x", "actor", "bddb")).toBeNull();
    expect(withAttribution(null, "actor", "bddb")).toBeNull();
  });
});
