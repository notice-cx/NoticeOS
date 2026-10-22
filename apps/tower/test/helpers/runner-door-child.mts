// The production door exits on a failed bind. Keep that interlock inside an
// owned child so fixture acquisition can select another port without exiting Vitest.
import { ChildProcess } from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, createServer, type ViteDevServer } from "vite";
import { installOwnerConfigReadGuard } from "../../../../scripts/test-config-isolation.mjs";
import { createTestViteServer } from "../../../../scripts/test-vite-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
installOwnerConfigReadGuard({ testDir: path.join(root, "test") });
const logger = createLogger("silent");
logger.error = (message) => {
  // Only this exact production bind diagnostic authorizes another acquisition.
  if (message.startsWith(`[tower-port] This Tower could not listen on its port ${towerPort} (EADDRINUSE).`) ||
      message.startsWith(`[ingest-door] cannot listen on 127.0.0.1:${doorPort} (EADDRINUSE).`)) {
    process.send?.({ type: "collision" });
  } else process.stderr.write(message + "\n");
};
const channel = tracingChannel("child_process.spawn");
channel.subscribe({ end: message => {
  const child: unknown = Reflect.get(message, "process");
  if (!(child instanceof ChildProcess)) return;
  child.once("spawn", () => process.send?.({ type: "descendant", pid: child.pid }));
} });
let server: ViteDevServer | undefined;
let closing: Promise<void> | undefined;
function close() {
  closing ??= (async () => {
    await server?.close();
    if (process.connected) process.disconnect?.();
  })();
  return closing;
}
process.on("message", message => { if (message === "close") void close().catch(fail); });
process.once("disconnect", () => { void close().catch(fail); });
function fail(error: unknown) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
  void close();
}
const towerPort = Number(process.env.NOTICEOS_TEST_TOWER_PORT);
const doorPort = Number(process.env.OS_UP_INGEST_DOOR_PORT);
try {
  for (const port of [towerPort, doorPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || [5173, 8791].includes(port)) throw new Error("unsafe fixture port");
  }
  server = await createTestViteServer(createServer, {
    root,
    configFile: process.env.NOTICEOS_TEST_VITE_CONFIG ?? path.join(root, "vite.config.ts"),
    server: { port: towerPort, strictPort: true, host: "127.0.0.1" },
    customLogger: logger,
    logLevel: "silent",
  }, { pages: false });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Tower fixture has no TCP address");
  if ([5173, 8791].includes(address.port)) throw new Error("Tower fixture bound a live port");
  // Readiness includes the door, whose listener starts after Vite's listener.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${process.env.OS_UP_INGEST_DOOR_PORT}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* workerd is starting */ }
    if (Date.now() >= deadline) throw new Error("ingest door fixture never became ready");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  process.send?.({ type: "ready", towerPort: address.port, optimizerDisabled: server.environments.client?.depsOptimizer === undefined });
} catch (error) {
  if (error instanceof Error && (error.message === `Port ${towerPort} is already in use` ||
      (Reflect.get(error, "code") === "EADDRINUSE" && Reflect.get(error, "port") === towerPort))) {
    process.send?.({ type: "collision" });
  }
  fail(error);
}
