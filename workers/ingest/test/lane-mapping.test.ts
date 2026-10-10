// The register is what the collectors ask. Every case here is the same
// question from a different lane: does the value an operator saved on an
// asset's Sources tab reach the provider, and does an asset nobody has mapped
// keep exactly the behaviour it had? The register is injected (`laneRegister`)
// rather than read from `config/integrations.json`, so this suite states its
// own mapping.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATAFORSEO_BASELINE_LANGUAGE_CODE,
  DATAFORSEO_BASELINE_LOCATION_CODE,
  credentialPropertyMapNeeded,
  credentialPropertyMapUse,
  laneMapping,
  mappingSourceTally,
  registerMappedAssets,
  resolveDataForSeoScope,
  resolveLaneRef,
  type LaneRegister,
} from '../src/lane-mapping.js';
import {
  credentialNamedAssets,
  googleTargets,
  runGoogleSignals,
  withCredentialPropertyMaps,
} from '../src/google-signals.js';
import { listCredentialSummaries } from '../src/credentials.js';
import { runBingSignals } from '../src/bing-signals.js';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { reset } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

/** The credential blob shape the ingest reads, for the two pure target tests
 * below (nothing here is signed, so an unusable key is fine). The two collector
 * runs use the suite's own `GOOGLE_SIGNAL_ACCOUNTS` binding instead, under a
 * real generated key, which is what makes a token mintable. */
const ACCOUNTS = JSON.stringify({
  'test-signals': {
    service_account_b64: btoa(
      JSON.stringify({
        client_email: 'signals@example.test',
        private_key: 'test-private-key',
      }),
    ),
    properties: {
      'meadow.example': {
        ga4_property_id: '123456',
        gsc_site_url: 'sc-domain:meadow.example',
      },
      'northwind.example': {
        ga4_property_id: '654321',
        gsc_site_url: 'sc-domain:northwind.example',
      },
    },
  },
});

/** One asset mapped on all four lanes; every other asset says nothing, which is
 * what makes "unmapped keeps today's behaviour" testable in the same run. */
const REGISTER: LaneRegister = {
  assets: {
    'meadow.example': {
      ga4: { propertyId: '999999' },
      gsc: { siteUrl: 'sc-domain:register.meadow.example' },
      'bing-webmaster': { siteUrl: 'https://www.meadow.example/' },
      dataforseo: { locationCode: 2826, languageCode: 'en' },
    },
  },
};

const GRANT = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: 'SEKRIT-client',
  refreshToken: 'SEKRIT-refresh',
  account: 'ops@example.test',
  scopes: [],
};

beforeEach(async () => {
  await reset();
});

describe('the resolver', () => {
  it('reads one asset and lane out of the register', () => {
    expect(laneMapping('meadow.example', 'ga4', REGISTER).propertyId).toBe('999999');
    expect(laneMapping('meadow.example', 'dataforseo', REGISTER)).toMatchObject({
      locationCode: 2826,
      languageCode: 'en',
    });
    // An asset with no entry, and a lane the asset does not carry, are the same
    // answer: nothing is mapped.
    expect(laneMapping('northwind.example', 'ga4', REGISTER).propertyId).toBeNull();
    expect(laneMapping('meadow.example', 'gsc', REGISTER).propertyId).toBeNull();
  });

  it('treats an emptied field and a wrong type as "not mapped"', () => {
    // Clearing the box on the Sources tab leaves an empty string behind, and it
    // must not reach a provider as a property id.
    const odd: LaneRegister = {
      assets: {
        'northwind.example': { ga4: { propertyId: '' }, dataforseo: { locationCode: 28.5 } },
      },
    };
    expect(laneMapping('northwind.example', 'ga4', odd).propertyId).toBeNull();
    expect(laneMapping('northwind.example', 'dataforseo', odd).locationCode).toBeNull();
  });

  it('prefers the register and falls back to the lane’s old source', () => {
    expect(
      resolveLaneRef('meadow.example', 'ga4', { value: '123456', source: 'credential' }, REGISTER),
    ).toEqual({ value: '999999', source: 'register' });
    expect(
      resolveLaneRef('northwind.example', 'ga4', { value: '654321', source: 'credential' }, REGISTER),
    ).toEqual({ value: '654321', source: 'credential' });
    // Neither side has an answer: the lane reports "nothing points this asset at
    // a property", which is what each caller already knows how to say.
    expect(
      resolveLaneRef('northwind.example', 'ga4', { value: null, source: 'credential' }, REGISTER),
    ).toBeNull();
  });

  it('answers the DataForSEO scope per field, baseline behind each', () => {
    expect(resolveDataForSeoScope('meadow.example', REGISTER)).toEqual({
      locationCode: 2826,
      languageCode: 'en',
      source: 'register',
    });
    expect(resolveDataForSeoScope('northwind.example', REGISTER)).toEqual({
      locationCode: DATAFORSEO_BASELINE_LOCATION_CODE,
      languageCode: DATAFORSEO_BASELINE_LANGUAGE_CODE,
      source: 'baseline',
    });
    // A market stated without a language is an answer, not half a config.
    const marketOnly: LaneRegister = {
      assets: { 'northwind.example': { dataforseo: { locationCode: 2276 } } },
    };
    expect(resolveDataForSeoScope('northwind.example', marketOnly)).toEqual({
      locationCode: 2276,
      languageCode: DATAFORSEO_BASELINE_LANGUAGE_CODE,
      source: 'register',
    });
  });

  it('tallies which source answered, for a run’s completion line', () => {
    expect(mappingSourceTally(['register', 'credential', 'register'])).toEqual({
      register: 2,
      credential: 1,
    });
  });
});

describe('the Google lanes', () => {
  function googleFetch(): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      }
      if (url.includes('analyticsdata.googleapis.com')) {
        return Response.json({
          dimensionHeaders: [{ name: 'date' }],
          metricHeaders: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'screenPageViews' },
            { name: 'eventCount' },
          ],
          rows: [],
        });
      }
      return Response.json({ rows: [] });
    }) as typeof fetch;
    return { fetchImpl, urls };
  }

  it('asks for the property the register holds, and leaves an unmapped asset alone', async () => {
    const { fetchImpl, urls } = googleFetch();
    const result = await runGoogleSignals(env, {
      nowMs: NOW,
      fetchImpl,
      laneRegister: REGISTER,
    });

    // The mapped asset: the register's property id and site, not the blob's.
    expect(urls.some((url) => url.includes('/properties/999999:runReport'))).toBe(true);
    expect(urls.some((url) => url.includes('/properties/123456:runReport'))).toBe(false);
    expect(
      urls.some((url) => url.includes(encodeURIComponent('sc-domain:register.meadow.example'))),
    ).toBe(true);
    // The unmapped one: exactly what it asked for with no register.
    expect(urls.some((url) => url.includes('/properties/654321:runReport'))).toBe(true);
    expect(urls.some((url) => url.includes(encodeURIComponent('sc-domain:northwind.example')))).toBe(true);

    // And each attempt RECORDS which mapping it ran on.
    const sources = Object.fromEntries(
      result.outcomes.map((outcome) => [
        `${outcome.asset} ${outcome.integration}`,
        outcome.mappingSource,
      ]),
    );
    expect(sources).toEqual({
      'meadow.example ga4': 'register',
      'meadow.example gsc': 'register',
      'northwind.example ga4': 'credential',
      'northwind.example gsc': 'credential',
    });
  });

  it('asks the credential blob when the register holds nothing', async () => {
    const { fetchImpl, urls } = googleFetch();
    const result = await runGoogleSignals(env, {
      nowMs: NOW,
      fetchImpl,
      laneRegister: { assets: {} },
    });
    expect(urls.some((url) => url.includes('/properties/123456:runReport'))).toBe(true);
    expect(
      result.outcomes.every((outcome) => outcome.mappingSource === 'credential'),
    ).toBe(true);
  });

  /** An install that signed in and never pasted an account map collects
   * whatever the register maps. */
  it('collects a sign-in against the register alone, with no account map at all', () => {
    const targets = googleTargets(
      { accounts: undefined, oauth: GRANT },
      'store',
      undefined,
      REGISTER,
    );
    expect(targets.map((target) => `${target.integration}:${target.propertyRef}`)).toEqual([
      'ga4:999999',
      'gsc:sc-domain:register.meadow.example',
    ]);
    for (const target of targets) {
      expect(target.auth.kind).toBe('oauth');
      expect(target.mappingSource).toBe('register');
      // The ledger records WHICH credential ran the pull, never the operator's
      // address.
      expect(target.credentialRef).toBe('store:google-oauth');
    }
    expect(registerMappedAssets('ga4', REGISTER)).toEqual([
      { asset: 'meadow.example', ref: '999999' },
    ]);
  });

  it('never collects an asset twice when the blob and the register both name it', () => {
    const targets = googleTargets({ accounts: ACCOUNTS, oauth: GRANT }, 'env', undefined, REGISTER);
    expect(targets).toHaveLength(4);
    expect(
      targets.filter((t) => t.asset === 'meadow.example' && t.integration === 'ga4'),
    ).toHaveLength(1);
  });

  /** The second copy retires itself. `FULLY_MAPPED` maps both assets the
   * suite's own `GOOGLE_SIGNAL_ACCOUNTS` names, on both lanes, to values the
   * blob does not hold — so the blob not being read and the blob being read
   * and discarded cannot look the same. */
  const FULLY_MAPPED: LaneRegister = {
    assets: {
      'meadow.example': {
        ga4: { propertyId: '999999' },
        gsc: { siteUrl: 'sc-domain:register.meadow.example' },
      },
      'northwind.example': {
        ga4: { propertyId: '888888' },
        gsc: { siteUrl: 'sc-domain:register.northwind.example' },
      },
    },
  };

  it('asks per lane whether the credential’s own map is still anyone’s answer', () => {
    const named = ['meadow.example', 'northwind.example'];
    expect(credentialPropertyMapNeeded(named, 'ga4', FULLY_MAPPED)).toBe(false);
    expect(credentialPropertyMapNeeded(named, 'gsc', FULLY_MAPPED)).toBe(false);
    // One asset mapped on one lane retires nothing: the OTHER asset, and the
    // other lane, still have only the credential to read.
    expect(credentialPropertyMapNeeded(named, 'ga4', REGISTER)).toBe(true);
    expect(credentialPropertyMapNeeded(named, 'gsc', REGISTER)).toBe(true);
    // An asset the credential does not name cannot hold the map open — the
    // question is only ever asked of the assets it is responsible for.
    expect(credentialPropertyMapNeeded(['meadow.example'], 'ga4', REGISTER)).toBe(false);
    expect(credentialPropertyMapNeeded([], 'ga4', { assets: {} })).toBe(false);
  });

  /** One function answers it, because of the orphan: an asset the credential
   * names with no register entry at all is still mapped only by the
   * credential, so the collector goes on reading `ga4_property_id` for it,
   * and the card must not say the map answers for none of them — a safe to
   * remove the operator cannot recover from. The Tower never sees credential
   * contents, so it cannot derive this itself. */
  it('keeps the map open for an asset the register has no entry for at all', () => {
    const orphaned = credentialPropertyMapUse(
      ['meadow.example', 'northwind.example', 'acorn.example'],
      ['ga4', 'gsc'],
      FULLY_MAPPED,
    );
    // Two of the three are mapped on both data sources; the third is in the blob
    // and nowhere else, so the credential is still the only answer for it.
    expect(orphaned).toEqual({
      needed: true,
      answersFor: [
        { asset: 'acorn.example', id: 'ga4', label: 'ga4' },
        { asset: 'acorn.example', id: 'gsc', label: 'gsc' },
      ],
    });
    // And the collector reads the same rule, so the two cannot drift.
    expect(
      credentialPropertyMapNeeded(['meadow.example', 'northwind.example', 'acorn.example'], 'ga4', FULLY_MAPPED),
    ).toBe(true);
  });

  it('spells each data source the way the catalog does', () => {
    const labelled: LaneRegister = {
      ...FULLY_MAPPED,
      assets: { 'northwind.example': { gsc: { siteUrl: 'sc-domain:register.northwind.example' } } },
      catalog: [
        { id: 'ga4', label: 'Google Analytics 4 (GA4 Data API)' },
        { id: 'gsc', label: 'Google Search Console (GSC API)' },
      ],
    };
    expect(credentialPropertyMapUse(['northwind.example'], ['ga4', 'gsc'], labelled)).toEqual({
      needed: true,
      answersFor: [
        { asset: 'northwind.example', id: 'ga4', label: 'Google Analytics 4 (GA4 Data API)' },
      ],
    });
  });

  it('answers null where there is no property map to talk about', () => {
    // A provider that never held one.
    expect(credentialPropertyMapUse(['northwind.example'], ['bing-webmaster'], FULLY_MAPPED)).toBeNull();
    // And a credential the OS cannot read a blob out of — a sign-in with no
    // account map, or one that does not parse. Saying nothing beats guessing.
    expect(credentialPropertyMapUse(null, ['ga4', 'gsc'], FULLY_MAPPED)).toBeNull();
  });

  it('reports the answer to the card from the credential the collector reads', async () => {
    // The ingest answers, so the card and the run cannot hold two opinions.
    // The suite's own GOOGLE_SIGNAL_ACCOUNTS binding names meadow.example and
    // northwind.example.
    expect((await credentialNamedAssets(env))?.sort()).toEqual(['meadow.example', 'northwind.example']);

    const state = await withCredentialPropertyMaps(
      env,
      await listCredentialSummaries(env),
      FULLY_MAPPED,
    );
    const google = state.summaries.find((entry) => entry.provider === 'google')!;
    expect(google.propertyMap).toEqual({ needed: false, answersFor: [] });
    // Every other provider keeps it absent — there is no map to describe.
    for (const entry of state.summaries.filter((entry) => entry.provider !== 'google')) {
      expect(entry).not.toHaveProperty('propertyMap');
    }

    const unmapped = await withCredentialPropertyMaps(
      env,
      await listCredentialSummaries(env),
      { assets: {} },
    );
    expect(
      unmapped.summaries.find((entry) => entry.provider === 'google')!.propertyMap?.needed,
    ).toBe(true);
  });

  it('stops reading the credential’s property ids once every asset is mapped', () => {
    const targets = googleTargets({ accounts: ACCOUNTS, oauth: null }, 'env', undefined, FULLY_MAPPED);
    expect(targets.map((target) => `${target.integration}:${target.propertyRef}`).sort()).toEqual([
      'ga4:888888',
      'ga4:999999',
      'gsc:sc-domain:register.meadow.example',
      'gsc:sc-domain:register.northwind.example',
    ]);
    // Nothing collected twice, and the ROUTING half of the blob still answers:
    // every target is authenticated by the account entry that named its asset.
    expect(targets.every((target) => target.account === 'test-signals')).toBe(true);
    expect(mappingSourceTally(targets.map((target) => target.mappingSource))).toEqual({
      register: 4,
    });
  });

  it('lets the finished lane go while the unfinished one keeps its fallback', () => {
    // GA4 is mapped for both assets; Search Console for neither. The half that
    // is done stops reading the credential; the half that is not is untouched.
    const ga4Only: LaneRegister = {
      assets: {
        'meadow.example': { ga4: { propertyId: '999999' } },
        'northwind.example': { ga4: { propertyId: '888888' } },
      },
    };
    const targets = googleTargets({ accounts: ACCOUNTS, oauth: null }, 'env', undefined, ga4Only);
    const source = Object.fromEntries(
      targets.map((target) => [`${target.asset} ${target.integration}`, target.mappingSource]),
    );
    expect(source).toEqual({
      'meadow.example ga4': 'register',
      'meadow.example gsc': 'credential',
      'northwind.example ga4': 'register',
      'northwind.example gsc': 'credential',
    });
    expect(
      targets.filter((target) => target.integration === 'gsc').map((target) => target.propertyRef),
    ).toEqual(['sc-domain:meadow.example', 'sc-domain:northwind.example']);
  });

  it('records register only on a real run once nothing needs the credential map', async () => {
    const { fetchImpl, urls } = googleFetch();
    const result = await runGoogleSignals(env, {
      nowMs: NOW,
      fetchImpl,
      laneRegister: FULLY_MAPPED,
    });
    expect(result.outcomes.every((outcome) => outcome.mappingSource === 'register')).toBe(true);
    // The blob's own ids are in the binding and reach no request.
    expect(urls.some((url) => url.includes('/properties/123456:runReport'))).toBe(false);
    expect(urls.some((url) => url.includes('/properties/654321:runReport'))).toBe(false);
    expect(urls.some((url) => url.includes('/properties/999999:runReport'))).toBe(true);
    expect(urls.some((url) => url.includes('/properties/888888:runReport'))).toBe(true);
  });

  it('still refuses an install with no blob and no sign-in, in the old words', () => {
    expect(() => googleTargets({ accounts: undefined, oauth: null }, 'env', undefined, REGISTER))
      .toThrowError(/GOOGLE_SIGNAL_ACCOUNTS is not configured/);
  });
});

describe('the Bing lane', () => {
  /** Bing lists every seeded property as verified, spelled its own way. */
  const SITES = [
    'https://meadow.example/',
    'https://northwind.example/',
    'https://pebble.example/',
    'https://puffin.example/',
    'https://acorn.example/',
    'https://ferns.example/',
  ];

  function bingFetch(): { fetchImpl: typeof fetch; sites: string[] } {
    const sites: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.endsWith('/GetUserSites')) {
        return Response.json({ d: SITES.map((Url) => ({ Url })) });
      }
      sites.push(url.searchParams.get('siteUrl')!);
      return Response.json({ d: [] });
    }) as typeof fetch;
    return { fetchImpl, sites };
  }

  it('asks for the site the register holds, and matches the domain otherwise', async () => {
    const { fetchImpl, sites } = bingFetch();
    const result = await runBingSignals(env, {
      nowMs: NOW,
      fetchImpl,
      laneRegister: REGISTER,
    });
    // The register's spelling wins — which is the whole point for Bing, whose
    // account can hold two sites that share a host.
    expect(sites).toContain('https://www.meadow.example/');
    expect(sites).not.toContain('https://meadow.example/');
    expect(sites).toContain('https://northwind.example/');

    const meadow = result.outcomes.find((outcome) => outcome.asset === 'meadow.example');
    const nom = result.outcomes.find((outcome) => outcome.asset === 'northwind.example');
    expect(meadow?.mappingSource).toBe('register');
    expect(nom?.mappingSource).toBe('domain-match');
  });
});

describe('the DataForSEO lane', () => {
  function providerFetch(): {
    fetchImpl: typeof fetch;
    tasks: Record<string, unknown>[];
  } {
    const tasks: Record<string, unknown>[] = [];
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>[])
          : [];
      tasks.push(body[0] ?? {});
      return Response.json({
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.011,
        tasks: [
          {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.011,
            result: [{ items_count: 1, items: [{ ok: true }] }],
          },
        ],
      });
    }) as typeof fetch;
    return { fetchImpl, tasks };
  }

  /** Every family whose request carries a market at all. */
  const scoped = (tasks: Record<string, unknown>[]): Record<string, unknown>[] =>
    tasks.filter((task) => task.location_code !== undefined);

  it('asks every family in the one scope the asset states', async () => {
    const { fetchImpl, tasks } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example' },
      laneRegister: REGISTER,
    });
    const markets = scoped(tasks);
    // Every family that carries a market asks the same question — the
    // register's, rather than a hand-written US/English literal (six families,
    // because the two llm-mentions families share one request builder).
    expect(new Set(markets.map((task) => String(task.tag).split(':')[1])).size).toBe(6);
    for (const task of markets) {
      expect(task.location_code).toBe(2826);
      expect(task.language_code).toBe('en');
    }
  });

  it('asks in the portfolio baseline when the asset states no scope', async () => {
    const { fetchImpl, tasks } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'northwind.example' },
      laneRegister: REGISTER,
    });
    const markets = scoped(tasks);
    expect(markets.length).toBeGreaterThan(0);
    for (const task of markets) {
      expect(task.location_code).toBe(DATAFORSEO_BASELINE_LOCATION_CODE);
      expect(task.language_code).toBe(DATAFORSEO_BASELINE_LANGUAGE_CODE);
    }
  });
});
