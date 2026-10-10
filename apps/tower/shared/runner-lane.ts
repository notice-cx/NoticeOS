// The vocabulary of the local runner's private lane into the ingest Worker.
//
// Locally there is one workerd runtime: the Tower is the entry Worker and the
// ingest an auxiliary Worker beside it (vite.config.ts `auxiliaryWorkers`), so
// the runner reaches the ingest through the Tower. The Tower binds the LAN and
// the ingest's scheduled trigger has no authentication of its own, so the lane
// is a second listener bound to 127.0.0.1 (the "ingest door",
// apps/tower/vite/runner-door.ts). This module is the alphabet the door and the
// Worker share.
//
// Three independent things must all hold before a runner request is served:
//   1. it arrived on the loopback door (kernel: nothing off-machine can),
//   2. the door stamped RUNNER_DOOR_HEADER, which the guard strips off every
//      request that did NOT come through it — so it cannot be forged from the
//      LAN,
//   3. `__RUNNER_LANE__` is true, which only a dev build defines — the lane is
//      not compiled into a deployed Tower at all.

import { CLOUDFLARE_D1_BACKUP_PATH } from '@noticeos/contract/cloudflare-d1';

/** Every runner path lives under here. Inside `/api/` on purpose: the Tower's
 * `run_worker_first` rule (`/api/*`) is what makes a path reach the Worker
 * rather than the SPA's static fallback. */
export const RUNNER_PATH_PREFIX = "/api/runner/";

/** Stamped by the loopback door, stripped by the guard on everything else. Not a
 * secret — its whole value is that it CANNOT survive a LAN request. */
export const RUNNER_DOOR_HEADER = "x-noticeos-runner-door";
export const RUNNER_DOOR_HEADER_VALUE = "1";

/** What the door forwards a cron fire as. */
export const RUNNER_SCHEDULED_PATH = `${RUNNER_PATH_PREFIX}scheduled`;
/** Prefix for anything proxied verbatim to the ingest's own `fetch` routes. */
export const RUNNER_INGEST_PREFIX = `${RUNNER_PATH_PREFIX}ingest`;

/**
 * The paths that mean "fire a scheduled event" on the ingest: what
 * `scripts/os-up.mjs` fires and miniflare serves, its deprecated spelling, and
 * the `/__scheduled` form `workers/ingest/README.md` documents.
 */
export const SCHEDULED_TRIGGER_PATHS = [
  "/cdn-cgi/handler/scheduled",
  "/cdn-cgi/mf/scheduled",
  "/__scheduled",
] as const;

/**
 * Rewrite one request that arrived on the ingest door into the Tower path that
 * serves it.
 *
 * The door is the ingest's address, not a second front door for the Tower: every
 * path that is not a scheduled trigger is proxied verbatim to the ingest, so
 * `POST /api/pulse` and `GET /healthz` keep working exactly as they read in
 * `workers/ingest/README.md`, and `/` answers with the ingest's own 404 rather
 * than the Tower's UI.
 *
 * The fixed Cloudflare D1 backup path goes to the Tower's authenticated
 * receiver. A path that is already a runner path stays unchanged, so curling
 * the canonical path at the door gets the lane's own diagnosis, not a 404.
 */
export function runnerDoorTarget(rawUrl: string): string {
  const [rawPath = "/", search = ""] = splitQuery(rawUrl);
  const path = rawPath === "" ? "/" : rawPath;
  const query = search === "" ? "" : `?${search}`;
  if (path === CLOUDFLARE_D1_BACKUP_PATH) return `${path}${query}`;
  if ((SCHEDULED_TRIGGER_PATHS as readonly string[]).includes(path)) {
    return `${RUNNER_SCHEDULED_PATH}${query}`;
  }
  if (path.startsWith(RUNNER_PATH_PREFIX)) {
    return `${path}${query}`;
  }
  return `${RUNNER_INGEST_PREFIX}${path}${query}`;
}

function splitQuery(rawUrl: string): [string, string] {
  const idx = rawUrl.indexOf("?");
  if (idx < 0) return [rawUrl, ""];
  return [rawUrl.slice(0, idx), rawUrl.slice(idx + 1)];
}

/** What a `/api/runner/…` path is asking for. `null` = not a runner path. */
export type RunnerTarget =
  | { kind: "scheduled" }
  | { kind: "ingest"; path: string }
  | null;

export function runnerTarget(pathname: string): RunnerTarget {
  if (pathname === RUNNER_SCHEDULED_PATH) return { kind: "scheduled" };
  if (pathname === RUNNER_INGEST_PREFIX) return { kind: "ingest", path: "/" };
  if (pathname.startsWith(`${RUNNER_INGEST_PREFIX}/`)) {
    return { kind: "ingest", path: pathname.slice(RUNNER_INGEST_PREFIX.length) };
  }
  return null;
}

/** Loopback, in every spelling a Node socket reports it: IPv4, IPv6, and the
 * IPv4-mapped form a dual-stack listener hands back. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  // A scoped IPv6 address arrives as `fe80::1%en0`; the zone never makes a
  // non-loopback address loopback, so dropping it only narrows.
  const bare = address.split("%")[0]!.toLowerCase();
  if (bare === "::1" || bare === "127.0.0.1") return true;
  if (bare.startsWith("::ffff:")) return bare.slice("::ffff:".length) === "127.0.0.1";
  // 127.0.0.0/8 is all loopback, not just .1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}
