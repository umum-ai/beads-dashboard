import { describe, expect, test } from "bun:test";
import { BdClient, ProblemError, serializeQuery } from "../../../src/api-client/index.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Fake fetch recording each call and answering with `reply` (JSON) or a canned Response. */
function fakeFetch(reply: unknown | ((seen: Seen) => Response)) {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const seen: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(seen);
    if (typeof reply === "function") return (reply as (s: Seen) => Response)(seen);
    return Response.json(reply);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("serializeQuery", () => {
  test("repeats array keys, stringifies booleans and numbers, skips undefined", () => {
    const q = serializeQuery(
      "listIssues",
      {
        status: ["open", "in_progress"],
        label: ["ui", "a,b"],
        all: true,
        brief: false,
        limit: 0,
        assignee: undefined,
      },
      { status: true, label: true, all: true, brief: true, limit: true, assignee: true },
    );
    expect(q.toString()).toBe(
      "status=open&status=in_progress&label=ui&label=a%2Cb&all=true&brief=false&limit=0",
    );
  });

  test("refuses a key that is not in the operation's parameter table", () => {
    expect(() => serializeQuery("listIssues", { nosuch: 1 }, { status: true })).toThrow(
      /listIssues: query parameter "nosuch" is not in the bd serve spec/,
    );
  });

  test("undefined params → empty", () => {
    expect(serializeQuery("x", undefined, {}).toString()).toBe("");
  });
});

describe("BdClient reads", () => {
  test("listIssues builds the URL from the spec parameter table and sends headers", async () => {
    const { calls, fetchImpl } = fakeFetch({ items: [], has_more: false });
    const bd = new BdClient({
      baseUrl: "http://127.0.0.1:47313/",
      fetch: fetchImpl,
      projectId: "proj-1",
      token: "t0k",
    });
    const page = await bd.listIssues({
      status: ["open", "closed"],
      label: ["ui"],
      parent: "kb-1",
      limit: 0,
      brief: true,
      sort: "priority",
    });
    expect(page).toEqual({ items: [], has_more: false });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "http://127.0.0.1:47313/v0/beads/issues?status=open&status=closed&label=ui&parent=kb-1&limit=0&brief=true&sort=priority",
    );
    expect(calls[0]?.headers).toEqual({
      accept: "application/json",
      "bd-project-id": "proj-1",
      authorization: "Bearer t0k",
    });
    expect(calls[0]?.body).toBeUndefined();
  });

  test("path segments are encoded; custom-method suffixes are not", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    await bd.getIssue("kb-jfq.1", { include_comments: true });
    await bd.closeIssue("kb-jfq.1");
    await bd.configKey("status.custom");
    await bd.related("kb-1", { direction: "out", type: ["blocks", "parent-child"] });
    await bd.dependencyTree({ root_id: "kb-1", direction: "down", max_depth: 3 });
    await bd.events(0, 10);
    await bd.queryIssues("status=open AND type=bug", { sort: "priority", limit: 5 });
    await bd.readyCount({ unassigned: true });
    await bd.healthz();
    expect(calls.map((c) => c.url)).toEqual([
      "http://bd/v0/beads/issues/kb-jfq.1?include_comments=true",
      "http://bd/v0/beads/issues/kb-jfq.1:close",
      "http://bd/v0/beads/config/status.custom",
      "http://bd/v0/beads/issues/kb-1/related?direction=out&type=blocks&type=parent-child",
      "http://bd/v0/beads/dependencies/tree?root_id=kb-1&direction=down&max_depth=3",
      "http://bd/v0/beads/events?since=0&limit=10",
      "http://bd/v0/beads/issues:query?sort=priority&limit=5&q=status%3Dopen+AND+type%3Dbug",
      "http://bd/v0/beads/ready:count?unassigned=true",
      "http://bd/healthz",
    ]);
  });

  test("unknown query keys are refused before any request is made", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl });
    // A programmer error: thrown synchronously, before any I/O.
    expect(() => bd.listIssues({ updated_after: "2026-01-01" } as never)).toThrow(/updated_after/);
    expect(calls).toHaveLength(0);
  });

  test("non-2xx → ProblemError with the parsed document", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            code: "invalid_argument",
            status: 400,
            title: "Bad Request",
            param: "limit",
            reason: "invalid_value",
            request_id: "r",
          }),
          { status: 400, headers: { "content-type": "application/problem+json" } },
        ),
    );
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl });
    const err = await bd.listIssues({ limit: -1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect((err as ProblemError).code).toBe("invalid_argument");
    expect((err as ProblemError).problem.reason).toBe("invalid_value");
    expect((err as ProblemError).method).toBe("GET");
  });
});

describe("BdClient writes", () => {
  test("createIssue: JSON body, content-type, actor from the client default", async () => {
    const { calls, fetchImpl } = fakeFetch({ id: "kb-1" });
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    await bd.createIssue({ title: "Epic", issue_type: "epic", priority: 1 });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("http://bd/v0/beads/issues");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({
      actor: "dash",
      title: "Epic",
      issue_type: "epic",
      priority: 1,
    });
  });

  test("an explicit actor wins over the default; a missing actor is a TypeError", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    await bd.closeIssue("kb-1", { actor: "alice", reason: "done" });
    expect(calls[0]?.body).toEqual({ actor: "alice", reason: "done" });

    const anon = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl });
    expect(() => anon.reopenIssue("kb-1")).toThrow(TypeError);
    expect(() => anon.addComment("kb-1", { text: "hi" })).toThrow(/author/);
    expect(calls).toHaveLength(1);
  });

  test("patchIssue is a PATCH with the guard members verbatim; revision stays a string", async () => {
    const rev = "6843131066947791511";
    const { calls, fetchImpl } = fakeFetch({ changed: true, issue: { id: "kb-1" }, revision: rev });
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    const res = await bd.patchIssue("kb-1", {
      expected_version: rev,
      patch: { status: "in_progress", parent_id: "" },
    });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({
      actor: "dash",
      expected_version: rev,
      patch: { status: "in_progress", parent_id: "" },
    });
    expect(res.revision).toBe(rev);
    expect(typeof res.revision).toBe("string");
  });

  test("addComment defaults author from actor; dep add/remove and batches post to custom methods", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    await bd.addComment("kb-1", { text: "hello" });
    await bd.depAdd({ edges: [{ issue_id: "kb-2", depends_on_id: "kb-1", type: "blocks" }] });
    await bd.depRemove({ issue_id: "kb-2", depends_on_id: "kb-1" });
    await bd.batchApply({ items: [{ kind: "close", close: { target: { id: "kb-1" } } }] });
    await bd.batchCreate({ items: [{ title: "a" }] });
    await bd.batchClose({ items: [{ id: "kb-1" }] });
    await bd.claimIssue("kb-1");
    await bd.releaseIssue("kb-1", { force: true });
    expect(calls.map((c) => [c.method, c.url.replace("http://bd/v0/beads", "")])).toEqual([
      ["POST", "/issues/kb-1/comments"],
      ["POST", "/dependencies:add"],
      ["POST", "/dependencies:remove"],
      ["POST", "/issues:batchApply"],
      ["POST", "/issues:batchCreate"],
      ["POST", "/issues:batchClose"],
      ["POST", "/issues/kb-1:claim"],
      ["POST", "/issues/kb-1:release"],
    ]);
    expect(calls[0]?.body).toEqual({ author: "dash", text: "hello" });
    expect(calls[7]?.body).toEqual({ actor: "dash", force: true });
  });

  test("with() derives a client with other defaults", async () => {
    const { calls, fetchImpl } = fakeFetch({});
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl, actor: "dash" });
    await bd.with({ actor: "bob" }).reopenIssue("kb-1");
    expect(calls[0]?.body).toEqual({ actor: "bob" });
  });

  test("a caller signal aborts the request", async () => {
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const bd = new BdClient({ baseUrl: "http://bd", fetch: fetchImpl });
    const controller = new AbortController();
    const pending = bd.context({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
});
