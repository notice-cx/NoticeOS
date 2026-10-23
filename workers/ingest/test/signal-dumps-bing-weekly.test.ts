import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgCount, pgFirst, reset } from './helpers.js';
import {
  NOW,
  BING_PROPERTIES,
  BING_ATTEMPTS,
  BING_WEEKLY_ATTEMPTS,
  type FetchFixture,
  providerDumpFetch,
} from './signal-dumps-fixture';

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
  describe('weekly Bing families on a daily cron', () => {
    const DAY_MS = 86_400_000;
    /** Every BWT method this fixture was asked for, in call order. */
    const bingMethods = (fixture: FetchFixture): string[] =>
      fixture.calls
        .filter((call) => call.url.includes('ssl.bing.com'))
        .map((call) => new URL(call.url).pathname.split('/').at(-1)!)
        .filter((method) => method !== 'GetUserSites');

    it('asks for every family on the first run', async () => {
      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: fixture.fetchImpl,
        revisionDays: 1,
      });

      expect(result.skipped).toBe(0);
      expect(
        bingMethods(fixture).filter((method) => method === 'GetQueryStats'),
      ).toHaveLength(BING_PROPERTIES);
      expect(
        bingMethods(fixture).filter((method) => method === 'GetPageStats'),
      ).toHaveLength(BING_PROPERTIES);
    });

    it('does not re-ask a weekly family the next day, and records no attempt for it', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });

      const next = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW + DAY_MS,
        fetchImpl: next.fetchImpl,
        revisionDays: 1,
      });

      expect(bingMethods(next)).not.toContain('GetQueryStats');
      expect(bingMethods(next)).not.toContain('GetPageStats');
      expect(result.skipped).toBe(BING_WEEKLY_ATTEMPTS);
      // The four daily families still run, for every property.
      expect(
        result.outcomes.filter(
          (outcome) =>
            outcome.integration === 'bing-webmaster' &&
            outcome.report === 'rank-traffic',
        ),
      ).toHaveLength(BING_PROPERTIES);
      expect(
        result.outcomes.filter((outcome) => outcome.report === 'queries'),
      ).toEqual([]);

      // A day nobody asked about is not an attempt: no second manifest row, and
      // above all no error row that would read as a broken lane.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'bing-webmaster' AND report = 'queries'`,
        ),
      ).toBe(BING_PROPERTIES);
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'bing-webmaster' AND status = 'error'`,
        ),
      ).toBe(0);
      // Lane freshness is read as the newest manifest across the lane's
      // families, and the daily four still carry it to today.
      const newest = await pgFirst<{ latest: string }>(`SELECT MAX(report_date) AS latest FROM ${ARCHIVE_RUNS}
          WHERE integration = 'bing-webmaster'`);
      expect(newest?.latest).toBe('2026-07-29');
    });

    it('asks again once the provider refresh is due, and archives the moved snapshot', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });
      const objectsAfterFirst = (await env.RAW_SIGNALS.list()).objects.length;

      const weekLater = providerDumpFetch({ bingQueryClicks: 42 });
      const result = await runSignalDumps(env, {
        nowMs: NOW + 7 * DAY_MS,
        fetchImpl: weekLater.fetchImpl,
        revisionDays: 1,
      });

      expect(result.skipped).toBe(0);
      expect(
        bingMethods(weekLater).filter((method) => method === 'GetQueryStats'),
      ).toHaveLength(BING_PROPERTIES);
      expect(
        result.outcomes.filter((outcome) => outcome.report === 'queries'),
      ).toMatchObject(
        Array.from({ length: BING_PROPERTIES }, () => ({
          reportDate: '2026-08-04',
          status: 'success',
        })),
      );
      // A moved snapshot is a new archive object, not a dedup.
      expect((await env.RAW_SIGNALS.list()).objects.length).toBeGreaterThan(
        objectsAfterFirst,
      );
    });

    it('retries a weekly family the next day when its fetch failed', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ failBingReport: 'GetQueryStats' })
          .fetchImpl,
        revisionDays: 1,
      });

      const next = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW + DAY_MS,
        fetchImpl: next.fetchImpl,
        revisionDays: 1,
      });

      // An error is not evidence the provider answered, so it cannot buy a week
      // of silence. `pages` succeeded yesterday and is genuinely not due.
      expect(
        bingMethods(next).filter((method) => method === 'GetQueryStats'),
      ).toHaveLength(BING_PROPERTIES);
      expect(bingMethods(next)).not.toContain('GetPageStats');
      expect(result.skipped).toBe(BING_PROPERTIES);
      expect(
        result.outcomes.filter((outcome) => outcome.report === 'queries'),
      ).toMatchObject(
        Array.from({ length: BING_PROPERTIES }, () => ({ status: 'success' })),
      );
    });

    it('does not fabricate a credential failure for a family it was not going to ask', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });

      const result = await runSignalDumps(env, {
        nowMs: NOW + DAY_MS,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
        bingApiKey: '',
      });

      expect(result.skipped).toBe(BING_WEEKLY_ATTEMPTS);
      expect(
        result.outcomes.filter(
          (outcome) =>
            outcome.integration === 'bing-webmaster' &&
            outcome.errorCode === 'config_missing',
        ),
      ).toHaveLength(BING_ATTEMPTS - BING_WEEKLY_ATTEMPTS);
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'bing-webmaster' AND status = 'error'
              AND report IN ('queries','pages')`,
        ),
      ).toBe(0);
    });
  });
});
