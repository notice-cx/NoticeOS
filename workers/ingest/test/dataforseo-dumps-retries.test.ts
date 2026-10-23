import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { retryAfterWaitMs, runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { ARCHIVE_RUNS, pgCount, pgFirst } from './helpers.js';
import {
  NOW,
  PANEL_ASSETS,
  LAUNCHED_ASSETS,
  EXPECTED_ATTEMPTS,
  SERP_PATH,
  type FetchCall,
  FAST_RETRY,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('DataForSEO weekly archives', () => {
  /** A transient provider failure on the weekly cron costs the property a week. */
  describe('a transient provider failure is repeated, a bad request is not', () => {
    const backlinksCalls = (calls: FetchCall[]) =>
      calls.filter((call) => call.url.endsWith('/backlinks/summary/live'));

    it('collects the family on the second attempt and records that it retried', async () => {
      const { fetchImpl, calls } = providerFetch({
        failPath: '/backlinks/summary/live',
        failTimes: 1,
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: EXPECTED_ATTEMPTS,
        failed: 0,
      });
      // One retry per property, and the family stopped there rather than using
      // the rest of its budget.
      expect(backlinksCalls(calls)).toHaveLength(LAUNCHED_ASSETS * 2);
      const retried = result.outcomes.filter((outcome) => outcome.retries > 0);
      expect(retried).toHaveLength(LAUNCHED_ASSETS);
      expect(retried[0]).toMatchObject({
        report: 'backlinks-summary',
        status: 'success',
        retries: 1,
      });
      // The week has its backlinks snapshot: a stored success, not a hole.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
              AND status = 'success'`,
        ),
      ).toBe(LAUNCHED_ASSETS);
    });

    it('gives up after a bounded number of attempts and says how many', async () => {
      const { fetchImpl, calls } = providerFetch({
        failPath: '/backlinks/summary/live',
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      // Three attempts per property — the first plus the two the budget buys —
      // and not one more.
      expect(backlinksCalls(calls)).toHaveLength(LAUNCHED_ASSETS * 3);
      const failure = result.outcomes.find(
        (outcome) => outcome.report === 'backlinks-summary',
      );
      expect(failure).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_http_503',
        retries: 2,
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      // The row says what the OS already did about it, so the operator is not
      // invited to go and try the same call by hand.
      expect(stored?.errorMessage).toBe(
        'Provider unavailable. Gave up after 3 attempts.',
      );
    });

    it('never repeats a request the provider refused', async () => {
      // 400 is about what we ASKED FOR. Repeating it would fail identically,
      // three times as slowly.
      const { fetchImpl, calls } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 400,
          body: {
            status_code: 40501,
            status_message: 'Invalid Field: target.',
            cost: 0,
            tasks: [],
          },
        },
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(backlinksCalls(calls)).toHaveLength(LAUNCHED_ASSETS);
      expect(
        result.outcomes.find((outcome) => outcome.report === 'backlinks-summary'),
      ).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_http_400',
        retries: 0,
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      // Nothing was retried, so the row must not imply anything was.
      expect(stored?.errorMessage).toBe('Invalid Field: target.');
    });

    it('will not let a retry be the call that crosses the monthly cap', async () => {
      // The gate reserves one report's worth of cap per call. At a $0.25 cap the
      // FIRST attempt fits and a second never could, so the failure stands after
      // one call — the guardrail outranks the repair.
      const { fetchImpl, calls } = providerFetch({
        failPath: '/dataforseo_labs/google/ranked_keywords/live',
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        monthlyCapUsd: 0.25,
        retryBackoffMs: FAST_RETRY,
      });

      expect(
        calls.filter((call) => call.url.endsWith('/ranked_keywords/live')),
      ).toHaveLength(1);
      expect(
        result.outcomes.find((outcome) => outcome.report === 'ranked-keywords'),
      ).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_http_503',
        retries: 0,
      });
      // And the run still stops at the cap rather than spending through it.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND error_code = 'budget_exhausted'
              AND cost_state = 'reported' AND provider_cost_usd = 0`,
        ),
      ).toBeGreaterThan(0);
    });

    it('spends one budget across a whole family, not one per tracked query', async () => {
      // If each panel call bought its own retries a provider outage would mean
      // hundreds of calls and minutes of waiting inside one sweep.
      const { fetchImpl, calls } = providerFetch({ failPath: SERP_PATH });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      // One budget per FAMILY: each panel property's serp-panel family buys
      // exactly 1 attempt + 2 retries, however many queries it tracks — and
      // however many properties config/serp-panel.json names.
      expect(calls.filter((call) => call.url.endsWith(SERP_PATH))).toHaveLength(
        3 * PANEL_ASSETS.length,
      );
      const panelOutcomes = result.outcomes.filter(
        (outcome) => outcome.report === 'serp-panel',
      );
      expect(panelOutcomes).toHaveLength(PANEL_ASSETS.length);
      for (const outcome of panelOutcomes) {
        expect(outcome).toMatchObject({ status: 'error', retries: 2 });
      }
    });

    /** 429 is the one 4xx a second call usually does answer: a rate limit is
     * about when we asked, and the provider says when to come back. */
    describe('a rate limit is repeated on the provider’s own clock', () => {
      const rateLimited = (headers?: Record<string, string>) => ({
        status: 429,
        body: {
          status_code: 40202,
          status_message: 'Rate limit exceeded.',
          cost: 0,
          tasks: [],
        },
        ...(headers ? { headers } : {}),
      });

      it('collects the family after the interval the response asked for', async () => {
        // Scoped to one property so the second here is one second, and the
        // ladder is zero so the only thing that can produce a wait is the
        // header. Elapsed time is the assertion because the wait IS the
        // behaviour: retrying a rate limit on a fixed backoff makes it worse.
        const { fetchImpl, calls } = providerFetch({
          failPath: '/backlinks/summary/live',
          failWith: rateLimited({ 'retry-after': '1' }),
          failTimes: 1,
        });
        const startedAt = Date.now();
        const result = await runDataForSeoDumps(env, {
          nowMs: NOW,
          fetchImpl,
          login: 'operator-login',
          password: 'operator-password',
          retryBackoffMs: FAST_RETRY,
          scope: { asset: 'northwind.example', families: ['backlinks-summary'] },
        });

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
        expect(backlinksCalls(calls)).toHaveLength(2);
        expect(result.outcomes).toHaveLength(1);
        expect(result.outcomes[0]).toMatchObject({
          report: 'backlinks-summary',
          status: 'success',
          retries: 1,
        });
      });

      it('repeats a 429 that names no interval on the collector’s ladder', async () => {
        const { fetchImpl, calls } = providerFetch({
          failPath: '/backlinks/summary/live',
          failWith: rateLimited(),
          failTimes: 1,
        });
        const result = await runDataForSeoDumps(env, {
          nowMs: NOW,
          fetchImpl,
          login: 'operator-login',
          password: 'operator-password',
          retryBackoffMs: FAST_RETRY,
        });

        expect(backlinksCalls(calls)).toHaveLength(LAUNCHED_ASSETS * 2);
        expect(result).toMatchObject({
          attempted: EXPECTED_ATTEMPTS,
          succeeded: EXPECTED_ATTEMPTS,
          failed: 0,
        });
      });

      it('fails the family rather than hold the sweep open for a long wait', async () => {
        // Ten minutes is not a blip, and a sweep asleep inside it is a sweep
        // that can outlive its own lane lease. The family fails honestly and
        // Monday collects it.
        const { fetchImpl, calls } = providerFetch({
          failPath: '/backlinks/summary/live',
          failWith: rateLimited({ 'retry-after': '600' }),
        });
        const result = await runDataForSeoDumps(env, {
          nowMs: NOW,
          fetchImpl,
          login: 'operator-login',
          password: 'operator-password',
          retryBackoffMs: FAST_RETRY,
        });

        expect(backlinksCalls(calls)).toHaveLength(LAUNCHED_ASSETS);
        expect(
          result.outcomes.find(
            (outcome) => outcome.report === 'backlinks-summary',
          ),
        ).toMatchObject({
          status: 'error',
          errorCode: 'dataforseo_http_429',
          retries: 0,
        });
        const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
              AND status = 'error' LIMIT 1`);
        // Nothing was retried, so the row must not imply anything was.
        expect(stored?.errorMessage).toBe('Rate limit exceeded.');
      });

      it('reads an HTTP-date the same way it reads seconds', () => {
        const now = Date.parse('2026-08-04T12:00:00.000Z');
        expect(retryAfterWaitMs('7', now)).toBe(7_000);
        expect(retryAfterWaitMs(' 7 ', now)).toBe(7_000);
        expect(
          retryAfterWaitMs('Tue, 04 Aug 2026 12:00:09 GMT', now),
        ).toBe(9_000);
        // Already past: ask again now, and the ladder's floor bounds it.
        expect(
          retryAfterWaitMs('Tue, 04 Aug 2026 11:59:00 GMT', now),
        ).toBe(0);
        // Absent or unreadable is not "do not retry" — it is "we were not told".
        expect(retryAfterWaitMs(null, now)).toBeNull();
        expect(retryAfterWaitMs('', now)).toBeNull();
        expect(retryAfterWaitMs('soon', now)).toBeNull();
      });
    });
  });
});
