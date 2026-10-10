// pnpm --filter @noticeos/tower run journey:install [--with-deps] [--dry-run]
//
// Installs the pinned Chromium the journeys run in into
// JOURNEY_BROWSERS, an absolute path under this checkout, and says where, so
// the install and the journeys agree from any checkout or worktree. Every
// argument goes to `playwright install chromium`: --with-deps adds Linux
// system libraries (CI), --dry-run prints each install location and downloads
// nothing.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { JOURNEY_BROWSERS } from "./journey-browsers.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
console.log(`Journey browsers: ${JOURNEY_BROWSERS}`);
const result = spawnSync(process.execPath, [cli, "install", "chromium", ...args], {
  stdio: "inherit",
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: JOURNEY_BROWSERS },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
