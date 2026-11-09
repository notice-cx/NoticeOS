export * from '../task-snapshot-summary.mjs';
// runner/task-snapshot.mjs — the task-board snapshot: once a minute, while
// this installation's tasks live in Ntasks, the runner reads every saved
// project's boards from Ntasks's change feed (runner/task-service-poll.mjs)
// and files one snapshot at its ingest door, which is what the Tower's task
// screens render.

import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { laneSkips, log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import { captureWorkflowDiagnostic } from '../workflow-diagnostics.mjs';
import { parseBeadsProjects } from './task-hub.mjs';
import { syncTaskService, taskBackend, taskLaneSkip } from './task-service-poll.mjs';
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
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    readToken = operatorToken,
    post = fetch,
    now = Date.now,
    state = beadsPollState,
    emit = log,
    stopped = () => isShuttingDown(),
    // Where the snapshot is filed: the stack's door, unless the caller names its own.
    url = beadsSnapshotUrl(CONFIG),
    // The runner passes its own (os-up.mjs); without one the lane stands down.
    taskService = null,
    cacheDir = taskCacheDir(HOME_ROOT),
  } = deps;

  const { skip, resume } = laneSkips('beads snapshot', state, emit);

  if (stopped()) return null;
  // The tower's child hosts both Workers, so its readiness is the ingest's.
  if (!runtime.running || !runtime.ready) return skip('ingest is down/restarting');
  // A snapshot from the wrong register would look current; the last one keeps its own time.
  const standDown = taskLaneSkip(await taskBackend(taskService), 'file a task snapshot');
  if (standDown) return skip(standDown);
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

  const token = await readToken().catch(() => null);
  if (!token) return skip('no OPERATOR_TOKEN is configured for the ingest worker');

  let body;
  try {
    ({ body } = await syncTaskService({ service: taskService, spokes: projects, cacheDir, now }));
  } catch (err) {
    // Nothing is filed, so the last snapshot keeps the time it was taken.
    if (err instanceof TaskServiceUnavailable) return skip(`Ntasks did not answer (${err.reason})`);
    throw err;
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
