import { javascriptInstant } from '@noticeos/postgres';
import { cleanup, render } from './render';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStoreState, CredentialSummary, IntegrationHealthItem, IntegrationHealthPayload, IntegrationProviderStatus } from '@noticeos/contract';
import { integrationProvider } from '@noticeos/contract';
import { CONNECTION_HISTORY_GAP, type IntegrationHealthResponse } from '@shared/connection-status';
import { IntegrationHealthPanel } from '@/components/IntegrationHealthPanel';
import {
  CONNECTION_STATUS_RETENTION_DAYS,
  handleIntegrationHealthRequest,
  loadConnectionStatusHistory,
  recordConnectionStatusDay,
  recordTodaysConnectionCounts,
} from '../worker/connection-status-daily';
import { HOURLY_TICK, runTowerCron } from '../worker/tower-cron';
import { createTestStore, type TestStore, postgresUnavailable } from "./postgres-store";

import { addSites } from './sites';

// System health's four connection counts, once a day: the Connections strip
// draws each count's history from rows the hourly tick writes, with the same
// derivation the strip states its numbers with. Reading System health writes
// nothing. The record is in each test's own copy (test/sites.ts).

const AT = '2026-09-12T12:00:00.000Z';
const NOW = new Date(AT);
const DAY_MS = 86_400_000;

function item(patch: Partial<IntegrationHealthItem>): IntegrationHealthItem {
  return { id: 'a', provider: 'google', capability: 'ga4-daily', label: 'Analytics daily reports', state: 'healthy', asset: 'a.example.com', detail: null, report: null, reportDate: null,
    lastAttemptAt: AT, lastSuccessAt: AT, nextAttemptAt: null, failure: null, code: null, action: 'Review the connection.', coverage: 'monitored', ...patch };
}

/** Three working Google sites, one failing, one report an outage left missing,
 * and one Bing site past its schedule. */
function health(generatedAt = AT): IntegrationHealthPayload {
  return {
    generatedAt, available: true, events: [],
    items: [
      ...['a', 'b', 'c'].map((site) => item({ id: site, asset: `${site}.example.com` })),
      item({ id: 'd', asset: 'd.example.com', state: 'failing', failure: 'access', code: 'access', lastSuccessAt: null }),
      item({ id: 'gap', asset: 'a.example.com', capability: 'ga4-archive', label: 'Analytics report archive', report: 'events', reportDate: '2026-09-10', state: 'failing', failure: 'network', code: 'network', lastAttemptAt: '2026-09-10T12:00:00Z', lastSuccessAt: null }),
      item({ id: 'today', asset: 'a.example.com', capability: 'ga4-archive', label: 'Analytics report archive', report: 'events', reportDate: '2026-09-11' }),
      item({ id: 'bing', provider: 'bing-webmaster', capability: 'bing-daily', label: 'Bing daily reports', asset: 'b.example.com', state: 'stale' }),
    ],
  };
}

function credential(id: string): CredentialSummary {
  return { provider: id, source: 'store', fields: ['KEY'], assetsHeld: [], missingFields: [], auth: null, metadata: null, keyVersion: 1,
    createdAt: AT, updatedAt: AT, lastUsedAt: AT, lastOkAt: AT, lastError: null } as CredentialSummary;
}
const SUMMARIES = [credential('google'), credential('bing-webmaster')];
const PROVIDERS: IntegrationProviderStatus[] = SUMMARIES.map((summary) => ({ provider: integrationProvider(summary.provider)!, assets: [], meter: null, credential: summary }));

function ingest(payload: IntegrationHealthPayload = health()) {
  return {
    integrationHealth: async () => payload,
    listCredentialSummaries: async () => ({ summaries: SUMMARIES }) as unknown as CredentialStoreState,
  };
}

async function read(store: TestStore, payload?: IntegrationHealthPayload, now = NOW): Promise<IntegrationHealthResponse> {
  const response = await handleIntegrationHealthRequest(new Request('https://tower.local/api/integrations/health'), ingest(payload), store.call, now);
  expect(response.status).toBe(200);
  return (await response.json()) as IntegrationHealthResponse;
}

/** The hourly tick's recording, as it runs over this store. */
async function tick(store: TestStore, payload?: IntegrationHealthPayload, now = NOW) {
  return recordTodaysConnectionCounts(ingest(payload), store.call, now);
}

async function rows(store: TestStore) {
  const found = await (store.call).read((tx) =>
    tx.query<{ day: string; observed_at: string; sites_failing: number; sites_overdue: number; reports_missing: number; sites_working: number }>(
      'SELECT day, observed_at, sites_failing, sites_overdue, reports_missing, sites_working FROM noticeos.connection_status_daily_counts ORDER BY day',
    ),
  );
  return found.map((row) => ({ ...row, observed_at: javascriptInstant(row.observed_at) }));
}

function strip(data: IntegrationHealthResponse, nowMs = NOW.getTime()) {
  const { container } = render(<MemoryRouter><IntegrationHealthPanel data={data} nowMs={nowMs} providers={PROVIDERS} /></MemoryRouter>);
  return (label: string) => container.querySelector(`[data-connections] [data-kpi="${label}"]`)!;
}

const LABELS = ['Sites failing', 'Sites overdue', 'Reports missing', 'Sites working'] as const;

let store: TestStore;
beforeEach(async () => { store = await createTestStore(); });
afterEach(() => { cleanup(); });

const needsPostgres = describe.skipIf(postgresUnavailable() !== null);

needsPostgres('System health’s four connection counts, once a day', () => {
  it('records the numbers the strip states, through the one derivation, on the hourly tick', async () => {
    expect(await tick(store)).toEqual({ outcome: 'ran', counts: { sitesFailing: 1, sitesOverdue: 1, reportsMissing: 1, sitesWorking: 3 } });
    const body = await read(store);

    const [row] = await rows(store);
    expect(row).toMatchObject({ day: '2026-09-12', observed_at: AT, sites_failing: 1, sites_overdue: 1, reports_missing: 1, sites_working: 3 });
    const kpi = strip(body);
    expect(kpi('Sites failing')).toHaveTextContent(String(row!.sites_failing));
    expect(kpi('Sites overdue')).toHaveTextContent(String(row!.sites_overdue));
    expect(kpi('Reports missing')).toHaveTextContent(String(row!.reports_missing));
    expect(kpi('Sites working')).toHaveTextContent(String(row!.sites_working));
  });

  it('writes nothing when System health is read', async () => {
    const body = await read(store);
    expect(await rows(store)).toEqual([]);
    // A store with the table and no tick yet has no record, not "0 days".
    expect(body.countsHistory).toMatchObject({ days: 0 });
    const kpi = strip(body);
    for (const label of LABELS) expect(kpi(label)).toHaveAttribute('data-series-reason', CONNECTION_HISTORY_GAP);
  });

  it('keeps one row a day however many hours record it, the newest winning', async () => {
    const hourEarlier = new Date(NOW.getTime() - 3_600_000);
    await tick(store, health(hourEarlier.toISOString()), hourEarlier);
    const worse = health();
    worse.items = worse.items.map((entry) => (entry.id === 'a' ? { ...entry, state: 'failing' as const, failure: 'access' as const, code: 'access', lastSuccessAt: null } : entry));
    await tick(store, worse);
    expect(await rows(store)).toEqual([expect.objectContaining({ day: '2026-09-12', observed_at: AT, sites_failing: 2, sites_working: 2 })]);
  });

  it('keeps declaring the gap until three days are recorded', async () => {
    await tick(store);
    const body = await read(store);
    expect(body.countsHistory).toMatchObject({ days: 1 });
    const kpi = strip(body);
    for (const label of LABELS) {
      expect(kpi(label)).toHaveAttribute('data-series', 'unavailable');
      expect(kpi(label)).toHaveAttribute('data-series-reason', 'Only 1 day recorded');
    }
  });

  it('draws each count’s daily line once three days exist', async () => {
    await recordConnectionStatusDay(store.call, { sitesFailing: 0, sitesOverdue: 0, reportsMissing: 3, sitesWorking: 4 }, new Date(NOW.getTime() - 2 * DAY_MS));
    await recordConnectionStatusDay(store.call, { sitesFailing: 2, sitesOverdue: 0, reportsMissing: 2, sitesWorking: 2 }, new Date(NOW.getTime() - DAY_MS));
    await tick(store);
    const body = await read(store);

    expect(body.countsHistory?.days).toBe(3);
    expect(body.countsHistory?.series.sitesFailing).toEqual([
      { t: '2026-09-10', v: 0 }, { t: '2026-09-11', v: 2 }, { t: '2026-09-12', v: 1 },
    ]);
    const kpi = strip(body);
    for (const label of LABELS) {
      expect(kpi(label)).not.toHaveAttribute('data-series');
      expect(kpi(label).querySelector('[data-spark]')).not.toBeNull();
    }
  });

  it('keeps the newest observation of a day, never an older one', async () => {
    const later = new Date(NOW.getTime() + 60_000);
    await recordConnectionStatusDay(store.call, { sitesFailing: 5, sitesOverdue: 0, reportsMissing: 0, sitesWorking: 0 }, later);
    await recordConnectionStatusDay(store.call, { sitesFailing: 1, sitesOverdue: 0, reportsMissing: 0, sitesWorking: 0 }, NOW);
    expect(await rows(store)).toEqual([expect.objectContaining({ observed_at: later.toISOString(), sites_failing: 5 })]);
  });

  it(`keeps ${CONNECTION_STATUS_RETENTION_DAYS} days`, async () => {
    await recordConnectionStatusDay(store.call, { sitesFailing: 1, sitesOverdue: 0, reportsMissing: 0, sitesWorking: 0 }, new Date(NOW.getTime() - 401 * DAY_MS));
    await recordConnectionStatusDay(store.call, { sitesFailing: 1, sitesOverdue: 0, reportsMissing: 0, sitesWorking: 0 }, new Date(NOW.getTime() - 399 * DAY_MS));
    await recordConnectionStatusDay(store.call, { sitesFailing: 1, sitesOverdue: 0, reportsMissing: 0, sitesWorking: 0 }, NOW);
    expect((await rows(store)).map((row) => row.day)).toEqual(['2025-08-09', '2026-09-12']);
  });

  it('records nothing from a health read that is not current, as the strip states nothing', async () => {
    expect(await tick(store, health(new Date(NOW.getTime() - 5 * 60_000).toISOString()))).toEqual({ outcome: 'skipped', reason: 'not-current' });
    expect(await rows(store)).toEqual([]);
  });

  it('serves the health read without its record when the record cannot be read', async () => {
    const unreadable = { ...(store.call), read: async (): Promise<never> => { throw new Error('store offline'); } };
    await expect(loadConnectionStatusHistory(unreadable)).rejects.toThrow('store offline');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await handleIntegrationHealthRequest(new Request('https://tower.local/api/integrations/health'), ingest(), unreadable, NOW);
    const body = (await response.json()) as IntegrationHealthResponse;
    expect(body.items).toHaveLength(health().items.length);
    expect(body.countsHistory).toBeUndefined();
    const kpi = strip(body);
    for (const label of LABELS) expect(kpi(label)).toHaveAttribute('data-series-reason', CONNECTION_HISTORY_GAP);
    warned.mockRestore();
  });
});

// The hourly tick's Tower steps, the one function a deployed Tower's cron and
// the local runner's fire both run: System health's four counts, then each
// data source's day.
needsPostgres('the Tower’s share of the hourly tick', () => {
  // One site with one data source, as the saved register declares it.
  const SETTINGS = {
    integrations: { catalog: [{ id: 'gsc', label: 'Google Search Console', docRef: '' }], assets: { 'a.example.com': { gsc: { status: 'live' as const, since: '2026-09-01' } } } },
    pullConfig: [], monthlyCaps: { dataUsd: 25 }, serpPanel: { assets: {} },
  };
  const env = async (payload?: IntegrationHealthPayload) => ({ STORE: store.call, INGEST: ingest(payload), config: async () => SETTINGS });
  const sourceDays = async () => (store.call).read((tx) =>
    tx.query('SELECT source, day FROM noticeos.connection_daily_counts ORDER BY source COLLATE "C"'));
  beforeEach(async () => {
    await addSites(store, [{ id: "a.example.com", domain: null, displayName: "A", status: "live" }]);
  });

  it('records today on the hourly tick and nothing on any other', async () => {
    expect(HOURLY_TICK).toBe('0 * * * *');
    expect(await runTowerCron('*/15 * * * *', await env(), () => NOW)).toEqual([]);
    expect(await rows(store)).toEqual([]);
    expect(await sourceDays()).toEqual([]);

    expect(await runTowerCron(HOURLY_TICK, await env(), () => NOW)).toEqual([
      expect.objectContaining({ id: 'connection-counts', state: 'succeeded' }),
      expect.objectContaining({ id: 'source-history', state: 'succeeded' }),
    ]);
    expect(await rows(store)).toEqual([expect.objectContaining({ day: '2026-09-12', sites_working: 3 })]);
    // The register's source and the two the Tower derives, each with today's row.
    expect(await sourceDays()).toEqual([
      { source: 'egress', day: '2026-09-12' },
      { source: 'gsc', day: '2026-09-12' },
      { source: 'nightly-report', day: '2026-09-12' },
    ]);
  });

  it('never throws: a failed step is in the trace and its error in the log, and the next step still runs', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...(await env()), INGEST: { ...ingest(), listCredentialSummaries: async (): Promise<CredentialStoreState> => { throw new Error('store offline'); } } };
    expect(await runTowerCron(HOURLY_TICK, broken, () => NOW)).toEqual([
      expect.objectContaining({ id: 'connection-counts', state: 'failed' }),
      expect.objectContaining({ id: 'source-history', state: 'succeeded' }),
    ]);
    expect(JSON.parse(String(logged.mock.calls[0]![0]))).toMatchObject({ event: 'scheduled_step_failed', step: 'connection-counts', message: 'store offline' });

    const unread = { ...(await env()), config: async () => { throw new Error('settings unreadable'); } };
    expect(await runTowerCron(HOURLY_TICK, unread, () => NOW)).toEqual([
      expect.objectContaining({ id: 'connection-counts', state: 'succeeded' }),
      expect.objectContaining({ id: 'source-history', state: 'failed' }),
    ]);
    expect(JSON.parse(String(logged.mock.calls[1]![0]))).toMatchObject({ event: 'scheduled_step_failed', step: 'source-history', message: 'settings unreadable' });
    logged.mockRestore();
  });
});
