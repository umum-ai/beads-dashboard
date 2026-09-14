/**
 * Playwright e2e. `E2E_TARGET=mock` (default) starts the mock BFF on the port of `BDDB_URL`
 * (default http://127.0.0.1:7331) and tests against the fixture; any other value assumes a
 * server is already listening at `BDDB_URL` (real BFF against a stand, or the Docker image).
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.BDDB_URL ?? "http://127.0.0.1:7331";
const target = process.env.E2E_TARGET ?? "mock";
const port = new URL(baseURL).port || "80";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 30_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    locale: "en-US",
    colorScheme: "light",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /live\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // real-only live test; runs after the board tests so its new card cannot skew their counts
      name: "live",
      testMatch: /live\.spec\.ts/,
      dependencies: ["chromium"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer:
    target === "mock"
      ? {
          command: "bun src/web/dev/mock-bff.ts",
          url: `${baseURL}/healthz`,
          reuseExistingServer: !process.env.CI,
          env: { MOCK_PORT: port, MOCK_HMR: "0", MOCK_LIVE_MS: "4000" },
          timeout: 30_000,
        }
      : undefined,
});
