import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectionState } from '@noticeos/contract';
import { emptyTables, reset, storedCount, storeSignalRun } from './helpers.js';
import { credentialSummary, listCredentialSummaries, putCredential, resolveCredential } from '../src/credentials.js';
import { readIntegrationHealth } from '../src/integration-health-read.js';
import { persistReport } from '../src/mediavine.js';
import { forgetConfigCache, getConfigDocument, seedConfigDocuments } from '../src/config-store.js';
import { DEMO_CONNECTED_PROVIDERS } from '../src/demo-connections.js';

// A demo connection is answered only by the demo profile, for the one demo
// workspace its composition names. The same rows anywhere else read as not
// connected, whatever the register declares and whatever the runs say.

const NOW = Date.now();
const ASSET = 'meadow.example';
const PROPERTY = '381204401';
const SITE = `sc-domain:${ASSET}`;
const AD_SITE = 'synthetic-ad-site';
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
  const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
  const reads = await Promise.all(files.map(file => getConfigDocument(env, file)));
  const documents = Object.fromEntries(reads.map(read => [read.file, structuredClone(read.body)])) as Record<string, { assets: Record<string, Record<string, Record<string, unknown>>> }>;
  const lanes = documents['config/integrations.json']!.assets[ASSET]!;
  lanes.ga4 = { ...lanes.ga4, status: 'live', propertyId: PROPERTY };
  lanes.gsc = { ...lanes.gsc, status: 'live', siteUrl: SITE };
  lanes['ad-network'] = { ...lanes['ad-network'], status: 'live', mediavineSiteId: AD_SITE, mediavineEnabled: true };
  await seedConfigDocuments(env, { documents, actor: 'test' });
  // The simulator's own records: a quarter-hour Google refresh and the ad
  // network's morning report, through the ordinary writers' tables.
  for (const integration of ['ga4', 'gsc'] as const) {
    await storeSignalRun({ id: `demo-${integration}`, asset: ASSET, integration, credential_ref: 'synthetic-demo',
      property_ref: integration === 'ga4' ? PROPERTY : SITE, finished_at: minutesAgo(10) });
  }
  const yesterday = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
  await persistReport(env, ASSET, { site: { id: AD_SITE, title: ASSET, domain: ASSET }, period: { start: yesterday, end: yesterday },
    daily: [{ date: yesterday, revenueMinor: 1234 }], summaryMinor: 1234, dailyMinor: 1234, differenceMinor: 0,
    complete: true, missingDates: [], fetchedAt: minutesAgo(30) });
});
afterEach(() => { vi.restoreAllMocks(); forgetConfigCache(); });

const demoEnv = async (over: Record<string, unknown> = {}) =>
  ({ ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: await env.STORE.workspaceId(), ...over }) as unknown as IngestEnv;

it('the demo workspace shows its data sources connected and syncing, with no login, no key and no fetch', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('A demo connection must not fetch'));
  const demo = await demoEnv({ CREDENTIALS_KEY: undefined });
  const state = await listCredentialSummaries(demo);
  // The demo stores no credential, so no key is asked for.
  expect(state.keyPresent).toBe(false);
  expect(state.blockers).toEqual([]);
  for (const summary of state.summaries) {
    const connected = DEMO_CONNECTED_PROVIDERS.includes(summary.provider);
    expect(summary.source, summary.provider).toBe(connected ? 'demo' : 'none');
    expect(connectionState(summary), summary.provider).toBe(connected ? 'connected' : 'not-connected');
    expect(summary.fields).toEqual([]);
  }
  expect((await credentialSummary(demo, 'google'))?.source).toBe('demo');
  expect(await resolveCredential(demo, 'google')).toMatchObject({ source: 'demo', fields: {}, connectionId: null });
  expect(await storedCount('SELECT count(*) FROM noticeos.integration_connections')).toBe(0);

  // Its runs are its evidence: each site's daily counts and ad revenue are
  // working, with when they last synced; it keeps no report archive.
  const health = await readIntegrationHealth(demo, NOW);
  const item = (capability: string) => health.items.find(entry => entry.capability === capability && entry.asset === ASSET);
  for (const capability of ['ga4-daily', 'gsc-daily', 'mediavine-revenue']) {
    expect(item(capability), capability).toMatchObject({ state: 'healthy' });
    expect(item(capability)?.lastSuccessAt, capability).not.toBeNull();
  }
  expect(health.items.some(entry => DEMO_CONNECTED_PROVIDERS.includes(entry.provider as never) && entry.capability.endsWith('-archive'))).toBe(false);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('a failed refresh reads as failing, and the next success as working again', async () => {
  const demo = await demoEnv();
  await storeSignalRun({ id: 'demo-ga4-failed', asset: ASSET, integration: 'ga4', credential_ref: 'synthetic-demo', property_ref: PROPERTY,
    finished_at: minutesAgo(5), status: 'error', error_code: 'report_unavailable' });
  const failing = (await readIntegrationHealth(demo, NOW)).items.find(entry => entry.capability === 'ga4-daily' && entry.asset === ASSET);
  expect(failing?.state).toBe('failing');
  await storeSignalRun({ id: 'demo-ga4-back', asset: ASSET, integration: 'ga4', credential_ref: 'synthetic-demo', property_ref: PROPERTY,
    finished_at: minutesAgo(1) });
  const back = (await readIntegrationHealth(demo, NOW)).items.find(entry => entry.capability === 'ga4-daily' && entry.asset === ASSET);
  expect(back?.state).toBe('healthy');
});

it('a credential the demo workspace stores is the answer, never a demo connection', async () => {
  await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'synthetic-stored-key' } });
  const demo = await demoEnv();
  const state = await listCredentialSummaries(demo);
  expect(state.summaries.find(summary => summary.provider === 'bing-webmaster')?.source).toBe('store');
  expect(state.summaries.find(summary => summary.provider === 'google')?.source).toBe('demo');
  expect((await resolveCredential(demo, 'bing-webmaster')).source).toBe('store');
  expect((await credentialSummary(demo, 'bing-webmaster'))?.source).toBe('store');
});

it('any other profile or workspace with the same rows reads not connected', async () => {
  const others: [string, IngestEnv][] = [
    ['hosted profile', { ...env, NOTICEOS_WORKSPACE_PROFILE: 'hosted' } as unknown as IngestEnv],
    ['demo profile, another workspace', await demoEnv({ NOTICEOS_DEMO_WORKSPACE_ID: '00000000-0000-4000-8000-000000000000' })],
    ['demo profile, no demo workspace', await demoEnv({ NOTICEOS_DEMO_WORKSPACE_ID: undefined })],
    ['no profile', { ...env, NOTICEOS_WORKSPACE_PROFILE: undefined } as unknown as IngestEnv],
  ];
  for (const [name, other] of others) {
    const state = await listCredentialSummaries(other).catch(() => null);
    if (state) for (const provider of DEMO_CONNECTED_PROVIDERS) {
      const summary = state.summaries.find(entry => entry.provider === provider)!;
      expect(summary.source, `${name}: ${provider}`).toBe('none');
      expect(connectionState(summary), `${name}: ${provider}`).toBe('not-connected');
    }
    const resolved = await resolveCredential(other, 'google').catch(() => null);
    expect(resolved?.source ?? 'none', name).toBe('none');
    const health = await readIntegrationHealth(other, NOW).catch(() => null);
    if (health) for (const capability of ['ga4-daily', 'gsc-daily', 'mediavine-revenue']) {
      expect(health.items.filter(entry => entry.capability === capability).every(entry => entry.state === 'disconnected'), `${name}: ${capability}`).toBe(true);
    }
  }
  // The standalone test installation answers from its own legacy bindings,
  // never as a demo connection.
  expect((await listCredentialSummaries(env)).summaries.every(summary => summary.source !== 'demo')).toBe(true);
});
