/**
 * Contract tests against a real `bd serve` (beads 1.3.0-rc.2) on a scratch stand.
 * Run: `mise run contract`. Tests in this file run in order and share state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BdClient,
  Capabilities,
  type Context,
  checkVersion,
  type IssueDetails,
  ProblemError,
  problemFromResponse,
  type WatchEvent,
} from "../../src/api-client/index.ts";
import { type Stand, startStand, stopStand } from "./setup.ts";

const BUILT_FOR = "1.3.0-rc.2";
const ACTOR = "bddb-contract";

let stand: Stand;
let bd: BdClient;
let context: Context;
// Ids created by this run (tests run in file order, so later tests read what earlier ones set).
const ids = { epic: "", child: "", blocker: "", blocked: "" };
let childDetails: IssueDetails;
let staleRevision: string;

beforeAll(async () => {
  stand = await startStand();
  bd = new BdClient({ baseUrl: stand.baseUrl, actor: ACTOR, timeoutMs: 10_000 });
}, 90_000);

afterAll(async () => {
  if (stand) await stopStand(stand);
}, 60_000);

async function expectProblem(promise: Promise<unknown>): Promise<ProblemError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProblemError);
  return err as ProblemError;
}

describe("handshake", () => {
  test("healthz is live", async () => {
    expect(await bd.healthz()).toEqual({ status: "ok" });
  });

  test("context: api_version v0, capabilities include the operations we use", async () => {
    context = await bd.context();
    expect(context.api_version).toBe("v0");
    expect(context.backend).toBe("dolt");
    expect(context.dolt_mode).toBe("server");
    expect(context.project_id).not.toBe("");
    const caps = Capabilities.fromContext(context);
    expect(
      caps.missing([
        "issues.list",
        "issues.get",
        "issues.query",
        "issues.create",
        "issues.update",
        "issues.close",
        "issues.reopen",
        "issues.addComment",
        "issues.batchApply",
        "ready.list",
        "ready.count",
        "dependencies.tree",
        "dependencies.add",
        "dependencies.remove",
        "stats.get",
        "config.list",
        "config.get",
        "events.list",
        "events.watch",
        "project.enforce",
      ]),
    ).toEqual([]);
    const version = checkVersion(context.bd_version, BUILT_FOR);
    expect(version.ok).toBe(true);
  });

  test("ready?limit=1 is the readiness probe", async () => {
    const page = await bd.ready({ limit: 1 });
    expect(page).toHaveProperty("items");
    expect(page).toHaveProperty("has_more");
  });

  test("Bd-Project-Id: the right id is accepted, a wrong one is 400 project_mismatch", async () => {
    const stamped = bd.with({ projectId: context.project_id });
    expect((await stamped.context()).project_id).toBe(context.project_id);
    await stamped.ready({ limit: 1 });
    const wrong = bd.with({ projectId: "00000000-0000-0000-0000-000000000000" });
    const err = await expectProblem(wrong.ready({ limit: 1 }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_argument");
    expect(err.problem.reason).toBe("project_mismatch");
    expect(err.problem.param).toBe("Bd-Project-Id");
    expect(err.problem.server_project_id).toBe(context.project_id);
  });

  test("an unknown query parameter is 400 unknown_parameter (raw request; the client refuses it locally)", async () => {
    const res = await fetch(`${stand.apiUrl}/issues?nosuch=1`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const err = await problemFromResponse(res);
    expect(err.code).toBe("invalid_argument");
    expect(err.problem.param).toBe("nosuch");
    expect(err.problem.reason).toBe("unknown_parameter");
  });
});

describe("issues: create, list, get, guarded patch", () => {
  test("create an epic and a child (hierarchical id)", async () => {
    const epic = await bd.createIssue({ title: "Contract epic", issue_type: "epic", priority: 1 });
    expect(epic.issue_type).toBe("epic");
    expect(epic.status).toBe("open");
    ids.epic = epic.id;
    const child = await bd.createIssue({
      title: "Contract child",
      issue_type: "task",
      parent_id: epic.id,
      labels: ["ui"],
    });
    expect(child.id.startsWith(`${epic.id}.`)).toBe(true);
    ids.child = child.id;
  });

  test("list returns {items, has_more}; rows carry parent and counts but no revision", async () => {
    const page = await bd.listIssues({ parent: ids.epic, limit: 0 });
    expect(page.has_more).toBe(false);
    expect(Array.isArray(page.items)).toBe(true);
    const row = page.items.find((i) => i.id === ids.child);
    expect(row).toBeDefined();
    expect(row?.parent).toBe(ids.epic);
    expect(row?.labels).toEqual(["ui"]);
    expect(typeof row?.dependency_count).toBe("number");
    expect("revision" in (row ?? {})).toBe(false);

    const all = await bd.listIssues({ limit: 0, brief: true });
    expect(all.items.map((i) => i.id)).toEqual(expect.arrayContaining([ids.epic, ids.child]));
  });

  test("getIssue: revision is a string; parent is set", async () => {
    childDetails = await bd.getIssue(ids.child);
    expect(typeof childDetails.revision).toBe("string");
    expect(childDetails.revision.length).toBeGreaterThan(0);
    expect(childDetails.parent).toBe(ids.epic);
    expect(childDetails.id).toBe(ids.child);
  });

  test("guarded PATCH succeeds, then a stale revision is 409 precondition_failed", async () => {
    staleRevision = childDetails.revision;
    const res = await bd.patchIssue(ids.child, {
      expected_version: staleRevision,
      patch: { status: "in_progress", priority: 0 },
    });
    expect(res.changed).toBe(true);
    expect(res.issue.status).toBe("in_progress");
    expect(res.issue.priority).toBe(0);
    expect(typeof res.revision).toBe("string");
    expect(res.revision).not.toBe(staleRevision);

    const err = await expectProblem(
      bd.patchIssue(ids.child, {
        expected_version: staleRevision,
        patch: { title: "must not be written" },
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("precondition_failed");
    expect(err.class).toBe("conflict");
    expect(err.problem.param).toBe("expected_version");
    expect(err.problem.expected_version).toBe(staleRevision);
    const after = await bd.getIssue(ids.child);
    expect(after.title).toBe("Contract child");
    expect(after.revision).toBe(res.revision);
  });

  test("an empty patch is 400", async () => {
    const err = await expectProblem(bd.patchIssue(ids.child, { patch: {} }));
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_argument");
  });

  test("getIssue on an unknown id is 404 not_found", async () => {
    const err = await expectProblem(bd.getIssue("nope-000"));
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
  });

  test("issues:query finds the epic", async () => {
    const page = await bd.queryIssues("type=epic", { sort: "created" });
    expect(page.items.map((i) => i.id)).toContain(ids.epic);
  });
});

describe("close / reopen", () => {
  test("closing an epic with an open child is 409 not_closable with open_children", async () => {
    const err = await expectProblem(bd.closeIssue(ids.epic));
    expect(err.status).toBe(409);
    expect(err.code).toBe("not_closable");
    expect(err.problem.open_children).toBe(1);
  });

  test("close the child, then the epic; a repeat close is already_closed", async () => {
    const child = await bd.closeIssue(ids.child, { reason: "contract done" });
    expect(child.issue.status).toBe("closed");
    expect(child.already_closed).toBe(false);
    expect(child.issue.close_reason).toBe("contract done");
    const epic = await bd.closeIssue(ids.epic);
    expect(epic.issue.status).toBe("closed");
    expect(epic.open_children).toBe(0);
    const again = await bd.closeIssue(ids.epic);
    expect(again.already_closed).toBe(true);
  });

  test("closed issues leave the default list and come back with status=closed", async () => {
    const open = await bd.listIssues({ limit: 0 });
    expect(open.items.map((i) => i.id)).not.toContain(ids.epic);
    const closed = await bd.listIssues({ status: ["closed"], limit: 0 });
    expect(closed.items.map((i) => i.id)).toEqual(expect.arrayContaining([ids.epic, ids.child]));
  });

  test("reopen the epic; a repeat reopen is already_open", async () => {
    const res = await bd.reopenIssue(ids.epic, { reason: "more work" });
    expect(res.issue.status).toBe("open");
    expect(res.already_open).toBe(false);
    expect(typeof res.revision).toBe("string");
    const again = await bd.reopenIssue(ids.epic);
    expect(again.already_open).toBe(true);
  });
});

describe("comments", () => {
  test("add a comment and read it back with include_comments", async () => {
    const comment = await bd.addComment(ids.epic, { text: "hello from the contract test" });
    expect(comment.author).toBe(ACTOR);
    expect(comment.issue_id).toBe(ids.epic);
    const details = await bd.getIssue(ids.epic, { include_comments: true });
    expect(details.comments?.map((c) => c.text)).toEqual(["hello from the contract test"]);
    expect(details.comment_count).toBe(1);
    const brief = await bd.getIssue(ids.epic);
    expect(brief.comments ?? []).toEqual([]);
  });
});

describe("dependencies", () => {
  test("dependencies:add blocks; ready excludes the blocked issue; blocking annotations name the blocker", async () => {
    const blocker = await bd.createIssue({ title: "Contract blocker", issue_type: "task" });
    const blocked = await bd.createIssue({ title: "Contract blocked", issue_type: "task" });
    ids.blocker = blocker.id;
    ids.blocked = blocked.id;
    const added = await bd.depAdd({
      edges: [{ issue_id: blocked.id, depends_on_id: blocker.id, type: "blocks" }],
    });
    expect(added.added).toEqual([
      { issue_id: blocked.id, depends_on_id: blocker.id, type: "blocks" },
    ]);

    const ready = await bd.ready({ limit: 0 });
    const readyIds = ready.items.map((i) => i.id);
    expect(readyIds).toContain(blocker.id);
    expect(readyIds).not.toContain(blocked.id);

    const count = await bd.readyCount();
    expect(count.total).toBe(readyIds.length);

    const blocking = await bd.dependenciesBlocking({ issue_id: [blocked.id] });
    expect(blocking.items).toEqual([
      expect.objectContaining({ id: blocked.id, blocked_by: [blocker.id] }),
    ]);

    const details = await bd.getIssue(blocked.id);
    expect(details.dependencies?.map((d) => [d.id, d.dependency_type])).toEqual([
      [blocker.id, "blocks"],
    ]);

    const related = await bd.related(blocked.id, { direction: "out" });
    expect(related.items.map((i) => [i.id, i.dependency_type])).toEqual([[blocker.id, "blocks"]]);
  });

  test("adding the same pair with another type is 409 dependency_exists", async () => {
    const err = await expectProblem(
      bd.depAdd({
        edges: [{ issue_id: ids.blocked, depends_on_id: ids.blocker, type: "related" }],
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("dependency_exists");
    expect(err.problem.existing_type).toBe("blocks");
    expect(err.problem.requested_type).toBe("related");
  });

  test("dependencies/tree: children are DEPENDENTS of the epic (parent-child points child → parent)", async () => {
    // `down` follows what the root depends on; an epic depends on nothing, so its children
    // are not reached. Verified on bd 1.3.0-rc.2: `down` from an epic returns only the root.
    const down = await bd.dependencyTree({ root_id: ids.epic, direction: "down" });
    expect(down.items.map((n) => n.id)).toEqual([ids.epic]);

    const both = await bd.dependencyTree({ root_id: ids.epic, direction: "both" });
    expect(both.has_more).toBe(false);
    const byId = new Map(both.items.map((n) => [n.id, n]));
    expect(byId.get(ids.epic)?.depth).toBe(0);
    const child = byId.get(ids.child);
    expect(child?.depth).toBe(1);
    expect(child?.parent_id).toBe(ids.epic);
    expect(child?.edge_from_parent).toBe("parent-child");

    // `up` = dependents, so from the epic it reaches the child too.
    const up = await bd.dependencyTree({ root_id: ids.epic, direction: "up" });
    expect(up.items.map((n) => n.id)).toEqual(expect.arrayContaining([ids.epic, ids.child]));

    // and from the child, `down` reaches the parent epic
    const fromChild = await bd.dependencyTree({ root_id: ids.child, direction: "down" });
    expect(fromChild.items.map((n) => n.id)).toEqual(expect.arrayContaining([ids.child, ids.epic]));
  });

  test("dependencies:remove unblocks", async () => {
    const removed = await bd.depRemove({
      issue_id: ids.blocked,
      depends_on_id: ids.blocker,
    });
    expect(removed.removed).toBe(true);
    const ready = await bd.ready({ limit: 0 });
    expect(ready.items.map((i) => i.id)).toContain(ids.blocked);
  });

  test("batchApply closes two issues in one transaction", async () => {
    const res = await bd.batchApply({
      items: [
        { kind: "close", close: { target: { id: ids.blocker }, reason: "batch" } },
        { kind: "close", close: { target: { id: ids.blocked } } },
      ],
    });
    expect(res.items.map((i) => [i.kind, i.issue_id, i.changed])).toEqual([
      ["close", ids.blocker, true],
      ["close", ids.blocked, true],
    ]);
    expect(res.items.every((i) => typeof i.revision === "string")).toBe(true);
  });
});

describe("stats and config", () => {
  test("stats summary counts what we created", async () => {
    const stats = await bd.stats();
    expect(stats.summary.total_issues).toBeGreaterThanOrEqual(4);
    expect(stats.summary.closed_issues).toBeGreaterThanOrEqual(3);
    expect(typeof stats.blocked_count_skipped).toBe("boolean");
  });

  test("config lists issue_prefix; status.custom is present without a value", async () => {
    const config = await bd.config();
    expect(config.items.map((c) => c.key)).toContain("issue_prefix");
    const custom = await bd.configKey("status.custom");
    expect(custom.key).toBe("status.custom");
    expect(custom.value).toBeUndefined();
  });
});

describe("events journal", () => {
  let head = 0;

  test("events?since=0 returns records and head; the first record is the epic's create", async () => {
    const page = await bd.events(0);
    expect(page.records.length).toBeGreaterThan(0);
    expect(page.records[0]?.seq).toBe(1);
    expect(page.records[0]?.op).toBe("create");
    expect(page.records[0]?.issue_id).toBe(ids.epic);
    expect(page.records[0]?.actor).toBe(ACTOR);
    expect(page.records[0]?.issue?.id).toBe(ids.epic);
    head = page.head;
    expect(head).toBe(page.records.at(-1)?.seq as number);
    const ops = new Set(page.records.map((r) => r.op));
    expect([...ops]).toEqual(
      expect.arrayContaining(["create", "update", "close", "dep_add", "dep_remove", "comment"]),
    );
    const depAdd = page.records.find((r) => r.op === "dep_add" && r.issue_id === ids.blocked);
    expect(depAdd?.dep).toEqual(expect.objectContaining({ kind: "blocks", target: ids.blocker }));
  });

  test("events?since=head is an empty page (caught up); limit pages the log", async () => {
    const empty = await bd.events(head);
    expect(empty.records).toEqual([]);
    expect(empty.head).toBe(head);
    const two = await bd.events(0, 2);
    expect(two.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(two.head).toBe(head);
  });

  test("events:watch delivers a create record for an issue created after connecting", async () => {
    const controller = new AbortController();
    const received: WatchEvent[] = [];
    let createdId = "";
    const done = new Promise<WatchEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no record within 10 s")), 10_000);
      (async () => {
        try {
          for await (const ev of bd.watchEvents({ since: head, signal: controller.signal })) {
            received.push(ev);
            if (
              ev.type === "record" &&
              ev.record.op === "create" &&
              ev.record.issue_id === createdId
            ) {
              clearTimeout(timer);
              resolve(ev);
              return;
            }
          }
          reject(new Error("stream ended before the record arrived"));
        } catch (err) {
          reject(err);
        }
      })();
    });
    // Give the stream a moment to connect, then mutate.
    await Bun.sleep(200);
    const created = await bd.createIssue({ title: "Contract live", issue_type: "chore" });
    createdId = created.id;
    const ev = await done;
    controller.abort();
    expect(ev.type).toBe("record");
    if (ev.type === "record") {
      expect(ev.seq).toBe(head + 1);
      expect(ev.record.seq).toBe(head + 1);
      expect(ev.record.issue?.title).toBe("Contract live");
      expect(ev.record.actor).toBe(ACTOR);
    }
    expect(received[0]).toEqual({ type: "retry", ms: 3000 });
    head += 1;
  });

  test("Last-Event-ID wins over since as the resume point", async () => {
    const controller = new AbortController();
    const first: WatchEvent[] = [];
    for await (const ev of bd.watchEvents({
      since: 0,
      lastEventId: head - 1,
      signal: controller.signal,
    })) {
      first.push(ev);
      if (ev.type === "record") break;
    }
    controller.abort();
    const record = first.find((e) => e.type === "record");
    expect(record?.type).toBe("record");
    if (record?.type === "record") expect(record.seq).toBe(head);
  });
});
