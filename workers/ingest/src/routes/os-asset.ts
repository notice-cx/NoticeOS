// GET /api/os-asset — which asset is the OS itself, as the store says
// (`assets.is_os`, beads `ro-k9hf`, `ro-ujb9.118`).
//
// Operator-authed and READ-ONLY. The caller is the local runner
// (`scripts/os-up.mjs`), which files the OS's own deploys and its task-map
// beads against that asset and cannot reach D1 itself. A store with no OS row
// answers `{ "asset": null }`, and the runner then files nothing about the OS.

import { authenticateOperator } from '../auth.js';
import { readOsAssetId } from '../os-asset.js';
import { json } from '../responses.js';

export async function handleOsAsset(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return json({ asset: await readOsAssetId(env) }, 200);
}
