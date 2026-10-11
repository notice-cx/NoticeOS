// GET /api/capacity — the store's capacity inventory, how `pnpm os:capacity`
// measures the store through its owning runtime. Metadata only, and the read
// changes nothing (capacity.ts).

import { authenticateOperator } from '../auth.js';
import { readCapacityInventory } from '../capacity.js';
import { json } from '../responses.js';

export async function handleCapacity(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return json(await readCapacityInventory(env), 200, { 'cache-control': 'no-store' });
}
