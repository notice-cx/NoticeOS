import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import { authenticateOperator } from '../auth.js';
import { RefreshRefused, refreshAnomalies } from '../anomaly-refresh.js';
import { json } from '../responses.js';

export async function handleAnomalyRefresh(request: Request, env: IngestEnv): Promise<Response> {
  if (!await authenticateOperator(request, env.OPERATOR_TOKEN)) return json({ error: 'unauthorized' }, 401);
  let body: { asset?: unknown; apply?: unknown };
  try {
    const value: unknown = JSON.parse(await readBoundedJsonText(request, 4096));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['asset', 'apply'].includes(k))) throw new Error();
    body = value;
    if (typeof body.asset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(body.asset)
      || body.apply !== undefined && (typeof body.apply !== 'string' || !/^\d{13}\.[a-f0-9]{64}$/.test(body.apply))) throw new Error();
  } catch { return json({ error: 'invalid_request' }, 400); }
  try {
    return json(await refreshAnomalies(env.STORE, body.asset as string, body.apply as string | undefined), 200, { 'cache-control': 'no-store' });
  } catch (error) {
    if (error instanceof RefreshRefused) return json({ error: error.code }, error.code === 'unknown_asset' ? 404 : 409);
    return json({ error: 'refresh_failed' }, 500);
  }
}
