import { beadsClosedSince, beadsClosesSince, beadsPollArgs, beadsProjectError, summarizeBeadsProject } from '../task-snapshot-summary.mjs';
export * from '../task-snapshot-summary.mjs';
// runner/task-snapshot.mjs — the task-board snapshot: once a minute the runner
// reads every saved project through `bd` (read-only) and files one snapshot at
// its ingest door, which is what the Tower's task screens render. It also
// joins each project's Tower handoff beads and its panel-review state.

import { readTaskProjectConfig, taskProjectDirectory } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { laneSkips, log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import { captureWorkflowDiagnostic } from '../workflow-diagnostics.mjs';
import { checkBeadsHub, parseBeadsProjects, runBd } from './task-hub.mjs';
import { syncTaskService, taskBackend } from './task-service-poll.mjs';
import { createTaskService, TaskServiceUnavailable } from '../task-service.mjs';
import { taskCacheDir } from '../task-service-cache.mjs';

let sharedTaskService = null;
/** The installation's task service, one per runner, so its answers' short reuse holds across ticks. */
export function runnerTaskService() {
  sharedTaskService ??= createTaskService();
  return sharedTaskService;
}

async function responseDiagnostic(response, token) {
  const reader = response.body?.getReader();
  if (!reader) return captureWorkflowDiagnostic('', { secrets: [token] });
  const decoder = new TextDecoder();
  const limit = 65_536 + new TextEncoder().encode(token).byteLength;
  let text = '', size = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      const available = Math.max(0, limit - size);
      text += decoder.decode(value.subarray(0, available), { stream: true });
      size += value.byteLength;
      if (size > limit) { truncated = true; break; }
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const safe = captureWorkflowDiagnostic(text, { secrets: [token] });
  return { ...safe, truncated: safe.truncated || truncated };
}

/**
 * One snapshot of the whole portfolio.
 *
 * `run(args)` is injected so the tests exercise the assembly without spawning
 * anything. Projects are polled in `config/beads.json` order and that order is
 * preserved into the payload — it is the order the board renders, and the file
 * is where the operator changes it.
 */
export async function collectBeadsSnapshot({ projects, run, nowMs = Date.now(), repoRoot = HOME_ROOT }) {
  const reach = { closedSince: beadsClosedSince(nowMs), closesSince: beadsClosesSince(nowMs) };
  const entries = [];
  for (const project of projects) {
    if (project.unavailableReason) {
      entries.push(beadsProjectError(project, project.unavailableReason));
      continue;
    }
    const repoDir = taskProjectDirectory(project, repoRoot);
    const args = beadsPollArgs(repoDir, reach.closesSince);
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
    entries.push(failed ?? summarizeBeadsProject(project, results, reach));
  }
  return { capturedAt: new Date(nowMs).toISOString(), projects: entries };
}

export function beadsSnapshotUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/beads-snapshot`;
}

const beadsPollState = { skipping: null };

/**
 * Take one snapshot and file it. Every dependency that touches the world is
 * injectable. Every failure is a log line: none takes the runner down, and
 * none stops the next tick.
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
    // the stack's door and home checkout, unless the caller names its own.
    url = beadsSnapshotUrl(CONFIG),
    repoRoot = HOME_ROOT,
    // While tasks live in Ntasks the snapshot comes from its change feed
    // (runner/task-service-poll.mjs) and `bd` is never run. Only the runner
    // itself passes one (os-up.mjs), so no test reaches a real ingest.
    taskService = null,
    cacheDir = taskCacheDir(repoRoot),
  } = deps;

  const { skip, resume } = laneSkips('beads snapshot', state, emit);

  if (stopped()) return null;
  // The tower's child hosts both Workers, so its readiness is the ingest's.
  if (!runtime.running || !runtime.ready) return skip('ingest is down/restarting');
  let projects;
  try {
    const raw = await readConfig();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.spokes)) throw new Error('invalid task project map');
    projects = parseBeadsProjects(raw);
    if (projects.length !== parsed.spokes.length) throw new Error('invalid task project entries');
  } catch (err) {
    return skip(`the task map is unreadable (${err.message})`);
  }
  const backend = await taskBackend(taskService);
  // A snapshot from the wrong register would look current; the last one keeps its own time.
  if (backend === 'unknown') return skip('the ingest has not said whether tasks live in Ntasks');
  const remote = backend === 'ntasks';
  // An acknowledged empty map must clear the last snapshot even when the hub
  // is down. Store failures above never turn into a fabricated empty roster.
  if (!remote && projects.length > 0 && !(await probe())) return skip('the beads task hub is unreachable');

  const token = await readToken().catch(() => null);
  if (!token) return skip('no OPERATOR_TOKEN is configured for the ingest worker');

  let body;
  if (remote) {
    try {
      ({ body } = await syncTaskService({ service: taskService, spokes: projects, cacheDir, now }));
    } catch (err) {
      // Nothing is filed, so the last snapshot keeps the time it was taken.
      if (err instanceof TaskServiceUnavailable) return skip(`Ntasks did not answer (${err.reason})`);
      throw err;
    }
  } else {
    body = await collectBeadsSnapshot({ projects, run, nowMs: now(), repoRoot });
  }
  resume();
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
      const responseBody = await responseDiagnostic(res, token);
      emit(
        'ERROR',
        `beads snapshot → HTTP ${res.status} (non-201) ${responseBody.text.slice(0, 200)}`,
      );
      return { ...body, ok: false, response: { status: res.status, body: responseBody.text, truncated: responseBody.truncated, redacted: responseBody.redacted } };
    }
    emit(
      'INFO',
      `beads snapshot filed — ${body.projects.length} project(s)` +
        (failed.length > 0
          ? `, ${failed.length} unreadable: ${failed.map((e) => `${e.asset} (${e.error})`).join('; ')}`
          : ''),
    );
  } catch (err) {
    const error = captureWorkflowDiagnostic(err, { secrets: [token] });
    emit('ERROR', `beads snapshot POST failed: ${captureWorkflowDiagnostic(err.message ?? String(err), { secrets: [token] }).text}`);
    return { ...body, ok: false, error };
  }
  return body;
}
