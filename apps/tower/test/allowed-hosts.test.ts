// @vitest-environment node
// The Tower answers on this installation's machine names: the list comes from
// the machine at start, never from names written into the product, and
// Vite's DNS-rebinding guard still refuses every other Host.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { EXTRA_HOSTS_ENV, machineHostNames, towerAllowedHosts } from "../vite/allowed-hosts";

describe("the names the Tower answers to", () => {
  it("are the machine's own name, its first label and that label's .local form", () => {
    expect(machineHostNames("studio")).toEqual(["studio", "studio.local"]);
    expect(machineHostNames("Studio.local")).toEqual(["studio.local", "studio"]);
    expect(machineHostNames("studio.lan.")).toEqual(["studio.lan", "studio", "studio.local"]);
    expect(machineHostNames("")).toEqual([]);
    expect(machineHostNames("not a name")).toEqual([]);
  });

  it("add loopback and the operator's extra names, and drop what is not a host name", () => {
    const hosts = towerAllowedHosts({
      hostname: "studio",
      env: { [EXTRA_HOSTS_ENV]: " Tower.Example.com, .home.example  *  studio.local" },
    });
    expect(hosts).toEqual(["localhost", "studio", "studio.local", "tower.example.com", ".home.example"]);
    expect(towerAllowedHosts({ hostname: "studio", env: {} })).toEqual(["localhost", "studio", "studio.local"]);
  });

  it("are read from the machine when nothing is passed", () => {
    const hosts = towerAllowedHosts({ env: {} });
    expect(hosts[0]).toBe("localhost");
    expect(hosts.length).toBeGreaterThan(1);
  });
});

describe("Vite's host guard, given that list", () => {
  let server: ViteDevServer;
  let port = 0;
  let root = "";

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "tower-hosts-"));
    // The shared test-server helper: no page is loaded, so no optimizer.
    server = await createTestViteServer(createServer, {
      configFile: false,
      root,
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 6957,
        strictPort: false,
        hmr: false,
        allowedHosts: towerAllowedHosts({ hostname: "studio", env: { [EXTRA_HOSTS_ENV]: "tower.example.com" } }),
      },
    }, { pages: false });
    await server.listen();
    port = (server.httpServer!.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function ask(host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      });
      request.on("error", reject);
    });
  }

  it("serves the machine's names, the operator's extra name, loopback and an address", async () => {
    for (const host of [`studio.local:${port}`, `studio:${port}`, `tower.example.com:${port}`, `localhost:${port}`, `127.0.0.1:${port}`]) {
      const reply = await ask(host);
      expect(reply.status, host).not.toBe(403);
      expect(reply.body, host).not.toMatch(/Blocked request/);
    }
  });

  it("refuses a request whose Host is not one of them", async () => {
    for (const host of [`attacker.example:${port}`, `studio.example:${port}`, `other-machine.local:${port}`]) {
      const reply = await ask(host);
      expect(reply.status, host).toBe(403);
      expect(reply.body, host).toMatch(/Blocked request/);
    }
  });
});
