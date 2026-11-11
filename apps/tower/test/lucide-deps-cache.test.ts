// @vitest-environment node
// An installation keeps Vite's dependency cache outside the checkout
// (NOTICEOS_VITE_CACHE_DIR). A pre-bundled package that imports icons, such
// as the Ntasks UI, is served from there, and every icon it imports has to
// load from there too.
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createTestViteServer, optimizerIdle } from "../../../scripts/test-vite-server.mjs";
import { lucideIcons } from "../vite/lucide-icons";

const towerRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(towerRoot, "..", "..");
const PACKAGE = "@notice-cx/ntasks-ui";

describe("icons imported by a pre-bundled package, with the cache outside the checkout", () => {
  let server: ViteDevServer;
  let port = 0;
  let cacheDir = "";

  beforeAll(async () => {
    server = await createTestViteServer(createServer, {
      configFile: false,
      root: towerRoot,
      logLevel: "silent",
      plugins: [lucideIcons(towerRoot)],
      optimizeDeps: { noDiscovery: true, include: [PACKAGE, "react", "react-dom"] },
      server: { host: "127.0.0.1", port: 0, hmr: false },
    }, { pages: true });
    cacheDir = server.config.cacheDir;
    // The test server's cache is in the OS temp dir, outside the checkout, as an installation's is.
    expect(path.relative(repoRoot, cacheDir).startsWith("..")).toBe(true);
    server.config.server.fs.allow.push(cacheDir);
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
    expect(await optimizerIdle(server)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  }, 120_000);

  function get(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: url }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }).on("error", reject);
    });
  }

  const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

  it("serves every pre-bundled chunk and every icon module they import", async () => {
    const optimizer = server.environments.client.depsOptimizer!;
    const entry = optimizer.metadata.optimized[PACKAGE];
    expect(entry, "the package is pre-bundled").toBeDefined();
    const start = `/@fs${entry!.file}?v=${optimizer.metadata.browserHash}`;
    const seen = new Set<string>();
    const failed: string[] = [];
    const icons: string[] = []; // the lucide-react modules the chunks import
    const queue = [start];
    while (queue.length) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const reply = await get(url);
      if (reply.status !== 200) {
        failed.push(`${reply.status} ${url}`);
        continue;
      }
      if (url.includes("/lucide-react/")) {
        icons.push(url);
        continue;
      }
      for (const match of reply.body.matchAll(IMPORT)) {
        // An import Vite rewrote carries its version or an absolute path; the
        // bundled code also quotes names and paths in comments and strings.
        if (!/[?&]v=|^\/@fs\/|^\/node_modules\//.test(match[1]!)) continue;
        const next = new URL(match[1]!, `http://tower${url}`);
        const target = next.pathname + next.search;
        // The cache's own chunks, and the icon modules they import.
        if (next.pathname.includes(cacheDir) || next.pathname.includes("/lucide-react/")) queue.push(target);
      }
    }
    expect(failed).toEqual([]);
    // One module per icon, and never the package's 4 MB index.
    expect(icons.filter((url) => /\/lucide-react\/dist\/esm\/icons\/[a-z0-9-]+\.mjs/.test(url)).length).toBeGreaterThan(0);
    expect(icons.filter((url) => /\/lucide-react\/dist\/esm\/lucide-react\.mjs/.test(url))).toEqual([]);
  }, 120_000);
});
