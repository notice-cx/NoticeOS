import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fixtureConfigPlugin } from "../../scripts/test-config-isolation.mjs";
import { unitTestAttribution } from "../../scripts/unit-test-attribution.mjs";
import { unitTestWorkers } from "../../scripts/unit-test-workers.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Deliberately does NOT load the Cloudflare plugin: these are plain node/jsdom
// unit tests. Reader SQL runs against isolated real Postgres copies
// (test/postgres-store.ts) — no workerd needed. Vitest
// prefers this file over vite.config.ts, so the two never mix.
//
// No test reads the checkout's own config/ (bead ro-ujb9.92): a module that
// imports a repo config file (the contract's compiled clock) gets
// test/fixture-config/'s copy, a test importing one is refused, and
// test/setup.ts refuses reading one — bar the seed-validation tests listed in
// scripts/test-config-isolation.mjs.
export default defineConfig({
  plugins: [
    fixtureConfigPlugin({ fixtureDir: path.resolve(rootDir, "test/fixture-config"), testDir: path.resolve(rootDir, "test") }),
    react(),
    // A worker that dies names the file it was running (bead ro-ujb9.179).
    unitTestAttribution(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      "@shared": path.resolve(rootDir, "shared"),
    },
  },
  test: {
    environment: "jsdom",
    // Half the cores, beside the ingest suite (scripts/unit-test-workers.mts).
    maxWorkers: unitTestWorkers(),
    setupFiles: ["./test/setup.ts"],
    // One throwaway Postgres for the run: test/postgres-global-setup.mjs.
    globalSetup: ["./test/postgres-global-setup.mjs"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
