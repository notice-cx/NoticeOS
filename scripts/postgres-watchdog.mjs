#!/usr/bin/env node
// The watchdog beside a throwaway Postgres server.
//
// A process that starts a throwaway server (openThrowaway, the Postgres
// development profile) stops it on close(), on exit and on SIGINT, SIGTERM or
// SIGHUP. Nothing runs when a process is killed with SIGKILL, and pg_ctl
// starts the server in a session of its own, so without this the server
// would keep running, and keep its System V shared-memory slot (macOS has 32
// in all), until someone stopped it by hand.
//
// So the owner starts this watchdog once, detached (a session of its own, so
// a signal to the owner's process group does not reach it), and writes to its
// stdin one line per server BEFORE it runs `pg_ctl start`: {"data": "<data
// folder>", "socketDir": "<the private socket folder the server is started
// with>"}, then the same line with "started": true once the start returns.
// The owner holds the other end of that pipe until it ends, however it ends.
//
// When the pipe closes, the watchdog sends SIGQUIT — the immediate shutdown
// `pg_ctl stop -m immediate` asks for, on which the server removes its
// segment — to each server whose folder's postmaster.pid names a running
// process listening in the owner's socket folder: only the owner ever starts
// a server with that folder, so a server the owner already stopped, or one
// started again in the same folder by anyone, is left alone. A server whose
// start had not returned when the owner died (pg_ctl start waits until it
// accepts connections, 0.3-2 s) may not have written its postmaster.pid yet,
// so while its socket folder is still there — the owner removes it once it
// has stopped that server — the watchdog waits for it, bounded, and stops it
// as soon as it appears. Then it waits for the servers it signalled to exit,
// and exits itself. The sweep of dead servers' segments at the next
// throwaway start stays the second line.

import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** How long the watchdog waits for the servers it stopped to exit. */
export const STOP_WAIT_MS = 15_000;
/** How long it waits for a server whose start had not returned when its owner died. */
export const START_WAIT_MS = 30_000;

/** Whether process `pid` exists (EPERM: it does, as someone else). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * What `<data>/postmaster.pid` says: the server's pid (line 1) and the socket
 * folder it listens in (line 5, written once its socket exists), or null when
 * there is no such file.
 */
export function readPostmasterPid(data) {
  try {
    const lines = readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\n');
    const pid = Number(lines[0]);
    return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, socketDir: lines[4]?.trim() || null };
  } catch {
    return null;
  }
}

/** The servers the owner reported, one per folder pair, from its lines; a line that is not one is skipped. */
export function parseWatched(text) {
  const watched = new Map();
  for (const line of text.split('\n')) {
    try {
      const { data, socketDir, started } = JSON.parse(line);
      if (typeof data !== 'string' || !path.isAbsolute(data) || typeof socketDir !== 'string' || !path.isAbsolute(socketDir)) continue;
      const key = `${data}\n${socketDir}`;
      watched.set(key, { data, socketDir, started: started === true || watched.get(key)?.started === true });
    } catch {
      // Not a whole line: the owner died mid-write, or wrote nothing.
    }
  }
  return [...watched.values()];
}

/**
 * What to do about one server the owner reported, now that the owner is gone:
 * `{ stop: pid }` when its folder's postmaster.pid names a running process
 * listening in the owner's socket folder; 'wait' while a start that had not
 * returned may still bring one up (its socket folder is still there and no
 * other server holds the folder); null otherwise.
 */
export function whatToDo({ data, socketDir, started }, { postmaster = readPostmasterPid, running = alive, exists = existsSync } = {}) {
  const named = postmaster(data);
  const live = named?.pid && running(named.pid);
  if (live && named.socketDir === socketDir) return { stop: named.pid };
  if (live && named.socketDir) return null;
  return !started && exists(socketDir) ? 'wait' : null;
}

/**
 * Stop what the owner started: SIGQUIT each server as soon as `whatToDo`
 * names it, waiting up to `startWaitMs` for the ones still starting, then up
 * to `stopWaitMs` for the signalled ones to exit, then removes only those
 * stopped servers' private socket folders. Returns the servers still
 * running after that (`running`) and the starts that never showed a server
 * (`neverStarted`).
 */
export async function stopOwnedServers(
  watched,
  {
    decide = (server) => whatToDo(server),
    signal = (pid) => process.kill(pid, 'SIGQUIT'),
    running = alive,
    removeSocket = (socketDir) => rmSync(socketDir, { recursive: true, force: true }),
    startWaitMs = START_WAIT_MS,
    stopWaitMs = STOP_WAIT_MS,
    pollMs = 50,
  } = {},
) {
  const signalled = [];
  let starting = watched;
  const startDeadline = Date.now() + startWaitMs;
  for (;;) {
    const still = [];
    for (const server of starting) {
      const next = decide(server);
      if (next === 'wait') {
        still.push(server);
      } else if (next?.stop) {
        try {
          signal(next.stop);
        } catch {
          // Gone in the meantime.
        }
        signalled.push({ ...server, pid: next.stop });
      }
    }
    starting = still;
    if (starting.length === 0 || Date.now() >= startDeadline) break;
    await delay(pollMs);
  }
  const stopDeadline = Date.now() + stopWaitMs;
  while (signalled.some(({ pid }) => running(pid)) && Date.now() < stopDeadline) await delay(pollMs);
  const stillRunning = [];
  for (const server of signalled) {
    if (running(server.pid)) stillRunning.push(server);
    else removeSocket(server.socketDir);
  }
  return { running: stillRunning, neverStarted: starting };
}

function invokedDirectly() {
  try {
    return realpathSync(path.resolve(process.argv[1] ?? '')) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    text += chunk;
  });
  // The pipe closes when the owner ends, however it ends.
  process.stdin.once('end', () => {
    stopOwnedServers(parseWatched(text)).then(() => process.exit(0));
  });
}
