// @vitest-environment node
//
// The shared test-server helper against real Vite. Closing a dev server while
// its optimizer is bundling crashes rolldown or hangs the close, so the helper
// waits for the optimizer first, through fields Vite does not document: this
// test notices when an upgrade moves them. scripts/test-vite-server.test.mjs
// covers the rest.
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import { createTestViteServer, optimizerWork } from "../../../scripts/test-vite-server.mjs";

const towerRoot = path.dirname(fileURLToPath(new URL("../vite.config.ts", import.meta.url)));

describe("a Vite dev server a test starts", () => {
  it("closes right after listening only once the optimizer's run has finished", async () => {
    const server = await createTestViteServer(createServer, {
      configFile: false,
      root: towerRoot,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, hmr: false },
      // Nothing to scan and one dependency to bundle: the optimizer's first run
      // starts when the server listens and ends a moment later, in the background.
      optimizeDeps: { entries: [], include: ["react"] },
    }, { pages: true });
    await server.listen();
    const optimizer = server.environments.client?.depsOptimizer;
    expect(optimizerWork(server).length, "the run is in flight when the close starts").toBeGreaterThan(0);
    await server.close();
    expect(optimizerWork(server)).toEqual([]);
    // Finished and kept, not cancelled: the close waited for the bundle.
    expect(optimizer?.metadata.optimized.react).toBeDefined();
  }, 60_000);

  it("runs no dependency optimizer when no page is loaded from it, whatever its plugins include", async () => {
    const server = await createTestViteServer(createServer, {
      configFile: false,
      root: towerRoot,
      logLevel: "silent",
      plugins: [react()],
      server: { host: "127.0.0.1", port: 0, hmr: false },
    }, { pages: false });
    await server.listen();
    expect(server.environments.client?.depsOptimizer).toBeUndefined();
    expect(server.config.cacheDir).not.toContain(towerRoot);
    expect(server.config.server.watch).toBeNull();
    await server.close();
  }, 60_000);
});
