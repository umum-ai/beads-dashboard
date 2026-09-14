/**
 * Board MVP e2e (stage 3). Against the mock BFF by default (`E2E_TARGET=mock`), where the
 * fixture is deterministic; the same tests run against a real BFF when `E2E_TARGET` is
 * anything else and the database named by `E2E_DB` holds at least one open issue.
 */
import { expect, type Page, test } from "@playwright/test";
import { DB, MOCK, snapshot } from "./helpers.ts";

test.beforeEach(async ({ page }) => {
  await page.goto(`/p/${DB}/board`);
  await expect(page.getByTestId("board")).toBeVisible();
});

test("board opens with status columns and at least one card", async ({ page, request }) => {
  const columns = page.getByTestId("column");
  await expect(columns.first()).toBeVisible();
  expect(await columns.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("column").filter({ hasText: "Open" })).toBeVisible();
  await expect(page.getByTestId("card").first()).toBeVisible();
  // every open issue the BFF reports is on the board (seeded data in real mode, fixture in mock)
  const open = (await snapshot(request)).issues.filter((i) => i.status === "open");
  expect(open.length).toBeGreaterThan(0);
  for (const issue of open) {
    const card = page.locator(`[data-testid="card"][data-id="${issue.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("card-title")).toHaveText(issue.title);
  }
  if (MOCK) {
    // only the default columns show up (the custom status waits in the settings); the closed
    // column names its window
    await expect(page.locator('[data-testid="column"][data-status="review"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="column"][data-status="deferred"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="column"][data-status="closed"]')).toContainText(
      "Closed · 24 h",
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
  await expect(panel.getByTestId("detail-parent")).toContainText("sp-a1f");
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
  // the mock fixture has P0 issues; real data may not, so take the priority of the first card
  const cards = page.getByTestId("card");
  const wanted = MOCK ? "0" : ((await cards.first().getAttribute("data-priority")) ?? "2");
  await page.getByTestId(`filter-priority-${wanted}`).click();
  await expect(page).toHaveURL(new RegExp(`[?&]priority=${wanted}`));
  await expect.poll(() => cards.count()).toBeGreaterThan(0);
  for (const p of await cards.evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-priority")),
  )) {
    expect(p).toBe(wanted);
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

test.describe("board settings", () => {
  const column = (page: Page, status: string) =>
    page.locator(`[data-testid="column"][data-status="${status}"]`);

  test("the gear lists every status; unchecking hides its column and persists across reloads", async ({
    page,
  }) => {
    const total = await page.getByTestId("column").count();
    await page.getByTestId("settings-button").click();
    const pop = page.getByTestId("settings-popover");
    await expect(pop).toBeVisible();
    await expect(pop).toHaveAttribute("aria-label", `Board settings for ${DB}`);
    const checks = pop.locator('[data-testid^="settings-column-"]');
    expect(await checks.count()).toBeGreaterThan(total);
    await expect(pop.getByTestId("settings-columns-count")).toHaveText(
      `${total} of ${await checks.count()} shown`,
    );
    await expect(pop.getByTestId("settings-column-open")).toBeChecked();
    await expect(pop.getByTestId("settings-columns-reset")).toBeDisabled();

    await pop.getByTestId("settings-column-in_progress").uncheck();
    await expect(column(page, "in_progress")).toHaveCount(0);
    await expect(page.getByTestId("column")).toHaveCount(total - 1);
    await expect(pop.getByTestId("settings-columns-count")).toContainText(`${total - 1} of`);
    // the card menu still offers every status as a move target
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(page.getByTestId("settings-button")).toBeFocused();
    await page.getByTestId("card").first().focus();
    await page.keyboard.press(" ");
    await expect(page.getByTestId("menu-status-in_progress")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.reload();
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(column(page, "in_progress")).toHaveCount(0);
    await expect(column(page, "open")).toBeVisible();

    await page.getByTestId("settings-button").click();
    await pop.getByTestId("settings-columns-reset").click();
    await expect(column(page, "in_progress")).toBeVisible();
    await expect(pop.getByTestId("settings-columns-reset")).toBeDisabled();
  });

  test("a custom or frozen status stays hidden until checked", async ({ page }) => {
    test.skip(!MOCK, "fixture statuses");
    await expect(column(page, "review")).toHaveCount(0);
    await page.getByTestId("settings-button").click();
    const pop = page.getByTestId("settings-popover");
    await pop.getByTestId("settings-column-review").check();
    await pop.getByTestId("settings-column-deferred").check();
    const review = column(page, "review");
    await expect(review).toBeVisible();
    await expect(review.locator('[data-testid="card"][data-id="sp-a1f.5"]')).toBeVisible();
    await expect(
      column(page, "deferred").locator('[data-testid="card"][data-id="sp-a1f.7"]'),
    ).toBeVisible();
    // board order is kept: review sits right after open
    const order = await page
      .getByTestId("column")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    expect(order).toEqual(["open", "review", "in_progress", "blocked", "deferred", "closed"]);
  });

  test("the closed period narrows the Closed column and its header names the window", async ({
    page,
  }) => {
    test.skip(!MOCK, "fixture-specific closed ages");
    const closed = column(page, "closed");
    const card = (id: string) => closed.locator(`[data-testid="card"][data-id="${id}"]`);
    // default 24 h: closed ~2 h and ~20 h ago are in, ~50 h is out, and so is everything the
    // server no longer sends (~600 h)
    await expect(card("sp-a9b")).toBeVisible();
    await expect(card("sp-g1a.1.1")).toBeVisible();
    await expect(card("sp-b2c.3")).toHaveCount(0);
    await expect(card("sp-c9d")).toHaveCount(0);
    await expect(closed.getByTestId("column-window").first()).toHaveText("· 24 h");

    await page.getByTestId("settings-button").click();
    const select = page.getByTestId("settings-closed-hours");
    await expect(select).toHaveValue("24");
    const labels = await select.locator("option").allTextContents();
    expect(labels).toEqual([
      "1 hour",
      "2 hours",
      "3 hours",
      "4 hours",
      "5 hours",
      "6 hours",
      "7 hours",
      "8 hours",
      "9 hours",
      "10 hours",
      "11 hours",
      "12 hours",
      "15 hours",
      "18 hours",
      "21 hours",
      "1 day",
      "1.5 days",
      "2 days",
      "2.5 days",
      "3 days",
    ]);
    // the mock keeps 72 h: nothing is disabled and no cap hint is shown
    await expect(select.locator("option[disabled]")).toHaveCount(0);
    await expect(page.getByTestId("settings-closed-cap")).toHaveCount(0);

    await select.selectOption("72");
    await expect(card("sp-b2c.3")).toBeVisible();
    await expect(closed.getByTestId("column-window").first()).toHaveText("· 72 h");
    await select.selectOption("1");
    await expect(card("sp-a9b")).toHaveCount(0);
    await expect(card("sp-g1a.1.1")).toHaveCount(0);
    await expect(closed.getByTestId("column-window").first()).toHaveText("· 1 h");
    await page.reload();
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(closed.getByTestId("column-window").first()).toHaveText("· 1 h");
    await expect(card("sp-a9b")).toHaveCount(0);
  });

  test("periods beyond what the server keeps are disabled with a hint", async ({ page }) => {
    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const meta = (await res.json()) as { closedHours: number };
      meta.closedHours = 12;
      await route.fulfill({ json: meta });
    });
    await page.reload();
    await expect(page.getByTestId("board")).toBeVisible();
    await page.getByTestId("settings-button").click();
    const select = page.getByTestId("settings-closed-hours");
    // the default (24 h) is capped by the server's 12 h
    await expect(select).toHaveValue("12");
    await expect(select.locator("option[disabled]")).toHaveCount(8);
    await expect(select.locator('option[value="15"]')).toHaveJSProperty("disabled", true);
    await expect(select.locator('option[value="12"]')).toHaveJSProperty("disabled", false);
    await expect(page.getByTestId("settings-closed-cap")).toContainText(
      "The server keeps 12 h (BDDB_CLOSED_HOURS)",
    );
    await expect(
      page
        .locator('[data-testid="column"][data-status="closed"]')
        .getByTestId("column-window")
        .first(),
    ).toHaveText("· 12 h");
  });

  test("the , shortcut toggles the settings; Escape returns focus to the gear", async ({
    page,
  }) => {
    await page.getByTestId("card").first().focus();
    await page.keyboard.press(",");
    const pop = page.getByTestId("settings-popover");
    await expect(pop).toBeVisible();
    await expect(pop.locator('[data-testid^="settings-column-"]').first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(page.getByTestId("settings-button")).toBeFocused();
    // the shortcuts help lists it
    await page.keyboard.press("?");
    await expect(page.getByTestId("help-dialog")).toContainText("Board settings");
  });
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
