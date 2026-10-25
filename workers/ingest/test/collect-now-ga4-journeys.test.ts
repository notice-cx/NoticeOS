import { env } from 'cloudflare:test';
import type { JourneyDefinition } from '@noticeos/contract/journeys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import constantsJson from './fixture-config/constants.json';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runCollectNow } from '../src/dispatch.js';
import { EGRESS_BEACONS, EGRESS_DOWN_CODE } from '../src/egress.js';
import { jobRunName, SCHEDULED_JOBS } from '../../../scripts/scheduled-jobs.mjs';
import { cutUplink, emptyTables, pgAll, pgCount, reset, storeSignalRuns } from './helpers.js';
import { TOKEN_URL } from './signal-dumps-fixture.js';

const NOW = Date.parse('2026-10-25T12:15:00Z');
const DEFINITION: JourneyDefinition = {
  id: 'signup', label: 'Signup', kind: 'funnel', status: 'active', goal: 'Create an account', version: 1,
  steps: [
    { id: 'view', label: 'View', alternatives: [{ eventName: 'page_view' }] },
    { id: 'complete', label: 'Complete', alternatives: [{ eventName: 'sign_up' }] },
  ],
};
const INPUT = { provider: 'ga4', assets: ['meadow.example'], families: ['journeys'] };

async function seed(paused?: string) {
  const seeded = await seedConfigDocuments(env, { documents: {
    'config/value-events.json': { assets: {
      'meadow.example': { journeys: [DEFINITION] },
      'northwind.example': { journeys: [DEFINITION] },
    } },
    ...(paused ? { 'config/constants.json': { ...structuredClone(constantsJson), schedules: { [paused]: { enabled: false, cron: '15 12 * * *' } } } } : {}),
  }, actor: 'config:seed' }, NOW);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  await storeSignalRuns([
    { run: { id: 'meadow-zone', asset: 'meadow.example', integration: 'ga4', property_ref: '123456', time_zone: 'UTC', finished_at: new Date(NOW).toISOString() } },
    { run: { id: 'northwind-zone', asset: 'northwind.example', integration: 'ga4', property_ref: '654321', time_zone: 'UTC', finished_at: new Date(NOW).toISOString() } },
  ]);
  forgetConfigCache();
}

function provider(status = 200) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url === TOKEN_URL) return Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    if (!url.endsWith(':runFunnelReport')) throw new Error(`Unexpected provider request: ${url}`);
    if (status !== 200) return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status });
    return Response.json({ funnelTable: {
      dimensionHeaders: [{ name: 'funnelStepName' }], metricHeaders: [{ name: 'activeUsers' }],
      rows: DEFINITION.steps.map((step, index) => ({ dimensionValues: [{ value: `${index + 1}. ${step.id}` }], metricValues: [{ value: String(100 - index * 75) }] })),
    } });
  };
  return { calls, fetchImpl };
}

describe('manual GA4 journeys collection', () => {
  beforeEach(async () => {
    await reset();
    await emptyTables(['config_documents']);
    forgetConfigCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('collects only journeys for named assets and records the archive job as manual', async () => {
    await seed('counters');
    const fake = provider();
    const result = await runCollectNow(env, INPUT, { ...fake, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, provider: 'ga4', job: 'signal-dumps', sites: [
      { asset: 'meadow.example', outcome: 'collected', code: null, reports: 12 },
    ] });
    expect(fake.calls.filter((url) => url !== TOKEN_URL)).toHaveLength(12);
    expect(fake.calls.filter((url) => url !== TOKEN_URL).every((url) => url.includes('/properties/123456:runFunnelReport'))).toBe(true);
    const { results: archives } = await pgAll<{ asset: string; integration: string; report: string }>('SELECT asset_id AS asset, integration, report FROM noticeos.archive_runs');
    expect(archives).toHaveLength(12);
    expect(archives.every((row) => row.asset === 'meadow.example' && row.integration === 'ga4' && row.report.startsWith('journeys-'))).toBe(true);
    const { results: jobs } = await pgAll<{ job: string; outcome: string; detail: string }>('SELECT job, outcome, detail FROM noticeos.job_runs');
    expect(jobs).toEqual([{ job: jobRunName(SCHEDULED_JOBS.find((job) => job.id === 'signal-dumps')!), outcome: 'ran', detail: 'trigger:manual' }]);
    const priorCalls = fake.calls.length;
    expect(await runCollectNow(env, INPUT, { ...fake, nowMs: NOW })).toMatchObject({
      ok: true, sites: [{ asset: 'meadow.example', outcome: 'collected', code: null, reports: 12 }],
    });
    expect(fake.calls).toHaveLength(priorCalls);
  });

  it('honors the saved archive pause before any provider request', async () => {
    await seed('signal-dumps');
    const fake = provider();
    expect(await runCollectNow(env, INPUT, { ...fake, nowMs: NOW })).toEqual({ ok: false, provider: 'ga4', job: 'signal-dumps', error: 'paused' });
    expect(fake.calls).toEqual([]);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.job_runs')).toBe(0);
  });

  it('rejects unsupported GA4 family selections before any provider request', async () => {
    const fake = provider();
    for (const families of [[], ['sessions'], ['journeys', 'sessions'], ['journeys', 'journeys']]) {
      expect(await runCollectNow(env, { ...INPUT, families }, { ...fake, nowMs: NOW })).toMatchObject({ ok: false, error: 'not-supported' });
    }
    expect(await runCollectNow(env, { provider: 'ga4', assets: INPUT.assets }, { ...fake, nowMs: NOW })).toMatchObject({ ok: false, error: 'not-supported' });
    expect(await runCollectNow(env, { ...INPUT, provider: 'google' }, { ...fake, nowMs: NOW })).toMatchObject({ ok: false, error: 'not-supported' });
    expect(fake.calls).toEqual([]);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.job_runs')).toBe(0);
  });

  it('requires the existing Google connection before collection', async () => {
    await seed();
    const fake = provider();
    expect(await runCollectNow({ ...env, GOOGLE_SIGNAL_ACCOUNTS: '' }, INPUT, { ...fake, nowMs: NOW })).toEqual({
      ok: false, provider: 'ga4', job: 'signal-dumps', error: 'not-connected',
    });
    expect(fake.calls).toEqual([]);
  });

  it('reports provider failures without claiming collection succeeded', async () => {
    await seed();
    const fake = provider(403);
    const result = await runCollectNow(env, INPUT, { ...fake, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, job: 'signal-dumps', sites: [{ asset: 'meadow.example', outcome: 'failed', reports: 0 }] });
    expect(result.ok && result.sites[0]!.code).toBeTruthy();
    const { results: jobs } = await pgAll<{ outcome: string }>('SELECT outcome FROM noticeos.job_runs');
    expect(jobs).toEqual([{ outcome: 'failed' }]);
  });

  it('reports partial collection as failed while preserving the stored report count', async () => {
    await seed();
    const fake = provider();
    let reports = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith(':runFunnelReport') && ++reports > 1) {
        return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
      }
      return fake.fetchImpl(input, init);
    };
    const result = await runCollectNow(env, INPUT, { fetchImpl, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, sites: [{ asset: 'meadow.example', outcome: 'failed', reports: 1 }] });
    expect(result.ok && result.sites[0]!.code).toBeTruthy();
    const { results: jobs } = await pgAll<{ outcome: string }>('SELECT outcome FROM noticeos.job_runs');
    expect(jobs).toEqual([{ outcome: 'failed' }]);
  });

  it('reports missing sites and sites with only planned journeys as skipped', async () => {
    const seeded = await seedConfigDocuments(env, { documents: { 'config/value-events.json': {
      assets: { 'meadow.example': { journeys: [{ ...DEFINITION, status: 'planned' }] } },
    } }, actor: 'config:seed' }, NOW);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    forgetConfigCache();
    const fake = provider();
    expect(await runCollectNow(env, { ...INPUT, assets: ['meadow.example', 'missing.example'] }, { ...fake, nowMs: NOW })).toMatchObject({
      ok: true, job: 'signal-dumps', sites: [
        { asset: 'meadow.example', outcome: 'skipped', code: null, reports: 0 },
        { asset: 'missing.example', outcome: 'skipped', code: null, reports: 0 },
      ],
    });
    expect(fake.calls).toEqual([]);
    const { results: jobs } = await pgAll<{ outcome: string }>('SELECT outcome FROM noticeos.job_runs');
    expect(jobs).toEqual([{ outcome: 'skipped' }]);
  });

  it('reports an offline collection as unmeasured with no provider failure archives', async () => {
    await seed();
    const fake = provider();
    const offline = cutUplink(fake.fetchImpl);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return offline(input, init);
    };
    expect(await runCollectNow(env, INPUT, { fetchImpl, nowMs: NOW })).toMatchObject({
      ok: true, sites: [{ asset: 'meadow.example', outcome: 'unmeasured', code: EGRESS_DOWN_CODE, reports: 0 }],
    });
    expect(calls.filter((url) => !(EGRESS_BEACONS as readonly string[]).includes(url))).toEqual([TOKEN_URL]);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.archive_runs')).toBe(0);
    const { results: jobs } = await pgAll<{ outcome: string }>('SELECT outcome FROM noticeos.job_runs');
    expect(jobs).toEqual([{ outcome: 'skipped' }]);
  });
});
