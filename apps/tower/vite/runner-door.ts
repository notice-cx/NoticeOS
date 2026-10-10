// The ingest door: a loopback-only listener on the Tower's dev server. The
// ingest runs as an auxiliary Worker inside the Tower's runtime, whose listener
// is on the LAN; its scheduled trigger and write routes have no authentication
// and must not become LAN-reachable. This second listener serves the same vite
// middleware stack and is the one place a request can enter carrying the mark
// that unlocks `/api/runner/…`. The kernel enforces the boundary; nothing is
// trusted from a header, a token file or an origin check.
//
// Feeding a foreign `IncomingMessage` into `viteDevServer.middlewares` is the
// technique `@cloudflare/vite-plugin` itself uses for requests that originate
// inside workerd.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin, ViteDevServer } from "vite";
import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  RUNNER_PATH_PREFIX,
  isLoopbackAddress,
  runnerDoorTarget,
} from "../shared/runner-lane";

/** The ingest's pinned port; `scripts/runner/config.mjs` is the source of truth. */
export const DEFAULT_DOOR_PORT = 8791;
export const DEFAULT_DOOR_HOST = "127.0.0.1";

/** Marks the request objects this door created. A symbol, not a header:
 * nothing outside this process can set it. */
const DOOR_ORIGIN = Symbol.for("noticeos.runner-door");

type DoorRequest = IncomingMessage & { [DOOR_ORIGIN]?: true };

export function doorPortFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.OS_UP_INGEST_DOOR_PORT?.trim();
  if (!raw) return DEFAULT_DOOR_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `OS_UP_INGEST_DOOR_PORT must be a TCP port, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

export function doorHostFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.OS_UP_INGEST_DOOR_HOST?.trim();
  return raw ? raw : DEFAULT_DOOR_HOST;
}

/**
 * A Node request carries its headers twice: the parsed `req.headers` map and
 * the flat `req.rawHeaders` array, separate objects. The Cloudflare plugin
 * builds the `Request` it hands to workerd from `rawHeaders` alone, so both
 * must move together or the Worker sees the original wire headers.
 */
function stripHeader(req: IncomingMessage, name: string): void {
  delete req.headers[name];
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return;
  // Backwards: splicing a pair shifts everything after it.
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i]?.toLowerCase() === name) raw.splice(i, 2);
  }
}

function stampHeader(req: IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  if (Array.isArray(req.rawHeaders)) req.rawHeaders.push(name, value);
}

/**
 * The guard on the shared middleware stack. The header is stripped from every
 * request first and re-added only for the ones this process knows arrived on
 * the loopback listener; that ordering is what makes the mark unforgeable, and
 * why the guard must run before the Cloudflare plugin's dispatch middleware.
 */
export function runnerGuard(): Connect.NextHandleFunction {
  return function noticeosRunnerGuard(req, res, next) {
    const path = (req.url ?? "").split("?")[0] ?? "";
    // The Cloudflare plugin's unconditional `/cdn-cgi/handler/*` middleware
    // dispatches trigger events to the entry Worker, and the Tower binds the
    // LAN. The door rewrites trigger paths to the runner lane before entering
    // the stack, so every `/cdn-cgi/…` here is foreign.
    if (path.startsWith("/cdn-cgi/")) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ error: "runner_lane_loopback_only" }));
      return;
    }
    if (!path.startsWith(RUNNER_PATH_PREFIX)) {
      next();
      return;
    }
    stripHeader(req, RUNNER_DOOR_HEADER);
    if ((req as DoorRequest)[DOOR_ORIGIN] !== true) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ error: "runner_lane_loopback_only" }));
      return;
    }
    stampHeader(req, RUNNER_DOOR_HEADER, RUNNER_DOOR_HEADER_VALUE);
    next();
  };
}

/**
 * Hand one door request to the vite stack under its rewritten path. The
 * loopback check is redundant with the bind address and kept anyway.
 */
export function serveDoorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  middlewares: (req: IncomingMessage, res: ServerResponse) => void,
): void {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "runner_lane_loopback_only" }));
    return;
  }
  (req as DoorRequest)[DOOR_ORIGIN] = true;
  req.url = runnerDoorTarget(req.url ?? "/");
  middlewares(req, res);
}

/**
 * A failed bind is fatal on purpose: the door port is the single-runtime
 * interlock, and a second dev server would run duplicate scheduled lanes for
 * one installation.
 */
export function ingestDoor(): Plugin {
  return {
    name: "noticeos:ingest-door",
    enforce: "pre",
    apply: "serve",
    configureServer(viteDevServer: ViteDevServer) {
      viteDevServer.middlewares.use(runnerGuard());

      const host = doorHostFromEnv(process.env);
      const port = doorPortFromEnv(process.env);
      const door = http.createServer((req, res) =>
        serveDoorRequest(req, res, (r, s) => viteDevServer.middlewares(r, s)),
      );

      // One retry, then fatal: when vite restarts itself the outgoing server's
      // socket can still be releasing when the incoming one binds.
      let retried = false;
      door.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && !retried) {
          retried = true;
          setTimeout(() => door.listen(port, host), 300).unref();
          return;
        }
        viteDevServer.config.logger.error(
          `[ingest-door] cannot listen on ${host}:${port} (${err.code ?? err.message}). ` +
            `That port is the single-runtime interlock: something else is already ` +
            `serving the ingest, and starting beside it would put two workerd ` +
            `runtimes dispatching the same installation. Find the owner with:  ` +
            `lsof -nP -iTCP:${port} -sTCP:LISTEN  — then stop it and start again.`,
        );
        process.exit(1);
      });

      const close = () => {
        door.closeAllConnections?.();
        door.close();
      };

      // Bind only once vite itself is serving; in middleware mode there is no
      // httpServer to wait on.
      const httpServer = viteDevServer.httpServer;
      if (httpServer) {
        httpServer.once("listening", () => door.listen(port, host));
        httpServer.once("close", close);
      } else {
        door.listen(port, host);
      }
      process.once("exit", close);

      door.on("listening", () => {
        viteDevServer.config.logger.info(
          `  ➜  ingest door: http://${host}:${port}/ (loopback only)`,
        );
      });
    },
  };
}
