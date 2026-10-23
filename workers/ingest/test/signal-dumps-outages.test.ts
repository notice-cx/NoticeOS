import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_STORE_FAILED, runSignalDumps } from '../src/signal-dumps.js';
import { EGRESS_DOWN_CODE } from '../src/egress.js';
import { healthFailure } from '../src/integration-health-store.js';
import {
  ARCHIVE_RUNS,
  WORKERD_TRANSPORT_ERROR,
  cutUplink,
  openEgressFlags,
  pgCount,
  pgFirst,
  reset,
  storeArchiveRun,
  storedHealthStates,
} from './helpers.js';
import {
  NOW,
  TOKEN_URL,
  GOOGLE_PROPERTIES,
  GOOGLE_FAMILIES,
  EXPECTED_ATTEMPTS,
  type FetchFixture,
  providerDumpFetch,
} from './signal-dumps-fixture';

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
  describe('when the OS is what is down', () => {
    const ALL_PROPERTIES = [
      'meadow.example',
      'northwind.example',
      'pebble.example',
      'puffin.example',
      'acorn.example',
      'ferns.example',
    ];

    async function residue(): Promise<{
      manifests: number;
      objects: number;
      health: number;
      egressFlags: number;
    }> {
      return {
        manifests: await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`),
        objects: (await env.RAW_SIGNALS.list()).objects.length,
        health: (await storedHealthStates()).length,
        egressFlags: await openEgressFlags(),
      };
    }

    it('writes no manifest flood for a dead night — one OS fact instead', async () => {
      // The full four-date revision window: the shape that would otherwise write
      // a `request_failed` manifest per target x family x date.
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl),
      });

      expect(result.attempted).toBeGreaterThan(EXPECTED_ATTEMPTS);
      expect(result).toMatchObject({ succeeded: 0, unchanged: 0, failed: result.attempted });
      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject({ egressDown: true, errorCode: EGRESS_DOWN_CODE });
      }
      expect(await residue()).toEqual({ manifests: 0, objects: 0, health: 0, egressFlags: 1 });
      expect(result.egress).toMatchObject({ up: false, probes: 1, fired: 1 });
      expect([...result.egress.unmeasuredAssets].sort()).toEqual([...ALL_PROPERTIES].sort());
    });

    it('holds the same line when the uplink dies after the token and the asset list', async () => {
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl, {
          through: (url) => url === TOKEN_URL || url.includes('/GetUserSites'),
        }),
        revisionDays: 1,
      });

      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: 0,
        failed: EXPECTED_ATTEMPTS,
      });
      expect(result.outcomes.every((outcome) => outcome.egressDown === true)).toBe(true);
      expect(await residue()).toEqual({ manifests: 0, objects: 0, health: 0, egressFlags: 1 });
    });

    it('leaves every family due, so the next run collects it all', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl),
        revisionDays: 1,
      });

      // The uplink is back: the beacons answer and so does every provider.
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl, { beaconUp: true, through: () => true }),
        revisionDays: 1,
      });

      // Weekly Bing families included: a night nobody measured bought no week
      // of silence. And the first run that gets through retracts the flag.
      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: EXPECTED_ATTEMPTS,
        failed: 0,
        skipped: 0,
      });
      expect(result.egress).toMatchObject({ up: true, resolved: 1 });
      expect(await openEgressFlags()).toBe(0);
    });

    it('still records a provider that never answers while the OS can reach the world', async () => {
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl, {
          beaconUp: true,
          through: (url) => url === TOKEN_URL,
        }),
        revisionDays: 1,
      });

      expect(result).toMatchObject({ succeeded: 0, failed: EXPECTED_ATTEMPTS });
      expect(result.outcomes.some((outcome) => outcome.egressDown)).toBe(false);
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE status = 'error' AND error_code = 'request_failed' AND error_message = $1`,
          [WORKERD_TRANSPORT_ERROR],
        ),
      ).toBe(EXPECTED_ATTEMPTS);
      expect(result.egress).toMatchObject({ up: true, fired: 0 });
      expect(await openEgressFlags()).toBe(0);
    });
  });

  describe('re-collecting what an outage cost', () => {
    /** The run that never reached Google. */
    const OUTAGE_RUN = '2026-09-14T12:15:00.000Z';
    /** A scheduled run ten days on: its own window is 2026-09-23 alone. */
    const LATER = Date.parse('2026-09-24T12:15:00.000Z');
    const GOOGLE_REF: Record<string, Record<string, string>> = {
      'meadow.example': { ga4: '123456', gsc: 'sc-domain:meadow.example' },
      'northwind.example': { ga4: '654321', gsc: 'sc-domain:northwind.example' },
    };

    /** One manifest row, written the way the lane writes an error. */
    async function failedDump(
      asset: string,
      integration: 'ga4' | 'gsc',
      report: string,
      reportDate: string,
      code: string,
      requestedAt = OUTAGE_RUN,
    ): Promise<void> {
      await storeArchiveRun({
        id: crypto.randomUUID(), asset, integration, report, credential_ref: 'test-signals',
        property_ref: GOOGLE_REF[asset]![integration], report_date: reportDate, finished_at: requestedAt,
        status: 'error', data_state: integration === 'gsc' ? 'provider-final' : 'revision-window',
        error_code: code, error_message: 'fixture',
      });
    }

    /** Every provider answering AND the reference sites too — the shape of the
     * run after an outage, which asks the beacons once to close the flag. */
    const reachable = (fixture: FetchFixture): typeof fetch =>
      cutUplink(fixture.fetchImpl, { beaconUp: true, through: () => true });

    /** The newest manifest status for one report date. */
    async function latest(asset: string, integration: string, report: string, reportDate: string) {
      return pgFirst<{ status: string; errorCode: string | null }>(`SELECT status, error_code AS "errorCode" FROM ${ARCHIVE_RUNS}
          WHERE asset = $1 AND integration = $2 AND report = $3 AND report_date = $4
          ORDER BY requested_at DESC, finished_at DESC LIMIT 1`, [asset, integration, report, reportDate]);
    }

    /** Google data requests for one report date (a GA4 range ENDING on it, or a
     * GSC day), whatever family asked. */
    function askedFor(fixture: FetchFixture, reportDate: string) {
      return fixture.calls.filter((call) => {
        if (call.url.includes('/searchAnalytics/query')) return call.body?.endDate === reportDate;
        if (!call.url.includes('analyticsdata.googleapis.com')) return false;
        const ranges = call.body?.dateRanges;
        return Array.isArray(ranges) && (ranges[0] as { endDate?: string }).endDate === reportDate;
      });
    }

    it('asks a network-failed date again on the next run, and it reads collected afterwards', async () => {
      // The three shapes the outage left: a family's oldest window date, a GSC
      // day that timed out, and the rolling family asked for its newest date only.
      await failedDump('meadow.example', 'ga4', 'pages-screens', '2026-09-10', 'request_failed');
      await failedDump('northwind.example', 'gsc', 'page-query', '2026-09-10', 'request_timeout');
      await failedDump('meadow.example', 'ga4', 'events-28d', '2026-09-13', 'request_failed');

      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, { nowMs: LATER, fetchImpl: fixture.fetchImpl, revisionDays: 1 });

      expect(result.retried).toBe(3);
      expect(result.attempted).toBe(EXPECTED_ATTEMPTS + 3);
      expect(result.failed).toBe(0);
      expect(await latest('meadow.example', 'ga4', 'pages-screens', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('northwind.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('meadow.example', 'ga4', 'events-28d', '2026-09-13')).toMatchObject({ status: 'success' });
      // The exact question the dark night owed: that date, not today's.
      const rolling = askedFor(fixture, '2026-09-13');
      expect(rolling).toHaveLength(1);
      expect(rolling[0]?.body).toMatchObject({ dateRanges: [{ startDate: '2026-08-17', endDate: '2026-09-13' }] });
      expect(askedFor(fixture, '2026-09-10')).toHaveLength(2);
      // And a gap once filled is not asked for again.
      const next = await runSignalDumps(env, {
        nowMs: LATER + 86_400_000,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });
      expect(next.retried).toBe(0);
    });

    it('never re-asks a date the provider answered with a refusal', async () => {
      await failedDump('meadow.example', 'gsc', 'page-query', '2026-09-10', 'gsc_dump_http_403');
      await failedDump('meadow.example', 'ga4', 'pages-screens', '2026-09-10', 'ga4_quota_exhausted');
      // Network first, then the provider's own answer: the LATEST attempt decides.
      await failedDump('northwind.example', 'ga4', 'events', '2026-09-10', 'request_failed', '2026-09-14T12:15:00.000Z');
      await failedDump('northwind.example', 'ga4', 'events', '2026-09-10', 'ga4_dump_http_400', '2026-09-15T12:15:00.000Z');

      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, { nowMs: LATER, fetchImpl: fixture.fetchImpl, revisionDays: 1 });

      expect(result.retried).toBe(0);
      expect(askedFor(fixture, '2026-09-10')).toHaveLength(0);
      expect(await latest('meadow.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ errorCode: 'gsc_dump_http_403' });
    });

    it('names a date this machine failed to save as its own fault, and never asks Google again for it', async () => {
      // Google answered pages-screens for meadow.example; the file store refused it.
      const refusing = new Proxy(env.RAW_SIGNALS, {
        get(target, prop) {
          if (prop === 'put') {
            return (key: string, ...rest: unknown[]) =>
              key.includes('/ga4/meadow.example/pages-screens/')
                ? Promise.reject(new Error('R2 put failed: we encountered an internal error'))
                : (target.put as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      const first = await runSignalDumps({ ...env, RAW_SIGNALS: refusing }, {
        nowMs: LATER,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });
      expect(first.failed).toBe(1);
      expect(await latest('meadow.example', 'ga4', 'pages-screens', '2026-09-23')).toMatchObject({
        status: 'error',
        errorCode: LOCAL_STORE_FAILED,
      });
      // NoticeOS's fault on the Integrations page — not "Google could not be reached".
      expect(healthFailure(LOCAL_STORE_FAILED).failure).toBe('monitoring');

      const fixture = providerDumpFetch();
      const next = await runSignalDumps(env, { nowMs: LATER + 86_400_000, fetchImpl: fixture.fetchImpl, revisionDays: 1 });
      expect(next.retried).toBe(0);
      expect(askedFor(fixture, '2026-09-23')).toHaveLength(0);
    });

    it('never re-asks a date newer than the run could call complete', async () => {
      // A manual run before 12:15 UTC calls 2026-09-22 its newest completed
      // date; 2026-09-23 may still be open on the US west coast.
      await failedDump('meadow.example', 'ga4', 'pages-screens', '2026-09-23', 'request_failed', '2026-09-24T12:15:00.000Z');

      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: Date.parse('2026-09-24T08:00:00.000Z'),
        fetchImpl: fixture.fetchImpl,
        revisionDays: 1,
      });

      expect(result.retried).toBe(0);
      expect(askedFor(fixture, '2026-09-23')).toHaveLength(0);
    });

    it('asks no more than its bound per run — oldest first, the rest on the next runs', async () => {
      for (const date of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']) {
        await failedDump('meadow.example', 'ga4', 'pages-screens', date, 'request_failed');
      }

      const asked: string[][] = [];
      for (let day = 0; day < 4; day += 1) {
        const fixture = providerDumpFetch();
        const result = await runSignalDumps(env, {
          nowMs: LATER + day * 86_400_000,
          fetchImpl: fixture.fetchImpl,
          revisionDays: 1,
          retryLimit: 2,
        });
        asked.push(
          result.outcomes
            .filter((outcome) => outcome.reportDate < '2026-09-10')
            .map((outcome) => outcome.reportDate),
        );
        expect(result.retried).toBe(asked.at(-1)!.length);
      }
      expect(asked).toEqual([
        ['2026-09-05', '2026-09-06'],
        ['2026-09-07', '2026-09-08'],
        ['2026-09-09'],
        [],
      ]);
    });

    it('asks nothing while the outage is still on, and leaves every date owed', async () => {
      await failedDump('meadow.example', 'ga4', 'pages-screens', '2026-09-10', 'request_failed');
      await failedDump('northwind.example', 'gsc', 'page-query', '2026-09-10', 'request_failed');

      const dark = await runSignalDumps(env, {
        nowMs: LATER,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl),
        revisionDays: 1,
      });
      expect(dark.retried).toBe(0);
      expect(dark.outcomes.some((outcome) => outcome.reportDate === '2026-09-10')).toBe(false);

      // The uplink dying after the token: ONE ask meets the wall, and the pass
      // stops there instead of spending a request per owed date against it.
      const midway = await runSignalDumps(env, {
        nowMs: LATER,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl, { through: (url) => url === TOKEN_URL }),
        revisionDays: 1,
      });
      expect(midway.retried).toBe(1);
      expect(midway.outcomes.filter((outcome) => outcome.reportDate === '2026-09-10')).toMatchObject([
        { egressDown: true },
      ]);
      // Nothing was written against either date: both are still owed.
      expect(
        await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report_date = '2026-09-10'`),
      ).toBe(2);

      const back = await runSignalDumps(env, {
        nowMs: LATER,
        fetchImpl: reachable(providerDumpFetch()),
        revisionDays: 1,
      });
      expect(back.retried).toBe(2);
      expect(await latest('meadow.example', 'ga4', 'pages-screens', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('northwind.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ status: 'success' });
    });

    it('stops after one ask when the provider still drops the connection', async () => {
      for (const date of ['2026-09-08', '2026-09-09', '2026-09-10']) {
        await failedDump('meadow.example', 'ga4', 'pages-screens', date, 'request_failed');
      }
      // The world answers, Google's data endpoints do not.
      const result = await runSignalDumps(env, {
        nowMs: LATER,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl, {
          beaconUp: true,
          through: (url) => !url.includes('analyticsdata.googleapis.com'),
        }),
        revisionDays: 1,
      });
      expect(result.retried).toBe(1);
      // Recorded as the provider's network failure, so it is still owed.
      expect(await latest('meadow.example', 'ga4', 'pages-screens', '2026-09-08')).toMatchObject({
        status: 'error',
        errorCode: 'request_failed',
      });
    });

    it('fills the dates a dead night swallowed that the next window no longer covers', async () => {
      // Window 2026-07-27..28, none of it collected: no manifest, one flag.
      const outage = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl),
        revisionDays: 2,
      });
      expect(outage.egress).toMatchObject({ up: false, fired: 1 });
      expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(0);

      // The next day's window is 07-28..29. 07-27 fell out of it for every
      // daily family, and the rolling family only ever asks its newest date —
      // so without the flag naming the dates, both were gone for good.
      const next = await runSignalDumps(env, {
        nowMs: NOW + 86_400_000,
        fetchImpl: reachable(providerDumpFetch()),
        revisionDays: 2,
      });
      const DAILY_FAMILIES = GOOGLE_FAMILIES - 1;
      expect(next.retried).toBe(GOOGLE_PROPERTIES.length * (DAILY_FAMILIES + 1));
      expect(
        next.outcomes.filter((outcome) => outcome.reportDate === '2026-07-27' && outcome.status === 'success'),
      ).toHaveLength(GOOGLE_PROPERTIES.length * DAILY_FAMILIES);
      for (const asset of GOOGLE_PROPERTIES) {
        expect(await latest(asset, 'ga4', 'events-28d', '2026-07-28')).toMatchObject({ status: 'success' });
      }
      // Every owed date collected, so the outage's flag is finally closed.
      expect(next.egress).toMatchObject({ up: true, resolved: 1 });
      expect(await openEgressFlags()).toBe(0);
    });

    it('keeps the outage flag open while its dates are still owed', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: cutUplink(providerDumpFetch().fetchImpl),
        revisionDays: 2,
      });
      const bounded = await runSignalDumps(env, {
        nowMs: NOW + 86_400_000,
        fetchImpl: reachable(providerDumpFetch()),
        revisionDays: 2,
        retryLimit: 5,
      });
      expect(bounded.retried).toBe(5);
      expect(bounded.egress.resolved).toBe(0);
      expect(await openEgressFlags()).toBe(1);
    });
  });
});
