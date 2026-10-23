import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { EGRESS_BEACONS, EGRESS_DOWN_CODE } from '../src/egress.js';
import {
  ARCHIVE_RUNS,
  WORKERD_TRANSPORT_ERROR,
  cutUplink,
  openEgressFlags,
  pgCount,
  pgFirst,
  storedHealthStates,
} from './helpers.js';
import {
  NOW,
  PANEL_ASSETS,
  LAUNCHED_ASSETS,
  DOMAIN_ATTEMPTS,
  EXPECTED_ATTEMPTS,
  SERP_PATH,
  FAST_RETRY,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('DataForSEO weekly archives', () => {
  /** A family's manifest row is written only after its last request returns,
   * so a runtime restart mid-panel loses that family; everything that had no
   * reason to wait on it must already be collected. */
  describe('a family the property is due is never silently skipped', () => {
    it('collects every property’s single-call families before any long one', async () => {
      const { fetchImpl, calls } = providerFetch();
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
      });

      const firstPanelCall = calls.findIndex((call) =>
        call.url.endsWith(SERP_PATH),
      );
      // Every domain family in the portfolio is already collected by the time
      // the first tracked-query call goes out.
      expect(firstPanelCall).toBe(DOMAIN_ATTEMPTS);
      expect(
        calls.slice(firstPanelCall).every((call) => call.url.endsWith(SERP_PATH)),
      ).toBe(true);
    });

    it('writes an attempt row for every due family when the provider is wholly down', async () => {
      // Nothing answers. Not one family may end the run without a row: an
      // absent row is indistinguishable from a property that owes nothing.
      const fetchImpl = (async (): Promise<Response> =>
        Response.json(
          { status_code: 50000, status_message: 'Internal Error.', cost: 0, tasks: [] },
          { status: 500 },
        )) as typeof fetch;
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: 0,
        failed: EXPECTED_ATTEMPTS,
      });
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`,
        ),
      ).toBe(EXPECTED_ATTEMPTS);
      // Including the panel: a property that owes one has an error row, not a
      // gap the lane would have to guess about.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND report = 'serp-panel'
              AND status = 'error'`,
        ),
      ).toBe(PANEL_ASSETS.length);
    });
  });

  describe('when the OS is what is down', () => {
    const isBeacon = (url: string): boolean =>
      (EGRESS_BEACONS as readonly string[]).includes(url);

    /** A fetcher that records every URL it is handed, then applies the cut. */
    function recorded(fetchImpl: typeof fetch): { fetchImpl: typeof fetch; urls: string[] } {
      const urls: string[] = [];
      return {
        urls,
        fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
          urls.push(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          return fetchImpl(input, init);
        }) as typeof fetch,
      };
    }

    it('spends no retry, stores no "Gave up", and leaves every family due', async () => {
      const dead = recorded(cutUplink(providerFetch().fetchImpl));
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl: dead.fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      // ONE call per family and not one more: the gate answered before the
      // ladder could be climbed.
      expect(dead.urls.filter((url) => !isBeacon(url))).toHaveLength(EXPECTED_ATTEMPTS);
      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: 0,
        failed: EXPECTED_ATTEMPTS,
        costUsd: 0,
      });
      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject({ egressDown: true, errorCode: EGRESS_DOWN_CODE, retries: 0 });
      }
      // No manifest at all — so no "Gave up after", no provider-blaming cell,
      // and nothing that could satisfy a cadence.
      expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
      expect(await storedHealthStates()).toEqual([]);
      expect(result.egress).toMatchObject({ up: false, probes: 1, fired: 1 });
      expect(result.egress?.unmeasuredAssets).toHaveLength(LAUNCHED_ASSETS);
      expect(await openEgressFlags()).toBe(1);

      // The next run that gets through owes — and collects — every family.
      const back = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerFetch().fetchImpl, { beaconUp: true, through: () => true }),
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });
      expect(back).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: EXPECTED_ATTEMPTS,
        failed: 0,
      });
      expect(await openEgressFlags()).toBe(0);
    });

    it('still walks the ladder when only DataForSEO is dark', async () => {
      // The regression guard: beacons answer, so a provider that never does is
      // the provider's transient failure, repeated and disclosed as before.
      const live = recorded(cutUplink(providerFetch().fetchImpl, { beaconUp: true }));
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl: live.fetchImpl,
        scope: { asset: 'meadow.example', families: ['backlinks-summary'] },
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(
        live.urls.filter((url) => url.endsWith('/backlinks/summary/live')),
      ).toHaveLength(3);
      expect(result.outcomes[0]).toMatchObject({
        status: 'error',
        errorCode: 'request_failed',
        retries: 2,
      });
      expect(result.outcomes[0]?.egressDown).toBeUndefined();
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE report = 'backlinks-summary' AND status = 'error'`);
      expect(stored?.errorMessage).toBe(`${WORKERD_TRANSPORT_ERROR} Gave up after 3 attempts.`);
      expect(result.egress).toMatchObject({ up: true, fired: 0 });
      expect(await openEgressFlags()).toBe(0);
    });

    it('still counts what a panel already paid for when the uplink dies mid-panel', async () => {
      // Two paid result pages land, then the uplink goes. The money was spent,
      // so it must reach the monthly meter — in a row that says whose failure
      // this was and never touches the provider's Health cell.
      let panelCalls = 0;
      const midPanel = cutUplink(providerFetch().fetchImpl, {
        through: (url) => url.endsWith(SERP_PATH) && ++panelCalls <= 2,
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl: midPanel,
        scope: { asset: 'meadow.example', families: ['serp-panel'] },
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(result.outcomes[0]).toMatchObject({
        status: 'error',
        egressDown: true,
        errorCode: EGRESS_DOWN_CODE,
        retries: 0,
      });
      expect(result.costUsd).toBeCloseTo(2 * 0.004, 6);
      const row = await pgFirst<{ errorCode: string; errorMessage: string; costUsd: number }>(`SELECT error_code AS "errorCode", error_message AS "errorMessage",
                provider_cost_usd AS "costUsd"
           FROM ${ARCHIVE_RUNS} WHERE report = 'serp-panel'`);
      expect(row?.errorCode).toBe(EGRESS_DOWN_CODE);
      expect(row?.costUsd).toBeCloseTo(2 * 0.004, 6);
      expect(row?.errorMessage).not.toContain('Gave up');
      expect(row?.errorMessage).not.toContain(WORKERD_TRANSPORT_ERROR);
      expect(await storedHealthStates()).toEqual([]);
      expect(await openEgressFlags()).toBe(1);
    });
  });
});
