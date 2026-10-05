// GET /api/capacity — the store's capacity inventory (bead ro-ujb9.66).
//
// How `pnpm os:doctor` measures the store through its owning runtime:
// it asks the ingest Worker, over the loopback ingest door,
// with the operator bearer every other script read already uses
// (scripts/ingest-door.mjs). The answer is metadata only — names, counts, byte
// totals, arrival timestamps — and the read changes nothing (capacity.ts).

import { authenticateOperator } from '../auth.js';
import { readCapacityInventory } from '../capacity.js';
import { json } from '../responses.js';

export async function handleCapacity(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return json(await readCapacityInventory(env), 200, { 'cache-control': 'no-store' });
}
