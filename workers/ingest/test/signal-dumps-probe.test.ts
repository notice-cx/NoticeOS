import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgCount, reset, storeArchiveRun } from './helpers.js';
import {
  NOW,
  GOOGLE_PROPERTIES,
  type FetchFixture,
  providerDumpFetch,
} from './signal-dumps-fixture';

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
  describe('probe mode for an always-empty report family', () => {
    const discoverCalls = (fixture: FetchFixture): number =>
      fixture.calls.filter((call) => call.body?.type === 'discover').length;
    const discoverOutcomes = (
      result: Awaited<ReturnType<typeof runSignalDumps>>,
    ) => result.outcomes.filter((outcome) => outcome.report === 'discover-page');
    /** Probe state is per (property, family), so every assertion here is too. */
    const discoverDates = (
      result: Awaited<ReturnType<typeof runSignalDumps>>,
    ): string[] => discoverOutcomes(result).map((o) => `${o.asset} ${o.reportDate}`).sort();
    const everyProperty = (...dates: string[]): string[] =>
      GOOGLE_PROPERTIES.flatMap((asset) => dates.map((date) => `${asset} ${date}`)).sort();

    it('requests the full revision window on the first-ever run', async () => {
      const fixture = providerDumpFetch({ emptyDiscover: true });
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: fixture.fetchImpl,
        revisionDays: 2,
      });

      expect(discoverDates(result)).toEqual(everyProperty('2026-07-27', '2026-07-28'));
      expect(discoverCalls(fixture)).toBe(2 * GOOGLE_PROPERTIES.length);
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE report = 'discover-page' AND provider_rows = 0`,
        ),
      ).toBe(2 * GOOGLE_PROPERTIES.length);
    });

    it('narrows to the newest date once every completed run has come back empty', async () => {
      const first = providerDumpFetch({ emptyDiscover: true });
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: first.fetchImpl,
        revisionDays: 2,
      });

      const second = providerDumpFetch({ emptyDiscover: true });
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: second.fetchImpl,
        revisionDays: 2,
      });

      // Each property narrows on its OWN history, not on the portfolio's.
      expect(discoverOutcomes(result)).toMatchObject(
        GOOGLE_PROPERTIES.map((asset) => ({
          asset,
          reportDate: '2026-07-28',
          status: 'unchanged',
          providerRows: 0,
        })),
      );
      expect(discoverCalls(second)).toBe(GOOGLE_PROPERTIES.length);
      // The probe still writes its manifest — a narrowed window is not a
      // skipped attempt.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report = 'discover-page'`,
        ),
      ).toBe(3 * GOOGLE_PROPERTIES.length);
      // Only the opted-in family narrows; its neighbours keep the full window.
      expect(
        result.outcomes.filter((outcome) => outcome.report === 'image-page-query'),
      ).toHaveLength(2 * GOOGLE_PROPERTIES.length);
    });

    it('restores the full window after any non-empty run, even if later runs are empty', async () => {
      const withRows = providerDumpFetch();
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: withRows.fetchImpl,
        revisionDays: 2,
      });

      const nowEmpty = providerDumpFetch({ emptyDiscover: true });
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: nowEmpty.fetchImpl,
        revisionDays: 2,
      });

      expect(discoverDates(result)).toEqual(everyProperty('2026-07-27', '2026-07-28'));
      expect(discoverCalls(nowEmpty)).toBe(2 * GOOGLE_PROPERTIES.length);
    });

    it('does not let failed attempts alone arm the probe', async () => {
      await storeArchiveRun({
        id: 'probe-error-fixture', asset: 'meadow.example', integration: 'gsc', report: 'discover-page',
        credential_ref: 'test-signals', property_ref: 'sc-domain:meadow.example', report_date: '2026-07-27',
        requested_at: '2026-07-28T12:15:00.000Z', finished_at: '2026-07-28T12:15:01.000Z',
        status: 'error', data_state: 'provider-final', error_code: 'gsc_dump_http_403', error_message: 'denied',
      });

      const fixture = providerDumpFetch({ emptyDiscover: true });
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: fixture.fetchImpl,
        revisionDays: 2,
      });

      expect(discoverOutcomes(result)).toHaveLength(2 * GOOGLE_PROPERTIES.length);
      expect(discoverCalls(fixture)).toBe(2 * GOOGLE_PROPERTIES.length);
    });
  });
});
