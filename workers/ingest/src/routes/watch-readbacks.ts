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
    return json({ pending: await readPendingWatchReadbacks(env) }, 200);
  }

  const read = await readJsonBody(request);
  if (read instanceof Response) return read;
  const body = asRecord(read.value);
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

  const result = await markWatchReadbacksPosted(env, ids as string[], nowMs);
  return json(result, 200);
}
