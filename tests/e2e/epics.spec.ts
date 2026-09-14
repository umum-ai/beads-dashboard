/**
 * Hierarchy and epics e2e (stage 4). Fixture-specific checks run on the mock; the tests marked
 * "real" also run against a real BFF (`E2E_TARGET=real`) and pick an epic that has children
 * from the snapshot — `scripts/stand.sh seed` creates one ("Seed epic" with two children).
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { DB, MOCK } from "./helpers.ts";

interface Row {
  id: string;
  title: string;
  status?: string;
  issue_type?: string;
  parent?: string;
  blocked: boolean;
  child_count?: number;
  child_closed_count?: number;
}

async function rows(request: APIRequestContext): Promise<Row[]> {
  const res = await request.get(`/api/p/${DB}/snapshot`);
  if (!res.ok()) throw new Error(`snapshot: HTTP ${res.status()}`);
  return ((await res.json()) as { issues: Row[] }).issues;
}

/** An epic with at least one child in the snapshot: the fixture's sp-g1a, or the seeded epic. */
async function epicWithChildren(request: APIRequestContext): Promise<{ epic: Row; kids: Row[] }> {
  const all = await rows(request);
  const epics = all.filter((r) => r.issue_type === "epic" && (r.child_count ?? 0) > 0);
  const epic = MOCK ? epics.find((r) => r.id === "sp-g1a") : epics[0];
  if (!epic) throw new Error("no epic with children in the snapshot");
  return { epic, kids: all.filter((r) => r.parent === epic.id) };
}

async function gotoBoard(page: Page, query = "") {
  await page.goto(`/p/${DB}/board${query}`);
  await expect(page.getByTestId("board")).toBeVisible();
}

test("real: the board opens grouped by epic with a lane per epic showing progress", async ({
  page,
  request,
}) => {
  const { epic, kids } = await epicWithChildren(request);
  await gotoBoard(page);
  await expect(page.getByTestId("group-by-epic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".board--lanes")).toBeVisible();

  const lane = page.locator(`[data-testid="lane"][data-lane="${epic.id}"]`);
  await expect(lane).toBeVisible();
  await expect(lane.getByTestId("lane-title")).toHaveText(epic.title);
  await expect(lane.getByTestId("lane-progress")).toContainText(
    `${epic.child_closed_count ?? 0}/${epic.child_count}`,
  );
  // the epic's own card and its children sit in the lane's cells, each under its status column
  for (const row of [epic, ...kids]) {
    const card = page.locator(`[data-testid="card"][data-id="${row.id}"]`);
    if ((await card.count()) === 0) continue; // e.g. a child closed outside the window
    await expect(card.locator("xpath=ancestor::*[@data-testid='lane-cell']")).toHaveAttribute(
      "data-lane",
      epic.id,
    );
    await expect(card.locator("xpath=ancestor::*[@data-testid='column']")).toHaveAttribute(
      "data-status",
      row.status ?? "open",
    );
  }
  // the no-epic lane is last
  const lanes = page.getByTestId("lane");
  await expect(lanes.last()).toHaveAttribute("data-lane", "");
  await expect(lanes.last().getByTestId("lane-title")).toHaveText("No epic");
});

test("real: toggling group-by-epic off shows the flat board and persists", async ({
  page,
  request,
}) => {
  const { epic } = await epicWithChildren(request);
  await gotoBoard(page);
  await expect(page.locator(`[data-testid="lane"][data-lane="${epic.id}"]`)).toBeVisible();
  await page.getByTestId("group-by-epic").click();
  await expect(page.getByTestId("group-by-epic")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("lane")).toHaveCount(0);
  await expect(page.locator(".board--lanes")).toHaveCount(0);
  await expect(page.locator(`[data-testid="card"][data-id="${epic.id}"]`)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("group-by-epic")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("lane")).toHaveCount(0);
  await page.getByTestId("group-by-epic").click();
  await expect(page.locator(`[data-testid="lane"][data-lane="${epic.id}"]`)).toBeVisible();
});

test("real: a collapsed lane hides its cards and stays collapsed after a reload", async ({
  page,
  request,
}) => {
  const { epic, kids } = await epicWithChildren(request);
  await gotoBoard(page);
  const lane = page.locator(`[data-testid="lane"][data-lane="${epic.id}"]`);
  const kid = kids.find((k) => (k.status ?? "open") !== "closed") ?? kids[0];
  const card = page.locator(`[data-testid="card"][data-id="${kid?.id}"]`);
  await expect(card).toBeVisible();
  await lane.getByTestId("lane-toggle").click();
  await expect(lane.getByTestId("lane-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(lane.getByTestId("lane-toggle")).toHaveAttribute("aria-expanded", "false");
  await lane.getByTestId("lane-toggle").click();
  await expect(card).toBeVisible();
});

test("real: drill-down via ?epic= shows only the descendants with breadcrumbs", async ({
  page,
  request,
}) => {
  const { epic, kids } = await epicWithChildren(request);
  const all = await rows(request);
  await gotoBoard(page, `?epic=${encodeURIComponent(epic.id)}`);
  const crumbs = page.getByTestId("breadcrumbs").getByTestId("crumb");
  await expect(crumbs.first()).toHaveText(/All issues/);
  await expect(crumbs.last()).toContainText(epic.id);
  await expect(crumbs.last()).toContainText(epic.title);

  const ids = await page
    .getByTestId("card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  expect(ids.length).toBeGreaterThan(0);
  expect(ids).not.toContain(epic.id);
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const id of ids) {
    // every shown card descends from the epic
    let cur = byId.get(id ?? "");
    let under = false;
    for (let i = 0; cur && i < 20; i++) {
      if (cur.parent === epic.id) under = true;
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    expect(under, `${id} is under ${epic.id}`).toBe(true);
  }
  for (const kid of kids) {
    if ((kid.status ?? "open") === "closed") continue;
    await expect(page.locator(`[data-testid="card"][data-id="${kid.id}"]`)).toBeVisible();
  }
  // the first crumb goes back to the whole board
  await crumbs.first().locator("button").click();
  await expect(page).not.toHaveURL(/epic=/);
  await expect(page.getByTestId("breadcrumbs")).toHaveCount(0);
  await expect(page.locator(`[data-testid="card"][data-id="${epic.id}"]`)).toBeVisible();
});

test("drill-down groups by sub-epic and the lane Focus button drills further", async ({ page }) => {
  test.skip(!MOCK, "fixture-specific hierarchy");
  await gotoBoard(page, "?epic=sp-g1a");
  const lanes = page.getByTestId("lane");
  await expect(lanes).toHaveCount(3);
  await expect(lanes.nth(0)).toHaveAttribute("data-lane", "sp-g1a.1");
  await expect(lanes.nth(1)).toHaveAttribute("data-lane", "sp-g1a.2");
  await expect(lanes.nth(2).getByTestId("lane-title")).toHaveText("Directly in sp-g1a");
  await expect(lanes.nth(0).getByTestId("lane-progress")).toContainText("1/3");
  await expect(lanes.nth(1).locator(".chip--blocked")).toBeVisible();
  await expect(page.locator('[data-testid="card"][data-id="sp-g1a.1.2"]')).toBeVisible();
  await expect(page.locator('[data-testid="card"][data-id="sp-a1f.4"]')).toHaveCount(0);

  await lanes.nth(0).getByTestId("lane-open").click();
  await expect(page).toHaveURL(/epic=sp-g1a\.1/);
  // no sub-epics under sp-g1a.1: flat board of its three tasks, three crumbs
  await expect(page.getByTestId("lane")).toHaveCount(0);
  await expect(page.getByTestId("card")).toHaveCount(3);
  const crumbs = page.getByTestId("breadcrumbs").getByTestId("crumb");
  await expect(crumbs).toHaveCount(3);
  await expect(crumbs.nth(1)).toContainText("sp-g1a");
  await crumbs.nth(1).locator("button").click();
  await expect(page).toHaveURL(/epic=sp-g1a(&|$)/);
  await expect(page.getByTestId("lane")).toHaveCount(3);
});

test("real: the epics view lists epics with progress, expands children and opens the board", async ({
  page,
  request,
}) => {
  const { epic, kids } = await epicWithChildren(request);
  await page.goto(`/p/${DB}/epics`);
  await expect(page.getByTestId("epics-view")).toBeVisible();
  const row = page.locator(`[data-testid="epic-row"][data-id="${epic.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("epic-title")).toHaveText(epic.title);
  await expect(row.getByTestId("epic-status").first()).toHaveText(/.+/);
  await expect(row.getByTestId("epic-progress").first()).toContainText(
    `${epic.child_closed_count ?? 0}/${epic.child_count}`,
  );
  await expect(row.getByTestId("epic-children")).toHaveCount(0);
  await row.getByTestId("epic-toggle").first().click();
  const children = row.getByTestId("epic-children").first().locator("> li");
  await expect(children).toHaveCount(kids.length);
  for (const kid of kids) {
    await expect(row.locator(`[data-testid="epic-child"][data-id="${kid.id}"]`)).toContainText(
      kid.title,
    );
  }
  await row.getByTestId("epic-open-board").first().click();
  await expect(page).toHaveURL(
    new RegExp(`/p/${DB}/board\\?.*epic=${encodeURIComponent(epic.id).replace(/\./g, "\\.")}`),
  );
  await expect(page.getByTestId("breadcrumbs")).toBeVisible();
});

test("epics view: status chips, text filter, nested sub-epic expansion, blocked badge", async ({
  page,
}) => {
  test.skip(!MOCK, "fixture-specific content");
  await page.goto(`/p/${DB}/epics`);
  await expect(page.getByTestId("epic-row")).toHaveCount(6);
  // sorted by priority: the P0 epic first
  await expect(page.getByTestId("epic-row").first()).toHaveAttribute("data-id", "sp-b2c");
  await expect(
    page.locator('[data-testid="epic-row"][data-id="sp-g1a.2"]').getByTestId("blocked"),
  ).toBeVisible();

  await page.getByTestId("filter-text").fill("editing");
  await expect(page.getByTestId("epic-row")).toHaveCount(1);
  await page.getByTestId("filters-clear").click();
  await expect(page.getByTestId("epic-row")).toHaveCount(6);

  await page.getByTestId("epics-status-open").click();
  await expect(page.getByTestId("epic-row")).toHaveCount(6);
  await page.getByTestId("epics-status-all").click();

  const g1a = page.locator('[data-testid="epic-row"][data-id="sp-g1a"]');
  await g1a.getByTestId("epic-toggle").first().click();
  const sub = g1a.locator('[data-testid="epic-child"][data-id="sp-g1a.1"]');
  await expect(sub).toBeVisible();
  await expect(sub.getByTestId("epic-progress").first()).toContainText("1/3");
  await sub.getByTestId("epic-toggle").first().click();
  await expect(sub.locator('[data-testid="epic-child"][data-id="sp-g1a.1.2"]')).toBeVisible();
  await expect(sub.locator('[data-testid="epic-child"][data-id="sp-g1a.1.3"]')).toContainText(
    "Blocked",
  );
  await sub
    .locator('[data-testid="epic-child"][data-id="sp-g1a.1.2"]')
    .getByTestId("epic-title")
    .click();
  await expect(page.getByTestId("detail-panel")).toHaveAttribute("data-id", "sp-g1a.1.2");
});

test("real: the detail panel shows the hierarchy section with children and the dependency tree", async ({
  page,
  request,
}) => {
  const { epic, kids } = await epicWithChildren(request);
  await page.goto(`/p/${DB}/issue/${encodeURIComponent(epic.id)}`);
  const panel = page.getByTestId("detail-panel");
  await expect(panel.getByTestId("detail-title")).toHaveText(epic.title);
  const section = panel.getByTestId("detail-hierarchy");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("detail-children").locator("li")).toHaveCount(kids.length);
  // the tree answer reaches every child (parent-child edges point child → parent, so they are
  // in the "up" half; a child may be reached through a blocking edge first, hence no label check)
  const tree = section.getByTestId("detail-tree");
  await expect(tree).toBeVisible({ timeout: 10_000 });
  await expect(tree.getByTestId("detail-tree-up")).toBeVisible();
  for (const kid of kids) {
    await expect(tree.locator(`[data-id="${kid.id}"]`).first()).toBeVisible();
  }
  // a child's panel shows the parent chain as breadcrumbs
  const kid = kids[0] as Row;
  await section.getByTestId("detail-children").locator(`li[data-id="${kid.id}"] button`).click();
  await expect(panel).toHaveAttribute("data-id", kid.id);
  const crumbs = panel.getByTestId("detail-crumbs").getByTestId("crumb");
  await expect(crumbs.first()).toContainText(epic.id);
  await expect(crumbs.last()).toContainText(kid.id);
  await expect(panel.getByTestId("detail-tree")).toBeVisible({ timeout: 10_000 });
  await expect(
    panel.getByTestId("detail-tree").locator(`[data-id="${epic.id}"]`).first(),
  ).toContainText("parent");
});

test("detail panel: blocked badge with explanation, tree labels blockers", async ({ page }) => {
  test.skip(!MOCK, "fixture-specific content");
  await page.goto(`/p/${DB}/issue/sp-g1a.1.3`);
  const panel = page.getByTestId("detail-panel");
  await expect(panel.getByTestId("detail-blocked")).toBeVisible();
  await expect(panel.getByTestId("detail-blocked")).toHaveAttribute(
    "title",
    /not in the ready set/,
  );
  const tree = panel.getByTestId("detail-tree");
  await expect(tree).toBeVisible();
  const blocker = tree.locator('[data-id="sp-g1a.1.2"]').first();
  await expect(blocker).toContainText("blocks");
  await expect(tree.locator('[data-id="sp-g1a.1"]').first()).toContainText("parent");
  await expect(tree.locator('[data-id="sp-g1a"]').first()).toContainText("parent");
  // the board card carries the same explanation
  await page.keyboard.press("Escape");
  const card = page.locator('[data-testid="card"][data-id="sp-g1a.1.3"]');
  await expect(card.locator(".chip--blocked")).toHaveAttribute("title", /blocked by a dependency/);
});
