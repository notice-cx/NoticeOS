// @vitest-environment node
// The Tower's dev server never sends the installation's secrets, records or
// stores, including through the links the app image makes from the checkout
// into its state folder, while source files and the dependency cache are
// still served.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { TOWER_DENY, VITE_DEFAULT_DENY } from "../vite/served-files";

const SECRET = "PRIVATE-SENTINEL";

describe("what the Tower's dev server sends from disk", () => {
  let server: ViteDevServer;
  let port = 0;
  let base = "";
  let root = "";

  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), "tower-served-"));
    root = path.join(base, "checkout");
    const state = path.join(base, "state");
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    };
    write(path.join(state, "workers", "ingest", ".dev.secrets.json"), JSON.stringify({ OPERATOR_TOKEN: SECRET }));
    write(path.join(state, ".local", "logs", "os-up.log"), SECRET);
    write(path.join(state, ".local", "runner-state.json"), SECRET);
    write(path.join(state, ".local", "vite-cache", "deps", "dep.js"), "export const dep = 1;\n");
    write(path.join(state, ".wrangler", "state", "v3", "r2", "blob"), SECRET);
    write(path.join(root, "src", "ok.ts"), "export const ok = 1;\n");
    write(path.join(root, ".beads", "config.yaml"), SECRET);
    write(path.join(root, "workers", "ingest", ".dev.vars"), SECRET);
    // As the app image links them.
    symlinkSync(path.join(state, "workers", "ingest", ".dev.secrets.json"), path.join(root, "workers", "ingest", ".dev.secrets.json"));
    symlinkSync(path.join(state, ".local"), path.join(root, ".local"));
    symlinkSync(path.join(state, ".wrangler"), path.join(root, ".wrangler"));
    server = await createTestViteServer(createServer, {
      configFile: false,
      root,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 6958, strictPort: false, hmr: false, fs: { allow: [root], deny: TOWER_DENY } },
    }, { pages: false });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server?.close();
    rmSync(base, { recursive: true, force: true });
  });

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

  it("keeps Vite's own defaults on the list it replaces", () => {
    for (const pattern of VITE_DEFAULT_DENY) expect(TOWER_DENY).toContain(pattern);
  });

  it("refuses the secrets, records and stores, by /@fs/ and by plain path", async () => {
    for (const file of ["workers/ingest/.dev.secrets.json", "workers/ingest/.dev.vars", ".local/logs/os-up.log", ".local/runner-state.json",
      ".wrangler/state/v3/r2/blob", ".beads/config.yaml"]) {
      for (const url of [`/@fs${path.join(root, file)}`, `/${file}?raw`, `/${file}?import`]) {
        const reply = await get(url);
        expect(reply.body, url).not.toContain(SECRET);
      }
    }
  });

  it("still serves source and the dependency cache", async () => {
    expect((await get(`/@fs${path.join(root, "src", "ok.ts")}`)).body).toContain("ok");
    const cached = await get(`/@fs${path.join(root, ".local", "vite-cache", "deps", "dep.js")}`);
    expect(cached.status).toBe(200);
    expect(cached.body).toContain("dep");
  });
});
