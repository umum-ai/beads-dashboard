/**
 * Live acceptance against a real BFF (stage 3): while the board is open, an issue created
 * through the `bd` CLI in the stand workspace must appear as a card without a reload — the
 * mutation travels bd journal → `events:watch` → bddb delta → browser SSE.
 *
 * Skipped on the mock. The CLI command comes from `E2E_CREATE_ISSUE` (default
 * `scripts/stand.sh create-issue`), gets the title as its last argument and prints the new id.
 * Runs in its own Playwright project after the board tests, so the new card cannot disturb
 * their card counts.
 */
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { DB, MOCK } from "./helpers.ts";

const CREATE = (process.env.E2E_CREATE_ISSUE ?? "scripts/stand.sh create-issue").split(/\s+/);

test("an issue created through the CLI appears on the open board within 10 s", async ({ page }) => {
  test.skip(MOCK, "needs a real bd serve with the events journal");
  await page.goto(`/p/${DB}/board`);
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-mode", "sse");
  const before = await page.getByTestId("card").count();

  const title = `Live from CLI ${Date.now()}`;
  const [cmd, ...args] = CREATE as [string, ...string[]];
  const id = execFileSync(cmd, [...args, title], { encoding: "utf8", timeout: 20_000 }).trim();
  expect(id).toMatch(/^[a-z0-9]+-[a-z0-9.]+$/i);

  const card = page.locator(`[data-testid="card"][data-id="${id}"]`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.getByTestId("card-title")).toHaveText(title);
  await expect(card.locator("xpath=ancestor::*[@data-testid='column']")).toHaveAttribute(
    "data-status",
    "open",
  );
  expect(await page.getByTestId("card").count()).toBe(before + 1);

  // the new card is a real row: the drawer opens on it
  await card.getByTestId("card-title").click();
  await expect(page.getByTestId("detail-panel").getByTestId("detail-title")).toHaveText(title);
});
