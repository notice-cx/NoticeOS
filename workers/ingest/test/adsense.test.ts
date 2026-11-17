// Google is stubbed at the HTTP boundary. Collections use disposable Postgres.
import { env } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { applyConfigOps } from '../src/config-store.js';
import { runCollectNow } from '../src/dispatch.js';
import { importLedgerRows } from '../src/routes/revenue.js';
import { discoverSites } from '../src/site-discovery.js';
import { pgCount, pgRows, reset } from './helpers.js';

const NOW = Date.parse('2026-09-09T15:00:00Z');
const ASSET = 'meadow.example';
const ACCOUNT = 'accounts/pub-123';
const SITE = `${ACCOUNT}/sites/site-1`;
const OTHER_SITE = `${ACCOUNT}/sites/site-2`;
const SCOPE = 'https://www.googleapis.com/auth/adsense.readonly';
const credential = { provider: 'adsense', fields: {
  ADSENSE_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com',
  ADSENSE_CLIENT_SECRET: 'synthetic-client-secret',
  ADSENSE_REFRESH_TOKEN: 'synthetic-refresh-token',
} };

function google(scope = SCOPE) {
  const reports: Array<{ date: string; amount: string; id: string }> = [
    { date: '2026-09-01', amount: '1.23', id: 'site:1' },
    { date: '2026-09-02', amount: '0', id: 'site:1' },
  ];
  const sites = [
    { name: SITE, domain: ASSET, reportingDimensionId: 'site:1', state: 'READY' },
    { name: OTHER_SITE, domain: 'northwind.example', reportingDimensionId: 'site:2', state: 'READY' },
  ];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') {
      expect(init?.method).toBe('POST');
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe(credential.fields.ADSENSE_REFRESH_TOKEN);
      return Response.json({ access_token: 'synthetic-access', scope });
    }
    expect(url.origin).toBe('https://adsense.googleapis.com');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access');
    if (url.pathname === '/v2/accounts') return Response.json({ accounts: [{ name: ACCOUNT }] });
    if (url.pathname === `/v2/${ACCOUNT}/sites`) return Response.json(url.searchParams.has('pageToken')
      ? { sites: [sites[1]] }
      : { sites: [sites[0]], nextPageToken: 'another-page' });
    if (url.pathname === `/v2/${SITE}`) return Response.json(sites[0]);
    if (url.pathname === `/v2/${ACCOUNT}/reports:generate`) {
      expect(url.searchParams.get('filters')).toBe('OWNED_SITE_ID==site:1');
      expect(url.searchParams.get('reportingTimeZone')).toBe('GOOGLE_TIME_ZONE');
      expect(url.searchParams.get('startDate.month')).toBe('8');
      expect(url.searchParams.get('endDate.day')).toBe('8');
      return Response.json({
        totalMatchedRows: String(reports.length),
        headers: [{ name: 'DATE' }, { name: 'OWNED_SITE_ID' }, { name: 'ESTIMATED_EARNINGS', currencyCode: 'EUR' }],
        rows: reports.map(({ date, id, amount }) => ({ cells: [{ value: date }, { value: id }, { value: amount }] })),
      });
    }
    throw new Error(`Unexpected fixture route ${url.pathname}`);
  });
  return { fetchImpl, reports };
}

beforeEach(async () => { await reset(); });

it('refuses grants outside read-only AdSense before calling the AdSense API or storing a credential', async () => {
  const { fetchImpl } = google('https://www.googleapis.com/auth/adsense');
  const connected = await connectCredential(env, credential, { fetchImpl, nowMs: NOW });
  expect(connected).toMatchObject({ ok: true, verdict: 'refused' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await pgCount("SELECT COUNT(*) AS n FROM noticeos.integration_connections WHERE provider = 'adsense'")).toBe(0);
});

it('collects only the mapped site, refreshes changed earnings and keeps one current monthly figure', async () => {
  const { fetchImpl, reports } = google();
  const options = { fetchImpl, nowMs: NOW };
  expect(await connectCredential(env, credential, options)).toMatchObject({ ok: true, verdict: 'accepted' });
  expect(await discoverSites(env, 'adsense', options)).toMatchObject({
    ok: true, sites: [
      { ref: SITE, host: ASSET, mapping: { adsenseSite: SITE } },
      { ref: OTHER_SITE, host: 'northwind.example' },
    ],
  });
  expect(await applyConfigOps(env, { actor: 'operator', reason: 'Map the AdSense site', ops: [{
    kind: 'file-json-insert', file: 'config/integrations.json', pointer: `/assets/${ASSET}/adsense`,
    value: { status: 'needs-setup', since: '2026-09-09', adsenseSite: SITE },
  }] })).toMatchObject({ ok: true });

  const manual = await importLedgerRows([{
    kind: 'revenue', asset: ASSET, period: '2026-09', family: 'ads', source: 'adsense-report',
    amount: 1, currency: 'EUR', booking_state: 'estimated',
    coverage_start: '2026-09-01', coverage_end: '2026-09-02', coverage_complete: false,
  }], env.STORE);
  expect(manual.inserted).toBe(1);

  const run = () => runCollectNow(env, { provider: 'adsense', assets: [ASSET, 'northwind.example'] }, options);
  expect(await run()).toMatchObject({ ok: true, sites: [{ asset: ASSET, outcome: 'collected' }] });
  expect(await run()).toMatchObject({ ok: true, sites: [{ asset: ASSET, outcome: 'collected' }] });
  expect(await pgCount("SELECT COUNT(*) AS n FROM noticeos.revenue_observations WHERE source = 'adsense'")).toBe(2);
  reports[0]!.amount = '2.75';
  expect(await run()).toMatchObject({ ok: true, sites: [{ asset: ASSET, outcome: 'collected' }] });
  expect(await pgCount("SELECT COUNT(*) AS n FROM noticeos.revenue_observations WHERE source = 'adsense'")).toBe(3);
  reports.length = 0;
  expect(await run()).toMatchObject({ ok: true, sites: [{ asset: ASSET, outcome: 'skipped', code: 'unpublished' }] });

  expect(await pgRows(
    `SELECT asset_id, revenue_date::text AS day, amount_minor::text AS amount, currency
       FROM noticeos.current_revenue WHERE source = 'adsense' ORDER BY revenue_date`,
  )).toEqual([
    { asset_id: ASSET, day: '2026-09-01', amount: '275', currency: 'EUR' },
    { asset_id: ASSET, day: '2026-09-02', amount: '0', currency: 'EUR' },
  ]);
  expect(await pgRows(
    `SELECT amount_minor::text AS amount, source FROM noticeos.financial_ledger
      WHERE asset_id = $1 AND period_month = '2026-09-01' AND kind = 'revenue'`, [ASSET],
  )).toEqual([{ amount: '275', source: 'adsense' }]);
});
