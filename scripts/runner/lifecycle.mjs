// runner/lifecycle.mjs — whether this runner may start, and whether it is
// stopping. One runner at a time (the ingest door is the lock), a code folder
// that is not linked to home's state starts nothing, and every lane asks
// isShuttingDown() before it starts work.

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSharedStateLinks, linkConflictLines, samePath } from '../os-runtime.mjs';

let shuttingDown = false;

/** Whether this runner has begun its clean shutdown (SIGINT/SIGTERM). Lanes,
 * the scheduler and the child supervisor read it; only the shutdown sets it. */
export function isShuttingDown() {
  return shuttingDown;
}

export function beginShutdown() {
  shuttingDown = true;
}

/**
 * What a runner whose code is not the home checkout must prove before it
 * starts anything: every shared path in its copy links to home.
 * The subsequent runnerDatabase check validates the application's Postgres
 * login, workspace and schema before any heartbeat, child or schedule starts.
 */
export async function runtimeCopyRefusal({ codeRoot, homeRoot, liveSourceRoot = null, ensureLinks = ensureSharedStateLinks, fsp = fs }) {
  if (liveSourceRoot) {
    // Live code uses the installation's generated Worker configs and secret
    // paths. Its archive and runner state must be the same mounted directories,
    // rather than a second state tree hiding in the host checkout.
    try {
      const sameDirectory = async (a,b) => {
        const [first,second] = await Promise.all([fsp.lstat(a),fsp.lstat(b)]);
        return first.isDirectory() && second.isDirectory() && first.ino > 0 &&
          first.dev === second.dev && first.ino === second.ino;
      };
      if (!await sameDirectory(codeRoot,liveSourceRoot)) throw new Error('source');
      for (const relative of ['.local','.wrangler']) {
        if (!await sameDirectory(path.join(codeRoot,relative),path.join(homeRoot,relative))) throw new Error('state');
      }
      return null;
    } catch {return 'REFUSING development startup: checkout or installation state mounts do not match.';}
  }
  if (samePath(codeRoot, homeRoot)) return null;
  const links = await ensureLinks({ codeRoot, homeRoot });
  if (links.conflicts.length > 0) {
    return `REFUSING to start from ${codeRoot}: ${linkConflictLines(links.conflicts, codeRoot).join(' ')}`;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single instance — the guard that keeps a second runner from doubling every
// cron. See runnerArmDecision for why the bound port is the thing we ask.
// ─────────────────────────────────────────────────────────────────────────────

/** A runner that refused because someone else already owns the ingest port.
 * Distinct from 2 (bad flags): "you asked for the impossible" and "somebody got
 * here first" are different answers, and a wrapper should be able to tell. */
export const EXIT_ALREADY_RUNNING = 3;

/** A runner in a code folder that is not linked to home's state — it started
 * nothing. */
export const EXIT_RUNTIME_COPY = 4;

/** A runner whose database address is missing, unusable, or names a database
 * this code cannot start on — it started nothing. */
export const EXIT_NO_DATABASE = 5;

/**
 * Whether this process may arm anything at all, given whether the pinned ingest
 * door already answers.
 *
 * Two runners is not a degraded mode, it is a billing event: each arms its own
 * copy of every cron and fires it at CONFIG.ingestPort, so whichever ingest
 * holds the port receives both sets of ticks and every metered schedule runs
 * twice. The Tower's supervised runtime owns the ingest door and refuses to
 * start when it cannot bind it.
 *
 * The bound port is the guard rather than a pidfile because it cannot go
 * stale: a pidfile outlives whatever wrote it, while a listening socket is
 * held by a live process or by nobody. When a crashed runner's vite outlives
 * it and keeps the port, refusing is right: that orphan is the runtime our
 * crons would have fired at, and the thing worth stopping first.
 */
export function runnerArmDecision({ ingestPortAnswers }, config) {
  const where = `${config.ingestHost}:${config.ingestPort}`;
  if (!ingestPortAnswers) {
    return {
      arm: true,
      level: 'INFO',
      text: `single instance: nothing holds ${where}, so this runner owns the ingest and its crons`,
    };
  }
  return {
    arm: false,
    level: 'ERROR',
    text:
      `REFUSING to start: something already answers on ${where}, which is this repo's ingest door — ` +
      `another runner, or a vite/workerd orphaned by one that crashed. Starting anyway would point TWO ` +
      `schedulers at that one ingest and fire every cron TWICE, which bills a metered lane twice. ` +
      `Nothing was started here: no children, no crons, no migrations. Stop the other runner first; ` +
      `no command here will guess which unknown process tree is safe to kill.`,
  };
}

/**
 * Where the tower's runtime should open the ingest door.
 *
 * Passed as environment rather than hardcoded on the vite side so CONFIG above
 * stays the ONE port map: the scheduler fires at CONFIG.ingestPort, the
 * single-instance guard probes CONFIG.ingestPort, and the listener that has to
 * answer both is told the same number by this. `apps/tower/vite/runner-door.ts`
 * carries a matching fallback for a bare `pnpm dev`, and os-up.test.mjs pins the
 * two equal.
 */
export function ingestDoorEnv(config) {
  return {
    OS_UP_INGEST_DOOR_HOST: config.ingestHost,
    OS_UP_INGEST_DOOR_PORT: String(config.ingestPort),
  };
}
