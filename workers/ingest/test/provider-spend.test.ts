// GET /api/provider-spend: the month's metered spend per site and lane, read
// from the report runs, which `scripts/cost-import.mjs` books as an `api`
// cost row.
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { archiveDumpFailure } from '../src/signal-dumps';
import { SignalError } from '../src/signal-store';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call, reset, storeArchiveRuns } from './helpers.js';

beforeEach(reset);

const spend = (period: string, token: string | null = OPERATOR_TOKEN) =>
  call(new Request(`https://ingest.test/api/provider-spend?period=${period}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  }));

it('sums each site and lane by the month of the report day, exactly, and leaves out what cost nothing', async () => {
  await storeArchiveRuns([
    { id: 'dfs-1', asset: 'nosh.example', integration: 'dataforseo', report: 'ranked-keywords', report_date: '2026-09-01', finished_at: '2026-09-01T12:45:00.000Z', provider_cost_usd: 0.1 },
    { id: 'dfs-2', asset: 'nosh.example', integration: 'dataforseo', report: 'serp-panel', report_date: '2026-09-01', finished_at: '2026-09-01T12:50:00.000Z', provider_cost_usd: 0.2 },
    { id: 'dfs-3', asset: 'meals.example', integration: 'dataforseo', report: 'ranked-keywords', report_date: '2026-09-30', finished_at: '2026-10-01T00:02:00.000Z', provider_cost_usd: 1.125 },
    // A price the collector could not read is no spend, and neither is a free lane.
    { id: 'dfs-unknown', asset: 'meals.example', integration: 'dataforseo', report: 'backlinks-summary', report_date: '2026-09-02', finished_at: '2026-09-02T12:45:00.000Z', provider_cost_usd: 0 },
    { id: 'ga4-free', asset: 'meals.example', integration: 'ga4', report: 'daily-traffic', report_date: '2026-09-02', finished_at: '2026-09-02T12:15:00.000Z' },
    // Another month.
    { id: 'dfs-aug', asset: 'meals.example', integration: 'dataforseo', report: 'ranked-keywords', report_date: '2026-08-31', finished_at: '2026-09-01T00:05:00.000Z', provider_cost_usd: 9 },
  ]);

  const response = await spend('2026-09');
  expect(response.status).toBe(200);
  // A run is billed to the month of its report day, not the one it finished in.
  expect(await response.json()).toEqual({
    period: '2026-09',
    totalUsd: 1.43,
    unknownPrices: 1,
    byAsset: [
      { asset: 'meals.example', integration: 'dataforseo', costUsd: 1.13, runs: 1, unknownPrices: 1 },
      { asset: 'nosh.example', integration: 'dataforseo', costUsd: 0.3, runs: 2, unknownPrices: 0 },
    ],
  });
  expect(await (await spend('2026-07')).json()).toEqual({ period: '2026-07', totalUsd: 0, unknownPrices: 0, byAsset: [] });
});

it('asks for the operator and a month', async () => {
  expect((await spend('2026-09', null)).status).toBe(401);
  expect((await spend('2026-9')).status).toBe(422);
});

it.each([
  [undefined, 'reported', '0.000000'],
  [0, 'reported', '0.000000'],
  [1.25, 'reported', '1.250000'],
  [-1, 'unknown', null],
  [Number.NaN, 'unknown', null],
  [Number.POSITIVE_INFINITY, 'unknown', null],
] as const)('a known-zero marker never hides a supplied price %s', async (providerCostUsd, state, usd) => {
  await archiveDumpFailure(env.STORE, {
    target: { asset: 'meals.example', integration: 'dataforseo', credentialRef: 'test', propertyRef: 'example.com' },
    report: 'ranked-keywords', reportDate: '2026-09-01', requestedAt: '2026-09-01T12:00:00.000Z',
    dataState: 'provider-snapshot', error: new SignalError('test', 'Synthetic failure'),
    providerCostUsd, knownZeroCost: true,
  });
  const rows = await env.STORE.read((tx) => tx.query('SELECT cost_state, cost_usd::text FROM noticeos.archive_runs'));
  expect(rows).toEqual([{ cost_state: state, cost_usd: usd }]);
});
