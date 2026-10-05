// GET /api/serp-panel-landings — which properties have a fresh weekly
// DataForSEO collection. The S1b panel is one family of it (ro-478), not the
// question: a property with no panel buys the other five families and owes the
// same review.
//
// Operator-authed and READ-ONLY. The caller is the panel-review filer in
// `scripts/runner/panel-review.mjs`. It uses this route to read the Postgres
// store through the application boundary, then files tasks through the host
// task client. The Worker says what landed; the runner decides what to file.
//
// It writes nothing. A read lane that could also create the review bead would
// put the decision in the wrong process — only the runner can reach the spokes.

import { authenticateOperator } from '../auth.js';
import { json } from '../responses.js';
import { readSerpPanelLandings } from '../serp-panel-landings.js';

export async function handleSerpPanelLandings(
  request: Request,
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return json(await readSerpPanelLandings(env, nowMs), 200);
}
