// GET /api/serp-panel-landings — which properties have a fresh weekly
// DataForSEO collection; a property with no panel buys the other families and
// owes the same review. Operator-authed and read-only: the caller is the
// runner's panel-review filer, which files tasks through the host task client.
// The Worker says what landed; the runner decides what to file.

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
