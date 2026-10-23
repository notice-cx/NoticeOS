import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataForSeoFamiliesFor, runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { recordResearch } from '../src/research-log.js';
import { ARCHIVE_RUNS, pgAll, pgCount, pgFirst } from './helpers.js';
import {
  NOW,
  PANEL_CALLS,
  LAUNCHED_ASSETS,
  LAUNCHED,
  DOMAIN_ATTEMPTS,
  EXPECTED_ATTEMPTS,
  FAST_RETRY,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('DataForSEO weekly archives', () => {
  it('fills only the missing families after a partial prior sweep', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['backlinks-summary'] },
    });
    expect(calls).toHaveLength(1);

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS - 1,
      failed: 0,
    });
    expect(calls).toHaveLength(DOMAIN_ATTEMPTS + PANEL_CALLS);
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith('/backlinks/summary/live') &&
          call.task.tag === 'meadow.example:backlinks-summary',
      ),
    ).toHaveLength(1);
  });

  it('lets an explicit repair force one fresh expensive family', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    const firstCallCount = calls.length;

    const repair = await runDataForSeoDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['llm-mentions-google'] },
    });
    expect(repair).toMatchObject({
      attempted: 1,
      succeeded: 1,
      unchanged: 0,
      failed: 0,
    });
    expect(calls).toHaveLength(firstCallCount + 1);
  });

  it('retries failed families on the next automated run while fresh successes stay skipped', async () => {
    const failedProvider = providerFetch({
      failPath: '/backlinks/summary/live',
    });
    const first = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: failedProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [],
    });
    expect(first.failed).toBe(LAUNCHED_ASSETS);

    const recoveredProvider = providerFetch();
    const recovery = await runDataForSeoDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl: recoveredProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    expect(recovery).toMatchObject({
      attempted: LAUNCHED_ASSETS,
      succeeded: LAUNCHED_ASSETS,
      failed: 0,
    });
    expect(
      recoveredProvider.calls.every((call) =>
        call.url.endsWith('/backlinks/summary/live'),
      ),
    ).toBe(true);
  });

  it('logs every fresh family automation skipped and its next due date', async () => {
    const { fetchImpl } = providerFetch();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
      });
      log.mockClear();
      await runDataForSeoDumps(env, {
        nowMs: NOW + 86_400_000,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
      });
      const events = log.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      );
      const complete = events.find(
        (event) => event.event === 'dataforseo_dumps_complete',
      ) as
        | {
            costUsd: number;
            skippedFresh: Array<{
              asset: string;
              report: string;
              latestReportDate: string;
              nextDueDate: string;
            }>;
          }
        | undefined;
      expect(complete?.costUsd).toBe(0);
      expect(complete?.skippedFresh).toHaveLength(EXPECTED_ATTEMPTS);
      expect(complete?.skippedFresh).toContainEqual({
        asset: 'meadow.example',
        report: 'backlinks-summary',
        latestReportDate: '2026-07-27',
        nextDueDate: '2026-08-03',
      });
      expect(complete?.skippedFresh).toContainEqual({
        asset: 'meadow.example',
        report: 'llm-mentions-google',
        latestReportDate: '2026-07-27',
        nextDueDate: '2026-08-03',
      });
    } finally {
      log.mockRestore();
    }
  });

  it('keeps a midnight catch-up manifest on its collection day while requesting 90 completed days', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: Date.parse('2026-08-05T00:01:02.000Z'),
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: {
        asset: 'meadow.example',
        families: ['backlinks-new-lost'],
      },
    });

    expect(result).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toMatchObject({
      date_from: '2026-05-07',
      date_to: '2026-08-04',
      group_range: 'week',
    });
    expect(
      await pgFirst<{ reportDate: string }>(`SELECT report_date AS "reportDate"
           FROM ${ARCHIVE_RUNS}
          WHERE asset = 'meadow.example'
            AND report = 'backlinks-new-lost'`),
    ).toEqual({ reportDate: '2026-08-05' });
  });

  /** The domain-driven lane has no roster: `loadCandidates` reads the `assets`
   * table, so a launched property with a domain is enrolled the moment it is
   * seeded. The tracked panel is the one family a property must be named in
   * config to receive. Pinned because narrowing to a hand-kept list would stop
   * collecting a property without an error row to say so. */
  it('sweeps every launched property by store membership, not a roster', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const rows = (
      await pgAll<{ asset: string; n: number }>(`SELECT asset, count(*)::int AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report != 'serp-panel'
          GROUP BY asset
          ORDER BY asset COLLATE "C"`)
    ).results;

    // The property list is the assertion; the per-property family count is
    // derived so adding a family does not masquerade as a membership regression.
    const owed = (asset: string) =>
      dataForSeoFamiliesFor(asset).filter((f) => f !== 'serp-panel').length;
    expect(rows).toEqual(
      LAUNCHED.map((asset) => ({ asset, n: owed(asset) })),
    );
    // Asset #0 has no public search surface and falls out of the store query.
    expect(rows.map((row) => row.asset)).not.toContain('root-os');
  });

  it('records a missing credential attempt for every expected report', async () => {
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      login: '',
      password: '',
    });
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: 0,
      unchanged: 0,
      failed: EXPECTED_ATTEMPTS,
      costUsd: 0,
    });
    expect(
      await pgCount(
        `SELECT count(*) AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo'
            AND error_code = 'config_missing'`,
      ),
    ).toBe(EXPECTED_ATTEMPTS);
    expect(await env.STORE.read((tx) => tx.query(
      "SELECT cost_state FROM noticeos.archive_runs WHERE cost_state <> 'reported' OR cost_usd <> 0 OR cost_usd IS NULL",
    ))).toEqual([]);
  });

  it('isolates one report family failure without discarding other evidence', async () => {
    const { fetchImpl } = providerFetch({
      failPath: '/backlinks/summary/live',
    });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: FAST_RETRY,
    });
    // The dead family is one call per property, so it fails once per property.
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: EXPECTED_ATTEMPTS - LAUNCHED_ASSETS,
      failed: LAUNCHED_ASSETS,
    });
    expect(
      result.outcomes.filter((outcome) => outcome.status === 'error'),
    ).toHaveLength(LAUNCHED_ASSETS);
    expect(
      result.outcomes.find((outcome) => outcome.status === 'error'),
    ).toMatchObject({
      report: 'backlinks-summary',
      errorCode: 'dataforseo_http_503',
    });
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(
      EXPECTED_ATTEMPTS - LAUNCHED_ASSETS + PANEL_CALLS,
    );
  });

  it('fails closed before a call that could exceed the monthly data cap', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      monthlyCapUsd: 0.24,
    });
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: 0,
      unchanged: 0,
      failed: EXPECTED_ATTEMPTS,
      costUsd: 0,
    });
    expect(calls).toHaveLength(0);
    expect(
      await pgCount(
        `SELECT count(*) AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo'
            AND error_code = 'budget_exhausted'`,
      ),
    ).toBe(EXPECTED_ATTEMPTS);
  });

  /** The gate and the desk read one sum. Ad-hoc research spends the same
   * account and lands in the research log, so a month whose collected reports
   * cost nothing can still be over the cap. */
  it('fails closed on ad-hoc research alone, with no collected report to see', async () => {
    const { fetchImpl, calls } = providerFetch();
    await recordResearch(
      env.STORE,
      {
        asset: 'meadow.example',
        provider: 'dataforseo',
        endpoint: 'dataforseo_labs/google/keyword_overview/live',
        params: { keywords: ['dri calculator'], location_code: 2840 },
        question: 'keyword overview, 1 term, US/en',
        costUsd: 0.9,
        actor: 'claude-opus-5',
      },
      NOW,
    );
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      monthlyCapUsd: 1,
    });
    expect(result).toMatchObject({ succeeded: 0, failed: EXPECTED_ATTEMPTS, costUsd: 0 });
    expect(calls).toHaveLength(0);
  });
});
