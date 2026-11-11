// runner/watch-readbacks.mjs — carries each closed bet's verdict to the task
// that owns its reading: the store keeps the queue, this lane comments in
// Ntasks on the owning task, then tells the store what landed.

import { readTaskProjectConfig } from '../task-project-config.mjs';
import { CONFIG, HOME_ROOT } from './config.mjs';
import { log } from './log.mjs';
import { taskBackend, taskLaneSkip } from './task-service-poll.mjs';
import { ntasksRegister } from './task-service-register.mjs';
import { operatorToken } from './operator-token.mjs';
import { parseTaskProjects } from './task-hub.mjs';
import { taskInstant } from '../task-snapshot-values.mjs';
import { readTaskResolution } from '../../packages/contract/src/task-resolution.mjs';
import { recordsClose, TASK_METADATA } from '../../packages/contract/src/task-metadata.mjs';
import { createHash } from 'node:crypto';

/** Who Ntasks records for this lane's verdict comments and for the reviews it files. */
export const OUTCOME_UPDATES_ACTOR = 'outcome-task-updates';
export const OUTCOME_REVIEW_ACTOR = 'outcome-review-filer';

/** An outcome review filed in Ntasks, under a key for the project's prefix,
 * then linked to the task whose reading it reviews. */
export async function fileNtasksOutcomeReview(register, project, entry) {
  const key = 'outcome-review:' + createHash('sha256').update(JSON.stringify(
    ['ntasks', project.prefix, entry.asset, entry.windowId, entry.taskId])).digest('hex');
  const id = await register.create(project, {
    title: `Review the ${entry.asset} outcome (${entry.taskId})`, type: 'task', priority: 2, labels: ['outcome-review'],
    metadata: { [TASK_METADATA.source.name]: 'outcome-review', [TASK_METADATA.asset.name]: entry.asset,
      [TASK_METADATA.rule.name]: 'watch-window-closed', [TASK_METADATA.key.name]: entry.windowId },
    description: `WHAT: Review the recorded outcome for ${entry.asset}.\n` +
      `WHY: The original task ${entry.taskId} was closed before this result was delivered; the measurement still needs review.\n` +
      `WHERE: Outcome window ${entry.windowId}; related task ${entry.taskId}.\n` +
      'FIX: Review the result comment posted by Outcome task updates, record the decision and evidence, and file any required follow-up work.',
    acceptance: 'Record the review decision and evidence, then close this review task. Preserve the measured outcome and original implementation evidence.',
  }, key);
  await register.relate(project, id, entry.taskId);
  return id;
}

/** A verdict comment's key: one comment per window and task, however often it is retried. */
function verdictKey(entry, taskId) {
  return 'readback:' + createHash('sha256').update(JSON.stringify([entry.windowId, taskId])).digest('hex');
}

async function attachReview(fetchImpl, url, auth, entry, taskId, previousPostedAt) {
  const response = await fetchImpl(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ linked: [{ windowId: entry.windowId, asset: entry.asset, previousTaskId: entry.taskId, taskId, previousPostedAt }] }) });
  if (!response.ok || !(await response.json()).linked?.includes(entry.windowId)) throw new Error('Outcome review link changed; retry unchanged');
}

/** The readback queue's door (workers/ingest/src/routes/watch-readbacks.ts). */
export function watchReadbacksUrl(config) {
  return `http://${config.ingestHost}:${config.ingestPort}/api/watch-readbacks`;
}

/**
 * Carry each closed bet's verdict to the task that owns its reading.
 *
 * The store keeps the queue, this process comments in Ntasks, and the store is
 * told what actually landed — in that order, so a crash mid-post leaves a
 * verdict pending rather than silently delivered.
 *
 * Silent when nothing is owed. A lane that logged "0 verdicts" every hour would
 * be teaching the operator to skim the one line that matters.
 */
export async function runWatchReadbackFiler(deps = {}) {
  const {
    config = CONFIG,
    readToken = operatorToken,
    fetchImpl = fetch,
    readConfig = () => readTaskProjectConfig({ repoRoot: HOME_ROOT }),
    emit = log,
    now = Date.now,
    taskService = null,
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
  // The verdicts stay queued in the store until they can be posted in Ntasks.
  const standDown = taskLaneSkip(await taskBackend(taskService), 'post');
  if (standDown) {
    emit('WARN', `watch readbacks wait — ${standDown} (${pending.length + reviews.length} queued)`);
    return { posted: [], failed: [] };
  }
  const updates = ntasksRegister(taskService, OUTCOME_UPDATES_ACTOR);
  const reviewer = ntasksRegister(taskService, OUTCOME_REVIEW_ACTOR);

  let projects = [];
  try {
    projects = parseTaskProjects(await readConfig());
  } catch (err) {
    const failure = `task configuration unavailable: ${err.message}`;
    emit('WARN', `watch readbacks skipped — ${failure}`);
    return { posted: [], failed: [...pending, ...reviews].map((entry) => `${entry.taskId}: ${failure}`) };
  }
  const spokes = new Map(projects.map((project) => [project.asset, project]));

  const posted = [];
  const expectedTasks = {};
  const failed = [];
  for (const entry of pending) {
    const spoke = spokes.get(entry.asset);
    if (!spoke) {
      failed.push(`${entry.taskId}: no task project is configured for ${entry.asset}`);
      continue;
    }
    try {
      const task = await updates.show(spoke, entry.taskId);
      let taskId = entry.taskId;
      if (task.status === 'closed' && entry.reviewRequired !== false) {
        taskId = await fileNtasksOutcomeReview(reviewer, spoke, entry);
        await attachReview(fetchImpl, url, auth, entry, taskId, null);
      }
      await updates.comment(spoke, taskId, entry.comment, verdictKey(entry, taskId));
      expectedTasks[entry.windowId] = taskId;
    } catch (err) {
      failed.push(`${entry.taskId}: result delivery failed: ${err.message}`);
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
        // The comments ARE on the tasks; only the stamp failed. Saying so is
        // what stops the next tick's retry from looking like a mystery.
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
    .map((entry) => `${expectedTasks[entry.windowId] ?? entry.taskId} ${entry.outcome}`)
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
      if (!spoke) {
        const failure = `${review.taskId}: task project unavailable`;
        failed.push(failure);
        emit('WARN', `watch readbacks: ${failure}`);
        continue;
      }
      try {
        const task = await updates.show(spoke, review.taskId);
        const closedAt = taskInstant(task?.closed_at);
        const checkedAt = new Date(now()).toISOString();
        if (task.status === 'closed' && closedAt && closedAt <= review.postedAt) {
          const taskId = await fileNtasksOutcomeReview(reviewer, spoke, review);
          await attachReview(fetchImpl, url, auth, review, taskId, review.postedAt);
          // Delivery stays pending until the new task's comment is confirmed.
          continue;
        }
        if (task?.id !== review.taskId || task.status !== 'closed' || !closedAt
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
        const failure = `${review.taskId}: ${err.message}`;
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
