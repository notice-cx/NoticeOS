// pnpm --filter @noticeos/tower run test:journeys [-- <Playwright options>]
//
// Runs the journeys in playwright.config.ts. Everything after `--` goes to
// `playwright test`:
//   -- -g "exact task and approval"   only the journeys whose title matches
//   -- --project desktop              only one viewport (desktop or mobile)
//   -- --list                         list what would run and run nothing
//
// pnpm passes the `--` itself on to the script, and Playwright ignores every
// argument after a `--`, so `playwright test -- -g x` runs every journey. This
// drops that one leading `--` and runs Playwright's CLI in this process, so
// signals and the exit code stay Playwright's own.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cli = require.resolve("@playwright/test/cli");
const config = fileURLToPath(new URL("./playwright.config.ts", import.meta.url));

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
process.argv = [process.argv[0], cli, "test", "-c", config, ...args];
require(cli);
