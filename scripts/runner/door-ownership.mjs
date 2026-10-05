// runner/door-ownership.mjs — may this tick fire at the ingest door? It may
// only when a listener on the door is this runner's own child (or inside its
// process tree). The pure decisions are exported for tests; the lookups go
// through scripts/run-command.mjs.

import { runCommand } from '../run-command.mjs';
import { CONFIG, REPO_ROOT } from './config.mjs';
import { lsofBin } from './host-tools.mjs';
import { log } from './log.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// DOOR OWNERSHIP — is the ingest we are about to fire at the one OUR child bound?
//
// runnerArmDecision closes every doubling window but one: two runners started
// inside the same second both probe a FREE port, both proceed, and only one of
// them can win the bind. The loser is supposed to die — the door plugin calls
// process.exit(1) on EADDRINUSE (apps/tower/vite/runner-door.ts) and vite's
// --strictPort refuses a taken 5173 — but `child.ready` is a LIVENESS fact, not
// an ownership one. It flips when vite prints its banner, which happens BEFORE
// the door binds, and it flips again on the 15s grace timer that exists so a
// banner-format change cannot mute the crons forever. So a runner that owns
// nothing can consider its ingest ready and fire every cron at somebody else's
// runtime — every schedule twice, on a metered lane. That is the "ticks are
// provably inert" half of ro-u33's acceptance, left open as ro-1b0.1.
//
// So a tick proves it: ask who is LISTENING on the door port and fire only when
// one of them is in our child's process group. We spawn the child detached, so
// its pid IS its process-group id and vite/workerd inherit that group — the same
// fact killChild relies on when it signals -pid.
//
// This gate is on the cron fires and nowhere else, deliberately. The fires are
// what cost money (a duplicate DataForSEO Monday, 2026-07-31); the other lanes
// that talk to the door are idempotent by construction — the beads poll
// photographs the hub, and the two filers dedupe against the spoke before they
// write — so a loser reaching the winner's door there wastes a request and
// changes nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** Ask for the pid AND the process-group id of every listener on `port`, in
 * lsof's machine-readable field format. `-F pg` is what removes a second
 * subprocess: lsof already knows the group, so nothing has to `ps` for it. */
export function listenerOwnersArgs(port) {
  return ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pg'];
}

/**
 * Owners from `lsof -F pg` output: one `p<pid>` line opens a process block and
 * a `g<pgid>` line inside it names its group (other field lines are ignored, so
 * this survives lsof adding fields we did not ask for).
 *
 * A block missing either half is dropped rather than half-read: an owner we
 * cannot place in a process group cannot answer the only question being asked.
 */
export function parseListenerOwners(stdout) {
  const owners = [];
  const seen = new Set();
  let pid = null;
  let pgid = null;
  const flush = () => {
    if (pid !== null && pgid !== null && !seen.has(pid)) {
      seen.add(pid);
      owners.push({ pid, pgid });
    }
  };
  for (const line of String(stdout ?? '').split('\n')) {
    const p = /^p(\d+)$/.exec(line);
    if (p) {
      flush();
      pid = Number(p[1]);
      pgid = null;
      continue;
    }
    const g = /^g(\d+)$/.exec(line);
    if (g && pid !== null) pgid = Number(g[1]);
  }
  flush();
  return owners;
}

/** Who holds the door, or null when we could not look. lsof exits 1 when
 * nothing matched — that is the answer "nobody", not a failure to ask. */
export async function listListenerOwners(port) {
  const { code, stdout } = await runCommand(lsofBin(), listenerOwnersArgs(port), {
    cwd: REPO_ROOT,
    timeoutMs: 5_000,
  });
  return code === 0 || code === 1 ? parseListenerOwners(stdout) : null;
}

/** `pid ppid` pairs from `ps -Ao pid=,ppid=`, as a child → parent map. */
export function parseProcessParents(stdout) {
  const parents = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/** Is `pid` inside `ancestor`'s process tree? Walks up, bounded, and never
 * past pid 1 — a cycle in a parent map would otherwise hang the runner. */
export function isDescendantOf(pid, ancestor, parents) {
  let current = pid;
  for (let hops = 0; hops < 64; hops += 1) {
    if (current === ancestor) return true;
    const next = parents.get(current);
    if (next === undefined || next === current || next <= 1) return false;
    current = next;
  }
  return false;
}

/**
 * Does the door belong to this runner's child?
 *
 * TWO ways to be ours, because one of them is an assumption. The child is
 * spawned detached, so its pid is its process-group id and everything it starts
 * inherits that group — that is the cheap check, and it is the same fact
 * killChild relies on. But a package manager that ever put its child in a
 * session of its own would turn that assumption into "the door is not ours",
 * which would stand every cron down forever: a silent, total outage caused by
 * the guard rather than by the race. So a proven-foreign group is re-checked
 * against the process TREE (`parents`, supplied only for that second look)
 * before anything stands down.
 *
 * `owns` is deliberately three-valued. `false` is a proven negative — somebody
 * else's process tree holds the port, or nothing does — and it stands a tick
 * down. `null` means we could not find out (no lsof, a timeout), and a runner
 * that cannot check must keep firing: silently stopping every cron because a
 * diagnostic tool moved would be a worse failure than the one this guards.
 */
export function doorOwnershipDecision({ owners, group, parents = null }, config) {
  const where = `${config.ingestHost}:${config.ingestPort}`;
  if (group === null || group === undefined) {
    return { owns: false, reason: `this runner has no ingest child holding ${where}` };
  }
  if (owners === null) {
    return {
      owns: null,
      reason: `could not ask who holds ${where} (lsof did not answer)`,
    };
  }
  if (owners.length === 0) {
    return { owns: false, reason: `nothing is listening on ${where}` };
  }
  const byGroup = owners.filter((o) => o.pgid === group || o.pid === group);
  if (byGroup.length > 0) {
    return {
      owns: true,
      reason: `${where} is held by pid ${byGroup.map((o) => o.pid).join(', ')} in this runner's process group ${group}`,
    };
  }
  const byTree = parents ? owners.filter((o) => isDescendantOf(o.pid, group, parents)) : [];
  if (byTree.length > 0) {
    return {
      owns: true,
      reason:
        `${where} is held by pid ${byTree.map((o) => o.pid).join(', ')}, a descendant of this ` +
        `runner's ingest child ${group} (which is not leading its process group — harmless, ` +
        `but worth knowing if a group-kill ever misses on shutdown)`,
    };
  }
  return {
    owns: false,
    reason:
      `${where} is held by pid ${owners.map((o) => o.pid).join(', ')} ` +
      `(process group ${[...new Set(owners.map((o) => o.pgid))].join(', ')}), which is neither this ` +
      `runner's ingest child (${group}) nor anything it started`,
  };
}

// The check costs a subprocess, so a PROVEN owner is remembered for the life of
// that child: a process that holds a listening socket holds it until it dies,
// and dying changes the pid this is keyed on. A negative is never cached —
// vite's banner beats its door bind by a moment, so "not ours yet" turns into
// "ours" without anything else changing.
const doorOwnershipMemo = { pid: null, decision: null };

/** Every process's parent, or an empty map when `ps` could not be asked — the
 * fallback look, run only when the cheap group check came back foreign. */
async function listProcessParents() {
  const { code, stdout } = await runCommand('/bin/ps', ['-Ao', 'pid=,ppid='], {
    cwd: REPO_ROOT,
    timeoutMs: 5_000,
  });
  return code === 0 ? parseProcessParents(stdout) : new Map();
}

/** The process group to compare against: the child's pid, because we spawn it
 * detached (setsid), so it leads the group its vite and workerd run in. */
export async function runtimeDoorOwnership(child) {
  const group = child.proc?.pid ?? null;
  if (doorOwnershipMemo.pid === group && doorOwnershipMemo.decision !== null && doorOwnershipMemo.decision.owns !== false) {
    return doorOwnershipMemo.decision;
  }
  const owners = group === null ? [] : await listListenerOwners(CONFIG.ingestPort);
  let decision = doorOwnershipDecision({ owners, group }, CONFIG);
  // Only the expensive look, and only when the answer would otherwise be a
  // stand-down: somebody holds the door and it is not in our group.
  if (decision.owns === false && Array.isArray(owners) && owners.length > 0) {
    decision = doorOwnershipDecision({ owners, group, parents: await listProcessParents() }, CONFIG);
  }
  doorOwnershipMemo.pid = group;
  doorOwnershipMemo.decision = decision;
  // One line per child, the first time its ownership is settled: an operator
  // reading the log after a restart should not have to infer that the crons are
  // pointed at the runtime this runner actually started.
  if (decision.owns === true) log('INFO', `ingest door ownership proven — ${decision.reason}`);
  return decision;
}

/**
 * Whether this tick fires, as a decision with its own log line.
 *
 * `outcome` is what the job-run record keeps (ro-ic5): every tick leaves
 * evidence of what it did, so a lane that stopped firing is legible from the
 * record instead of inferred from silence.
 */
export function cronFireDecision({ running, ready, ownership }, expr) {
  if (!running || !ready) {
    return {
      fire: false,
      outcome: 'skipped',
      detail: 'ingest down/restarting',
      level: 'WARN',
      text: `cron "${expr}" due but ingest is down/restarting — skipping (no replay)`,
    };
  }
  const owns = ownership?.owns ?? null;
  const reason = ownership?.reason ?? 'ownership of the ingest door was never checked';
  if (owns === false) {
    return {
      fire: false,
      outcome: 'skipped',
      detail: `door not owned: ${reason}`,
      level: 'ERROR',
      text:
        `cron "${expr}" due but STANDING DOWN: ${reason}. This runner lost the bind race, so firing ` +
        `would run the schedule on a runtime it does not own — the double-fire the port guard exists ` +
        `to prevent (ro-u33), on a metered lane. Nothing was fired: whoever owns that door has its ` +
        `own scheduler and this tick is already covered. Stop the extra runner ` +
        `(lsof -nP -iTCP:${CONFIG.ingestPort} -sTCP:LISTEN).`,
    };
  }
  if (owns === null) {
    return {
      fire: true,
      outcome: 'ran',
      detail: 'ownership unproven',
      level: 'WARN',
      text:
        `cron "${expr}": ${reason} — firing anyway, because a runner that cannot check must not ` +
        `silently stop firing, but a second runner would be invisible from here.`,
    };
  }
  return { fire: true, outcome: 'ran', detail: null, level: null, text: null };
}
