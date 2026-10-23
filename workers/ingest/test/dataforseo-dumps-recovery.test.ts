import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDataForSeoDumps, runDataForSeoRecovery } from '../src/dataforseo-dumps.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { SIGNAL_DUMPS_CRON } from '../src/crons.js';
import { runCron } from '../src/dispatch.js';
import constantsFixture from './fixture-config/constants.json';
import { EGRESS_BEACONS, EgressGate } from '../src/egress.js';
import { ARCHIVE_RUNS, cutUplink, openEgressFlags, pgCount, emptyTables } from './helpers.js';
import {
  NOW,
  LAUNCHED_ASSETS,
  EXPECTED_ATTEMPTS,
  FAST_RETRY,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

/** A family the dead uplink swallowed stays due, but the sweep is weekly; the
 * daily pass re-runs exactly what the outage skipped and nothing a provider
 * refused. */
describe('the daily re-collection of what an offline Monday skipped', () => {
  /** Tuesday 12:15 UTC — the next daily archive tick after the Monday sweep. */
  const TUESDAY = NOW + 86_400_000 - 30 * 60_000;
  const WEDNESDAY = TUESDAY + 86_400_000;
  const BACKLINKS_SUMMARY = '/backlinks/summary/live';
  const CREDS = {
    login: 'operator-login',
    password: 'operator-password',
    retryBackoffMs: FAST_RETRY,
  };
  /** Every family but the one the provider refused on Monday. */
  const SKIPPED_BY_OUTAGE = EXPECTED_ATTEMPTS - LAUNCHED_ASSETS;
  const DFS_SUCCESS = `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
                        WHERE integration = 'dataforseo' AND status = 'success'`;
  const PROVIDER_REFUSED = `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
                             WHERE report = 'backlinks-summary' AND status = 'error'`;

  function urlOf(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  }

  /** Records every URL handed to `fetchImpl`, beacons included. */
  function recording(fetchImpl: typeof fetch): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    return {
      urls,
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(urlOf(input));
        return fetchImpl(input, init);
      }) as typeof fetch,
    };
  }

  const reportCalls = (urls: string[]): string[] =>
    urls.filter((url) => new URL(url).hostname === 'api.dataforseo.com');

  /**
   * Monday's sweep on a dead uplink — except that backlinks-summary reaches a
   * DataForSEO that answers 503. One outage, both kinds of failure: every other
   * family is unmeasured (no manifest, named on the offline alert), and
   * backlinks-summary is the provider's own error row.
   */
  async function offlineMonday(): Promise<void> {
    const monday = await runDataForSeoDumps(env, {
      nowMs: NOW,
      ...CREDS,
      fetchImpl: cutUplink(providerFetch({ failPath: BACKLINKS_SUMMARY }).fetchImpl, {
        through: (url) => url.endsWith(BACKLINKS_SUMMARY),
      }),
    });
    expect(monday.egress).toMatchObject({ up: false, fired: 1 });
    expect(await pgCount(PROVIDER_REFUSED)).toBe(LAUNCHED_ASSETS);
    expect(await pgCount(DFS_SUCCESS)).toBe(0);
  }

  const connectionBack = (): { fetchImpl: typeof fetch; urls: string[] } =>
    recording(cutUplink(providerFetch().fetchImpl, { beaconUp: true, through: () => true }));

  it('re-collects within a day only what the outage skipped, never what the provider refused', async () => {
    await offlineMonday();

    const back = connectionBack();
    const tuesday = await runDataForSeoRecovery(env, { nowMs: TUESDAY, ...CREDS, fetchImpl: back.fetchImpl });

    expect(tuesday).toMatchObject({
      attempted: SKIPPED_BY_OUTAGE,
      succeeded: SKIPPED_BY_OUTAGE,
      failed: 0,
    });
    // The provider's refusal is its own story: retrying a paid error every day
    // is exactly what this pass must never do.
    expect(reportCalls(back.urls).some((url) => url.endsWith(BACKLINKS_SUMMARY))).toBe(false);
    expect(await pgCount(PROVIDER_REFUSED)).toBe(LAUNCHED_ASSETS);
    expect(await pgCount(DFS_SUCCESS)).toBe(SKIPPED_BY_OUTAGE);
    // Nothing is owed any more, so the offline alert has nothing left to hold.
    expect(await openEgressFlags()).toBe(0);

    // Wednesday: nothing owed, nothing asked — not even a connectivity check.
    const idle = recording(providerFetch().fetchImpl);
    const wednesday = await runDataForSeoRecovery(env, { nowMs: WEDNESDAY, ...CREDS, fetchImpl: idle.fetchImpl });
    expect(wednesday).toMatchObject({ attempted: 0, costUsd: 0 });
    expect(idle.urls).toEqual([]);
  });

  it('keeps an outage that outlasts the daily pass owed rather than writing it off', async () => {
    await offlineMonday();

    const stillDown = await runDataForSeoRecovery(env, {
      nowMs: TUESDAY,
      ...CREDS,
      fetchImpl: cutUplink(providerFetch().fetchImpl),
    });
    expect(stillDown).toMatchObject({ succeeded: 0, costUsd: 0 });
    expect(stillDown.egress).toMatchObject({ up: false });
    expect(await pgCount(DFS_SUCCESS)).toBe(0);
    expect(await openEgressFlags()).toBe(1);

    const back = connectionBack();
    const wednesday = await runDataForSeoRecovery(env, { nowMs: WEDNESDAY, ...CREDS, fetchImpl: back.fetchImpl });
    expect(wednesday.succeeded).toBe(SKIPPED_BY_OUTAGE);
    expect(reportCalls(back.urls).some((url) => url.endsWith(BACKLINKS_SUMMARY))).toBe(false);
    expect(await openEgressFlags()).toBe(0);
  });

  it('stays under the monthly spend cap, and a capped family is not retried tomorrow', async () => {
    await offlineMonday();

    const capped = connectionBack();
    const tuesday = await runDataForSeoRecovery(env, {
      nowMs: TUESDAY,
      ...CREDS,
      monthlyCapUsd: 0.01,
      fetchImpl: capped.fetchImpl,
    });
    expect(tuesday.costUsd).toBe(0);
    expect(reportCalls(capped.urls)).toEqual([]);
    expect(
      await pgCount(
        `SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE error_code = 'budget_exhausted'`,
      ),
    ).toBe(SKIPPED_BY_OUTAGE);
    // The cap is not the uplink's doing: those families leave the owed list, so
    // the next day's pass does not walk into the same cap again.
    expect(await openEgressFlags()).toBe(0);
    const idle = recording(providerFetch().fetchImpl);
    await runDataForSeoRecovery(env, { nowMs: WEDNESDAY, ...CREDS, fetchImpl: idle.fetchImpl });
    expect(idle.urls).toEqual([]);
  });

  it('costs nothing when DataForSEO is owed nothing — even while another collector is', async () => {
    // Another collector's outage entry is open; DataForSEO has none.
    const hygiene = new EgressGate(env, {
      lane: 'hygiene',
      fetchImpl: cutUplink(providerFetch().fetchImpl),
      at: new Date(NOW).toISOString(),
    });
    await hygiene.isDown();
    hygiene.recordUnmeasured('meadow.example');
    await hygiene.finalize();

    const log = vi.spyOn(console, 'log');
    try {
      const idle = recording(providerFetch().fetchImpl);
      const result = await runDataForSeoRecovery(env, { nowMs: TUESDAY, ...CREDS, fetchImpl: idle.fetchImpl });

      expect(result).toEqual({ attempted: 0, succeeded: 0, unchanged: 0, failed: 0, costUsd: 0, outcomes: [] });
      expect(idle.urls).toEqual([]);
      expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);
      // Not even a start line: a pass with nothing to do is not a run.
      expect(log.mock.calls.some(([line]) => String(line).includes('dataforseo_dumps'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  describe('on the daily archive tick', () => {
    async function clearConfig(): Promise<void> {
      await emptyTables(['config_documents']);
      forgetConfigCache();
    }
    beforeEach(clearConfig);
    afterEach(async () => {
      vi.unstubAllGlobals();
      await clearConfig();
    });

    /** The tick's whole outbound traffic, with the connection back: the
     * reference sites and DataForSEO answer; the Google and Bing archive calls
     * running beside it get a 503, which that collector records as its own. */
    function stubOutbound(): string[] {
      const urls: string[] = [];
      const dataForSeo = providerFetch();
      vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        urls.push(url);
        if ((EGRESS_BEACONS as readonly string[]).includes(url)) return new Response('h=1', { status: 200 });
        if (new URL(url).hostname === 'api.dataforseo.com') return dataForSeo.fetchImpl(input, init);
        return new Response('unavailable', { status: 503 });
      }) as typeof fetch);
      return urls;
    }

    it('runs the re-collection beside the archives, skipping what the provider refused', async () => {
      await offlineMonday();
      const urls = stubOutbound();

      await runCron(SIGNAL_DUMPS_CRON, env);

      const calls = reportCalls(urls);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((url) => url.endsWith(BACKLINKS_SUMMARY))).toBe(false);
      expect(await pgCount(DFS_SUCCESS)).toBe(SKIPPED_BY_OUTAGE);
    });

    it('honours a paused DataForSEO schedule', async () => {
      await offlineMonday();
      const seeded = await seedConfigDocuments(
        env,
        {
          documents: {
            'config/constants.json': {
              ...constantsFixture,
              schedules: { dataforseo: { enabled: false, cron: '45 12 * * 1' } },
            },
          },
          actor: 'config:seed',
        },
        NOW,
      );
      expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
      const urls = stubOutbound();

      await runCron(SIGNAL_DUMPS_CRON, env);

      expect(reportCalls(urls)).toEqual([]);
      expect(await pgCount(DFS_SUCCESS)).toBe(0);
    });
  });
});
