// START COLLECTING RUNS THE SCHEDULED STEP, NOT A SECOND COLLECTOR (bead
// `ro-ujb9.96.7.2`).
//
// The connect panel's one press collects the confirmed sites at once. These
// tests hold it to the promise written in `scripts/scheduled-jobs.mts`
// (`collectNow`): the step runs through dispatch's own lane calls, on the
// stored config, inside the lane's own membership rule, lease and budget gate,
// and refuses — before any provider call — while its job is paused.
//
// And the listing half (`discoverSites`): one free read, nothing stored, every
// site the account holds listed, unverified ones included.

import { env } from 'cloudflare:test';
import { siteHost } from '@noticeos/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import constantsJson from './fixture-config/constants.json';
import integrationsJson from './fixture-config/integrations.json';
import { normalizeBingHost } from '../src/bing-client.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { manualRunOutcome, runCollectNow } from '../src/dispatch.js';
import { cronRunSuccessValue, latestJobRuns } from '../src/job-runs.js';
import { bingSites, discoverSites } from '../src/site-discovery.js';
import { jobRunName, collectNowStep } from '../../../scripts/scheduled-jobs.mjs';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, call, emptyTables, pgCount, reset, storedCount, storedHealthStates } from './helpers.js';

const NOW = Date.parse('2026-09-23T15:00:00.000Z');
const MAPPED = 'https://www.meals.example/';

/** A Bing that lists every seeded property (and one it never verified) and
 * answers a day of traffic for whatever site it is asked about. */
function bing(): { fetchImpl: typeof fetch; asked: string[]; calls: string[] } {
  const asked: string[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/GetUserSites')) {
      return Response.json({ d: [
        { Url: 'https://meals.example/', IsVerified: true },
        { Url: 'https://nosh.example/', IsVerified: true },
        { Url: 'https://unverified.example/', IsVerified: false },
      ] });
    }
    asked.push(url.searchParams.get('siteUrl') ?? '');
    return Response.json({ d: [{ Date: '2026-09-22', Clicks: 12, Impressions: 340 }] });
  }) as typeof fetch;
  return { fetchImpl, asked, calls };
}

/** A DataForSEO that answers every family with one row at a known price. */
function dataForSeo(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Response.json({
      status_code: 20000, status_message: 'Ok.', cost: 0.011,
      tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.011, result: [{ items_count: 1, items: [{ ok: true }] }] }],
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The stored documents a Save on the Sources tab would leave: meals.example's
 * Bing site mapped, and — optionally — a paused job. */
async function seed({ paused = null as string | null } = {}) {
  const integrations = structuredClone(integrationsJson) as unknown as {
    assets: Record<string, Record<string, Record<string, unknown>>>;
  };
  integrations.assets['meals.example']!['bing-webmaster']!.siteUrl = MAPPED;
  const constants = structuredClone(constantsJson) as Record<string, unknown>;
  if (paused) constants.schedules = { [paused]: { enabled: false, cron: '30 2 * * *' } };
  const seeded = await seedConfigDocuments(env, {
    documents: {
      'config/integrations.json': integrations as unknown as Record<string, unknown>,
      'config/constants.json': constants,
    },
    actor: 'config:seed',
  }, NOW);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
}

describe('collect now runs the job step for the confirmed sites', () => {
  beforeEach(async () => {
    await reset();
    await emptyTables(['config_documents']);
    forgetConfigCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('collects Bing for the named asset only, asking for the site its stored mapping names', async () => {
    await seed();
    const provider = bing();
    const result = await runCollectNow(env, { provider: 'bing-webmaster', assets: ['meals.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });

    expect(result).toMatchObject({ ok: true, provider: 'bing-webmaster', job: 'pull', sites: [{ asset: 'meals.example', outcome: 'collected', code: null }] });
    expect(provider.asked).toEqual([MAPPED]);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE integration = 'bing-webmaster' AND status = 'success'`)).toBe(1);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE asset_id = 'nosh.example'`)).toBe(0);
    // …and the monitoring result the connection model reads Working from.
    expect((await storedHealthStates()).filter((row) => row.provider === 'bing-webmaster' && row.asset === 'meals.example' && row.outcome === 'success')).toHaveLength(1);
  });

  it('refuses before any provider call while the job is paused on its schedule', async () => {
    await seed({ paused: 'pull' });
    const provider = bing();
    const result = await runCollectNow(env, { provider: 'bing-webmaster', assets: ['meals.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(result).toEqual({ ok: false, provider: 'bing-webmaster', error: 'paused', job: 'pull' });
    expect(provider.calls).toEqual([]);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(0);
  });

  it('refuses a provider no job step collects, and a press that names no site', async () => {
    expect(await runCollectNow(env, { provider: 'calendar', assets: ['meals.example'] })).toEqual({ ok: false, provider: 'calendar', error: 'not-supported' });
    expect(await runCollectNow(env, { provider: 'bing-webmaster', assets: [] })).toEqual({ ok: false, provider: 'bing-webmaster', error: 'no-sites', job: 'pull' });
  });

  it('collects one asset of DataForSEO through the weekly lane, and never one the lane would not collect', async () => {
    const provider = dataForSeo();
    const result = await runCollectNow(env, { provider: 'dataforseo', assets: ['nosh.example', 'fees.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job).toBe('dataforseo');
    // fees.example is pre-launch: outside the collector's own membership rule.
    expect(result.sites.map((site) => site.asset)).toEqual(['nosh.example']);
    expect(result.sites[0]).toMatchObject({ outcome: 'collected', code: null });
    expect(result.sites[0]!.reports).toBeGreaterThan(0);
    expect(result.sites[0]!.costUsd).toBeGreaterThan(0);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo' AND asset = 'fees.example'`)).toBe(0);
    const onlyPreLaunch = await runCollectNow(env, { provider: 'dataforseo', assets: ['fees.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(onlyPreLaunch).toEqual({ ok: false, provider: 'dataforseo', error: 'no-sites', job: 'dataforseo' });
  });

  // IN ITS JOB'S RUN HISTORY (bead `ro-ujb9.96.7.19`): the press is one firing
  // of the job's step, recorded marked manual, read back through the door the
  // Workflows page reads (GET /api/job-runs?trigger=manual) — and left out of
  // the scheduled read, so cron health cannot be moved by a press.
  it('records the press once in its job\'s run history, marked manual, and nowhere a scheduled firing is read', async () => {
    await seed();
    const provider = bing();
    const result = await runCollectNow(env, { provider: 'bing-webmaster', assets: ['meals.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(result.ok).toBe(true);

    const job = jobRunName(collectNowStep('bing-webmaster')!.job);
    const response = await call(new Request('https://ingest.local/api/job-runs?trigger=manual', { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } }));
    expect(response.status).toBe(200);
    const { runs } = await response.json() as { runs: { job: string; startedAt: string; finishedAt: string; outcome: string }[] };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job, startedAt: new Date(NOW).toISOString(), outcome: 'ran' });
    expect(Date.parse(runs[0]!.finishedAt)).toBeGreaterThanOrEqual(NOW);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.job_runs WHERE detail = 'trigger:manual'`)).toBe(1);
    // The scheduled read never sees it: no lane's last run, no cron verdict.
    expect(await latestJobRuns(env)).toEqual([]);
    expect(cronRunSuccessValue(await latestJobRuns(env), NOW)).toBeNull();
    // The door answers the operator only, and only this one read.
    expect((await call(new Request('https://ingest.local/api/job-runs?trigger=manual'))).status).toBe(401);
    expect((await call(new Request('https://ingest.local/api/job-runs', { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } }))).status).toBe(400);
  });

  it('records nothing for a press that ran nothing', async () => {
    await seed({ paused: 'pull' });
    const provider = bing();
    await runCollectNow(env, { provider: 'bing-webmaster', assets: ['meals.example'] }, { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.job_runs`)).toBe(0);
  });

  it('reads a press as ran, failed or skipped in the runner\'s own words', () => {
    expect(manualRunOutcome([{ asset: 'a', outcome: 'failed', code: 'x' }, { asset: 'b', outcome: 'collected', code: null }])).toBe('ran');
    expect(manualRunOutcome([{ asset: 'a', outcome: 'failed', code: 'x' }, { asset: 'b', outcome: 'skipped', code: null }])).toBe('failed');
    expect(manualRunOutcome([{ asset: 'a', outcome: 'unmeasured', code: null }])).toBe('skipped');
  });

  it('buys nothing while another DataForSEO run holds the lane', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const holding = new Promise<void>((resolve) => { started = resolve; });
    const slow = dataForSeo();
    const weekly = runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => { started(); await gate; return slow.fetchImpl(input, init); }) as typeof fetch,
    });
    await holding;
    const press = dataForSeo();
    const result = await runCollectNow(env, { provider: 'dataforseo', assets: ['nosh.example'] }, { fetchImpl: press.fetchImpl, nowMs: NOW });
    expect(result).toEqual({ ok: false, provider: 'dataforseo', error: 'in-flight', job: 'dataforseo' });
    expect(press.calls).toEqual([]);
    release();
    await weekly;
  });
});

describe('discoverSites lists what the connected account holds', () => {
  beforeEach(async () => {
    await reset();
    forgetConfigCache();
  });

  it('lists every Bing site, the unverified one included and marked not ready, with the mapping it writes', async () => {
    const provider = bing();
    const found = await discoverSites(env, 'bing-webmaster', { fetchImpl: provider.fetchImpl, nowMs: NOW });
    expect(found).toMatchObject({ ok: true, kind: 'account', checkedAt: new Date(NOW).toISOString() });
    if (!found.ok) return;
    expect(found.sites).toEqual([
      { lane: 'bing-webmaster', ref: 'https://meals.example/', label: 'https://meals.example/', host: 'meals.example', mapping: { siteUrl: 'https://meals.example/' }, ready: true },
      { lane: 'bing-webmaster', ref: 'https://nosh.example/', label: 'https://nosh.example/', host: 'nosh.example', mapping: { siteUrl: 'https://nosh.example/' }, ready: true },
      { lane: 'bing-webmaster', ref: 'https://unverified.example/', label: 'https://unverified.example/', host: 'unverified.example', mapping: { siteUrl: 'https://unverified.example/' }, ready: false },
    ]);
    // A listing is not evidence: nothing about the credential or health moved.
    expect(await storedHealthStates()).toEqual([]);
  });

  it("says Bing refused the key rather than listing nothing", async () => {
    const refusing = (async () => Response.json({ ErrorCode: 3, Message: 'InvalidApiKey' }, { status: 401 })) as typeof fetch;
    expect(await discoverSites(env, 'bing-webmaster', { fetchImpl: refusing, nowMs: NOW }))
      .toEqual({ ok: false, provider: 'bing-webmaster', checkedAt: new Date(NOW).toISOString(), reason: 'refused' });
  });

  it('lists the assets the DataForSEO weekly lane covers, by its own membership rule', async () => {
    const found = await discoverSites(env, 'dataforseo', { nowMs: NOW });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.kind).toBe('portfolio');
    const assets = found.sites.map((site) => site.asset);
    expect(assets).toContain('nosh.example');
    expect(assets).not.toContain('fees.example');
    expect(assets).not.toContain('root-os');
  });

  it('answers not-supported for a provider this panel cannot list yet', async () => {
    expect(await discoverSites(env, 'calendar', { nowMs: NOW })).toMatchObject({ ok: false, reason: 'not-supported' });
  });

  it('matches by the same host rule the Bing collector has always used', () => {
    for (const value of ['https://www.Meals.example/path?x=1', 'http://nosh.example', 'nosh.example', 'https://sub.example.com:8443/', 'www.example.org']) {
      expect(siteHost(value)).toBe(normalizeBingHost(value));
    }
    expect(siteHost('sc-domain:meals.example')).toBe('meals.example');
    expect(siteHost('')).toBeNull();
    expect(bingSites(['https://nosh.example/', 'https://nosh.example/'])).toHaveLength(1);
  });
});
