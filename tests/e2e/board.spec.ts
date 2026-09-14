/**
 * Board MVP e2e (stage 3). Against the mock BFF by default (`E2E_TARGET=mock`), where the
 * fixture is deterministic; the same tests run against a real BFF when `E2E_TARGET` is
 * anything else and the database named by `E2E_DB` holds at least one open issue.
 */
import { expect, test } from "@playwright/test";

const DB = process.env.E2E_DB ?? "siam_platform";
const MOCK = (process.env.E2E_TARGET ?? "mock") === "mock";

test.beforeEach(async ({ page }) => {
  await page.goto(`/p/${DB}/board`);
  await expect(page.getByTestId("board")).toBeVisible();
});

test("board opens with status columns and at least one card", async ({ page }) => {
  const columns = page.getByTestId("column");
  await expect(columns.first()).toBeVisible();
  expect(await columns.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("column").filter({ hasText: "Open" })).toBeVisible();
  await expect(page.getByTestId("card").first()).toBeVisible();
  if (MOCK) {
    // custom status from config lands between the built-ins; closed column has the window hint
    await expect(page.locator('[data-testid="column"][data-status="review"]')).toBeVisible();
    await expect(page.locator('[data-testid="column"][data-status="closed"]')).toContainText(
      "Closed in the last 7 days",
    );
    await expect(page.locator('[data-testid="card"][data-id="sp-b2c.5"]')).toContainText("Blocked");
  }
});

test("clicking a card opens the detail panel with its title and the issue URL", async ({
  page,
}) => {
  const card = page.getByTestId("card").first();
  const id = await card.getAttribute("data-id");
  const title = await card.getByTestId("card-title").textContent();
  await card.getByTestId("card-title").click();
  await expect(page).toHaveURL(new RegExp(`/p/${DB}/issue/${id?.replace(/\./g, "\\.")}$`));
  const panel = page.getByTestId("detail-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("detail-title")).toHaveText(title ?? "");
  await expect(panel.getByTestId("detail-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/p/${DB}/board$`));
});

test("detail panel renders markdown, children and comments from the fixture", async ({ page }) => {
  test.skip(!MOCK, "fixture-specific content");
  await page.goto(`/p/${DB}/issue/sp-a1f`);
  const panel = page.getByTestId("detail-panel");
  await expect(panel.getByTestId("detail-title")).toHaveText(
    "Board MVP: columns, cards, filters, detail panel",
  );
  await expect(panel.locator(".md strong").first()).toHaveText("only through bd serve");
  await expect(panel.getByTestId("detail-children").locator("li")).toHaveCount(8);
  await expect(panel.getByTestId("detail-comments").locator(".comment")).toHaveCount(2);
  await panel.getByTestId("detail-children").locator("button").first().click();
  await expect(page).toHaveURL(/\/issue\/sp-a1f\.\d$/);
  await expect(panel.getByTestId("detail-parent")).toHaveText("sp-a1f");
});

test("theme toggle flips data-theme and persists across reloads", async ({ page }) => {
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-toggle").click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("language toggle switches the header to Russian and back", async ({ page }) => {
  const tab = page.getByTestId("tab-board");
  await expect(tab).toHaveText("Board");
  await page.getByTestId("lang-toggle").click();
  await expect(tab).toHaveText("Доска");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByTestId("filter-text")).toHaveAttribute(
    "placeholder",
    "Поиск по заголовку или id",
  );
  await page.getByTestId("lang-toggle").click();
  await expect(tab).toHaveText("Board");
});

test("project switcher changes the URL and reloads the board", async ({ page }) => {
  const select = page.getByTestId("project-switcher");
  const options = await select.locator("option").allTextContents();
  test.skip(options.length < 2, "needs two databases");
  const other = options.find((name) => name !== DB) as string;
  await select.selectOption(other);
  await expect(page).toHaveURL(new RegExp(`/p/${other}/board$`));
  await expect(page.getByTestId("board")).toBeVisible();
  if (MOCK) {
    await expect(page.locator('[data-testid="card"][data-id="sb-x3"]')).toBeVisible();
    await expect(page.locator('[data-testid="card"][data-id="sp-a1f"]')).toHaveCount(0);
  }
});

test("text filter hides non-matching cards and lives in the URL", async ({ page }) => {
  const cards = page.getByTestId("card");
  const before = await cards.count();
  expect(before).toBeGreaterThan(1);
  const needle = MOCK ? "supervisor" : ((await cards.first().getAttribute("data-id")) ?? "");
  await page.getByTestId("filter-text").fill(needle);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(needle)}`));
  await expect.poll(() => cards.count()).toBeLessThan(before);
  for (const text of await cards.getByTestId("card-title").allTextContents()) {
    const ids = await cards.allInnerTexts();
    expect(`${text} ${ids.join(" ")}`.toLowerCase()).toContain(needle.toLowerCase());
  }
  await expect(page.getByTestId("filter-count")).toContainText(`of ${before} shown`);
  await page.getByTestId("filters-clear").click();
  await expect.poll(() => cards.count()).toBe(before);
});

test("priority filter keeps only cards of that priority", async ({ page }) => {
  await page.getByTestId("filter-priority-0").click();
  await expect(page).toHaveURL(/[?&]priority=0/);
  const cards = page.getByTestId("card");
  await expect.poll(() => cards.count()).toBeGreaterThan(0);
  for (const p of await cards.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-priority")),
  )) {
    expect(p).toBe("0");
  }
});

test("live delta from the server moves the demo card between columns", async ({ page }) => {
  test.skip(!MOCK, "needs the mock ticker");
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-mode", "sse");
  const card = page.locator('[data-testid="card"][data-id="sp-d4e"]');
  const columnOf = () =>
    card.evaluate((el) => el.closest('[data-testid="column"]')?.getAttribute("data-status"));
  const start = await columnOf();
  await expect.poll(columnOf, { timeout: 15_000 }).not.toBe(start);
});

test("show all closed loads the older closed issues", async ({ page }) => {
  test.skip(!MOCK, "fixture-specific content");
  const closed = page.locator('[data-testid="column"][data-status="closed"]');
  await expect(closed.locator('[data-testid="card"][data-id="sp-c9d"]')).toHaveCount(0);
  await closed.getByTestId("show-all-closed").click();
  await expect(closed.locator('[data-testid="card"][data-id="sp-c9d"]')).toBeVisible();
  await expect(closed).toContainText("Showing all");
});

test("column resize handle changes the width and persists", async ({ page }) => {
  const column = page.locator('[data-testid="column"][data-status="open"]');
  const before = (await column.boundingBox())?.width ?? 0;
  const handle = column.getByTestId("column-resize");
  await handle.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(before + 64);
  await page.reload();
  await expect.poll(async () => (await column.boundingBox())?.width ?? 0).toBe(before + 64);
});
