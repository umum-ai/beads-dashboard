/**
 * Keyboard navigation, dialog focus handling, empty / error states and an axe scan (stage 7).
 * Runs against the mock and a real BFF; the server-state scenarios are simulated by
 * intercepting `/api/meta`, `/snapshot` and `/events` in the page, so they work on both.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { DB, MOCK } from "./helpers.ts";

const META = {
  bddb: { version: "0.0.0-test", builtForBeads: "1.3.0-rc.2" },
  defaultDatabase: DB,
  actorDefault: "bddb",
  closedHours: 72,
  pollIntervalMs: 15_000,
};

const INFO = {
  name: DB,
  state: "ready",
  live: "sse",
  lastSyncAt: new Date().toISOString(),
  bdVersion: "1.3.0-rc.2" as string | null,
  projectId: null,
  versionWarning: null,
  capabilities: [] as string[],
  issueCount: 0,
  lastError: null as string | null,
};

function problem(status: number, code: string, detail: string) {
  return {
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({ type: "about:blank", code, status, title: code, detail }),
  };
}

/** Serve `/api/meta` with one database in `state`; the stream and snapshot refuse like the BFF does. */
async function simulateDatabase(page: Page, info: Partial<typeof INFO>): Promise<void> {
  const database = { ...INFO, ...info };
  await page.route("**/api/meta", (route) =>
    route.fulfill({ json: { ...META, databases: [database] } }),
  );
  if (database.state !== "ready") {
    const refuse = problem(503, "bddb_not_ready", `database "${DB}" is ${database.state}`);
    await page.route(`**/api/p/${DB}/events`, (route) => route.fulfill(refuse));
    await page.route(`**/api/p/${DB}/snapshot`, (route) => route.fulfill(refuse));
  }
}

const focusedCardId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-id") ?? null);

test.describe("keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("card").first()).toBeVisible();
  });

  test("Tab reaches a card; arrows move inside and between columns", async ({ page }) => {
    const first = page.getByTestId("card").first();
    await first.focus();
    const id = await first.getAttribute("data-id");
    expect(await focusedCardId(page)).toBe(id);
    // inner controls are not tab stops: Tab leaves the card for the next card (or beyond)
    await page.keyboard.press("Tab");
    const afterTab = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        inCard: !!el?.closest('[data-testid="card"]'),
        isCard: el?.dataset.testid === "card",
      };
    });
    expect(afterTab.inCard).toBe(afterTab.isCard);

    await first.focus();
    const column = await first.evaluate(
      (el) => el.closest('[data-testid="column"]')?.getAttribute("data-status") ?? "",
    );
    const inColumn = await page
      .locator(`[data-testid="column"][data-status="${column}"] [data-testid="card"]`)
      .count();
    if (inColumn > 1) {
      await page.keyboard.press("ArrowDown");
      const next = await focusedCardId(page);
      expect(next).not.toBe(id);
      await page.keyboard.press("ArrowUp");
      expect(await focusedCardId(page)).toBe(id);
    }
    await page.keyboard.press("ArrowRight");
    const right = await focusedCardId(page);
    expect(right).not.toBeNull();
    const rightColumn = await page.evaluate(
      () =>
        document.activeElement?.closest('[data-testid="column"]')?.getAttribute("data-status") ??
        "",
    );
    // moved to another column when one to the right has cards; otherwise focus stayed
    if (right !== id) expect(rightColumn).not.toBe(column);
  });

  test("Enter opens the drawer, Escape closes it and gives focus back to the card", async ({
    page,
  }) => {
    const card = page.getByTestId("card").first();
    const id = await card.getAttribute("data-id");
    await card.focus();
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("detail-panel");
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/issue/${id?.replace(/\./g, "\\.")}$`));
    await expect(panel.getByTestId("detail-close")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(page.locator(`[data-testid="card"][data-id="${id}"]`)).toBeFocused();
  });

  test("Space opens the card menu, Escape closes it and restores focus", async ({ page }) => {
    const card = page.getByTestId("card").first();
    const id = await card.getAttribute("data-id");
    await card.focus();
    await page.keyboard.press(" ");
    const menu = page.getByTestId("card-menu-panel");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.locator(`[data-testid="card"][data-id="${id}"]`)).toBeFocused();
  });

  test("? opens the shortcuts help with a focus trap; Escape closes it", async ({ page }) => {
    await page.getByTestId("card").first().focus();
    await page.keyboard.press("?");
    const dialog = page.getByTestId("help-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByTestId("help-close")).toBeFocused();
    // the only control: Tab cycles back to it instead of leaving the dialog
    await page.keyboard.press("Tab");
    await expect(dialog.getByTestId("help-close")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByTestId("help-close")).toBeFocused();
    await expect(dialog).toContainText("Keyboard shortcuts");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // the header button opens it too
    await page.getByTestId("help-button").click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("help-close").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("help-button")).toBeFocused();
  });

  test("/ focuses the quick filter, n opens the create dialog with a focus trap", async ({
    page,
  }) => {
    await page.getByTestId("card").first().focus();
    await page.keyboard.press("/");
    await expect(page.getByTestId("filter-text")).toBeFocused();
    // inside a field the letter shortcuts are plain typing
    await page.keyboard.type("n");
    await expect(page.getByTestId("filter-text")).toHaveValue("n");
    await expect(page.getByTestId("create-dialog")).toHaveCount(0);
    await page.getByTestId("filter-text").fill("");
    await page.getByTestId("card").first().focus();

    await page.keyboard.press("n");
    const dialog = page.getByTestId("create-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByTestId("create-title")).toBeFocused();
    // Shift+Tab from the first field wraps to the last control of the dialog
    await page.keyboard.press("Shift+Tab");
    const inDialog = await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="create-dialog"]'),
    );
    expect(inDialog).toBe(true);
    await expect(dialog.getByTestId("create-submit")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("card").first()).toBeFocused();
  });

  test("the close-reason dialog traps focus and returns it on cancel", async ({ page }) => {
    test.skip(!MOCK, "uses a fixture card that is open");
    const card = page.locator('[data-testid="card"][data-status="open"]').first();
    await card.focus();
    await page.keyboard.press(" ");
    await page.getByTestId("menu-status-closed").click();
    const dialog = page.getByTestId("close-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("close-reason")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByTestId("close-confirm")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(card).toBeFocused();
  });
});

test.describe("empty and error states", () => {
  test("quick filter with no match shows the empty state with a Clear filters action", async ({
    page,
  }) => {
    await page.goto(`/p/${DB}/board?q=zzz-nothing-matches-this`);
    const empty = page.getByTestId("filter-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No issue matches");
    await empty.getByTestId("empty-clear-filters").click();
    await expect(page.getByTestId("card").first()).toBeVisible();
    await expect(page).not.toHaveURL(/q=/);
  });

  test("an unknown issue id shows a not-found message with a way back to the board", async ({
    page,
  }) => {
    await page.goto(`/p/${DB}/issue/nope-does-not-exist`);
    const error = page.getByTestId("detail-panel").getByTestId("detail-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("nope-does-not-exist");
    await expect(error).toContainText("not found");
    await error.getByTestId("detail-back").click();
    await expect(page.getByTestId("detail-panel")).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/p/${DB}/board$`));
  });

  test("an unknown issue id in the epics view goes back to the epics list", async ({ page }) => {
    await page.goto(`/p/${DB}/epics/issue/nope-does-not-exist`);
    const error = page.getByTestId("detail-panel").getByTestId("detail-error");
    await expect(error).toBeVisible();
    await expect(error.getByTestId("detail-back")).toHaveText("Back to epics");
    await error.getByTestId("detail-back").click();
    await expect(page.getByTestId("detail-panel")).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/p/${DB}/epics$`));
    await expect(page.getByTestId("epics-view")).toBeVisible();
  });

  test("every column hidden: the board says so and opens the settings", async ({ page }) => {
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("card").first()).toBeVisible();
    await page.getByTestId("settings-button").click();
    const pop = page.getByTestId("settings-popover");
    const ids = await pop
      .locator('[data-testid^="settings-column-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
    for (const id of ids) await pop.getByTestId(id).uncheck();
    await page.keyboard.press("Escape");
    const empty = page.getByTestId("board-no-columns");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No columns shown");
    await empty.getByTestId("board-choose-columns").click();
    await expect(pop).toBeVisible();
    await pop.getByTestId("settings-columns-reset").click();
    await expect(page.getByTestId("card").first()).toBeVisible();
  });

  test("epics view with no epics offers to create one", async ({ page }) => {
    // a snapshot without epics: intercept it and the stream
    await page.route(`**/api/p/${DB}/snapshot`, async (route) => {
      const res = await route.fetch();
      const snap = (await res.json()) as { issues: { issue_type?: string }[] };
      snap.issues = snap.issues.filter((i) => i.issue_type !== "epic");
      await route.fulfill({ json: snap });
    });
    await page.route(`**/api/p/${DB}/events`, (route) =>
      route.fulfill(problem(503, "bddb_not_ready", "no stream in this test")),
    );
    await page.goto(`/p/${DB}/epics`);
    const empty = page.getByTestId("epics-empty");
    await expect(empty).toBeVisible();
    await empty.getByTestId("epics-empty-create").click();
    const dialog = page.getByTestId("create-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("create-type")).toHaveValue("epic");
  });

  test("an empty board offers to create the first issue", async ({ page }) => {
    await page.route(`**/api/p/${DB}/snapshot`, async (route) => {
      const res = await route.fetch();
      const snap = (await res.json()) as { issues: unknown[]; ready: string[] };
      snap.issues = [];
      snap.ready = [];
      await route.fulfill({ json: snap });
    });
    await page.route(`**/api/p/${DB}/events`, (route) =>
      route.fulfill(problem(503, "bddb_not_ready", "no stream in this test")),
    );
    await page.goto(`/p/${DB}/board`);
    const empty = page.getByTestId("board-empty");
    await expect(empty).toBeVisible();
    await empty.getByTestId("board-empty-create").click();
    await expect(page.getByTestId("create-dialog")).toBeVisible();
  });

  test("a database that is starting shows the spinner state", async ({ page }) => {
    await simulateDatabase(page, { state: "starting", live: "none", bdVersion: null });
    await page.goto(`/p/${DB}/board`);
    const state = page.getByTestId("db-starting");
    await expect(state).toBeVisible();
    await expect(state).toHaveAttribute("aria-busy", "true");
    await expect(state.locator(".spinner")).toBeVisible();
    await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-mode", "starting");
  });

  test("a database that is down shows the last error and the hints", async ({ page }) => {
    await simulateDatabase(page, {
      state: "down",
      live: "none",
      lastError: "bd serve failed to start (exit 1): dial tcp 127.0.0.1:3308: connection refused",
    });
    await page.goto(`/p/${DB}/board`);
    const state = page.getByTestId("db-down");
    await expect(state).toBeVisible();
    await expect(state).toContainText("connection refused");
    await expect(state).toContainText("bddb doctor");
    await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-mode", "down");
  });

  test("a degraded database with no snapshot yet explains the Dolt side", async ({ page }) => {
    await simulateDatabase(page, {
      state: "degraded",
      live: "polling",
      lastError: "db_unavailable: database temporarily unavailable; retry",
    });
    await page.goto(`/p/${DB}/board`);
    const state = page.getByTestId("db-degraded");
    await expect(state).toBeVisible();
    await expect(state).toContainText("listener.host");
    await expect(state).toContainText("db_unavailable");
  });

  test("no databases: the page explains what to check", async ({ page }) => {
    await page.route("**/api/meta", (route) =>
      route.fulfill({ json: { ...META, defaultDatabase: "", databases: [] } }),
    );
    await page.goto(`/p/${DB}/board`);
    const state = page.getByTestId("no-databases");
    await expect(state).toBeVisible();
    await expect(state).toContainText("BDDB_DOLT_HOST");
    await expect(state).toContainText("BDDB_DATABASES");
    await expect(state).toContainText("bddb doctor");
  });

  test("/api/meta failing on boot: full-page error with a retry that recovers", async ({
    page,
  }) => {
    let fail = true;
    await page.route("**/api/meta", (route) => (fail ? route.abort() : route.continue()));
    await page.goto(`/p/${DB}/board`);
    const state = page.getByTestId("meta-error");
    await expect(state).toBeVisible();
    await expect(state).toContainText("Cannot reach the dashboard server");
    fail = false;
    await state.getByTestId("meta-retry").click();
    await expect(page.getByTestId("card").first()).toBeVisible();
  });

  test("the version warning banner explains the risk, links the docs and dismisses per tab", async ({
    page,
  }) => {
    const mismatch = {
      bdVersion: "1.4.0",
      versionWarning: "bd 1.4.0 differs from 1.3.0-rc.2 in the minor component",
    };
    await page.route("**/api/meta", async (route) => {
      const res = await route.fetch();
      const meta = (await res.json()) as { databases: Record<string, unknown>[] };
      meta.databases = meta.databases.map((d) => ({ ...d, ...mismatch }));
      await route.fulfill({ json: meta });
    });
    // the snapshot carries the same DatabaseInfo; the stream is refused so the snapshot is used
    await page.route(`**/api/p/${DB}/snapshot`, async (route) => {
      const res = await route.fetch();
      const snap = (await res.json()) as { database: Record<string, unknown> };
      snap.database = { ...snap.database, ...mismatch };
      await route.fulfill({ json: snap });
    });
    await page.route(`**/api/p/${DB}/events`, (route) =>
      route.fulfill(problem(503, "bddb_not_ready", "no stream in this test")),
    );
    await page.goto(`/p/${DB}/board`);
    const banner = page.getByTestId("version-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("1.4.0");
    await expect(banner).toContainText("schema");
    await expect(banner.getByRole("link")).toHaveAttribute("href", /compatibility\.md/);
    await banner.getByTestId("version-banner-dismiss").click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("card").first()).toBeVisible();
    await expect(page.getByTestId("version-banner")).toHaveCount(0);
  });
});

test.describe("axe", () => {
  const scan = (page: Page) =>
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
      .then((r) =>
        r.violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map(
            (v) => `${v.id}: ${v.help} (${v.nodes.length} nodes: ${v.nodes[0]?.target.join(" ")})`,
          ),
      );

  test("board has no serious or critical violations", async ({ page }) => {
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("card").first()).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test("drawer and help dialog have no serious or critical violations", async ({ page }) => {
    await page.goto(`/p/${DB}/board`);
    const card = page.getByTestId("card").first();
    await card.getByTestId("card-title").click();
    await expect(page.getByTestId("detail-panel").getByTestId("detail-title")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.keyboard.press("?");
    await expect(page.getByTestId("help-dialog")).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test("board settings popover and the epics drawer have no serious or critical violations", async ({
    page,
  }) => {
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("card").first()).toBeVisible();
    await page.getByTestId("settings-button").click();
    await expect(page.getByTestId("settings-popover")).toBeVisible();
    expect(await scan(page)).toEqual([]);
    await page.goto(`/p/${DB}/epics`);
    await page.getByTestId("epic-row").first().getByTestId("epic-title").click();
    await expect(page.getByTestId("detail-panel").getByTestId("detail-title")).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test("dark theme keeps the contrast", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/p/${DB}/board`);
    await expect(page.getByTestId("card").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await scan(page)).toEqual([]);
  });
});
