import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fixtureConfigPlugin } from "../../scripts/test-config-isolation.mjs";
import { unitTestAttribution } from "../../scripts/unit-test-attribution.mjs";
import { unitTestWorkers } from "../../scripts/unit-test-workers.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// No Cloudflare plugin: these are plain node/jsdom unit tests, and reader SQL
// runs against isolated Postgres copies (test/postgres-store.ts). Vitest
// prefers this file over vite.config.ts.
//
// No test reads the checkout's own config/: a module importing a repo config
// file gets test/fixture-config/'s copy, and test/setup.ts refuses the rest,
// bar the seed-validation tests listed in scripts/test-config-isolation.mjs.
export default defineConfig({
  plugins: [
    fixtureConfigPlugin({ fixtureDir: path.resolve(rootDir, "test/fixture-config"), testDir: path.resolve(rootDir, "test") }),
    react(),
    // A worker that dies names the file it was running.
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
    maxWorkers: unitTestWorkers(),
    setupFiles: ["./test/setup.ts"],
    globalSetup: ["./test/postgres-global-setup.mjs"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
