/** Shared e2e settings: the database under test and whether the target is the mock BFF. */
import type { APIRequestContext, Locator, Page } from "@playwright/test";

export const DB = process.env.E2E_DB ?? "siam_platform";
export const MOCK = (process.env.E2E_TARGET ?? "mock") === "mock";

export type SnapshotIssue = {
  id: string;
  title: string;
  status: string;
  priority: number;
  issue_type?: string;
  parent?: string;
  child_count?: number;
  child_closed_count?: number;
};

/** `GET /api/p/<db>/snapshot` — the rows the board is built from. */
export async function snapshot(
  request: APIRequestContext,
): Promise<{ seq: number; issues: SnapshotIssue[] }> {
  const res = await request.get(`/api/p/${DB}/snapshot`);
  if (!res.ok()) throw new Error(`snapshot: HTTP ${res.status()}`);
  return (await res.json()) as { seq: number; issues: SnapshotIssue[] };
}

/** Visible part of an element after clipping by every scrolling ancestor and the viewport. */
interface VisibleBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Scroll `target` into view (its own column body first, then the board's horizontal scroller,
 * which `scrollIntoView` does not always reach) and return the rectangle of it that is really
 * visible, so the pointer can be placed inside it even when the element is taller than the
 * viewport or partly hidden behind sticky headers. Works mid-drag.
 */
async function reveal(target: Locator): Promise<VisibleBox> {
  return target.evaluate((el) => {
    // a lane header is sticky: scrolled to the start it sits right under the column headers,
    // painted over the headers of the lanes scrolled past (earlier in DOM order)
    const isLaneHead = el.classList.contains("lane-head");
    if (isLaneHead) {
      // scrollIntoView on a sticky element is unreliable: anchor on the lane's first cell instead,
      // the header then sticks right above it
      const key = el.getAttribute("data-lane") ?? "";
      const cell = document.querySelector<HTMLElement>(
        `[data-testid="lane-cell"][data-lane="${key}"]`,
      );
      (cell ?? el).scrollIntoView({ block: "start", inline: "nearest" });
    } else el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const scroller = el.closest<HTMLElement>(".board");
    if (scroller) {
      const box = el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      let dx = 0;
      if (box.left < view.left + 40) dx = box.left - view.left - 40;
      else if (box.right > view.right - 40) {
        dx = Math.min(box.left - view.left - 40, box.right - view.right + 40);
      }
      if (dx) scroller.scrollBy({ left: dx, behavior: "instant" });
    }
    const rect = el.getBoundingClientRect();
    let x1 = rect.left;
    let y1 = rect.top;
    let x2 = rect.right;
    let y2 = rect.bottom;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX)) {
        const r = node.getBoundingClientRect();
        x1 = Math.max(x1, r.left);
        y1 = Math.max(y1, r.top);
        x2 = Math.min(x2, r.right);
        y2 = Math.min(y2, r.bottom);
      }
    }
    const stickies = document.querySelectorAll<HTMLElement>(
      ".column__head, .lane-head, .toolbar, .header, .querybar",
    );
    for (const sticky of stickies) {
      if (sticky === el || sticky.contains(el)) continue;
      if (isLaneHead && sticky.classList.contains("lane-head")) continue;
      const r = sticky.getBoundingClientRect();
      if (r.bottom > y1 && r.top <= y1 && r.left < x2 && r.right > x1) y1 = Math.max(y1, r.bottom);
    }
    x1 = Math.max(x1, 0);
    y1 = Math.max(y1, 0);
    x2 = Math.min(x2, window.innerWidth);
    y2 = Math.min(y2, window.innerHeight);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  });
}

/**
 * Drag a card onto a drop zone with real pointer events (pragmatic-drag-and-drop listens to the
 * native drag events Chromium synthesizes from them). The drag is started with a few small
 * moves; once the board shows its drop placeholders (layout may shift), the target is scrolled
 * into view, its visible box is measured again and the pointer travels there in steps before
 * release. `point` picks where inside the visible box to release (default: horizontally
 * centred, 24 px down).
 */
export async function dragCardTo(
  page: Page,
  card: Locator,
  target: Locator,
  point: { x?: number; y?: number } = {},
): Promise<void> {
  // Start the native drag; under load Chromium occasionally turns the gesture into a text
  // selection instead, so the start is retried once when no placeholder shows up.
  for (let attempt = 0; ; attempt++) {
    await reveal(card);
    await page.waitForTimeout(60); // let the scroll settle before hit-testing the pointer
    const from = await reveal(card);
    if (!from.width || !from.height) throw new Error("drag source is not visible");
    const sx = from.x + from.width / 2;
    const sy = from.y + from.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 6, sy + 6, { steps: 3 });
    await page.mouse.move(sx + 14, sy + 14, { steps: 3 });
    const started = await page
      .locator(".section--placeholder")
      .first()
      .waitFor({ state: "attached", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (started) break;
    await page.mouse.up();
    if (attempt >= 1) throw new Error("drag did not start (no drop placeholders appeared)");
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(80);
  await reveal(target);
  await page.waitForTimeout(80);
  const to = await reveal(target);
  if (!to.width || !to.height) throw new Error("drop target is not visible");
  const tx = to.x + Math.min(point.x ?? to.width / 2, to.width - 4);
  const ty = to.y + Math.min(point.y ?? Math.min(24, to.height / 2), to.height - 4);
  await page.mouse.move(tx - 20, ty - 10, { steps: 10 });
  await page.mouse.move(tx, ty, { steps: 6 });
  await page.waitForTimeout(80);
  await page.mouse.up();
}

/** Status column a card currently sits in. */
export function columnOf(card: Locator): Promise<string | null | undefined> {
  return card.evaluate((el) => el.closest('[data-testid="column"]')?.getAttribute("data-status"));
}

/** A section drop zone by status and priority, optionally inside one swimlane. */
export function sectionZone(page: Page, status: string, priority: number, lane?: string): Locator {
  const scope =
    lane === undefined
      ? `[data-testid="column"][data-status="${status}"]`
      : `[data-testid="lane-cell"][data-lane="${lane}"][data-status="${status}"]`;
  return page.locator(`${scope} [data-testid="section"][data-drop-priority="${priority}"]`).first();
}
