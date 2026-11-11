// GET/POST /api/watch-readbacks — the runner's two-step onto the readback
// queue (src/watch-readbacks.ts). Operator-authed. Two steps because the work
// in the middle happens outside this Worker: the runner reads what is pending,
// posts each verdict, and comes back with the ids that landed. A verdict is
// stamped only by that second call, so a runner that dies mid-post leaves it
// pending.

import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import {
  WATCH_READBACK_MAX_BATCH,
  markWatchReadbacksPosted,
  readPendingWatchReadbacks,
  readWatchReviews,
  completeWatchReviews,
  type CompletedWatchReview,
  linkWatchReviews,
  type WatchReviewLink,
} from '../watch-readbacks.js';
import { asRecord } from '../shared.js';
import { readJsonBody } from './validate.js';

export async function handleWatchReadbacks(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (request.method === 'GET') {
    const after = new URL(request.url).searchParams.get('reviewsAfter') ?? '0';
    if (!/^\d{1,10}$/.test(after) || !Number.isSafeInteger(Number(after))) {
      return json({ error: 'bad_request', detail: 'reviewsAfter must be an alert number' }, 400);
    }
    const [pending, reviews] = await Promise.all([
      Number(after) === 0 ? readPendingWatchReadbacks(env) : Promise.resolve([]),
      readWatchReviews(env, Number(after)),
    ]);
    return json({ pending, reviews, nextReviewAfter: reviews.length === WATCH_READBACK_MAX_BATCH
      ? reviews.at(-1)!.flagNumber : null }, 200);
  }

  const read = await readJsonBody(request);
  if (read instanceof Response) return read;
  const body = asRecord(read.value);
  if (body?.linked !== undefined) {
    if (!Array.isArray(body.linked) || body.linked.length > WATCH_READBACK_MAX_BATCH || !body.linked.every(isReviewLink)) {
      return json({ error: 'bad_request', detail: 'linked must be a bounded list of review task links' }, 400);
    }
    return json(await linkWatchReviews(env, body.linked), 200);
  }
  if (body?.reviewed !== undefined) {
    const reviews = body.reviewed;
    if (!Array.isArray(reviews) || reviews.length > WATCH_READBACK_MAX_BATCH || !reviews.every(isCompletedReview)) {
      return json({ error: 'bad_request', detail: 'reviewed must be a bounded list of task-close evidence' }, 400);
    }
    return json(await completeWatchReviews(env, reviews, nowMs), 200);
  }
  const ids = body?.posted;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    return json({ error: 'bad_request', detail: 'posted must be an array of window ids' }, 400);
  }
  if (ids.length > WATCH_READBACK_MAX_BATCH) {
    return json(
      { error: 'bad_request', detail: `posted must hold at most ${WATCH_READBACK_MAX_BATCH} ids` },
      400,
    );
  }

  const expectedTasks = body?.expectedTasks === undefined ? null : asRecord(body.expectedTasks);
  if (body?.expectedTasks !== undefined && (expectedTasks === null || ids.some(id =>
    typeof expectedTasks[id] !== 'string' || expectedTasks[id].length === 0 || expectedTasks[id].length > 2048))) {
    return json({ error: 'bad_request', detail: 'expectedTasks must name the task for every delivered result' }, 400);
  }
  const result = await markWatchReadbacksPosted(env, ids as string[], nowMs, expectedTasks as Record<string, string> | null);
  return json(result, 200);
}

function isReviewLink(value: unknown): value is WatchReviewLink {
  const row = asRecord(value);
  return row !== null && (row.previousPostedAt === null || typeof row.previousPostedAt === 'string'
    && Number.isFinite(Date.parse(row.previousPostedAt))) && row.previousTaskId !== row.taskId && ['windowId', 'asset', 'previousTaskId', 'taskId'].every(key =>
    typeof row[key] === 'string' && row[key].trim().length > 0 && row[key].length <= 2048 && !row[key].includes('\u0000'));
}

function isCompletedReview(value: unknown): value is CompletedWatchReview {
  const row = asRecord(value);
  return row !== null && typeof row.flagNumber === 'number' && Number.isSafeInteger(row.flagNumber) && row.flagNumber > 0
    && ['windowId', 'asset', 'taskId', 'postedAt', 'closedAt', 'checkedAt', 'reason'].every((key) =>
      typeof row[key] === 'string' && row[key].trim().length > 0 && row[key].length <= 2048 && !row[key].includes('\u0000'));
}
