import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OS_TIME_ZONE } from '@noticeos/contract';
import {
  assumedTimeZoneEvent,
  parseGoogleTargets,
  runGoogleSignals,
} from '../src/google-signals.js';
import { dateInTimeZone } from '../src/time-zone.js';
import { putCredential } from '../src/credentials.js';
import { EGRESS_DOWN_CODE } from '../src/egress.js';
import { readPanelTrend } from '../src/panel-source.js';
import { WORKERD_TRANSPORT_ERROR, credentialVerdict, cutUplink, openEgressFlags, pgRows, reset, storeSignalRun, storedCount, storedEgressChecks, storedHealthStates } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The properties vitest.config.ts maps onto the test service account. Two,
 * so collecting every property and collecting the first one are different
 * numbers: a break-instead-of-continue regression is visible here. */
const GOOGLE_PROPERTIES = ['meals.example', 'nosh.example'] as const;
/** One GA4 lane and one GSC lane per property. */
const GOOGLE_ATTEMPTS = GOOGLE_PROPERTIES.length * 2;
/** Daily observations one property's GA4 lane writes on a first collection. */
const GA4_OBSERVATIONS = 388;
const GSC_OBSERVATIONS = 388;

function googleFetch({
  ga4Status = 200,
  ga4Error = { message: 'GA4 property access denied' } as Record<string, unknown>,
  ga4Quota = null,
  gscStatus = 200,
  gscIncompleteDate = '2026-07-25',
  ga4TimeZone = null,
}: {
  /** GA4's `metadata.timeZone`; null omits `metadata`, as the default fixture always has. */
  ga4TimeZone?: string | null;
  ga4Status?: number;
  /** The provider's `error` object, verbatim — its `status` is load-bearing. */
  ga4Error?: Record<string, unknown>;
  /** What the Data API reports the property has spent and has left. */
  ga4Quota?: { consumed: number; remaining: number } | null;
  gscStatus?: number;
  gscIncompleteDate?: string | null;
} = {}): { fetchImpl: typeof fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : '';
    calls.push({ url, body });
    if (url === TOKEN_URL) {
      return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
    }
    if (url.includes('analyticsdata.googleapis.com')) {
      if (ga4Status !== 200) {
        return Response.json({ error: ga4Error }, { status: ga4Status });
      }
      return Response.json({
        dimensionHeaders: [{ name: 'date' }],
        metricHeaders: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'screenPageViews' },
          { name: 'eventCount' },
        ],
        rows: [
          {
            dimensionValues: [{ value: '20260726' }],
            metricValues: [{ value: '18' }, { value: '14' }, { value: '31' }, { value: '92' }],
          },
          {
            dimensionValues: [{ value: '20260727' }],
            metricValues: [{ value: '20' }, { value: '16' }, { value: '35' }, { value: '104' }],
          },
        ],
        ...(ga4Quota
          ? {
              propertyQuota: {
                tokensPerDay: ga4Quota,
                tokensPerHour: { consumed: 2, remaining: 39_998 },
              },
            }
          : {}),
        ...(ga4TimeZone === null ? {} : { metadata: { timeZone: ga4TimeZone } }),
      });
    }
    if (url.includes('/searchAnalytics/query')) {
      if (gscStatus !== 200) {
        return Response.json(
          { error: { message: 'Search Console site access denied' } },
          { status: gscStatus },
        );
      }
      return Response.json({
        ...(gscIncompleteDate
          ? { metadata: { first_incomplete_date: gscIncompleteDate } }
          : {}),
        rows: [
          {
            keys: ['2026-07-25'],
            clicks: 9,
            impressions: 240,
            ctr: 0.0375,
            position: 8.2,
          },
          {
            keys: ['2026-07-26'],
            clicks: 12,
            impressions: 280,
            ctr: 0.0428,
            position: 7.8,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(reset);

describe('Google signal collector', () => {
  it('resolves a compiled per-account credential binding', () => {
    const encoded = btoa(
      JSON.stringify({
        client_email: 'signals@example.test',
        private_key: 'test-private-key',
      }),
    );
    const targets = parseGoogleTargets(
      JSON.stringify({
        'portfolio-signals': {
          service_account_binding: 'GOOGLE_SERVICE_ACCOUNT_PORTFOLIO_SIGNALS',
          properties: {
            'fees.example': {
              ga4_property_id: '789',
              gsc_site_url: 'sc-domain:fees.example',
            },
          },
        },
      }),
      (binding) =>
        binding === 'GOOGLE_SERVICE_ACCOUNT_PORTFOLIO_SIGNALS' ? encoded : undefined,
    );

    expect(targets.map(({ account, asset, integration, propertyRef }) => ({
      account,
      asset,
      integration,
      propertyRef,
    }))).toEqual([
      {
        account: 'portfolio-signals',
        asset: 'fees.example',
        integration: 'ga4',
        propertyRef: '789',
      },
      {
        account: 'portfolio-signals',
        asset: 'fees.example',
        integration: 'gsc',
        propertyRef: 'sc-domain:fees.example',
      },
    ]);
  });

  it('reuses one scoped token per account and stores normalized daily snapshots', async () => {
    const { fetchImpl, calls } = googleFetch();
    const result = await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    expect(result).toMatchObject({
      attempted: GOOGLE_ATTEMPTS,
      succeeded: GOOGLE_ATTEMPTS,
      failed: 0,
    });
    // One token per account per SCOPE — two properties on one account still
    // mint two, which is the point of the account-centric credential map.
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    expect(calls.some((call) => call.body.includes('assertion='))).toBe(true);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(GOOGLE_ATTEMPTS);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_observations`)).toBe(
      GOOGLE_PROPERTIES.length * (GA4_OBSERVATIONS + GSC_OBSERVATIONS),
    );

    // Every configured property collected, not just the first one.
    const collected = await env.STORE.read((tx) =>
      tx.query<{ asset: string; integration: string; propertyRef: string }>(
        `SELECT asset_id AS asset, integration, property_ref AS "propertyRef" FROM noticeos.signal_runs
          ORDER BY asset_id COLLATE "C", integration COLLATE "C"`,
      ),
    );
    expect(collected).toEqual([
      { asset: 'meals.example', integration: 'ga4', propertyRef: '123456' },
      { asset: 'meals.example', integration: 'gsc', propertyRef: 'sc-domain:meals.example' },
      { asset: 'nosh.example', integration: 'ga4', propertyRef: '654321' },
      { asset: 'nosh.example', integration: 'gsc', propertyRef: 'sc-domain:nosh.example' },
    ]);

    const [ga4] = await env.STORE.read((tx) =>
      tx.query<{
        credentialRef: string;
        propertyRef: string;
        windowStart: string;
        windowEnd: string;
        dataState: string;
        provisionalFrom: string | null;
        providerRows: number;
        observationCount: number;
      }>(
        `SELECT credential_ref AS "credentialRef", property_ref AS "propertyRef",
                window_start AS "windowStart", window_end AS "windowEnd",
                data_state AS "dataState", provisional_from AS "provisionalFrom",
                provider_rows AS "providerRows", observation_count AS "observationCount"
           FROM noticeos.signal_runs WHERE integration = 'ga4' AND asset_id = 'meals.example'`,
      ),
    );
    expect(ga4).toEqual({
      credentialRef: 'test-signals',
      propertyRef: '123456',
      windowStart: '2026-04-24',
      windowEnd: '2026-07-29',
      dataState: 'includes-provisional',
      // Yesterday too: GA4 has not finished attributing it.
      provisionalFrom: '2026-07-28',
      providerRows: 2,
      observationCount: GA4_OBSERVATIONS,
    });
    const [gsc] = await env.STORE.read((tx) =>
      tx.query<{ dataState: string; provisionalFrom: string | null }>(
        `SELECT data_state AS "dataState", provisional_from AS "provisionalFrom"
           FROM noticeos.signal_runs WHERE integration = 'gsc' AND asset_id = 'meals.example'`,
      ),
    );
    expect(gsc).toEqual({
      dataState: 'includes-provisional',
      provisionalFrom: '2026-07-25',
    });

    const activeUsers = await env.STORE.read((tx) =>
      tx.query<{ asset: string; date: string; value: number }>(
        `SELECT s.asset_id AS asset, o.observed_date AS date, o.value
           FROM noticeos.signal_observations o
           JOIN noticeos.measurement_series s ON s.workspace_id = o.workspace_id AND s.series_id = o.series_id
          WHERE s.integration = 'ga4' AND s.metric = 'active_users' AND o.value > 0
          ORDER BY s.asset_id COLLATE "C", o.observed_date`,
      ),
    );
    expect(activeUsers).toEqual([
      { asset: 'meals.example', date: '2026-07-26', value: 14 },
      { asset: 'meals.example', date: '2026-07-27', value: 16 },
      { asset: 'nosh.example', date: '2026-07-26', value: 14 },
      { asset: 'nosh.example', date: '2026-07-27', value: 16 },
    ]);

    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(GOOGLE_ATTEMPTS * 2);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_observations`)).toBe(
      GOOGLE_PROPERTIES.length * (GA4_OBSERVATIONS + GSC_OBSERVATIONS),
    );
  });

  it('keeps a GA4 day provisional until it has been collected two days after it', async () => {
    // A day collected at D+1 can still carry a large share of its sessions as
    // "Unassigned" that a D+2 read attributes correctly. So yesterday is
    // provisional too, and the trend the panel publishes says so.
    const { fetchImpl } = googleFetch();
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    const trend = await readPanelTrend(env, 'meals.example', '2026-07-26');
    const provisional = (date: string): number[] =>
      trend
        .filter((row) => row.integration === 'ga4' && row.date === date)
        .map((row) => row.provisional);
    // NOW is 2026-07-29 in the property's zone: today and yesterday are still
    // being processed, the day before yesterday has had its two days.
    expect(provisional('2026-07-29')).toEqual([1, 1, 1, 1]);
    expect(provisional('2026-07-28')).toEqual([1, 1, 1, 1]);
    expect(provisional('2026-07-27')).toEqual([0, 0, 0, 0]);
    // Search Console keeps its own, provider-stated boundary.
    expect(
      trend.filter((row) => row.integration === 'gsc' && row.date === '2026-07-26').map((row) => row.provisional),
    ).toEqual([1, 1, 1, 1]);
  });

  it('treats today as provisional when GSC omits incomplete-date metadata', async () => {
    const { fetchImpl } = googleFetch({ gscIncompleteDate: null });
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });
    const [gsc] = await env.STORE.read((tx) =>
      tx.query<{ dataState: string; provisionalFrom: string | null }>(
        `SELECT data_state AS "dataState", provisional_from AS "provisionalFrom"
           FROM noticeos.signal_runs WHERE integration = 'gsc' AND asset_id = 'meals.example'`,
      ),
    );
    expect(gsc).toEqual({
      dataState: 'includes-provisional',
      provisionalFrom: '2026-07-29',
    });
  });

  it('uses provider reporting days before UTC rolls into a nonexistent tomorrow', async () => {
    const { fetchImpl } = googleFetch({ gscIncompleteDate: null });
    const lateAfternoonPacific = Date.parse('2026-07-30T00:30:00.000Z');
    await runGoogleSignals(env, { nowMs: lateAfternoonPacific, fetchImpl });
    const runs = await env.STORE.read((tx) =>
      tx.query<{
        integration: string;
        windowStart: string;
        windowEnd: string;
        provisionalFrom: string | null;
      }>(
        `SELECT DISTINCT integration COLLATE "C" AS integration, window_start AS "windowStart",
                window_end AS "windowEnd", provisional_from AS "provisionalFrom"
           FROM noticeos.signal_runs
          ORDER BY 1`,
      ),
    );
    // DISTINCT: the window is a property of the clock, so every property's run
    // must land on the same one — two rows here would be two different days.
    expect(runs).toEqual([
      {
        integration: 'ga4',
        windowStart: '2026-04-24',
        windowEnd: '2026-07-29',
        provisionalFrom: '2026-07-28',
      },
      {
        integration: 'gsc',
        windowStart: '2026-04-24',
        windowEnd: '2026-07-29',
        provisionalFrom: '2026-07-29',
      },
    ]);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(GOOGLE_ATTEMPTS);
  });

  it('records one provider failure without blocking the other signal lane', async () => {
    const { fetchImpl } = googleFetch({ ga4Status: 403 });
    const result = await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    // The GA4 lane fails for BOTH properties and the GSC lane survives for
    // both: isolation is per (property, integration), not per integration.
    expect(result).toMatchObject({
      attempted: GOOGLE_ATTEMPTS,
      succeeded: GOOGLE_PROPERTIES.length,
      failed: GOOGLE_PROPERTIES.length,
    });
    const runs = await env.STORE.read((tx) =>
      tx.query<{
        asset: string;
        integration: string;
        status: string;
        errorCode: string | null;
        errorMessage: string | null;
        observationCount: number;
      }>(
        `SELECT asset_id AS asset, integration, status, error_code AS "errorCode",
                error_message AS "errorMessage", observation_count AS "observationCount"
           FROM noticeos.signal_runs ORDER BY asset_id COLLATE "C", integration COLLATE "C"`,
      ),
    );
    expect(runs).toEqual(
      GOOGLE_PROPERTIES.flatMap((asset) => [
        {
          asset,
          integration: 'ga4',
          status: 'error',
          errorCode: 'ga4_http_403',
          errorMessage: 'GA4 property access denied',
          observationCount: 0,
        },
        {
          asset,
          integration: 'gsc',
          status: 'success',
          errorCode: null,
          errorMessage: null,
          observationCount: GSC_OBSERVATIONS,
        },
      ]),
    );
  });

  // The card's verdict on a run where every property failed is what went wrong
  // in a site row's words, then the count — never the code each property's own
  // run keeps.
  it('tells the card what failed and for how many properties, without a code', async () => {
    await putCredential(env, {
      provider: 'google',
      fields: { GOOGLE_SIGNAL_ACCOUNTS: env.GOOGLE_SIGNAL_ACCOUNTS! },
    });
    const { fetchImpl } = googleFetch({ ga4Status: 403, gscStatus: 403 });
    const result = await runGoogleSignals(env, { nowMs: NOW, fetchImpl });
    expect(result).toMatchObject({ attempted: GOOGLE_ATTEMPTS, succeeded: 0, failed: GOOGLE_ATTEMPTS });

    const stamped = await credentialVerdict('google');
    expect(stamped?.lastError).toBe(`Access was refused · ${GOOGLE_ATTEMPTS} of ${GOOGLE_ATTEMPTS} properties`);
  });

  describe('when the OS is what is down', () => {
    /** Everything a dead night may leave behind, in one read. */
    async function residue(): Promise<{ runs: number; health: number; egressFlags: number }> {
      return {
        runs: await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`),
        health: (await storedHealthStates()).length,
        egressFlags: await openEgressFlags(),
      };
    }

    it('accuses no property when the token mint never reached Google', async () => {
      const result = await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(googleFetch().fetchImpl),
      });

      // The collections did not happen, so they still count as failed — but
      // nobody is blamed: no `request_failed` row, no degraded Health cell.
      expect(result).toMatchObject({
        attempted: GOOGLE_ATTEMPTS,
        succeeded: 0,
        failed: GOOGLE_ATTEMPTS,
      });
      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject({
          status: 'error',
          egressDown: true,
          errorCode: EGRESS_DOWN_CODE,
        });
      }
      expect(await residue()).toEqual({ runs: 0, health: 0, egressFlags: 1 });
      // One question for the whole run, one fact on the OS row.
      expect(result.egress).toMatchObject({
        up: false,
        probes: 1,
        fired: 1,
        unmeasuredAssets: [...GOOGLE_PROPERTIES],
      });
    });

    it('holds the same line when the uplink dies after the token was minted', async () => {
      const result = await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(googleFetch().fetchImpl, { through: (url) => url === TOKEN_URL }),
      });

      expect(result).toMatchObject({ succeeded: 0, failed: GOOGLE_ATTEMPTS });
      expect(result.outcomes.every((outcome) => outcome.egressDown === true)).toBe(true);
      expect(await residue()).toEqual({ runs: 0, health: 0, egressFlags: 1 });
    });

    it('still blames Google when the OS can reach the world', async () => {
      // The regression guard: a provider that never answers while the beacons
      // do is the provider's failure, recorded exactly as before.
      const result = await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(googleFetch().fetchImpl, {
          beaconUp: true,
          through: (url) => url === TOKEN_URL,
        }),
      });

      expect(result).toMatchObject({ succeeded: 0, failed: GOOGLE_ATTEMPTS });
      expect(result.outcomes.some((outcome) => outcome.egressDown)).toBe(false);
      expect(
        await storedCount(
          `SELECT count(*)::int AS n FROM noticeos.signal_runs
            WHERE status = 'error' AND error_code = 'request_failed' AND error_message = $1`,
          [WORKERD_TRANSPORT_ERROR],
        ),
      ).toBe(GOOGLE_ATTEMPTS);
      expect(result.egress).toMatchObject({ up: true, probes: 1, fired: 0 });
      expect(await openEgressFlags()).toBe(0);
    });

    it('asks nothing on a healthy run', async () => {
      const result = await runGoogleSignals(env, { nowMs: NOW, fetchImpl: googleFetch().fetchImpl });
      expect(result.egress).toMatchObject({ checked: false, probes: 0 });
      expect(await storedEgressChecks()).toBe(0);
    });
  });

  describe('GA4 quota', () => {
    async function quotaFlag(): Promise<{ message: string; ruleInputs: string } | null> {
      const [row] = await pgRows<{ message: string; ruleInputs: string }>(
        `SELECT message, rule_inputs::text AS "ruleInputs" FROM noticeos.current_flags
          WHERE rule_id = 'ga4-quota-pressure' AND resolved_at IS NULL LIMIT 1`,
      );
      return row ?? null;
    }

    it('asks what the 96-runs-a-day lane costs', async () => {
      const { fetchImpl, calls } = googleFetch({ ga4Quota: { consumed: 100, remaining: 199_900 } });
      await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

      const ga4 = calls.filter((call) => call.url.includes('analyticsdata.googleapis.com'));
      expect(ga4).toHaveLength(GOOGLE_PROPERTIES.length);
      for (const call of ga4) {
        expect(JSON.parse(call.body) as { returnPropertyQuota?: boolean }).toMatchObject({
          returnPropertyQuota: true,
        });
      }
      expect(await quotaFlag()).toBeNull();
    });

    it('flags a thin budget on the property spending it, then retracts when it refills', async () => {
      await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: googleFetch({ ga4Quota: { consumed: 190_000, remaining: 10_000 } }).fetchImpl,
      });

      // The budget is per property, so the flag is too — one on each, not one
      // portfolio-wide alert standing in for whichever property was read first.
      const flagged = await pgRows<{ asset: string }>(
        `SELECT asset_id AS asset FROM noticeos.current_flags WHERE rule_id = 'ga4-quota-pressure' ORDER BY asset_id COLLATE "C"`,
      );
      expect(flagged.map((row) => row.asset)).toEqual([...GOOGLE_PROPERTIES]);

      const flag = await quotaFlag();
      // A headline with its value; the tokens and the lane are the inputs.
      expect(flag!.message).toMatch(/^GA4 daily quota at 5% for /);
      expect(JSON.parse(flag!.ruleInputs) as Record<string, unknown>).toMatchObject({
        lane: 'google-signals',
        tokensPerDay: { consumed: 190_000, remaining: 10_000 },
      });

      await runGoogleSignals(env, {
        nowMs: NOW + 900_000,
        fetchImpl: googleFetch({ ga4Quota: { consumed: 100, remaining: 199_900 } }).fetchImpl,
      });
      expect(await quotaFlag()).toBeNull();
    });

    it('tells an exhausted budget apart from an ordinary rate limit', async () => {
      const errorCode = async (): Promise<string | null> =>
        (
          await env.STORE.read((tx) =>
            tx.query<{ errorCode: string }>(
              `SELECT error_code AS "errorCode" FROM noticeos.signal_runs
                WHERE integration = 'ga4' AND status = 'error'
                ORDER BY finished_at DESC, run_seq LIMIT 1`,
            ),
          )
        )[0]?.errorCode ?? null;

      await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: googleFetch({
          ga4Status: 429,
          ga4Error: { code: 429, message: 'Too many concurrent requests.' },
        }).fetchImpl,
      });
      expect(await errorCode()).toBe('ga4_http_429');

      await runGoogleSignals(env, {
        nowMs: NOW,
        fetchImpl: googleFetch({
          ga4Status: 429,
          ga4Error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'Exhausted property tokens for today.',
          },
        }).fetchImpl,
      });
      expect(await errorCode()).toBe('ga4_quota_exhausted');
    });
  });
});

// Two ways in, one collector. Nothing below the auth layer knows which kind it
// holds: the same parse produces a target either way, and the same 401
// recovery runs for both.
describe('authenticating a pull', () => {
  const ACCOUNTS = JSON.stringify({
    'test-signals': {
      properties: {
        'meals.example': { ga4_property_id: '123456', gsc_site_url: 'sc-domain:meals.example' },
      },
    },
  });
  const GRANT = {
    clientId: '123-abc.apps.googleusercontent.com',
    clientSecret: 'SEKRIT-client',
    refreshToken: 'SEKRIT-refresh',
    account: 'ops@example.test',
    scopes: [],
  };

  it('authenticates a map entry with no key using the sign-in', () => {
    const targets = parseGoogleTargets(ACCOUNTS, undefined, 'store', GRANT);
    expect(targets).toHaveLength(2);
    for (const target of targets) {
      expect(target.auth.kind).toBe('oauth');
      if (target.auth.kind !== 'oauth') throw new Error('unreachable');
      expect(target.auth.grant.account).toBe('ops@example.test');
    }
  });

  it('still refuses a map entry with no key and no sign-in, in the old words', () => {
    // An install on service accounts must not start reading "sign in" at its
    // config errors.
    expect(() => parseGoogleTargets(ACCOUNTS)).toThrowError(/service_account_b64/);
  });

  it('prefers the entry OWN key over the sign-in, so a map keeps working', () => {
    const encoded = btoa(
      JSON.stringify({
        client_email: 'signals@example.test',
        private_key: 'test-private-key',
      }),
    );
    const targets = parseGoogleTargets(
      JSON.stringify({
        'test-signals': {
          service_account_b64: encoded,
          properties: { 'meals.example': { ga4_property_id: '123456' } },
        },
      }),
      undefined,
      'store',
      GRANT,
    );
    expect(targets[0]!.auth.kind).toBe('service-account');
  });

  it('gets a fresh token and retries ONCE when a provider answers 401', async () => {
    // A pull over a large portfolio can outlive an hour-long token. One retry
    // fixes that; a second would turn a broken credential into a burst of
    // requests against Google. The refreshed token is then SHARED by the rest
    // of the account's properties rather than minted again for each.
    let ga4Calls = 0;
    const tokens: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === TOKEN_URL) {
        const token = `test-access-token-${tokens.length + 1}`;
        tokens.push(token);
        return Response.json({ access_token: token, expires_in: 3600 });
      }
      if (url.includes('analyticsdata.googleapis.com')) {
        ga4Calls += 1;
        // The FIRST minted token is refused; anything minted after that
        // refusal is served.
        if (new Headers(init?.headers).get('authorization') === 'Bearer test-access-token-1') {
          return Response.json({ error: { message: 'Invalid Credentials' } }, { status: 401 });
        }
        return Response.json({
          dimensionHeaders: [{ name: 'date' }],
          metricHeaders: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'screenPageViews' },
            { name: 'eventCount' },
          ],
          rows: [],
          metadata: { timeZone: 'America/Los_Angeles' },
        });
      }
      // Search Console answers plainly; this test is about the GA4 lane.
      return Response.json({ rows: [] });
    }) as typeof fetch;

    const result = await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    expect(result.failed).toBe(0);
    expect(result.attempted).toBe(GOOGLE_ATTEMPTS);
    // THREE GA4 calls across two properties: a refusal, its retry, and the
    // second property served straight off the token the retry earned.
    expect(ga4Calls).toBe(3);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });
});

// The day boundary a GA4 property is read in when its config entry names none.
// A literal zone in the Worker source would be a fact about one portfolio that
// a self-hoster in another zone could only change by editing TypeScript, and
// whose only symptom is rows landing on the wrong day.
describe('GA4 fallback reporting timezone', () => {
  /** The shipped fixture states no `time_zone` for either property, which is
   * exactly the case this fallback exists for. */
  function targets(timeZone?: string) {
    return parseGoogleTargets(
      JSON.stringify({
        'test-signals': {
          service_account_b64: btoa(
            JSON.stringify({
              client_email: 'signals@example.test',
              private_key: 'test-private-key',
            }),
          ),
          properties: {
            'meals.example': {
              ga4_property_id: '123456',
              gsc_site_url: 'sc-domain:meals.example',
              ...(timeZone === undefined ? {} : { time_zone: timeZone }),
            },
          },
        },
      }),
    );
  }

  it('falls back to the configured OS clock, not a literal', () => {
    const ga4 = targets().find((target) => target.integration === 'ga4')!;
    // The equality is the point: it holds only while the fallback is
    // OS_TIME_ZONE. Asserting a literal zone would break the day an operator
    // changes config/constants.json — the one case that has to keep working.
    expect(ga4.timeZone).toBe(OS_TIME_ZONE);
    expect(ga4.timeZoneAssumed).toBe(true);
  });

  it('never overrides a zone the config actually states', () => {
    const ga4 = targets('Europe/Warsaw').find((target) => target.integration === 'ga4')!;
    expect(ga4.timeZone).toBe('Europe/Warsaw');
    // Stated, so nothing was assumed and nothing is announced.
    expect(ga4.timeZoneAssumed).toBe(false);
    expect(assumedTimeZoneEvent(targets('Europe/Warsaw'))).toBeNull();
  });

  it('buckets a property that states no zone by the configured clock', async () => {
    const { fetchImpl, calls } = googleFetch();
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    const ga4Call = calls.find((call) => call.url.includes('analyticsdata.googleapis.com'))!;
    const range = (
      JSON.parse(ga4Call.body) as { dateRanges: { startDate: string; endDate: string }[] }
    ).dateRanges[0]!;
    // "Today" in the configured zone, computed the same way the collector does
    // rather than written down — so this stays true if the operator moves the
    // OS clock, which is the change the fallback was made configurable for.
    expect(range.endDate).toBe(dateInTimeZone(NOW, OS_TIME_ZONE));
  });

  it('announces the assumption once per pull, naming the zone and properties', () => {
    // Built apart from the printing because a test inside workerd cannot see the
    // lane's own console. GSC is excluded — its boundary is Google's documented
    // PT and was never a guess.
    expect(assumedTimeZoneEvent(targets())).toEqual({
      event: 'ga4_time_zone_assumed',
      timeZone: OS_TIME_ZONE,
      assets: ['meals.example'],
    });
  });

  it('assumes the zone saved in Settings over the compiled one, and says which', async () => {
    // What dispatch.ts hands the lane from the config store on a cron fire.
    const saved = parseGoogleTargets(
      JSON.stringify({
        'test-signals': {
          service_account_b64: btoa(JSON.stringify({ client_email: 'signals@example.test', private_key: 'test-private-key' })),
          properties: { 'meals.example': { ga4_property_id: '123456', gsc_site_url: 'sc-domain:meals.example' } },
        },
      }),
      undefined, 'env', null, undefined, 'Pacific/Kiritimati',
    );
    expect(saved.find((target) => target.integration === 'ga4')).toMatchObject({ timeZone: 'Pacific/Kiritimati', timeZoneAssumed: true });
    expect(assumedTimeZoneEvent(saved)).toEqual({
      event: 'ga4_time_zone_assumed',
      timeZone: 'Pacific/Kiritimati',
      assets: ['meals.example'],
    });

    const { fetchImpl, calls } = googleFetch();
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl, osTimeZone: 'Pacific/Kiritimati' });
    const ga4Call = calls.find((call) => call.url.includes('analyticsdata.googleapis.com'))!;
    const range = (JSON.parse(ga4Call.body) as { dateRanges: { endDate: string }[] }).dateRanges[0]!;
    expect(range.endDate).toBe(dateInTimeZone(NOW, 'Pacific/Kiritimati'));
  });
});

// A moved day boundary is a change to one provider resource. Repointing the
// asset at a different GA4 property that happens to report in another zone is
// a new series, not a timezone change, and must file nothing.
describe('GA4 reporting-timezone change detection', () => {
  const PT = 'America/Los_Angeles';
  const ET = 'America/New_York';

  /** An earlier successful meals.example GA4 run on `propertyRef`, in `timeZone`. */
  async function priorGa4Run(propertyRef: string, timeZone: string): Promise<void> {
    await storeSignalRun({
      id: crypto.randomUUID(),
      asset: 'meals.example',
      integration: 'ga4',
      credential_ref: 'test-signals',
      property_ref: propertyRef,
      finished_at: '2026-07-28T12:00:00.000Z',
      window_start: '2026-07-01',
      window_end: '2026-07-28',
      provider_rows: 0,
      time_zone: timeZone,
    });
  }

  async function timeZoneAnnotations(): Promise<
    { asset: string; day: string; kind: string; ref: string }[]
  > {
    return pgRows<{ asset: string; day: string; kind: string; ref: string }>(
      `SELECT asset_id AS asset, (at AT TIME ZONE 'UTC')::date AS day, kind, ref FROM noticeos.annotations
        WHERE ref LIKE 'reporting-time-zone-changed:%' ORDER BY asset_id COLLATE "C"`,
    );
  }

  it('files a change when the same property reports a new zone', async () => {
    // '123456' is the property vitest.config.ts maps meals.example's GA4 onto.
    await priorGa4Run('123456', PT);
    const { fetchImpl } = googleFetch({ ga4TimeZone: ET });
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    // nosh.example has no earlier run, so its first zone is a baseline, not a change.
    expect(await timeZoneAnnotations()).toEqual([
      {
        asset: 'meals.example',
        day: dateInTimeZone(NOW, OS_TIME_ZONE),
        kind: 'config',
        ref: `reporting-time-zone-changed:ga4:${PT}->${ET}`,
      },
    ]);
  });

  it('files nothing when the asset was repointed at a property in another zone', async () => {
    await priorGa4Run('999999', PT);
    const { fetchImpl } = googleFetch({ ga4TimeZone: ET });
    await runGoogleSignals(env, { nowMs: NOW, fetchImpl });

    expect(await timeZoneAnnotations()).toEqual([]);
    // The new property's own first run still records the zone it reported.
    const [current] = await env.STORE.read((tx) =>
      tx.query<{ timeZone: string }>(
        `SELECT time_zone AS "timeZone" FROM noticeos.signal_runs
          WHERE asset_id = 'meals.example' AND integration = 'ga4' AND property_ref = '123456'`,
      ),
    );
    expect(current?.timeZone).toBe(ET);
  });
});
