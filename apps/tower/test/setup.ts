import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { installOwnerConfigReadGuard } from "../../../scripts/test-config-isolation.mjs";
import { releaseTestStores } from "./postgres-store";

// Tests run on fixture configuration (bead ro-ujb9.92): test code reading the
// checkout's own config/ with node:fs is refused before the file is touched,
// unless it is a seed-validation test listed in
// scripts/test-config-isolation.mjs. Imports are answered by vitest.config.ts.
// A string, not `new URL(...)`: under jsdom the global URL is jsdom's.
installOwnerConfigReadGuard({ testDir: path.dirname(fileURLToPath(import.meta.url)) });

// No global test APIs (verbatimModuleSyntax friendly) — tests import from
// vitest explicitly. This only wires jest-dom matchers and unmounts the DOM
// between tests so document-scoped queries never collide across cases.
afterEach(() => {
  cleanup();
});
// Release every per-test Postgres copy, including a failed assertion's copy.
afterEach(() => releaseTestStores());

// Two browser APIs jsdom does not ship, both wanted by cmdk's `Command` (the
// palette, and the kitchen sink's demo of it): the list observes its own height
// to publish `--cmdk-list-height`, and it keeps the highlighted row in view.
// Neither carries meaning the tests read, and jsdom has no layout to measure,
// so a no-op is the honest stand-in rather than a fake measurement.
// Guarded, because this file also loads for the suites that run in the node
// environment (the vite plugins, the runner door) where there is no DOM at all.
if (typeof Element !== "undefined") {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
}
