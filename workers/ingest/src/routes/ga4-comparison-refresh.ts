// POST /api/ga4-comparison-refresh: read every GA4 property's activity
// comparison now instead of at its next hourly attempt. Not a second
// collector: the scheduled lane's own update runs with its retry time skipped.
import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import { authenticateOperator } from '../auth.js';
import { refreshGa4Comparisons, type Ga4RealtimeOptions } from '../ga4-realtime.js';
import { json } from '../responses.js';

export async function handleGa4ComparisonRefresh(request: Request, env: IngestEnv,
  options: Pick<Ga4RealtimeOptions, 'nowMs' | 'fetchImpl' | 'tokenCache'> = {}): Promise<Response> {
  if (!await authenticateOperator(request, env.OPERATOR_TOKEN)) return json({ error: 'unauthorized' }, 401);
  try {
    const text = await readBoundedJsonText(request, 64);
    const value: unknown = text.trim() ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error();
  } catch { return json({ error: 'invalid_request' }, 400); }
  try {
    return json({ sites: await refreshGa4Comparisons(env, options) }, 200, { 'cache-control': 'no-store' });
  } catch {
    return json({ error: 'refresh_failed' }, 500);
  }
}
