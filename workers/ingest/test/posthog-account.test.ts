// ONE POSTHOG KEY FOR THE ACCOUNT (bead `ro-ujb9.96.7.8`).
//
// The connect panel asks for the personal API key alone: the region is the
// cloud that accepts it, the projects are that region's list, each project is
// matched to a site by the domain it records, and its saved funnels are
// picked up rather than typed. Against real D1 and WebCrypto; PostHog is
// stubbed at the network boundary (the `fetchImpl` every call goes through),
// so its own paths, headers and answer shapes are what is exercised.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import integrationsJson from './fixture-config/integrations.json';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { connectCredential } from '../src/credential-connect.js';
import { putCredential, resolveCredential } from '../src/credentials.js';
import { runCollectNow } from '../src/dispatch.js';
import {
  POSTHOG_ACCOUNT_TIMEOUT_MS,
  discoverPosthogProjects,
  insightFunnel,
  projectHost,
  readPosthogAccount,
  savedFunnels,
} from '../src/posthog-account.js';
import { runPosthogDumps } from '../src/posthog-dumps.js';
import { discoverSites } from '../src/site-discovery.js';
import { ARCHIVE_RUNS, emptyTables, forgetCredentials, pgCount, reset } from './helpers.js';

const KEY = 'phx_SEKRIT-account-key-4f1a-do-not-echo';
const NOW = Date.parse('2026-09-23T12:30:00.000Z');

const SIGNUP = { id: 11, short_id: 'sgn', name: 'Signup', query: { kind: 'InsightVizNode', source: { kind: 'FunnelsQuery',
  series: [{ kind: 'EventsNode', event: '$pageview' }, { kind: 'EventsNode', event: 'signed_up' }] } } };
const CHECKOUT = { id: 12, short_id: 'chk', name: 'Checkout', filters: { insight: 'FUNNELS', events: [
  { id: 'purchase', order: 2 },
  { id: '$pageview', order: 0, properties: [{ key: '$pathname', operator: 'exact', value: ['/pricing'] }] },
  { id: 'checkout_started', order: 1 }] } };
const TREND = { id: 13, short_id: 'trd', name: 'Visitors', query: { kind: 'InsightVizNode', source: { kind: 'TrendsQuery', series: [] } } };

interface Call { url: string; method: string; authorization: string | null; timed: boolean }

/**
 * A PostHog account in one region: `/api/projects/` lists two projects, the
 * first records meals.example as its app URL and holds a funnel of each kind
 * and a trend; the second records nothing. The other region refuses the key
 * the way PostHog does, and the query endpoint answers with no rows.
 */
function posthog({ region = 'us', details = true, insights = true }: { region?: 'us' | 'eu'; details?: boolean; insights?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url: url.href, method: init?.method ?? 'GET', authorization, timed: init?.signal instanceof AbortSignal });
    if (url.origin !== `https://${region}.posthog.com` || authorization !== `Bearer ${KEY}`) {
      return Response.json({ detail: 'Invalid personal API key.' }, { status: 401 });
    }
    if (url.pathname === '/api/projects/') return Response.json({ results: [{ id: 596607, name: 'Meal Planner' }, { id: 12, name: 'Staging' }] });
    if (url.pathname === '/api/projects/596607/') {
      return details ? Response.json({ id: 596607, name: 'Meal Planner', timezone: 'UTC', app_urls: ['https://www.meals.example/app'] }) : new Response('', { status: 500 });
    }
    if (url.pathname === '/api/projects/12/') return Response.json({ id: 12, name: 'Staging', timezone: 'UTC', app_urls: [] });
    if (url.pathname === '/api/projects/596607/insights/') {
      return insights ? Response.json({ results: [SIGNUP, CHECKOUT, TREND] }) : Response.json({ detail: 'Missing scope insight:read' }, { status: 403 });
    }
    if (url.pathname === '/api/projects/12/insights/') return Response.json({ results: [] });
    if (url.pathname.endsWith('/query/')) return Response.json({ results: [], query_status: { complete: true } });
    return Response.json({ detail: 'Not found.' }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const down = (async () => { throw new TypeError('network down'); }) as typeof fetch;

describe('the key alone finds its region and projects', () => {
  it('asks both regions at once, keeps the one that accepts, and never guesses the other', async () => {
    const { fetchImpl, calls } = posthog({ region: 'eu' });
    const read = await readPosthogAccount(KEY, fetchImpl);
    expect(read).toEqual({ verdict: 'accepted', region: 'eu', projects: [{ id: 596607, name: 'Meal Planner' }, { id: 12, name: 'Staging' }] });
    expect(calls.map((call) => call.url).sort()).toEqual(['https://eu.posthog.com/api/projects/?limit=100', 'https://us.posthog.com/api/projects/?limit=100']);
    // Every call is bounded and carries the key only as the bearer.
    expect(calls.every((call) => call.timed && call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(POSTHOG_ACCOUNT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('is a refusal when both clouds refuse, and no answer when one of them cannot be reached', async () => {
    expect(await readPosthogAccount('phx_wrong', posthog().fetchImpl)).toEqual({ verdict: 'refused' });
    expect(await readPosthogAccount(KEY, down)).toEqual({ verdict: 'unreachable' });
    const fiveHundred = (async (input: RequestInfo | URL) => String(input).startsWith('https://us.')
      ? new Response('', { status: 503 }) : Response.json({}, { status: 401 })) as typeof fetch;
    expect(await readPosthogAccount(KEY, fiveHundred)).toEqual({ verdict: 'unreachable' });
    expect(await readPosthogAccount('   ', posthog().fetchImpl)).toEqual({ verdict: 'refused' });
  });

  it('lists every project with the domain it records and its saved funnels, as the Data sources entry would hold them', async () => {
    const { fetchImpl, calls } = posthog();
    const found = await discoverPosthogProjects(KEY, fetchImpl);
    expect(found).toEqual({ ok: true, region: 'us', sites: [
      { lane: 'posthog', ref: 'us:596607', label: 'Meal Planner', host: 'meals.example', mapping: { host: 'us', projectId: '596607' }, ready: true, funnels: [
        { id: 'signup', name: 'Signup', steps: [{ event: '$pageview' }, { event: 'signed_up' }] },
        { id: 'checkout', name: 'Checkout', steps: [{ event: '$pageview', path: '/pricing' }, { event: 'checkout_started' }, { event: 'purchase' }] },
      ] },
      { lane: 'posthog', ref: 'us:12', label: 'Staging', host: null, mapping: { host: 'us', projectId: '12' }, ready: true },
    ] });
    // Reads only: nothing is created or changed in PostHog.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(JSON.stringify(found)).not.toContain(KEY);
  });

  it('keeps a project whose details or funnels cannot be read, with what it could read', async () => {
    const found = await discoverPosthogProjects(KEY, posthog({ details: false, insights: false }).fetchImpl);
    expect(found.ok && found.sites[0]).toEqual({ lane: 'posthog', ref: 'us:596607', label: 'Meal Planner', host: null, mapping: { host: 'us', projectId: '596607' }, ready: true });
    expect(await discoverPosthogProjects('phx_wrong', posthog().fetchImpl)).toEqual({ ok: false, reason: 'refused' });
  });
});

describe('a saved insight is a funnel only when the archive can count it as PostHog does', () => {
  it('reads query-based and filter-based funnels, and a name when the insight has only a derived one', () => {
    expect(insightFunnel(SIGNUP)).toEqual({ id: 'signup', name: 'Signup', steps: [{ event: '$pageview' }, { event: 'signed_up' }] });
    expect(insightFunnel({ derived_name: 'Pageview → Signed up', query: SIGNUP.query })?.id).toBe('pageview-signed-up');
    expect(insightFunnel(CHECKOUT)?.steps[0]).toEqual({ event: '$pageview', path: '/pricing' });
  });

  it('leaves out a trend, an all-events step, a step filtered on anything but one exact path, and an unnamed insight', () => {
    expect(insightFunnel(TREND)).toBeNull();
    expect(insightFunnel({ name: 'Any', query: { kind: 'FunnelsQuery', series: [{ kind: 'EventsNode', event: null }, { kind: 'EventsNode', event: 'x' }] } })).toBeNull();
    expect(insightFunnel({ name: 'Browser', query: { kind: 'FunnelsQuery', series: [
      { kind: 'EventsNode', event: 'a', properties: [{ key: '$browser', operator: 'exact', value: 'Chrome' }] }, { kind: 'EventsNode', event: 'b' }] } })).toBeNull();
    expect(insightFunnel({ name: 'Actions', query: { kind: 'FunnelsQuery', series: [{ kind: 'ActionsNode', id: 4 }, { kind: 'EventsNode', event: 'b' }] } })).toBeNull();
    expect(insightFunnel({ query: SIGNUP.query })).toBeNull();
    expect(insightFunnel({ ...SIGNUP, deleted: true })).toBeNull();
  });

  it('keeps ids unique within a project and stops at the register limit', () => {
    const many = Array.from({ length: 14 }, () => SIGNUP);
    const funnels = savedFunnels(many);
    expect(funnels).toHaveLength(10);
    expect(funnels.slice(0, 3).map((funnel) => funnel.id)).toEqual(['signup', 'signup-2', 'signup-3']);
  });

  it('reads a project domain from its app URLs, then its recordings, then a name that is a domain', () => {
    expect(projectHost({ app_urls: ['https://www.example.com/'] }, 'x')).toBe('example.com');
    expect(projectHost({ app_urls: [], recording_domains: ['https://shop.example.com'] }, 'x')).toBe('shop.example.com');
    expect(projectHost(null, 'example.org')).toBe('example.org');
    expect(projectHost(null, 'Default project')).toBeNull();
  });
});

async function seedPosthogMapping() {
  const integrations = structuredClone(integrationsJson) as unknown as { assets: Record<string, Record<string, Record<string, unknown>>> };
  integrations.assets['meals.example']!.posthog = { status: 'needs-setup', host: 'us', projectId: '596607', funnels: [] };
  const seeded = await seedConfigDocuments(env, { documents: { 'config/integrations.json': integrations as unknown as Record<string, unknown> }, actor: 'config:seed' }, NOW);
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
}

describe('connected with the account key', () => {
  beforeEach(async () => {
    await reset();
    await emptyTables(['config_documents']);
    forgetConfigCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await forgetCredentials();
  });

  it('stores the key only once PostHog accepts it, and says which region and how many projects', async () => {
    const { fetchImpl } = posthog({ region: 'eu' });
    const result = await connectCredential(env, { provider: 'posthog', fields: { POSTHOG_API_KEY: KEY } }, { fetchImpl, nowMs: NOW });
    expect(result).toEqual({ ok: true, verdict: 'accepted', checkedAt: new Date(NOW).toISOString(), facts: { projects: 2, region: 'eu' } });
    expect((await resolveCredential(env, 'posthog')).fields.POSTHOG_API_KEY).toBe(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);

    const refused = await connectCredential(env, { provider: 'posthog', fields: { POSTHOG_API_KEY: 'phx_wrong' } }, { fetchImpl, nowMs: NOW });
    expect(refused).toMatchObject({ ok: true, verdict: 'refused' });
    // The accepted key keeps collecting while a refused replacement is judged.
    expect((await resolveCredential(env, 'posthog')).fields.POSTHOG_API_KEY).toBe(KEY);
  });

  it('lists the stored key’s projects for the panel', async () => {
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_API_KEY: KEY } });
    const listed = await discoverSites(env, 'posthog', { fetchImpl: posthog().fetchImpl, nowMs: NOW });
    expect(listed).toMatchObject({ ok: true, provider: 'posthog', kind: 'account' });
    expect(listed.ok && listed.sites.map((site) => [site.ref, site.host, site.funnels?.length ?? 0])).toEqual([['us:596607', 'meals.example', 2], ['us:12', null, 0]]);
  });

  it('archives a mapped site with the account key, recorded as that key', async () => {
    await seedPosthogMapping();
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_API_KEY: KEY } });
    const { fetchImpl, calls } = posthog();
    const run = await runPosthogDumps(env, {
      nowMs: NOW, fetchImpl, scope: { asset: 'meals.example' },
      laneRegister: { assets: { 'meals.example': { posthog: { status: 'needs-setup', host: 'us', projectId: '596607', funnels: [] } } } },
    });
    expect(run.skipped.filter((skip) => skip.asset === 'meals.example')).toEqual([
      expect.objectContaining({ family: 'funnels', reason: 'no-funnels' }),
    ]);
    expect(run.succeeded).toBe(5);
    expect(calls.filter((call) => call.method === 'POST').every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'posthog' AND credential_ref = 'store:POSTHOG_API_KEY'`)).toBe(5);
  });

  it('collects now through the product analytics job for the confirmed site', async () => {
    await seedPosthogMapping();
    await putCredential(env, { provider: 'posthog', fields: { POSTHOG_API_KEY: KEY } });
    const result = await runCollectNow(env, { provider: 'posthog', assets: ['meals.example'] }, { fetchImpl: posthog().fetchImpl, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, provider: 'posthog', job: 'posthog', sites: [{ asset: 'meals.example', outcome: 'collected', code: null }] });
  });
});
