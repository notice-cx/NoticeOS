// The ingest door — a loopback-only listener on the Tower's dev server.
//
// WHY. Until 2026-08-03 the ingest ran as its own `wrangler dev` process and the
// Tower as `vite`: two workerd runtimes, each opening the SAME local sqlite as
// its own D1DatabaseObject. Durable Objects assume exclusive ownership of their
// storage, and the log showed what sharing it costs — 26 "internal error" lines
// clustered just after the */15 write burst, accelerating daily, and the leading
// suspect for the 2026-08-02 store corruption (beads ro-mad, ro-icq). The fix is
// ONE runtime: the ingest is now an auxiliary Worker inside the Tower's vite dev
// runtime. The operational store is now Postgres (D25); the shared runtime
// still keeps scheduled dispatch and the private ingest routes behind one door.
//
// The cost of one runtime is one listener, and the Tower's listener is on the
// LAN (0.0.0.0:5173) so a phone or a TV can render the wall. The ingest's
// scheduled trigger and its write routes must NOT become LAN-reachable — the
// scheduled endpoint has no authentication at all, by construction.
//
// So this plugin re-creates the boundary the ingest used to get from
// `wrangler dev --ip 127.0.0.1`: a second HTTP listener bound to loopback,
// serving the SAME vite middleware stack, which is the one place a request can
// enter carrying the mark that unlocks `/api/runner/…`. The kernel does the
// enforcing, exactly as before; nothing is trusted from a header, a token file
// or an origin check. And it keeps the ingest at its documented address, so
// `pnpm os:cron`, `scripts/pulse-relay.mjs` and every curl in
// `workers/ingest/README.md` still read the same.
//
// Feeding a foreign `IncomingMessage` into `viteDevServer.middlewares` is the
// same technique `@cloudflare/vite-plugin` itself uses to serve requests that
// originate inside workerd (`__VITE_MIDDLEWARE__`), so it is a supported shape
// in this stack rather than a trick.

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

/** The ingest's pinned port. `scripts/runner/config.mjs` CONFIG.ingestPort is the source
 * of truth and passes it in; the default keeps a bare `pnpm dev` honest. */
export const DEFAULT_DOOR_PORT = 8791;
export const DEFAULT_DOOR_HOST = "127.0.0.1";

/** Marks the request objects this door created. A symbol, not a header: nothing
 * outside this process can set it, and it never crosses the wire. */
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
 * A Node request carries its headers TWICE, and only one of them is the wire.
 *
 * `req.headers` is the parsed map every middleware reads. `req.rawHeaders` is
 * the flat `[name, value, name, value]` array as received. They are separate
 * objects, not views of each other — and the Cloudflare plugin builds the
 * `Request` it hands to workerd from `rawHeaders` ALONE (`createHeaders` in the
 * plugin's dist). So a middleware that only edits `req.headers` is talking to
 * itself: the Worker sees the original wire headers, whatever the map now says.
 *
 * That cost an operator restart. The door stamped `req.headers` only, the Worker
 * never saw the mark, and every single request through the door answered 403 —
 * while the unit tests, which held a fake request with only a `headers` object,
 * were perfectly green. The strip had the mirror-image bug: deleting a forged
 * header from the map left it untouched on the wire.
 *
 * So both representations move together, always, through these two helpers.
 * `rawHeaders` is a plain mutable array on the message object, so in-place
 * editing is what the plugin will read.
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
 * The guard on the SHARED middleware stack: only a request that came through the
 * door may carry the door mark.
 *
 * The strip is not defensive tidying, it is the whole mechanism. A LAN client
 * can send any header it likes to `http://<machine>.local:5173/api/runner/…`, so
 * the header is removed from EVERY request first and re-added only for the ones
 * this process knows arrived on the loopback listener. That ordering is what
 * makes the mark unforgeable, and it is why the guard must run before the
 * Cloudflare plugin's dispatch middleware (`enforce: "pre"`, listed first).
 */
export function runnerGuard(): Connect.NextHandleFunction {
  return function noticeosRunnerGuard(req, res, next) {
    const path = (req.url ?? "").split("?")[0] ?? "";
    // The Cloudflare plugin registers an unconditional middleware for
    // `/cdn-cgi/handler/*` that dispatches trigger events to the entry Worker,
    // and the Tower binds the LAN — so without this branch anyone on the
    // network can POST a scheduled/email event at the Tower (ro-qfv). The
    // Tower exports a scheduled handler since bead ro-ujb9.96.7.29 (its share
    // of the hourly tick, worker/tower-cron.ts), and the ingest sits behind the
    // door, so this branch is the boundary. Door requests never present `/cdn-cgi/…` here — the door
    // rewrites trigger paths to the runner lane before entering the stack — so
    // every one of these is foreign and is refused outright.
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
 * Hand one door request to the vite stack under its rewritten path.
 *
 * The loopback check is redundant with the bind address and kept anyway: if
 * someone ever widens the host this stays the thing that refuses, rather than
 * the boundary quietly becoming a comment.
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
 * The plugin. Dev only — `vite build` and `vite preview` never bind anything.
 *
 * A failed bind is FATAL on purpose. The door port is also the single-runtime
 * interlock: `scripts/os-up.mjs` refuses to start when it answers, and if a
 * second dev server ever slips past that check (a hand-run `pnpm dev` beside a
 * live runner, say) it would run duplicate scheduled lanes for one installation.
 * A warning would leave two runtimes dispatching the same work.
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

      // One retry, then fatal. The retry exists for exactly one case: vite
      // restarts itself when a config file changes, and the outgoing server's
      // socket can still be releasing when the incoming one binds. A port a
      // real owner holds is still held 300ms later, so this costs the diagnosis
      // nothing.
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

      // Bind only once vite itself is serving: until then a runner fire would
      // reach a middleware stack that cannot answer it. In middleware mode there
      // is no httpServer of our own to wait on, so bind straight away.
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
