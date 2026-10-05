import { beadsClosedSince, beadsPollArgs, beadsProjectError, summarizeBeadsProject } from '../task-snapshot-summary.mjs';
export * from '../task-snapshot-summary.mjs';
// runner/task-snapshot.mjs — the task-board snapshot: once a minute the runner
// reads every saved project through `bd` (read-only) and files one snapshot at
// its ingest door, which is what the Tower's task screens render. It also
// joins each project's Tower handoff beads and its panel-review state.

import path from 'node:path';
import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import {
  beadsSkipDecision,
  checkBeadsHub,
  parseBeadsProjects,
  runBd,
} from './task-hub.mjs';

/**
 * One snapshot of the whole portfolio.
 *
 * `run(args)` is injected so the tests exercise the assembly without spawning
 * anything. Projects are polled in `config/beads.json` order and that order is
 * preserved into the payload — it is the order the board renders, and the file
 * is where the operator changes it.
 */
export async function collectBeadsSnapshot({ projects, run, nowMs = Date.now(), repoRoot = HOME_ROOT }) {
  const closedSince = beadsClosedSince(nowMs);
  const entries = [];
  for (const project of projects) {
    if (project.unavailableReason) {
      entries.push(beadsProjectError(project, project.unavailableReason));
      continue;
    }
    const repoDir = path.resolve(repoRoot, project.repo);
    const args = beadsPollArgs(repoDir, closedSince);
    const results = {};
    let failed = null;
    for (const [key, argv] of Object.entries(args)) {
      try {
        results[key] = await run(argv);
      } catch (err) {
        // A spawn that never produced a process (bd missing, EACCES) is the same
        // class of problem as a bd that exited non-zero: this project, only.
        failed = beadsProjectError(project, `bd ${key} could not run: ${err.message}`);
        break;
      }
    }
    entries.push(failed ?? summarizeBeadsProject(project, results));
  }
  return { capturedAt: new Date(nowMs).toISOString(), projects: entries };
}

export function beadsSnapshotUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/beads-snapshot`;
}

// One WARN per outage, not one per tick: the hub being down for an afternoon
// would otherwise write 240 identical lines. `skipping` is the reason currently
// being suppressed; null = nothing is being skipped.
const beadsPollState = { skipping: null };

/**
 * Take one snapshot and file it.
 *
 * Every dependency that touches the world is injectable. That is not test
 * scaffolding for its own sake: the whole point of this function is what it
 * does when something is missing — a down hub, a dead ingest, an unreadable
 * repo — and none of those are reachable from a test that has to spawn `bd`
 * and open a socket to find out.
 *
 * Every failure is a log line. None of them take the runner down, and none of
 * them stop the next tick.
 */
export async function runBeadsPoll(runtime, deps = {}) {
  const {
    // `checkBeadsHub`, not a second `probeTcp` call: one owner of "is the hub
    // up?", one place that logs its state changes, and — because the poller
    // runs every minute rather than every fifteen — a contention or crash-loop
    // is named within a minute of starting instead of a quarter hour.
    probe = () => checkBeadsHub(),
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    readToken = operatorToken,
    run = runBd,
    post = fetch,
    now = Date.now,
    state = beadsPollState,
    emit = log,
    stopped = () => isShuttingDown(),
    // Where the snapshot is filed and where project checkouts resolve from:
    // the managed service's door and home checkout, unless an installation
    // `pnpm start` runs names its own (scripts/start-host-lanes.mjs).
    url = beadsSnapshotUrl(CONFIG),
    repoRoot = HOME_ROOT,
  } = deps;

  const skip = (reason) => {
    if (beadsSkipDecision(state, reason)) {
      emit('WARN', `beads snapshot skipped — ${reason} (silent until it changes)`);
    }
  };

  if (stopped()) return null;
  // The tower's child hosts BOTH Workers now, so its readiness is the ingest's:
  // there is no separate ingest process left to ask.
  if (!runtime.running || !runtime.ready) {
    skip('ingest is down/restarting');
    return null;
  }
  let projects;
  try {
    const raw = await readConfig();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.spokes)) throw new Error('invalid task project map');
    projects = parseBeadsProjects(raw);
    if (projects.length !== parsed.spokes.length) throw new Error('invalid task project entries');
  } catch (err) {
    skip(`the task map is unreadable (${err.message})`);
    return null;
  }
  // An acknowledged empty map must clear the last snapshot even when the hub
  // is down. Store failures above never turn into a fabricated empty roster.
  if (projects.length > 0 && !(await probe())) {
    skip('the beads task hub is unreachable');
    return null;
  }

  const token = await readToken().catch(() => null);
  if (!token) {
    skip('no OPERATOR_TOKEN is configured for the ingest worker');
    return null;
  }

  if (state.skipping !== null) {
    emit('INFO', `beads snapshot resumed (was skipped: ${state.skipping})`);
    state.skipping = null;
  }

  const body = await collectBeadsSnapshot({ projects, run, nowMs: now(), repoRoot });
  const failed = body.projects.filter((entry) => !entry.ok);

  try {
    const res = await post(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      emit(
        'ERROR',
        `beads snapshot → HTTP ${res.status} (non-201) ${(await res.text()).slice(0, 200)}`,
      );
      return { ...body, ok: false };
    }
    emit(
      'INFO',
      `beads snapshot filed — ${body.projects.length} project(s)` +
        (failed.length > 0
          ? `, ${failed.length} unreadable: ${failed.map((e) => `${e.asset} (${e.error})`).join('; ')}`
          : ''),
    );
  } catch (err) {
    emit('ERROR', `beads snapshot POST failed: ${err.message}`);
    return { ...body, ok: false };
  }
  return body;
}
