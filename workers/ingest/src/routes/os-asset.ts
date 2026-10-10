// GET /api/os-asset — which asset is the OS itself, as the store says
// (`assets.is_os`). Operator-authed and read-only; the caller is the local
// runner, which files the OS's own deploys against that asset. A store with no
// OS row answers `{ "asset": null }`, and the runner then files nothing.

import { authenticateOperator } from '../auth.js';
import { readOsAssetId } from '../os-asset.js';
import { json } from '../responses.js';

export async function handleOsAsset(request: Request, env: IngestEnv): Promise<Response> {
  if (!(await authenticateOperator(request, env.OPERATOR_TOKEN))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return json({ asset: await readOsAssetId(env) }, 200);
}
