// POST /api/job-runs — the scheduled-lane record's door. Operator-authed; the
// body is handed to the writer, which validates every field. The caller is the
// runner, the only witness to a firing while the ingest was down. It answers
// 201 for a batch that stored nothing new, deliberately: the runner treats
// non-2xx as "not shipped, keep it queued", and a duplicate is shipped.

import { authenticateOperator } from '../auth.js';
import { type JobRunsInput, readManualJobRuns, writeJobRuns } from '../job-runs.js';
import { json } from '../responses.js';
import { readJsonObject } from './validate.js';

export async function handleJobRuns(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  // A claim, not a check: `writeJobRuns` validates every field of it.
  const result = await writeJobRuns(env, body as unknown as JobRunsInput, nowMs);

  if (!result.ok) {
    return json({ error: 'validation', issues: result.issues }, 422);
  }
  return json(
    {
      received: result.received,
      created: result.created,
      duplicate: result.duplicate,
      stale: result.stale,
      pruned: result.pruned,
    },
    201,
  );
}

/**
 * GET /api/job-runs?trigger=manual — the manual firings the record holds, for
 * the Workflows page's run history: the runner's own file never sees a job
 * step a person ran from the connect panel. Operator-authed; any other query
 * is refused rather than guessed at.
 */
export async function handleManualJobRuns(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (new URL(request.url).searchParams.get('trigger') !== 'manual') {
    return json({ error: 'bad_request', detail: 'trigger=manual is the one read this route answers' }, 400);
  }
  return json({ runs: await readManualJobRuns(env) }, 200);
}
