#!/usr/bin/env bun
/**
 * README screenshots from the mock BFF: the board in light and dark, 1440×900 PNG.
 *
 *   bun scripts/screenshots.ts                 # starts the mock on a free port, writes docs/screenshots/
 *   BDDB_URL=http://127.0.0.1:7331 bun scripts/screenshots.ts   # against a running server
 *
 * Needs Chromium for Playwright (`bunx playwright install chromium`). Keep each file under
 * 300 KB (the script fails otherwise) — they are committed.
 */
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "docs/screenshots");
const MAX_BYTES = 300 * 1024;
const DB = process.env.SHOT_DB ?? "siam_platform";

async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

let mock: ReturnType<typeof Bun.spawn> | null = null;
let base = process.env.BDDB_URL ?? "";
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  mock = Bun.spawn(["bun", "src/web/dev/mock-bff.ts"], {
    cwd: ROOT,
    env: { ...process.env, MOCK_PORT: String(port), MOCK_HMR: "0", MOCK_LIVE_MS: "60000" },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not yet */
    }
    await Bun.sleep(100);
  }
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      colorScheme: scheme,
      locale: "en-US",
    });
    await page.goto(`${base}/p/${DB}/board`);
    await page.getByTestId("card").first().waitFor();
    await page.waitForTimeout(300);
    const file = path.join(OUT, `board-${scheme}.png`);
    await page.screenshot({ path: file });
    const size = (await stat(file)).size;
    console.log(`${path.relative(ROOT, file)}: ${(size / 1024).toFixed(0)} KB`);
    if (size > MAX_BYTES) throw new Error(`${file} exceeds ${MAX_BYTES / 1024} KB`);
    await page.close();
  }
} finally {
  await browser.close();
  mock?.kill();
}
