// NOT USING MEANS NOT COLLECTED, AND NOT BILLED (bead `ro-ujb9.96.7.18`).
//
// A data source an asset's Data sources row declines — the register's
// `skipped`, with its reason, written by the row's reason chip or by an
// unticked row in the connect panel — used to be a word on a card. Two lanes
// reach an asset nobody mapped and kept collecting it: Bing matches the
// asset's own domain against the account's verified sites (both its 15-minute
// collector and its nightly archive), and the weekly DataForSEO sweep collects
// every launched asset with a domain — billing it. Each case below states the
// same register the Sources tab would have saved and proves the declined site
// is neither requested nor recorded, while the rest of the portfolio is.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import integrationsJson from './fixture-config/integrations.json';
import { runBingSignals } from '../src/bing-signals.js';
import { runClarityDumps } from '../src/clarity-dumps.js';
import { runGoogleSignals } from '../src/google-signals.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { runCollectNow } from '../src/dispatch.js';
import { laneDeclined, type LaneRegister } from '../src/lane-mapping.js';
import { handleSignalCollect } from '../src/routes/signal-collect.js';
import { runSignalDumps } from '../src/signal-dumps.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { ARCHIVE_RUNS, emptyTables, pgCount, pgFirst, reset, storedCount } from './helpers.js';

const NOW = Date.parse('2026-09-23T15:00:00.000Z');

/** What the Sources tab leaves after "Not using" on nosh.example's Bing and
 * DataForSEO rows: the posture and the reason the chip wrote. */
const DECLINED: LaneRegister = {
  assets: {
    'nosh.example': {
      'bing-webmaster': { status: 'skipped', note: 'REASON: Replaced by another tool' },
      dataforseo: { status: 'skipped', note: 'REASON: Not relevant for this site' },
    },
  },
};
/** The same portfolio with nothing declined — the control each case is read against. */
const NOTHING_DECLINED: LaneRegister = { assets: {} };

/** A Bing whose account verifies every seeded property, recording which site
 * each report asked about. */
function bing(): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/GetUserSites')) {
      return Response.json({
        d: ['meals.example', 'nosh.example', 'pacer.example', 'pullups.example', 'areas.example', 'fees.example']
          .map((domain) => ({ Url: `https://${domain}/`, IsVerified: true })),
      });
    }
    asked.push(url.searchParams.get('siteUrl') ?? '');
    return Response.json({ d: [{ Date: '2026-09-22', Clicks: 12, Impressions: 340 }] });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** A DataForSEO that answers every family with one row at a known price,
 * recording each task it was asked (every task's tag starts with its asset). */
function dataForSeo(): { fetchImpl: typeof fetch; tags: string[]; calls: number } {
  const state = { tags: [] as string[], calls: 0 };
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    state.calls += 1;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>[]) : [];
    for (const task of body) if (typeof task.tag === 'string') state.tags.push(task.tag);
    return Response.json({
      status_code: 20000, status_message: 'Ok.', cost: 0.011,
      tasks: [{ status_code: 20000, status_message: 'Ok.', cost: 0.011, result: [{ items_count: 1, items: [{ ok: true }] }] }],
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    get tags() { return state.tags; },
    get calls() { return state.calls; },
  };
}

beforeEach(async () => {
  await reset();
  await emptyTables(['config_documents']);
  forgetConfigCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('laneDeclined', () => {
  it('reads Not using and does-not-apply as not collected, and everything else as collected', () => {
    const register: LaneRegister = {
      assets: {
        a: { 'bing-webmaster': { status: 'skipped' }, dataforseo: { status: 'not-applicable' }, ga4: { status: 'needs-setup' } },
      },
    };
    expect(laneDeclined('a', 'bing-webmaster', register)).toBe(true);
    expect(laneDeclined('a', 'dataforseo', register)).toBe(true);
    expect(laneDeclined('a', 'ga4', register)).toBe(false);
    expect(laneDeclined('a', 'gsc', register)).toBe(false);
    expect(laneDeclined('b', 'bing-webmaster', register)).toBe(false);
  });
});

describe("Bing's domain fallback skips a declined site", () => {
  it('the 15-minute collector never asks Bing for it and records no attempt', async () => {
    const control = bing();
    await runBingSignals(env, { nowMs: NOW, fetchImpl: control.fetchImpl, apiKey: 'test-key', laneRegister: NOTHING_DECLINED });
    // Without the decline the domain match finds nosh.example — so the case below
    // is the decline at work, not a site Bing never listed.
    expect(control.asked).toContain('https://nosh.example/');
    await reset();

    const provider = bing();
    const result = await runBingSignals(env, { nowMs: NOW, fetchImpl: provider.fetchImpl, apiKey: 'test-key', laneRegister: DECLINED });
    expect(provider.asked).not.toContain('https://nosh.example/');
    expect(provider.asked).toContain('https://meals.example/');
    expect(result.outcomes.map((outcome) => outcome.asset)).not.toContain('nosh.example');
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE asset_id = 'nosh.example'`)).toBe(0);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE asset_id = 'meals.example' AND status = 'success'`)).toBe(1);
  });

  it('the nightly archive never asks Bing for it and writes no manifest', async () => {
    const provider = bing();
    await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl: provider.fetchImpl,
      rawConfig: '{}',
      bingApiKey: 'test-key',
      revisionDays: 1,
      laneRegister: DECLINED,
    });
    expect(provider.asked).not.toContain('https://nosh.example/');
    expect(provider.asked).toContain('https://meals.example/');
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE asset = 'nosh.example'`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE asset = 'meals.example' AND integration = 'bing-webmaster'`)).toBeGreaterThan(0);
  });
});

describe('the DataForSEO weekly sweep neither requests nor bills a declined site', () => {
  it('buys every family for the rest of the portfolio and nothing for the declined one', async () => {
    const control = dataForSeo();
    await runDataForSeoDumps(env, {
      nowMs: NOW, fetchImpl: control.fetchImpl, login: 'operator-login', password: 'operator-password', laneRegister: NOTHING_DECLINED,
    });
    expect(control.tags.some((tag) => tag.startsWith('nosh.example:'))).toBe(true);
    await reset();

    const provider = dataForSeo();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW, fetchImpl: provider.fetchImpl, login: 'operator-login', password: 'operator-password', laneRegister: DECLINED,
    });
    // Not requested…
    expect(provider.tags.filter((tag) => tag.startsWith('nosh.example:'))).toEqual([]);
    expect(provider.tags.some((tag) => tag.startsWith('meals.example:'))).toBe(true);
    // …not recorded, and not billed.
    expect(result.outcomes.map((outcome) => outcome.asset)).not.toContain('nosh.example');
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo' AND asset = 'nosh.example'`)).toBe(0);
    const billed = await pgFirst<{ usd: number }>(`SELECT COALESCE(SUM(provider_cost_usd), 0) AS usd FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo' AND asset = 'nosh.example'`);
    expect(billed?.usd).toBe(0);
    const total = await pgFirst<{ usd: number }>(`SELECT COALESCE(SUM(provider_cost_usd), 0) AS usd FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`);
    expect(result.costUsd).toBeCloseTo(total?.usd ?? -1, 6);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('a named collection of the declined site asks for nothing', async () => {
    const provider = dataForSeo();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW, fetchImpl: provider.fetchImpl, login: 'operator-login', password: 'operator-password',
      laneRegister: DECLINED, scope: { asset: 'nosh.example' },
    });
    expect(provider.tags).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('the operator route refuses it by name, before anything is billed', async () => {
    const provider = dataForSeo();
    const res = await handleSignalCollect(
      new Request('https://ingest.local/api/signal-collect', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
        body: JSON.stringify({ asset: 'nosh.example' }),
      }),
      env,
      { nowMs: NOW, fetchImpl: provider.fetchImpl, login: 'operator-login', password: 'operator-password', laneRegister: DECLINED },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'declined', asset: 'nosh.example' });
    expect(provider.calls).toBe(0);
  });
});

// ONE SKIP RULE, EVERY COLLECTOR (D30): Not using is a product concept, the
// same for every provider, so the other collectors ask the same `laneDeclined`.
describe('every other collector skips a declined source the same way', () => {
  it('Google: neither GA4 nor Search Console is asked for a declined property', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      if (url.includes('analyticsdata.googleapis.com')) {
        return Response.json({ dimensionHeaders: [{ name: 'date' }], metricHeaders: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }, { name: 'eventCount' }], rows: [] });
      }
      return Response.json({ rows: [] });
    }) as typeof fetch;
    const result = await runGoogleSignals(env, {
      nowMs: NOW,
      fetchImpl,
      laneRegister: { assets: { 'nosh.example': { ga4: { status: 'skipped' }, gsc: { status: 'skipped' } } } },
    });
    // The suite's credential maps meals.example to GA4 123456 and nosh.example to 654321.
    expect(urls.some((url) => url.includes('/properties/123456:runReport'))).toBe(true);
    expect(urls.some((url) => url.includes('/properties/654321:runReport'))).toBe(false);
    expect(urls.some((url) => url.includes(encodeURIComponent('sc-domain:nosh.example')))).toBe(false);
    expect(result.outcomes.map((outcome) => outcome.asset)).not.toContain('nosh.example');
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE asset_id = 'nosh.example'`)).toBe(0);
  });

  it('Clarity: a declined project is not asked for, even with its token held', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      asked.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json([{ metricName: 'Traffic', information: [{ totalSessionCount: '1', Url: null }] }]);
    }) as typeof fetch;
    await runClarityDumps(env, {
      nowMs: NOW,
      fetchImpl,
      rawTokens: JSON.stringify({ 'meals.example': 'token-meals', 'nosh.example': 'token-nom' }),
      laneRegister: { assets: { 'nosh.example': { clarity: { status: 'skipped' } } } },
    });
    expect(asked).toEqual(['Bearer token-meals']);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE asset = 'nosh.example'`)).toBe(0);
  });
});

describe('the connect panel’s Start honours a decline saved in the same press', () => {
  /** The stored register after Start saved nosh.example as Not using on both lanes. */
  async function seedDeclined() {
    const integrations = structuredClone(integrationsJson) as unknown as {
      assets: Record<string, Record<string, Record<string, unknown>>>;
    };
    for (const lane of ['bing-webmaster', 'dataforseo']) {
      integrations.assets['nosh.example']![lane] = {
        ...integrations.assets['nosh.example']![lane],
        status: 'skipped',
        note: 'REASON: Replaced by another tool',
      };
    }
    const seeded = await seedConfigDocuments(env, {
      documents: { 'config/integrations.json': integrations as unknown as Record<string, unknown> },
      actor: 'config:seed',
    }, NOW);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  }

  it('collects nothing for a declined site, on either provider', async () => {
    await seedDeclined();
    const search = dataForSeo();
    expect(await runCollectNow(env, { provider: 'dataforseo', assets: ['nosh.example'] }, { fetchImpl: search.fetchImpl, nowMs: NOW }))
      .toEqual({ ok: false, provider: 'dataforseo', error: 'no-sites', job: 'dataforseo' });
    expect(search.calls).toBe(0);

    const site = bing();
    const result = await runCollectNow(env, { provider: 'bing-webmaster', assets: ['nosh.example', 'meals.example'] }, { fetchImpl: site.fetchImpl, nowMs: NOW });
    expect(site.asked).not.toContain('https://nosh.example/');
    expect(result.ok && result.sites.map((entry) => entry.asset)).toEqual(['meals.example']);
  });
});
