// Where the journeys' disposable Chromium lives: one absolute path, worked
// out from this file's own place in the checkout, so the install, the browser
// suite and the flow gate name the same folder from any working directory. A
// relative PLAYWRIGHT_BROWSERS_PATH would not: Playwright resolves it against
// INIT_CWD, the folder pnpm was started in.

import { fileURLToPath } from "node:url";

/** `<checkout>/node_modules/.cache/journey-playwright`. */
export const JOURNEY_BROWSERS = fileURLToPath(new URL("../../../node_modules/.cache/journey-playwright", import.meta.url));
