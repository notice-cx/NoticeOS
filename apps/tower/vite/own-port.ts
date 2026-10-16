// The Tower listens only on the port it was started with.
//
// Both launchers start Vite with `--port <n> --strictPort` (scripts/os-up.mjs
// for the stack, scripts/start.mjs for a throwaway Tower), but Vite chooses a
// restarted server's port from state an earlier failed restart can leave
// behind, and falls back to its default 5173: the stack's own port, where a
// throwaway Tower takes requests meant for the live one. So a listen on any
// other port, or a failed bind of its own, stops the process, as the ingest
// door does: whoever started it sees it stop.

import type { Server } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

type Exit = (code: number) => void;

export function ownPort({ exit = (code: number) => process.exit(code) }: { exit?: Exit } = {}): Plugin {
  return {
    name: "noticeos-own-port",
    apply: "serve",
    configureServer(server) {
      guardListen(server, exit);
    },
  };
}

/** Wraps the server's `listen` (Vite's own wrapper calls it) so that every
 * start and restart binds `server.port` or stops. */
export function guardListen(server: Pick<ViteDevServer, "httpServer" | "config">, exit: Exit): void {
  const httpServer = server.httpServer as Server | null;
  const { port, strictPort } = server.config.server;
  if (!httpServer || !strictPort || !port) return;
  const stop = (reason: string) => {
    server.config.logger.error(`[tower-port] ${reason} Stopping, so this Tower never answers on another server's port.`);
    exit(1);
  };
  const listen = httpServer.listen.bind(httpServer) as (...args: unknown[]) => Server;
  httpServer.listen = ((...args: unknown[]) => {
    const requested = args[0];
    if (requested !== port) {
      stop(`A restart was about to listen on port ${String(requested)} instead of this Tower's port ${port}.`);
      // Whoever waits on this listen hears why rather than waiting forever.
      queueMicrotask(() => httpServer.emit("error", new Error(`Port ${String(requested)} is not this Tower's port ${port}`)));
      return httpServer;
    }
    const failed = (error: NodeJS.ErrnoException) =>
      stop(`This Tower could not listen on its port ${port} (${error.code ?? error.message}).`);
    httpServer.once("error", failed);
    httpServer.once("listening", () => httpServer.off("error", failed));
    return listen(...args);
  }) as Server["listen"];
}
