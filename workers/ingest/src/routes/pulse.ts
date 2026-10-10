// POST /api/pulse — an asset pushes its nightly pulse.
//
// Order matters: we need the asset id from the body to select the right token,
// so we parse JSON, identify the asset, authenticate, then fully validate the
// envelope (a 422 with issues is only returned to an authenticated caller).

import { authenticateAsset } from '../auth.js';
import { ingestPulseEnvelope } from '../db.js';
import { json, zodIssues } from '../responses.js';

export async function handlePulse(request: Request, env: IngestEnv): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', detail: 'body is not valid JSON' }, 400);
  }

  const assetId = (body as { asset?: unknown } | null)?.asset;
  if (typeof assetId !== 'string' || assetId.length === 0) {
    // Can't identify the caller -> can't authenticate it.
    return json({ error: 'unauthorized', detail: 'asset id missing from body' }, 401);
  }

  if (!(await authenticateAsset(request, env.ASSET_TOKENS, assetId))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const outcome = await ingestPulseEnvelope(env, body);
  if (!outcome.ok) {
    return json({ error: 'unprocessable_entity', issues: zodIssues(outcome.error) }, 422);
  }
  return json({ ok: true, ...outcome.result }, 201);
}
