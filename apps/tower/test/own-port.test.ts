// @vitest-environment node
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { guardListen, ownPort } from "../vite/own-port";

// A Tower started on a port listens there after every restart or stops: it
// never comes back on another port, the stack's 5173 least of all. No test
// here binds 5173, since the operator's live Tower may be listening on it.

const owned: { dir?: string; server?: ViteDevServer; others: (http.Server | net.Server)[] } = { others: [] };
afterEach(async () => {
  await owned.server?.close();
  for (const other of owned.others) await new Promise((resolve) => other.close(resolve));
  if (owned.dir) rmSync(owned.dir, { recursive: true, force: true });
  owned.server = undefined;
  owned.dir = undefined;
  owned.others = [];
});

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** What the servers log as errors, across restarts: each restart makes a new
 * logger, but all of them write through this one. */
const logged: string[] = [];
const logger = createLogger("silent");
logger.error = (message) => void logged.push(message);

async function start(port: number, exit: (code: number) => void): Promise<ViteDevServer> {
  logged.length = 0;
  owned.dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "own-port-")));
  owned.server = await createTestViteServer(createServer, {
    configFile: false,
    root: owned.dir,
    customLogger: logger,
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
    plugins: [ownPort({ exit })],
  }, { pages: false });
  await owned.server.listen();
  return owned.server;
}

describe("a Tower dev server keeps its own port", () => {
  it("listens on its port after a restart", async () => {
    const port = await freePort();
    const exit = vi.fn();
    const server = await start(port, exit);
    await server.restart();
    expect((server.httpServer?.address() as AddressInfo).port).toBe(port);
    expect(exit).not.toHaveBeenCalled();
  }, 30_000);

  it("stops instead of listening elsewhere when a failed restart leaves Vite with another port", async () => {
    const port = await freePort();
    const elsewhere = await freePort();
    const exit = vi.fn();
    const server = await start(port, exit);
    // The state a failed restart can leave behind: Vite then picks its port
    // from it, which on the operator's machine was its default 5173.
    (server as unknown as { _currentServerPort: number })._currentServerPort = elsewhere;
    await expect(server.restart()).rejects.toThrow(`Port ${elsewhere} is not this Tower's port ${port}`);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logged).toContainEqual(expect.stringContaining(`listen on port ${elsewhere} instead of this Tower's port ${port}`));
    expect(await answers(elsewhere)).toBe(false);
  }, 30_000);
});

describe("guardListen", () => {
  function guarded(port: number, strictPort = true) {
    const httpServer = http.createServer();
    owned.others.push(httpServer);
    const logger = { error: vi.fn() };
    const exit = vi.fn();
    guardListen({ httpServer, config: { server: { port, strictPort }, logger } } as never, exit);
    return { httpServer, logger, exit };
  }

  it("stops when its own port is taken", async () => {
    const port = await freePort();
    const holder = net.createServer();
    owned.others.push(holder);
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    const { httpServer, logger, exit } = guarded(port);
    httpServer.on("error", () => {});
    httpServer.listen(port, "127.0.0.1");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`could not listen on its port ${port} (EADDRINUSE)`));
  });

  it("leaves a server alone once it listens, and one started without a fixed port", async () => {
    const port = await freePort();
    const { httpServer, exit } = guarded(port);
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
    // Vite keeps its own error listener on the server.
    httpServer.on("error", () => {});
    httpServer.emit("error", new Error("a later error the server reports"));
    expect(exit).not.toHaveBeenCalled();

    const loose = guarded(port, false);
    expect(loose.httpServer.listen).toBe(http.Server.prototype.listen);
  });
});
