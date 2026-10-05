// runner/host-tools.mjs — how the local runner finds this host's tools (`bd`,
// `git`, `lsof`) under launchd's bare PATH, and the TCP probe it asks "does
// anything answer here?" with. Running them is scripts/run-command.mjs's job.

import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// launchd hands us a minimal PATH, not the login shell's, so bd is not reliably
// resolvable by name. Look where its installer puts it before falling back to a
// bare name (which works when a human runs os:up).
const BD_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'bd'),
  '/opt/homebrew/bin/bd',
  '/usr/local/bin/bd',
];

// Same problem, same shape, for the push-state lane's git calls. Homebrew's git
// first: /usr/bin/git is the Command Line Tools shim, which on a machine with no
// CLT selected answers by opening a GUI installer prompt rather than by failing.
const GIT_CANDIDATES = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];

const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof', '/opt/homebrew/bin/lsof'];

/** First candidate that exists, else the bare name. An explicit env override
 * always wins so a non-standard install never needs a code change. */
export function resolveBin(override, candidates, exists, fallback) {
  const pinned = override?.trim();
  if (pinned) return pinned;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return fallback;
}

export function bdBin() {
  return resolveBin(process.env.BEADS_BD_BIN, BD_CANDIDATES, existsSync, 'bd');
}

export function gitBin() {
  return resolveBin(process.env.OS_UP_GIT_BIN, GIT_CANDIDATES, existsSync, 'git');
}

export function lsofBin() {
  return resolveBin(process.env.OS_UP_LSOF_BIN, LSOF_CANDIDATES, existsSync, 'lsof');
}

/** Can something accept a TCP connection here? The beads hub speaks the MySQL
 * wire protocol and logs nothing we can read from here, so a connect is the
 * only truthful liveness signal available. */
export function probeTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}
