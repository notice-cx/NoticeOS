// @vitest-environment node
import fs, { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAfterOptimizer, createTestViteServer } from "../../../scripts/test-vite-server.mjs";

// A restarted dev server reads its dependency cache before it transforms or
// answers anything, so the open tabs' reloads during a restart neither shrink
// the cache nor get a page its libraries from a second build.

const TOWER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const owned: { dir?: string; server?: ViteDevServer } = {};
afterEach(async () => {
  vi.restoreAllMocks();
  await owned.server?.close();
  if (owned.dir) rmSync(owned.dir, { recursive: true, force: true });
  owned.server = undefined;
  owned.dir = undefined;
});

/** A page whose first screen needs one library and whose later screen needs
 * another, both resolved from the Tower's node_modules. Outside the Tower's
 * folder, which a running dev Tower watches. */
function fixture(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dependencies-ready-")));
  symlinkSync(path.join(TOWER, "node_modules"), path.join(dir, "node_modules"), "dir");
  writeFileSync(path.join(dir, "index.html"), '<script type="module" src="/main.js"></script>\n');
  writeFileSync(path.join(dir, "main.js"), 'import { clsx } from "clsx";\nexport const shown = clsx("a");\nexport const later = () => import("./later.js");\n');
  writeFileSync(path.join(dir, "later.js"), 'import { twMerge } from "tailwind-merge";\nexport const merged = twMerge("p-1 p-2");\n');
  return dir;
}

/** The libraries the server's dependency cache holds now. */
function cachedLibraries(server: ViteDevServer): string[] {
  try {
    return Object.keys(JSON.parse(readFileSync(path.join(server.config.cacheDir, "deps", "_metadata.json"), "utf8")).optimized).sort();
  } catch {
    return [];
  }
}

async function start(dir: string, plugins: Plugin[]): Promise<ViteDevServer> {
  const server = (owned.server = await createTestViteServer(createServer, {
    configFile: false,
    root: dir,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
    plugins,
  }, { pages: true }));
  await vi.waitFor(() => expect(cachedLibraries(server)).toEqual(["clsx", "tailwind-merge"]), { timeout: 30_000, interval: 50 });
  return server;
}

/** The version the first screen's library is served under. */
function clsxVersion(code: string | undefined): string | undefined {
  return /\/deps\/clsx\.js\?v=([0-9a-f]+)/u.exec(code ?? "")?.[1];
}

/** What the open tabs cause on the Tower: the restarted server transforms
 * the first screen while it is still being created. */
function earlyTransform(): Plugin & { reloaded?: Promise<string | undefined> } {
  let servers = 0;
  const plugin: Plugin & { reloaded?: Promise<string | undefined> } = {
    name: "test-early-transform",
    configureServer(server) {
      if (++servers !== 2) return;
      plugin.reloaded = server.environments.client
        .transformRequest("/main.js")
        .then((result) => clsxVersion(result?.code), () => undefined);
    },
  };
  return plugin;
}

/** Restarts the server with the cache's record read late, as on a slow
 * restart. Returns the version the early transform got and the one served
 * once the restart has settled. */
async function restart(server: ViteDevServer, early: ReturnType<typeof earlyTransform>): Promise<[string | undefined, string | undefined]> {
  const read = fs.promises.readFile;
  vi.spyOn(fs.promises, "readFile").mockImplementation((async (file: Parameters<typeof read>[0], ...rest: unknown[]) => {
    if (String(file).endsWith("_metadata.json")) await new Promise((resolve) => setTimeout(resolve, 500));
    return (read as (...args: unknown[]) => Promise<unknown>).call(fs.promises, file, ...rest);
  }) as typeof read);
  await server.restart();
  // The restart replaced the server's close with the new instance's own.
  closeAfterOptimizer(server);
  const reloaded = await early.reloaded;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return [reloaded, clsxVersion((await server.environments.client.transformRequest("/main.js"))?.code)];
}

describe("a restarted Tower serves the libraries it already built", () => {
  it("keeps every cached library, and one version of each, through a transform during the restart", async () => {
    const dir = (owned.dir = fixture());
    const early = earlyTransform();
    const server = await start(dir, [early]);
    const [reloaded, settled] = await restart(server, early);
    expect(reloaded).toBeDefined();
    expect(reloaded).toBe(settled);
    expect(cachedLibraries(server)).toEqual(["clsx", "tailwind-merge"]);
  }, 60_000);

});
