import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { fixtureConfigPlugin } from "../../scripts/test-config-isolation.mjs";
import { unitTestAttribution } from "../../scripts/unit-test-attribution.mjs";
import { unitTestWorkers } from "../../scripts/unit-test-workers.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Vitest's own order, with the node files first. A worker keeps its process
 * only while the next file wants the same environment, so mixing the two
 * would start a process for nearly every file; the node files go first
 * because they hold the longest ones (dev servers, subprocesses, Postgres).
 * A file's environment is its `@vitest-environment` line, read the way Vitest
 * reads it. */
class NodeFilesFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const inNode = (file: TestSpecification) => /@(?:vitest|jest)-environment\s+node\b/.test(readFileSync(file.moduleId, "utf8"));
    const node = new Set(sorted.filter(inNode));
    return [...node, ...sorted.filter((file) => !node.has(file))];
  }
}

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
    // Node Web Storage is process-wide; browser tests need jsdom's per-window storage.
    execArgv: ["--no-experimental-webstorage"],
    maxWorkers: unitTestWorkers(),
    // One process per worker, reused from file to file: starting a process,
    // jsdom and the setup for every file costs more than most files' tests.
    // Every file still starts clean (test/clean-start.ts; test/isolation-probe.ts
    // proves it).
    isolate: false,
    setupFiles: ["./test/clean-start.ts", "./test/environment.ts", "./test/setup.ts"],
    sequence: { setupFiles: "list", sequencer: NodeFilesFirst },
    globalSetup: ["./test/postgres-global-setup.mjs"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
