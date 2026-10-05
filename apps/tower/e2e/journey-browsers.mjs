// WHERE THE JOURNEYS' DISPOSABLE CHROMIUM LIVES (bead ro-ujb9.181): one
// absolute path, worked out from this file's own place in the checkout, so the
// install (install-browser.mjs), the browser suite (playwright.config.ts) and
// the UX flow gate (flow-gate.mjs) name the same folder from any checkout,
// worktree or working directory. A relative PLAYWRIGHT_BROWSERS_PATH does not:
// Playwright resolves it against INIT_CWD, the folder pnpm was started in, so
// the install once landed two folders above the checkout.

import { fileURLToPath } from "node:url";

/** `<checkout>/node_modules/.cache/journey-playwright`. */
export const JOURNEY_BROWSERS = fileURLToPath(new URL("../../../node_modules/.cache/journey-playwright", import.meta.url));
