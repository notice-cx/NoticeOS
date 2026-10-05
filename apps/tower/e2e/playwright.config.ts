import { defineConfig } from "@playwright/test";
import { parallelServers } from "./fixture-server.mjs";
import { JOURNEY_BROWSERS } from "./journey-browsers.mjs";

process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;

// No shared server and no base URL here (bead ro-ujb9.167): every worker
// starts and owns its own isolated fixture server on its own free loopback
// port, and its tests reach only that server (journey-test.ts). So the tests
// run in parallel — JOURNEY_WORKERS workers, or half this machine's cores up
// to 4 — and none can see another's store. The run's one throwaway Postgres
// starts first (postgres-global-setup.mjs); each server takes its own copies.
export default defineConfig({
  testDir: ".", testMatch: ["journeys.spec.ts", "mobile-text-zoom.spec.ts"], fullyParallel: true, workers: parallelServers(),
  globalSetup: "./postgres-global-setup.mjs",
  forbidOnly: Boolean(process.env.CI), retries: 0, timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: { browserName: "chromium", headless: true, locale: "en-US", timezoneId: "UTC",
    colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block",
    screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: "mobile-text-zoom.spec.ts", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
});
