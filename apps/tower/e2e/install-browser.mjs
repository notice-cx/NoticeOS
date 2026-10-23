// pnpm --filter @noticeos/tower run journey:install [--with-deps] [--dry-run]
//
// Installs the pinned Chromium the journeys run in into
// JOURNEY_BROWSERS, an absolute path under this checkout, and says where, so
// the install and the journeys agree from any checkout or worktree. Every
// argument goes to `playwright install chromium`: --with-deps adds Linux
// system libraries (CI), --dry-run prints each install location and downloads
// nothing.
//
// --with-deps installs the libraries only when one is missing. Playwright's
// own --with-deps refreshes the package lists from Ubuntu's mirrors on every
// run, which on CI took over two minutes in 37 of 1,071 jobs (up to 12) on
// runners that already had every library.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNEY_BROWSERS } from "./journey-browsers.mjs";

/** The Playwright commands an install runs: the browser, then, when the
 * libraries are wanted, an offline check for missing ones and the library
 * install that runs only if that check fails. */
export function installSteps(args) {
  const withDeps = args.includes("--with-deps") && !args.includes("--dry-run");
  return {
    browser: ["install", "chromium", ...args.filter((arg) => !withDeps || arg !== "--with-deps")],
    check: withDeps ? ["install-deps", "--dry-run", "chromium"] : null,
    deps: withDeps ? ["install-deps", "chromium"] : null,
  };
}

function main() {
  const steps = installSteps(process.argv.slice(2).filter((arg) => arg !== "--"));
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const playwright = (command) => {
    const result = spawnSync(process.execPath, [cli, ...command], {
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: JOURNEY_BROWSERS },
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  };
  console.log(`Journey browsers: ${JOURNEY_BROWSERS}`);
  let status = playwright(steps.browser);
  if (status === 0 && steps.check && playwright(steps.check) !== 0) status = playwright(steps.deps);
  process.exitCode = status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
