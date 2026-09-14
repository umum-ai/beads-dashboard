/**
 * Editing e2e (stage 5): drag-and-drop between priority sections, status columns and into
 * Closed (reason / force dialogs), inline editing in the drawer with the stale-revision conflict
 * dialog, comments, the "New issue" modal and query mode. Every test creates its own issues
 * through the BFF write proxies, so the same file runs against the mock (in its `sandbox`
 * database, leaving the `siam_platform` fixture untouched for the other specs) and a real stand
 * (`E2E_TARGET=real`, `E2E_DB`, where the rows come back through the bd event journal).
 */
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { columnOf, dragCardTo, DB as MAIN_DB, MOCK, sectionZone } from "./helpers.ts";

/** On the mock the edits go to the second database, so the fixture-specific specs keep their counts. */
const DB = MOCK ? "sandbox" : MAIN_DB;
const ACTOR = "e2e";
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

interface Created {
  id: string;
  title: string;
}

async function createIssue(
  request: APIRequestContext,
  over: Record<string, unknown> = {},
): Promise<Created> {
  const title = typeof over.title === "string" ? over.title : `E2E ${stamp()}`;
  const res = await request.post(`/api/p/${DB}/issues`, {
    data: { actor: ACTOR, title, issue_type: "task", priority: 2, status: "open", ...over },
  });
  if (!res.ok()) throw new Error(`create: HTTP ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, title };
}

async function getIssue(request: APIRequestContext, id: string): Promise<Record<string, unknown>> {
  const res = await request.get(`/api/p/${DB}/issues/${encodeURIComponent(id)}`);
  if (!res.ok()) throw new Error(`get: HTTP ${res.status()}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Poll the BFF until `field` of the issue equals `value` (writes on a real stand take a moment). */
function eventually(request: APIRequestContext, id: string, field: string) {
  return expect.poll(async () => (await getIssue(request, id))[field], { timeout: 10_000 });
}

/**
 * Open a card's menu and pick an item. Under heavy live traffic (parallel tests writing to the
 * same database) a delta can re-render the card while the menu is open; the pick is retried.
 */
async function pickFromMenu(page: Page, card: Locator, itemId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await card.getByTestId("card-menu").click();
    const item = page.getByTestId("card-menu-panel").getByTestId(itemId);
    try {
      await item.click({ timeout: 3000 });
      return;
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
  throw new Error(`menu item ${itemId} could not be picked`);
}

function cardOf(page: Page, id: string): Locator {
  return page.locator(`[data-testid="card"][data-id="${id}"]`);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/p/${DB}/board`);
  await expect(page.getByTestId("board")).toBeVisible();
  // the flat board keeps the layout simple for pointer maths; the swimlane drop is tested on its own
  const toggle = page.getByTestId("group-by-epic");
  if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
  await expect(page.locator(".board--lanes")).toHaveCount(0);
}

test.use({ viewport: { width: 1900, height: 1000 } });

test.describe("drag and drop", () => {
  test("to another priority section → the priority chip changes", async ({ page, request }) => {
    const issue = await createIssue(request, { priority: 3 });
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByTestId("card-priority")).toHaveText("P3");
    await dragCardTo(page, card, sectionZone(page, "open", 1));
    await expect(card.getByTestId("card-priority")).toHaveText("P1");
    await expect.poll(async () => (await getIssue(request, issue.id)).priority).toBe(1);
    expect(await columnOf(card)).toBe("open");
  });

  test("to another status column → the card changes column (status + priority in one patch)", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request, { priority: 2 });
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await dragCardTo(page, card, sectionZone(page, "in_progress", 0));
    await expect.poll(() => columnOf(card)).toBe("in_progress");
    await expect(card.getByTestId("card-priority")).toHaveText("P0");
    await eventually(request, issue.id, "status").toBe("in_progress");
    await eventually(request, issue.id, "priority").toBe(0);
  });

  test("into Closed → reason dialog → confirm → closed with the reason", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request);
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await dragCardTo(page, card, sectionZone(page, "closed", 2));
    const dialog = page.getByTestId("close-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(issue.id);
    await expect(dialog.getByTestId("dialog-actor")).toBeVisible();
    await dialog.getByTestId("close-reason").fill("closed from the board");
    await dialog.getByTestId("close-confirm").click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => columnOf(card), { timeout: 10_000 }).toBe("closed");
    await eventually(request, issue.id, "status").toBe("closed");
    await eventually(request, issue.id, "close_reason").toBe("closed from the board");
    // the drawer shows the reason
    await card.getByTestId("card-title").click();
    await expect(page.getByTestId("detail-close-reason")).toContainText("closed from the board");
  });

  test("cancelling the reason dialog leaves the card where it was", async ({ page, request }) => {
    const issue = await createIssue(request);
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await dragCardTo(page, card, sectionZone(page, "closed", 2));
    await expect(page.getByTestId("close-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("close-dialog")).toBeHidden();
    expect(await columnOf(card)).toBe("open");
    expect((await getIssue(request, issue.id)).status).toBe("open");
  });

  test("an epic with an open child → force dialog → close with force", async ({
    page,
    request,
  }) => {
    const epic = await createIssue(request, { issue_type: "epic", priority: 1 });
    const child = await createIssue(request, { parent_id: epic.id });
    await openBoard(page);
    const card = cardOf(page, epic.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(cardOf(page, child.id)).toBeVisible({ timeout: 10_000 });
    await dragCardTo(page, card, sectionZone(page, "closed", 1));
    await page.getByTestId("close-dialog").getByTestId("close-confirm").click();
    const force = page.getByTestId("force-dialog");
    await expect(force).toBeVisible();
    await expect(force.getByTestId("force-body")).toContainText("1 open child");
    await force.getByTestId("force-confirm").click();
    await expect(force).toBeHidden();
    await expect.poll(() => columnOf(card), { timeout: 10_000 }).toBe("closed");
    await eventually(request, epic.id, "status").toBe("closed");
  });

  test("declining force keeps the epic open", async ({ page, request }) => {
    const epic = await createIssue(request, { issue_type: "epic", priority: 1 });
    await createIssue(request, { parent_id: epic.id });
    await openBoard(page);
    const card = cardOf(page, epic.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await dragCardTo(page, card, sectionZone(page, "closed", 1));
    await page.getByTestId("close-dialog").getByTestId("close-confirm").click();
    await expect(page.getByTestId("force-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("force-dialog")).toBeHidden();
    await expect.poll(() => columnOf(card)).toBe("open");
    expect((await getIssue(request, epic.id)).status).toBe("open");
  });

  test("out of Closed → reopened (into a non-open column: reopen + status patch)", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request);
    const close = await request.post(`/api/p/${DB}/issues/${issue.id}/close`, {
      data: { actor: ACTOR, reason: "pre-closed" },
    });
    expect(close.ok()).toBe(true);
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => columnOf(card)).toBe("closed");
    await dragCardTo(page, card, sectionZone(page, "in_progress", 2));
    await expect.poll(() => columnOf(card), { timeout: 10_000 }).toBe("in_progress");
    await eventually(request, issue.id, "status").toBe("in_progress");
    await eventually(request, issue.id, "close_reason").toBeFalsy();
  });

  test("onto another epic's lane → the parent changes", async ({ page, request }) => {
    const epic = await createIssue(request, {
      issue_type: "epic",
      priority: 1,
      title: `E2E lane ${stamp()}`,
    });
    await createIssue(request, { parent_id: epic.id }); // gives the lane a child so it exists
    const loose = await createIssue(request);
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("board")).toBeVisible();
    const toggle = page.getByTestId("group-by-epic");
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    const card = cardOf(page, loose.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    const lane = page.locator(`[data-testid="lane"][data-lane="${epic.id}"]`);
    await expect(lane).toBeVisible();
    await dragCardTo(page, card, lane, { x: 300, y: 18 });
    await expect(card.locator("xpath=ancestor::*[@data-testid='lane-cell']")).toHaveAttribute(
      "data-lane",
      epic.id,
      { timeout: 10_000 },
    );
    await expect.poll(async () => (await getIssue(request, loose.id)).parent).toBe(epic.id);
  });

  test("multi-select (Shift-click) + drag → both cards move", async ({ page, request }) => {
    const a = await createIssue(request, { priority: 3 });
    const b = await createIssue(request, { priority: 3 });
    await openBoard(page);
    const cardA = cardOf(page, a.id);
    const cardB = cardOf(page, b.id);
    await expect(cardA).toBeVisible({ timeout: 10_000 });
    await expect(cardB).toBeVisible({ timeout: 10_000 });
    await cardA.getByTestId("card-title").click({ modifiers: ["Shift"] });
    await cardB.getByTestId("card-title").click({ modifiers: ["Shift"] });
    await expect(page.getByTestId("selection-bar")).toContainText("2 selected");
    await dragCardTo(page, cardA, sectionZone(page, "in_progress", 3));
    await expect.poll(() => columnOf(cardA), { timeout: 10_000 }).toBe("in_progress");
    await expect.poll(() => columnOf(cardB), { timeout: 10_000 }).toBe("in_progress");
    await eventually(request, b.id, "status").toBe("in_progress");
  });

  test("card menu is the keyboard alternative: move to status / set priority", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request);
    await openBoard(page);
    const card = cardOf(page, issue.id);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await pickFromMenu(page, card, "menu-status-in_progress");
    await expect.poll(() => columnOf(card), { timeout: 10_000 }).toBe("in_progress");
    await eventually(request, issue.id, "status").toBe("in_progress");
    await pickFromMenu(page, card, "menu-priority-0");
    await expect(card.getByTestId("card-priority")).toHaveText("P0");
    await eventually(request, issue.id, "priority").toBe(0);
    // a done status from the menu asks for the reason too
    await pickFromMenu(page, card, "menu-status-closed");
    await expect(page.getByTestId("close-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test.describe("detail panel", () => {
  test("edit title → saved", async ({ page, request }) => {
    const issue = await createIssue(request);
    await page.goto(`/p/${DB}/issue/${issue.id}`);
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(issue.title);
    await panel.getByTestId("edit-title").click();
    await panel.getByTestId("title-input").fill(`${issue.title} (edited)`);
    await panel.getByTestId("save-title").click();
    await expect(panel.getByTestId("detail-title")).toHaveText(`${issue.title} (edited)`);
    await eventually(request, issue.id, "title").toBe(`${issue.title} (edited)`);
  });

  test("saving with a stale revision → conflict dialog → Overwrite wins, Reload adopts theirs", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request);
    await page.goto(`/p/${DB}/issue/${issue.id}`);
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(issue.title);
    await panel.getByTestId("edit-title").click(); // holds the revision while editing
    // someone else writes first
    const other = await request.patch(`/api/p/${DB}/issues/${issue.id}`, {
      data: { actor: "someone-else", patch: { title: "Theirs" } },
    });
    expect(other.ok()).toBe(true);
    await panel.getByTestId("title-input").fill("Mine");
    await panel.getByTestId("save-title").click();
    const conflict = page.getByTestId("conflict-dialog");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("Changed by someone else");
    await conflict.getByTestId("conflict-overwrite").click();
    await expect(conflict).toBeHidden();
    await expect(panel.getByTestId("detail-title")).toHaveText("Mine");
    await expect.poll(async () => (await getIssue(request, issue.id)).title).toBe("Mine");

    // second round: Reload discards the local edit and shows the other writer's title
    await panel.getByTestId("edit-title").click();
    await request.patch(`/api/p/${DB}/issues/${issue.id}`, {
      data: { actor: "someone-else", patch: { title: "Theirs again" } },
    });
    await panel.getByTestId("title-input").fill("Mine again");
    await panel.getByTestId("save-title").click();
    await expect(conflict).toBeVisible();
    await conflict.getByTestId("conflict-reload").click();
    await expect(panel.getByTestId("detail-title")).toHaveText("Theirs again");
    await eventually(request, issue.id, "title").toBe("Theirs again");
  });

  test("add a comment → listed with the actor as author", async ({ page, request }) => {
    const issue = await createIssue(request);
    await page.goto(`/p/${DB}/issue/${issue.id}`);
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(issue.title);
    const form = panel.getByTestId("comment-form");
    await form.getByTestId("mde-text").fill("First **comment**");
    await form.getByTestId("comment-submit").click();
    const comments = panel.getByTestId("detail-comments").getByTestId("comment");
    await expect(comments).toHaveCount(1, { timeout: 10_000 });
    await expect(comments.first()).toContainText("bddb"); // default actor
    await expect(comments.first().locator("strong")).toHaveText("comment");
  });

  test("labels, priority and status select save through the same guarded patch", async ({
    page,
    request,
  }) => {
    const issue = await createIssue(request);
    await page.goto(`/p/${DB}/issue/${issue.id}`);
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(issue.title);
    await panel.getByTestId("label-input").fill("e2e-label");
    await panel.getByTestId("label-input").press("Enter");
    await expect(panel.getByTestId("detail-labels")).toContainText("e2e-label");
    await panel.getByTestId("detail-priority-select").selectOption("0");
    await expect(panel.getByTestId("detail-priority")).toHaveText("P0");
    await panel.getByTestId("detail-status-select").selectOption("in_progress");
    await expect(panel.getByTestId("detail-status")).toHaveText("In progress", { timeout: 10_000 });
    await eventually(request, issue.id, "labels").toEqual(["e2e-label"]);
    await eventually(request, issue.id, "priority").toBe(0);
    await eventually(request, issue.id, "status").toBe("in_progress");
  });

  test("blocks dependency: add through the picker, remove again", async ({ page, request }) => {
    const a = await createIssue(request, { title: `E2E dep target ${stamp()}` });
    const b = await createIssue(request);
    await page.goto(`/p/${DB}/issue/${b.id}`);
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(b.title);
    await panel.getByTestId("add-dependsOn").click();
    await panel.getByTestId("dep-picker-dependsOn-input").fill(a.id);
    await panel.locator(`.picker__option[data-id="${a.id}"]`).click();
    const list = panel.getByTestId("detail-dependencies");
    await expect(list.locator(`li[data-id="${a.id}"]`)).toBeVisible({ timeout: 10_000 });
    await list.locator(`li[data-id="${a.id}"]`).getByTestId("dep-remove").click();
    await expect(list.locator(`li[data-id="${a.id}"]`)).toHaveCount(0, { timeout: 10_000 });
  });
});

test.describe("create and query", () => {
  test("New issue modal creates the issue and opens its drawer", async ({ page, request }) => {
    await openBoard(page);
    await page.getByTestId("new-issue").click();
    const dialog = page.getByTestId("create-dialog");
    await expect(dialog).toBeVisible();
    const title = `E2E created ${stamp()}`;
    await dialog.getByTestId("create-title").fill(title);
    await dialog.getByTestId("create-type").selectOption("bug");
    await dialog.getByTestId("create-priority").selectOption("1");
    await dialog.getByTestId("create-labels").getByTestId("label-input").fill("from-modal");
    await dialog.getByTestId("create-labels").getByTestId("label-input").press("Enter");
    await dialog.getByTestId("create-submit").click();
    await expect(dialog).toBeHidden();
    const panel = page.getByTestId("detail-panel");
    await expect(panel.getByTestId("detail-title")).toHaveText(title);
    await expect(page).toHaveURL(/\/issue\//);
    const id = (await panel.getAttribute("data-id")) as string;
    const row = await getIssue(request, id);
    expect(row.issue_type).toBe("bug");
    expect(row.priority).toBe(1);
    expect(row.labels).toEqual(["from-modal"]);
    await page.keyboard.press("Escape");
    await expect(cardOf(page, id)).toBeVisible({ timeout: 10_000 });
  });

  test("the column '+' prefills the status", async ({ page }) => {
    await openBoard(page);
    await page
      .locator('[data-testid="column"][data-status="in_progress"]')
      .getByTestId("column-add")
      .click();
    await expect(page.getByTestId("create-dialog").getByTestId("create-status")).toHaveValue(
      "in_progress",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("create-dialog")).toBeHidden();
  });

  test("query mode: an invalid expression shows the server's error under the field", async ({
    page,
  }) => {
    await openBoard(page);
    await page.getByTestId("query-toggle").click();
    const bar = page.getByTestId("query-bar");
    await bar.getByTestId("query-input").fill("this is not a query ???");
    await bar.getByTestId("query-run").click();
    await expect(bar.getByTestId("query-error")).toBeVisible();
    await expect(bar.getByTestId("query-error")).toContainText("Invalid expression");
    await expect(page).toHaveURL(/[?&]query=/);
  });

  test("query mode: a valid expression replaces the board's issue set", async ({
    page,
    request,
  }) => {
    const hit = await createIssue(request, { priority: 0, labels: ["e2e-query"] });
    const miss = await createIssue(request, { priority: 4, labels: ["e2e-query"] });
    await openBoard(page);
    await expect(cardOf(page, miss.id)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("query-toggle").click();
    const bar = page.getByTestId("query-bar");
    await bar.getByTestId("query-input").fill("label=e2e-query AND priority<=1");
    await bar.getByTestId("query-run").click();
    await expect(bar.getByTestId("query-status")).toContainText("Query mode");
    await expect(cardOf(page, hit.id)).toBeVisible();
    await expect(cardOf(page, miss.id)).toHaveCount(0);
    // the expression survives a reload through the URL
    await page.reload();
    await expect(page.getByTestId("query-status")).toContainText("Query mode");
    await expect(cardOf(page, miss.id)).toHaveCount(0);
    await page.getByTestId("query-clear").click();
    await expect(cardOf(page, miss.id)).toBeVisible();
  });

  test("Russian strings cover the new controls", async ({ page }) => {
    test.skip(!MOCK, "language toggle is covered on the mock");
    await openBoard(page);
    await page.getByTestId("lang-toggle").click();
    await expect(page.getByTestId("new-issue")).toHaveText("+ Новая");
    await expect(page.getByTestId("query-toggle")).toContainText("Запрос");
    await page.getByTestId("lang-toggle").click();
  });
});
