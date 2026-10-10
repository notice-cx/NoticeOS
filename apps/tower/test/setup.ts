import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { installOwnerConfigReadGuard } from "../../../scripts/test-config-isolation.mjs";
import { releaseTestStores } from "./postgres-store";

// Tests run on fixture configuration: test code reading the checkout's own
// config/ with node:fs is refused before the file is touched, unless it is a
// seed-validation test listed in scripts/test-config-isolation.mjs. Imports
// are answered by vitest.config.ts. A string, not `new URL(...)`: under jsdom
// the global URL is jsdom's.
installOwnerConfigReadGuard({ testDir: path.dirname(fileURLToPath(import.meta.url)) });

// Tests import from vitest explicitly; this wires jest-dom matchers and
// unmounts the DOM between tests so document-scoped queries never collide.
afterEach(() => {
  cleanup();
});
// Release every per-test Postgres copy, including a failed assertion's copy.
afterEach(() => releaseTestStores());

// cmdk's `Command` wants two browser APIs jsdom does not ship (ResizeObserver
// for `--cmdk-list-height`, scrollIntoView for the highlighted row); jsdom has
// no layout, so no-ops stand in. Guarded because node-environment suites load
// this file too.
if (typeof Element !== "undefined") {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
}
