// runner/watch-readbacks.mjs — carries each closed bet's verdict to the bead
// that owns its reading: the store keeps the queue, this lane posts
// a `bd comment` in the owning project, then tells the store what landed.

import { readTaskProjectConfig, taskProjectDirectory } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT, SECRET_FILES } from './config.mjs';
import { log } from './log.mjs';
import { operatorToken } from './operator-token.mjs';
import { beadsFailure, parseBeadsProjects, runBd } from './task-hub.mjs';
import { beadsInstant } from '../task-snapshot-values.mjs';
import { readTaskResolution } from '../../packages/contract/src/task-resolution.mjs';
import { recordsClose, TASK_METADATA } from '../../packages/contract/src/task-metadata.mjs';
import { createHash } from 'node:crypto';
import { openStandaloneTasks, ACTOR_HEADER } from '../standalone-mcp.mjs';
import { standaloneProjectId } from '../standalone-tasks.mjs';
import { DATABASE_URL, readDevSecretBindings } from '../dev-secrets.mjs';

/** Uses the task hub's durable create receipt, shared with the panel filer. */
export async function fileOutcomeReview(project, entry, { open = openStandaloneTasks,
  readBindings = () => readDevSecretBindings(SECRET_FILES) } = {}) {
  const { bindings } = await readBindings();
  const tasks = await open({ databaseUrl: bindings[DATABASE_URL] });
  try {
    const projectId = standaloneProjectId(project.database);
    const key = 'outcome-review:' + createHash('sha256').update(JSON.stringify(
      [projectId, entry.asset, entry.windowId, entry.bead])).digest('hex');
    const proof = new Request('http://localhost/api/mcp', { method: 'POST',
      headers: { [ACTOR_HEADER]: 'outcome-review-filer' } });
    const outcome = await tasks.operations.write(proof, tasks.workspaceId, { projectId, operation: {
      kind: 'create', title: `Review the ${entry.asset} outcome (${entry.bead})`, type: 'task', priority: 2,
      labels: ['outcome-review'], links: [{ type: 'related', taskId: entry.bead }],
      metadata: { [TASK_METADATA.source.name]: 'outcome-review', [TASK_METADATA.asset.name]: entry.asset,
        [TASK_METADATA.rule.name]: 'watch-window-closed', [TASK_METADATA.key.name]: entry.windowId },
      description: `WHAT: Review the recorded outcome for ${entry.asset}.\n` +
        `WHY: The original task ${entry.bead} was closed before this result was delivered; the measurement still needs review.\n` +
        `WHERE: Outcome window ${entry.windowId}; related task ${entry.bead}.\n` +
        'FIX: Review the result comment posted by Outcome task updates, record the decision and evidence, and file any required follow-up work.',
      acceptance: 'Record the review decision and evidence, then close this review task. Preserve the measured outcome and original implementation evidence.',
    } }, key);
    if (outcome.status !== 'done' || typeof outcome.value?.id !== 'string') {
      throw new Error(`Outcome review filing ${outcome.status}; retry unchanged.`);
    }
    return outcome.value.id;
  } finally { await tasks.close(); }
}

async function readLinkedTask(run, directory, id) {
  const result = await run(['-C', directory, 'show', id, '--json']);
  if (result.code !== 0) throw new Error(beadsFailure('show', result));
  const parsed = JSON.parse(result.stdout);
  const task = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (task?.id !== id || typeof task.status !== 'string') throw new Error('Linked task is unavailable');
  return task;
}

async function attachReview(fetchImpl, url, auth, entry, bead, previousPostedAt) {
  const response = await fetchImpl(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ linked: [{ windowId: entry.windowId, asset: entry.asset, previousBead: entry.bead, bead, previousPostedAt }] }) });
  if (!response.ok || !(await response.json()).linked?.includes(entry.windowId)) throw new Error('Outcome review link changed; retry unchanged');
}

/** The readback queue's door (workers/ingest/src/routes/watch-readbacks.ts). */
export function watchReadbacksUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/watch-readbacks`;
}

/**
 * Carry each closed bet's verdict to the bead that owns its reading.
 *
 * This lane exists because neither end can do it alone. The evaluator lives in
 * a Worker and cannot run `bd`; the beads hub knows nothing about watch
 * windows. So the store keeps the queue, this process does the posting, and the
 * store is told what actually landed — in that order, so a crash mid-post
 * leaves a verdict pending rather than silently delivered.
 *
 * Silent when nothing is owed. A lane that logged "0 verdicts" every hour would
 * be teaching the operator to skim the one line that matters.
 */
export async function runWatchReadbackFiler(deps = {}) {
  const {
    config = CONFIG,
    readToken = operatorToken,
    fetchImpl = fetch,
    run = runBd,
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    emit = log,
    repoRoot = HOME_ROOT,
    now = Date.now,
    createReview = fileOutcomeReview,
  } = deps;

  const token = await readToken();
  if (!token) {
    emit('WARN', 'watch readbacks skipped — no operator token');
    return { posted: [], failed: [] };
  }

  const url = watchReadbacksUrl(config);
  const auth = { authorization: `Bearer ${token}` };
  let pending;
  let reviews;
  let nextReviewAfter;
  try {
    const res = await fetchImpl(url, { headers: auth });
    if (!res.ok) {
      emit('WARN', `watch readbacks: the door answered HTTP ${res.status}`);
      return { posted: [], failed: [] };
    }
    ({ pending, reviews = [], nextReviewAfter = null } = await res.json());
  } catch (err) {
    emit('WARN', `watch readbacks: ${err.message}`);
    return { posted: [], failed: [] };
  }
  if (!Array.isArray(pending) || !Array.isArray(reviews)) return { posted: [], failed: [] };
  if (pending.length === 0 && reviews.length === 0) return { posted: [], failed: [] };

  let projects = [];
  try {
    projects = parseBeadsProjects(await readConfig());
  } catch (err) {
    const failure = `task configuration unavailable: ${err.message}`;
    emit('WARN', `watch readbacks skipped — ${failure}`);
    return { posted: [], failed: [...pending, ...reviews].map((entry) => `${entry.bead}: ${failure}`) };
  }
  const spokes = new Map(projects.map((project) => [project.asset, project]));

  const posted = [];
  const expectedTasks = {};
  const failed = [];
  for (const entry of pending) {
    const spoke = spokes.get(entry.asset);
    if (!spoke) {
      failed.push(`${entry.bead}: no beads spoke is configured for ${entry.asset}`);
      continue;
    }
    if (spoke.unavailableReason) {
      failed.push(`${entry.bead}: ${spoke.unavailableReason}`);
      continue;
    }
    // `-C <repo>`: bead ids are project-scoped, and the hub answers for the
    // project whose repo it is asked from. Resolved from the home checkout:
    // the inventory's paths are relative to it, not to the code folder.
    let result;
    try {
      const directory = taskProjectDirectory(spoke, repoRoot);
      const task = await readLinkedTask(run, directory, entry.bead);
      let bead = entry.bead;
      if (task.status === 'closed' && entry.reviewRequired !== false) {
        bead = await createReview(spoke, entry);
        await attachReview(fetchImpl, url, auth, entry, bead, null);
      }
      result = await run(['-C', directory, 'comment', bead, entry.comment]);
      if (result.code === 0) expectedTasks[entry.windowId] = bead;
    } catch (err) {
      failed.push(`${entry.bead}: result delivery failed: ${err.message}`);
      continue;
    }
    if (result.code !== 0) {
      failed.push(beadsFailure('comment', result));
      continue;
    }
    posted.push(entry.windowId);
  }

  if (posted.length > 0) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ posted, expectedTasks }),
      });
      if (!res.ok) {
        // The comments ARE on the beads; only the stamp failed. Saying so is
        // what stops the next tick's duplicate from looking like a mystery.
        emit(
          'WARN',
          `watch readbacks: ${posted.length} verdict(s) filed but NOT stamped (HTTP ${res.status}) — ` +
            'the next tick will file them again',
        );
      }
    } catch (err) {
      emit('WARN', `watch readbacks: filed but not stamped — ${err.message}`);
    }
  }

  const filed = pending
    .filter((entry) => posted.includes(entry.windowId))
    .map((entry) => `${expectedTasks[entry.windowId] ?? entry.bead} ${entry.outcome}`)
    .join(' · ');
  if (posted.length > 0) {
    emit('INFO', `watch readbacks — ${posted.length} verdict(s) filed: ${filed}`);
  }
  for (const failure of failed) emit('WARN', `watch readbacks: ${failure}`);
  // Read the owning task directly, rather than inferring completion from a
  // bounded recent-closures snapshot or from a task missing from open work.
  let after = 0;
  let completed = 0;
  while (reviews.length > 0) {
    for (const review of reviews) {
      const spoke = spokes.get(review.asset);
      if (!spoke || spoke.unavailableReason) {
        const failure = `${review.bead}: ${spoke?.unavailableReason ?? 'task project unavailable'}`;
        failed.push(failure);
        emit('WARN', `watch readbacks: ${failure}`);
        continue;
      }
      try {
        const task = await readLinkedTask(run, taskProjectDirectory(spoke, repoRoot), review.bead);
        const closedAt = beadsInstant(task?.closed_at);
        const checkedAt = new Date(now()).toISOString();
        if (task.status === 'closed' && closedAt && closedAt <= review.postedAt) {
          const bead = await createReview(spoke, review);
          await attachReview(fetchImpl, url, auth, review, bead, review.postedAt);
          // Delivery stays pending until the new task's comment is confirmed.
          continue;
        }
        if (task?.id !== review.bead || task.status !== 'closed' || !closedAt
          || closedAt <= review.postedAt || closedAt > checkedAt
          || typeof task.close_reason !== 'string' || task.close_reason.trim() === ''
          || !recordsClose(task.metadata, task.closed_at)
          || readTaskResolution(task.metadata, task.closed_at).resolution !== 'done') continue;
        const res = await fetchImpl(url, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ reviewed: [{ ...review, closedAt, checkedAt, reason: task.close_reason.slice(0, 2048) }] }),
        });
        if (!res.ok) throw new Error(`review acknowledgement HTTP ${res.status}`);
        const acknowledgement = await res.json();
        if (Array.isArray(acknowledgement.reviewed) && acknowledgement.reviewed.includes(review.flagNumber)) completed++;
      } catch (err) {
        const failure = `${review.bead}: ${err.message}`;
        failed.push(failure);
        emit('WARN', `watch readbacks: ${failure}`);
      }
    }
    const next = nextReviewAfter;
    if (!Number.isSafeInteger(next) || next <= after) break;
    after = next;
    try {
      const res = await fetchImpl(`${url}?reviewsAfter=${after}`, { headers: auth });
      if (!res.ok) throw new Error(`review queue HTTP ${res.status}`);
      ({ reviews, nextReviewAfter = null } = await res.json());
      if (!Array.isArray(reviews)) throw new Error('invalid review queue');
    } catch (err) {
      failed.push(err.message);
      emit('WARN', `watch readbacks: ${err.message}`);
      break;
    }
  }
  if (completed > 0) emit('INFO', `outcome reviews — ${completed} alert(s) marked read from completed tasks`);
  return { posted, failed };
}
