import { describe, expect, test } from "bun:test";
import {
  isProblem,
  isProblemClass,
  isProblemCode,
  ProblemError,
  parseRetryAfter,
  problemClass,
  problemFromBody,
  problemFromResponse,
} from "../../../src/api-client/index.ts";

const notClosable = {
  code: "not_closable",
  detail: "issue has open children; close them first or close with force",
  open_children: 1,
  request_id: "ac1f4573-000006",
  status: 409,
  title: "Conflict",
};

describe("problemClass", () => {
  test("maps the v0 status vocabulary", () => {
    expect(problemClass(400)).toBe("invalid");
    expect(problemClass(401)).toBe("unauthenticated");
    expect(problemClass(404)).toBe("not_found");
    expect(problemClass(409)).toBe("conflict");
    expect(problemClass(410)).toBe("gone");
    expect(problemClass(503)).toBe("unavailable");
    expect(problemClass(500)).toBe("server");
    expect(problemClass(502)).toBe("server");
    expect(problemClass(422)).toBe("client");
    expect(problemClass(200)).toBe("unknown");
  });
});

describe("problemFromBody", () => {
  test("parses application/problem+json and keeps extension members", () => {
    const p = problemFromBody(
      409,
      "Conflict",
      "application/problem+json",
      JSON.stringify(notClosable),
    );
    expect(p).toEqual(notClosable);
    expect(p.open_children).toBe(1);
  });

  test("accepts a JSON body with a string code under a plain json media type", () => {
    const p = problemFromBody(
      404,
      "Not Found",
      "application/json; charset=utf-8",
      '{"code":"not_found","status":404}',
    );
    expect(p.code).toBe("not_found");
    expect(p.title).toBe("Not Found");
    expect(p.request_id).toBe("");
  });

  test("synthesizes for non-problem bodies: internal for 5xx, non_problem_response otherwise", () => {
    const html = problemFromBody(502, "Bad Gateway", "text/html", "<html>nginx</html>");
    expect(html.code).toBe("internal");
    expect(html.status).toBe(502);
    expect(html.synthesized).toBe(true);
    expect(html.body).toBe("<html>nginx</html>");

    const notFound = problemFromBody(404, "Not Found", "text/plain", "no such route");
    expect(notFound.code).toBe("non_problem_response");
    expect(notFound.title).toBe("Not Found");

    const broken = problemFromBody(500, "", "application/json", "{not json");
    expect(broken.code).toBe("internal");
    expect(broken.title).toBe("HTTP 500");

    const noCode = problemFromBody(400, "Bad Request", "application/json", '{"error":"x"}');
    expect(noCode.code).toBe("non_problem_response");
  });
});

describe("parseRetryAfter", () => {
  test("delta seconds, HTTP-date, absent and garbage", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const now = Date.parse("2026-09-14T10:00:00Z");
    expect(parseRetryAfter("Mon, 14 Sep 2026 10:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Mon, 14 Sep 2026 09:00:00 GMT", now)).toBe(0);
  });
});

describe("ProblemError", () => {
  test("carries problem, status, code, class and a readable message", async () => {
    const response = new Response(JSON.stringify(notClosable), {
      status: 409,
      statusText: "Conflict",
      headers: { "content-type": "application/problem+json" },
    });
    const err = await problemFromResponse(response, {
      method: "POST",
      url: "http://bd/v0/beads/issues/kb-1:close",
    });
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ProblemError");
    expect(err.status).toBe(409);
    expect(err.code).toBe("not_closable");
    expect(err.class).toBe("conflict");
    expect(err.problem.open_children).toBe(1);
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.message).toContain("409 not_closable");
    expect(err.message).toContain("POST http://bd/v0/beads/issues/kb-1:close");
    expect(isProblemCode(err, "not_closable")).toBe(true);
    expect(isProblemCode(err, "not_found")).toBe(false);
    expect(isProblemCode(new Error("x"), "not_closable")).toBe(false);
    expect(isProblemClass(err, "conflict")).toBe(true);
    expect(isProblem(err.problem)).toBe(true);
    expect(isProblem({ code: 1 })).toBe(false);
  });

  test("reads Retry-After on a 503", async () => {
    const response = new Response(
      JSON.stringify({ code: "db_unavailable", status: 503, title: "x", request_id: "r" }),
      {
        status: 503,
        headers: { "content-type": "application/problem+json", "retry-after": "2" },
      },
    );
    const err = await problemFromResponse(response);
    expect(err.code).toBe("db_unavailable");
    expect(err.retryAfterMs).toBe(2000);
    expect(err.class).toBe("unavailable");
  });
});
