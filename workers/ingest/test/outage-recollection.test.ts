// An outage night, replayed end to end: the scheduled archive run could reach
// the reference sites but none of the providers, so every GA4 / Search Console
// date it owed (2026-09-10..13) and every Bing family it owed (report date
// 2026-09-13) was written as a network failure, and the 04:30 Clarity export
// failed the same way. The 12:30 PostHog archive met the same wall, so every
// product analytics window ending 2026-09-13 failed at the network too. The
// days after collect normally; without re-collection the Integrations page
// would stay red. This file rebuilds that store through the real lanes (with
// the re-collection switched off) and proves the next tick clears it.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { POSTHOG_FAMILIES, type IntegrationHealthPayload } from '@noticeos/contract';
import { runClarityDumps } from '../src/clarity-dumps.js';
import { getConfigDocument, forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { putCredential } from '../src/credentials.js';
import { EGRESS_BEACONS } from '../src/egress.js';
import { readIntegrationHealth } from '../src/integration-health-read.js';
import type { LaneRegister } from '../src/lane-mapping.js';
import { runPosthogDumps } from '../src/posthog-dumps.js';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, emptyTables, pgAll, reset, setConnection, WORKERD_TRANSPORT_ERROR } from './helpers.js';

/** Bing verifies every property but pullups.example — a standing provider
 * refusal, which this fix must leave visible. */
const BING_VERIFIED = ['meals.example', 'nosh.example', 'pacer.example', 'areas.example', 'fees.example'];

/** Every provider the archive lanes call, as one fake. `providersDown` is the
 * outage: the reference sites answer, no provider does. */
function world(providersDown = false): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if ((EGRESS_BEACONS as readonly string[]).includes(url)) return new Response('h=1');
    if (providersDown) throw new Error(WORKERD_TRANSPORT_ERROR);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({ access_token: 'archive-token', expires_in: 3600 });
    }
    const parsed = new URL(url);
    if (parsed.hostname === 'ssl.bing.com') {
      if (parsed.pathname.endsWith('/GetUserSites')) {
        return Response.json({ d: BING_VERIFIED.map((host) => ({ Url: `https://${host}/`, IsVerified: true })) });
      }
      return Response.json({ d: [{ Date: '/Date(1757635200000)/', Clicks: 3, Impressions: 40 }] });
    }
    if (url.includes('/searchAnalytics/query')) {
      return Response.json({ rows: [{ keys: ['value'], clicks: 1, impressions: 20, ctr: 0.05, position: 4 }] });
    }
    if (url.includes('analyticsdata.googleapis.com')) {
      return Response.json({ rows: [{ dimensionValues: [{ value: 'v' }], metricValues: [{ value: '1' }] }], rowCount: 1 });
    }
    if (parsed.hostname === 'www.clarity.ms') {
      return Response.json([{ metricName: 'Traffic', information: [{ totalSessionCount: '4', Url: 'https://meals.example/' }] }]);
    }
    if (parsed.hostname === 'us.posthog.com') {
      // The project read, then every family's query: nothing counted yet.
      return parsed.pathname.endsWith('/query/')
        ? Response.json({ results: [] })
        : Response.json({ id: 596607, timezone: 'America/New_York' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const at = (iso: string): number => Date.parse(iso);
const networkItems = (payload: IntegrationHealthPayload, provider: string) =>
  payload.items.filter((item) => item.provider === provider && item.failure === 'network');

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
  const files = ['config/integrations.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'];
  const reads = await Promise.all(files.map((file) => getConfigDocument(env, file)));
  await seedConfigDocuments(env, {
    documents: Object.fromEntries(reads.map((read) => [read.file, read.body])),
    actor: 'test',
  });
  await putCredential(env, {
    provider: 'clarity',
    fields: { CLARITY_TOKENS: JSON.stringify({ 'meals.example': 'clarity-project-token' }) },
  });
  await putCredential(env, {
    provider: 'posthog',
    fields: { POSTHOG_KEYS: JSON.stringify({ 'meals.example': 'phx_outage_replay_fixture' }) },
  });
  // Connected long before the outage, as they were.
  for (const provider of ['clarity', 'posthog']) await setConnection(provider, { updated_at: '2026-09-01T00:00:00.000Z' });
});
afterEach(() => forgetConfigCache());

// A replay of a whole outage night through the real lanes (hundreds of store
// writes): it runs ~6 s on a busy host, so it carries its own limit.
it('re-collects an outage night and leaves no network failure on Google, Bing, Clarity or PostHog', async () => {
  // The collectors as they ran then: no re-collection pass.
  const asThen = { retryLimit: 0 };
  const laneRegister = (await getConfigDocument(env, 'config/integrations.json')).body as LaneRegister;
  const posthog = (iso: string, providersDown = false) =>
    runPosthogDumps(env, { nowMs: at(iso), fetchImpl: world(providersDown), laneRegister, ...asThen });
  await runSignalDumps(env, { nowMs: at('2026-09-13T12:15:00.000Z'), fetchImpl: world(), ...asThen });
  await posthog('2026-09-13T12:30:00.000Z');
  await runClarityDumps(env, { nowMs: at('2026-09-14T04:30:00.000Z'), fetchImpl: world(true) });
  await runSignalDumps(env, { nowMs: at('2026-09-14T12:15:00.000Z'), fetchImpl: world(true), ...asThen });
  await posthog('2026-09-14T12:30:00.000Z', true);
  for (const day of ['15', '16']) {
    await runClarityDumps(env, { nowMs: at(`2026-09-${day}T04:30:00.000Z`), fetchImpl: world() });
    await runSignalDumps(env, { nowMs: at(`2026-09-${day}T12:15:00.000Z`), fetchImpl: world(), ...asThen });
    await posthog(`2026-09-${day}T12:30:00.000Z`);
  }

  // What the outage run recorded.
  expect(
    await pgAll(`SELECT integration, count(*)::int AS n FROM ${ARCHIVE_RUNS}
        WHERE requested_at = '2026-09-14T12:15:00.000Z' AND error_code = 'request_failed'
        GROUP BY integration ORDER BY integration`),
  ).toMatchObject({ results: [{ integration: 'bing-webmaster', n: 26 }, { integration: 'ga4', n: 66 }, { integration: 'gsc', n: 80 }] });

  const stuck = await readIntegrationHealth(env, Date.now() + 1000);
  // Google: every property's oldest window date, plus the rolling family's
  // newest — the two report windows the page shows.
  const google = networkItems(stuck, 'google');
  expect(google).toHaveLength(2 * (8 + 1 + 10));
  expect(new Set(google.map((item) => item.detail?.split(' · ')[1]))).toEqual(new Set(['2026-09-10', '2026-09-13']));
  expect(google.every((item) => item.state === 'failing')).toBe(true);
  // Bing and Clarity can only ever answer "now", and have answered since.
  expect(networkItems(stuck, 'bing-webmaster')).toEqual([]);
  expect(networkItems(stuck, 'clarity')).toEqual([]);
  // Its lane now reads by its newest export (stale only because this read runs
  // on today's clock), no longer by the one the outage cost.
  expect(stuck.items.filter((item) => item.provider === 'clarity' && item.capability === 'clarity-export')).toMatchObject([
    { detail: 'url-3d · 2026-09-16', failure: null },
  ]);
  // …while a refusal is still the provider's story, on the page.
  expect(
    stuck.items.filter((item) => item.provider === 'bing-webmaster' && item.asset === 'pullups.example' && item.failure === 'provider').length,
  ).toBeGreaterThan(0);
  // PostHog: every family's window ending 09-13, the one the dark run owned.
  expect(networkItems(stuck, 'posthog').map((item) => item.detail).sort()).toEqual(
    POSTHOG_FAMILIES.map((family) => `${family} · 2026-09-13`).sort(),
  );

  // The next scheduled 12:15 tick.
  const tick = await runSignalDumps(env, { nowMs: at('2026-09-22T12:15:00.000Z'), fetchImpl: world() });
  expect(tick.retried).toBe(google.length);
  expect(tick.outcomes.filter((outcome) => outcome.reportDate <= '2026-09-13').every((outcome) => outcome.status !== 'error')).toBe(true);
  // …and the 12:30 one after it.
  const product = await runPosthogDumps(env, { nowMs: at('2026-09-22T12:30:00.000Z'), fetchImpl: world(), laneRegister });
  expect(product.retried).toBe(POSTHOG_FAMILIES.length);
  expect(product.outcomes.every((outcome) => outcome.status === 'success')).toBe(true);

  const after = await readIntegrationHealth(env, Date.now() + 1000);
  for (const provider of ['google', 'bing-webmaster', 'clarity', 'posthog']) {
    expect(networkItems(after, provider)).toEqual([]);
  }
  expect(after.items.some((item) => item.provider === 'google' && item.detail?.includes('2026-09-10'))).toBe(false);
  expect(after.items.some((item) => item.provider === 'posthog' && item.detail?.includes('2026-09-13'))).toBe(false);
}, 30_000);
