import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runBingSignals } from '../src/bing-signals.js';
import { EGRESS_DOWN_CODE } from '../src/egress.js';
import { WORKERD_TRANSPORT_ERROR, cutUplink, openEgressFlags, reset, storedCount, storedHealthStates } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
/** The verified-site list Bing answers with, mirroring the seeded portfolio.
 * Every non-retired property is verified here, so the collector attempts six
 * and succeeds six — a site missing from this list would be a failure, not a
 * smaller run. */
const PORTFOLIO_SITES = [
  'https://meals.example/',
  'https://nosh.example/',
  'https://pacer.example/',
  'https://pullups.example/',
  'https://areas.example/',
  'https://fees.example/',
];

function bingDate(date: string): string {
  return `/Date(${Date.parse(`${date}T00:00:00.000Z`)})/`;
}

function bingFetch({
  sites = PORTFOLIO_SITES,
  failingHost = null,
  sitesStatus = 200,
}: {
  sites?: string[];
  failingHost?: string | null;
  sitesStatus?: number;
} = {}): { fetchImpl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    calls.push(url);
    expect(url.searchParams.get('apikey')).toBe('test-bing-key');
    if (url.pathname.endsWith('/GetUserSites')) {
      return sitesStatus === 200
        ? Response.json({
            d: [
              ...sites.map((Url) => ({ Url })),
              { Url: 'https://unmanaged.example/' },
            ],
          })
        : Response.json({ Message: 'Invalid API key' }, { status: sitesStatus });
    }
    if (url.pathname.endsWith('/GetRankAndTrafficStats')) {
      const host = new URL(url.searchParams.get('siteUrl')!).hostname;
      if (host === failingHost) {
        return Response.json({ Message: 'Site access denied' }, { status: 403 });
      }
      return Response.json({
        d: [
          {
            Date: bingDate('2026-07-26'),
            Clicks: 12,
            Impressions: 280,
          },
          {
            Date: bingDate('2026-07-27'),
            Clicks: 19,
            Impressions: 410,
          },
          {
            Date: bingDate('2026-05-15'),
            Clicks: 999,
            Impressions: 999,
          },
          {
            Date: bingDate('2026-04-01'),
            Clicks: 777,
            Impressions: 777,
          },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(reset);

describe('Bing Webmaster signal collector', () => {
  it('discovers verified non-retired assets, including pre-launch, and stores only Bing-reported dates', async () => {
    const { fetchImpl, calls } = bingFetch();
    const result = await runBingSignals(env, { nowMs: NOW, fetchImpl });

    expect(result).toMatchObject({ attempted: 6, succeeded: 6, failed: 0 });
    expect(calls.filter((url) => url.pathname.endsWith('/GetUserSites'))).toHaveLength(1);
    expect(calls.filter((url) => url.pathname.endsWith('/GetRankAndTrafficStats'))).toHaveLength(6);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(6);
    // Three Bing-reported dates × two metrics, per property.
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_observations`)).toBe(36);
    expect(
      await storedCount(
        `SELECT count(*)::int AS n
           FROM noticeos.signal_observations o
           JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
          WHERE r.integration = 'bing-webmaster' AND o.observed_date > '2026-07-27'`,
      ),
    ).toBe(0);
    expect(
      await storedCount(
        `SELECT count(*)::int AS n
           FROM noticeos.signal_observations o
           JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
          WHERE r.integration = 'bing-webmaster'
            AND o.observed_date NOT IN ('2026-05-15','2026-07-26','2026-07-27')`,
      ),
    ).toBe(0);

    const runs = await env.STORE.read((tx) =>
      tx.query<{
        asset: string;
        credentialRef: string;
        propertyRef: string;
        windowStart: string;
        windowEnd: string;
        dataState: string;
        provisionalFrom: string | null;
      }>(
        `SELECT asset_id AS asset, credential_ref AS "credentialRef",
                property_ref AS "propertyRef", window_start AS "windowStart",
                window_end AS "windowEnd", data_state AS "dataState",
                provisional_from AS "provisionalFrom"
           FROM noticeos.signal_runs ORDER BY asset_id COLLATE "C"`,
      ),
    );
    expect(runs).toEqual([
      {
        asset: 'areas.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://areas.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
      {
        asset: 'fees.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://fees.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
      {
        asset: 'meals.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://meals.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
      {
        asset: 'nosh.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://nosh.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
      {
        asset: 'pacer.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://pacer.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
      {
        asset: 'pullups.example',
        credentialRef: 'BING_WEBMASTER_API_KEY',
        propertyRef: 'https://pullups.example/',
        windowStart: '2026-05-15',
        windowEnd: '2026-07-27',
        dataState: 'final',
        provisionalFrom: null,
      },
    ]);

    await runBingSignals(env, { nowMs: NOW, fetchImpl });
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(12);
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_observations`)).toBe(36);
  });

  it('isolates one site failure and records it for header-state evidence', async () => {
    const { fetchImpl } = bingFetch({ failingHost: 'nosh.example' });
    const result = await runBingSignals(env, { nowMs: NOW, fetchImpl });

    expect(result).toMatchObject({ attempted: 6, succeeded: 5, failed: 1 });
    const [failed] = await env.STORE.read((tx) =>
      tx.query<{
        asset: string;
        status: string;
        errorCode: string;
        errorMessage: string;
      }>(
        `SELECT asset_id AS asset, status, error_code AS "errorCode",
                error_message AS "errorMessage"
           FROM noticeos.signal_runs WHERE status = 'error'`,
      ),
    );
    expect(failed).toEqual({
      asset: 'nosh.example',
      status: 'error',
      errorCode: 'bwt_http_403',
      errorMessage: 'Site access denied',
    });
  });

  describe('when the OS is what is down', () => {
    async function residue(): Promise<{ runs: number; health: number; egressFlags: number }> {
      return {
        runs: await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`),
        health: (await storedHealthStates()).length,
        egressFlags: await openEgressFlags(),
      };
    }

    it('turns one dead discovery call into one OS fact, not six accusations', async () => {
      const result = await runBingSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(bingFetch().fetchImpl),
      });

      expect(result).toMatchObject({ attempted: 6, succeeded: 0, failed: 6 });
      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject({ egressDown: true, errorCode: EGRESS_DOWN_CODE });
      }
      // No row at all — so no `request_failed`, and no `bwt_site_unverified`
      // from a discovery answer that never arrived.
      expect(await residue()).toEqual({ runs: 0, health: 0, egressFlags: 1 });
      expect(result.egress).toMatchObject({ up: false, probes: 1, fired: 1 });
      expect(result.egress.unmeasuredAssets).toHaveLength(6);
    });

    it('holds the same line when the uplink dies after discovery', async () => {
      const result = await runBingSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(bingFetch().fetchImpl, {
          through: (url) => new URL(url).pathname.endsWith('/GetUserSites'),
        }),
      });

      expect(result).toMatchObject({ attempted: 6, succeeded: 0, failed: 6 });
      expect(result.outcomes.every((outcome) => outcome.egressDown === true)).toBe(true);
      expect(await residue()).toEqual({ runs: 0, health: 0, egressFlags: 1 });
    });

    it('still records a Bing that never answers while the OS can reach the world', async () => {
      const result = await runBingSignals(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(bingFetch().fetchImpl, { beaconUp: true }),
      });

      expect(result).toMatchObject({ attempted: 6, failed: 6 });
      expect(result.outcomes.some((outcome) => outcome.egressDown)).toBe(false);
      expect(
        await storedCount(
          `SELECT count(*)::int AS n FROM noticeos.signal_runs
            WHERE status = 'error' AND error_code = 'request_failed' AND error_message = $1`,
          [WORKERD_TRANSPORT_ERROR],
        ),
      ).toBe(6);
      expect(result.egress).toMatchObject({ up: true, fired: 0 });
      expect(await openEgressFlags()).toBe(0);
    });

    it('never gates a real Bing refusal', async () => {
      const result = await runBingSignals(env, {
        nowMs: NOW,
        fetchImpl: bingFetch({ sitesStatus: 401 }).fetchImpl,
      });
      expect(result.egress).toMatchObject({ checked: false, probes: 0 });
      expect(
        await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs WHERE error_code = 'bwt_http_401'`),
      ).toBe(6);
    });
  });

  it('records a shared authentication failure against every eligible asset', async () => {
    const { fetchImpl } = bingFetch({ sitesStatus: 401 });
    const result = await runBingSignals(env, { nowMs: NOW, fetchImpl });

    expect(result).toMatchObject({ attempted: 6, succeeded: 0, failed: 6 });
    expect(
      await storedCount(
        `SELECT count(*)::int AS n FROM noticeos.signal_runs
          WHERE status = 'error' AND error_code = 'bwt_http_401'`,
      ),
    ).toBe(6);
  });
});
