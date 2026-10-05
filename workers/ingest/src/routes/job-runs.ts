// POST /api/job-runs — the scheduled-lane record's door (db/0022, bead ro-uwo.4).
//
// Operator-authed, same shape as /api/beads-snapshot: bearer → parse → hand the
// untrusted body to the writer, which validates every field before touching D1.
// The caller is `scripts/os-up.mjs`, the only process that fires the lanes and
// therefore the only witness to one firing while the ingest was down.
//
// It answers 201 for a batch that stored nothing new, deliberately: the runner
// treats non-2xx as "not shipped, keep it queued", and a duplicate IS shipped —
// the store simply already had it. Making re-posts look like failures would keep
// the queue growing forever after the first catch-up.

import { authenticateOperator } from '../auth.js';
import { type JobRunsInput, readManualJobRuns, writeJobRuns } from '../job-runs.js';
import { json } from '../responses.js';
import { asObject } from './validate.js';

export async function handleJobRuns(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (err) {
    return json({ error: 'bad_request', detail: `could not parse body: ${String(err)}` }, 400);
  }
  const body = asObject(parsed);
  if (!body) {
    return json({ error: 'bad_request', detail: 'body must be a JSON object' }, 400);
  }

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
 * GET /api/job-runs?trigger=manual — the manual firings the record holds
 * (bead `ro-ujb9.96.7.19`), for the Workflows page's run history: the runner's
 * own file never sees a job step a person ran from the connect panel, so the
 * page reads those here. Operator-authed, like the write above; any other
 * query is refused rather than guessed at.
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
