import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { updateComparison } from '../src/ga4-comparison.js';
import { handleGa4ComparisonRefresh } from '../src/routes/ga4-comparison-refresh.js';
import { call, pgRows, reset } from './helpers.js';
import { OPERATOR_TOKEN } from './fixtures.js';

const NOW = Date.parse('2026-07-29T12:00:00Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google answering a token request and each single-range minute report. */
function google() {
  return vi.fn<typeof fetch>(async (input) => {
    if (String(input) === TOKEN_URL) return Response.json({ access_token: 'synthetic-comparison-token', expires_in: 3600 });
    if (!String(input).endsWith(':runReport')) throw new Error(`unexpected provider read: ${String(input)}`);
    return Response.json({ dimensionHeaders: [{ name: 'dateHourMinute' }], metricHeaders: [{ name: 'activeUsers' }],
      rows: [{ dimensionValues: [{ value: '202607290000' }], metricValues: [{ value: '3' }] }], rowCount: 1, metadata: { timeZone: 'UTC' } });
  });
}
const request = (body = '{}', token = OPERATOR_TOKEN) => new Request('https://ingest.local/api/ga4-comparison-refresh',
  { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
const latest = (asset: string) => pgRows<{ error_code: string | null; stored: boolean }>(
  `SELECT error_code, payload IS NOT NULL AS stored FROM noticeos.traffic_comparison_reports WHERE asset_id = $1 ORDER BY observed_at DESC LIMIT 1`, [asset]);
beforeEach(reset);

describe('the on-demand activity comparison refresh', () => {
  it('reads every GA4 property now although its stored retry time is an hour away', async () => {
    const refused = vi.fn<typeof fetch>(async () => Response.json({ error: {} }, { status: 503 }));
    const held = { asset: 'meadow.example', property: '123456', token: 'synthetic', zone: 'UTC', cache: null };
    await updateComparison(env, { ...held, nowMs: NOW - 60_000, fetchImpl: refused, shared: new Map() });
    expect(await updateComparison(env, { ...held, nowMs: NOW, fetchImpl: google(), shared: new Map() })).toBeNull();

    const fetchImpl = google();
    const response = await handleGa4ComparisonRefresh(request(), env, { nowMs: NOW, fetchImpl, tokenCache: new Map() });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { sites } = await response.json() as { sites: { asset: string; ok: boolean }[] };
    expect(sites.map(site => [site.asset, site.ok]).sort()).toEqual([['meadow.example', true], ['northwind.example', true]]);
    // Two single-range reports per property.
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).endsWith(':runReport'))).toHaveLength(4);
    expect(await latest('meadow.example')).toEqual([{ error_code: null, stored: true }]);
  });

  it('refuses an unauthenticated call or a narrowed scope before any provider request', async () => {
    expect((await call(request('{}', 'wrong'))).status).toBe(401);
    const fetchImpl = google();
    for (const body of ['{"asset":"meadow.example"}', '[]', 'not json']) {
      expect((await handleGa4ComparisonRefresh(request(body), env, { nowMs: NOW, fetchImpl })).status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
