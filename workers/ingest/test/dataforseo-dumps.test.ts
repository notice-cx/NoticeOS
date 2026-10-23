import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DATAFORSEO_REPORT_CADENCE_DAYS, dataForSeoFamiliesFor, runDataForSeoDumps } from '../src/dataforseo-dumps.js';
import { ARCHIVE_RUNS, pgCount, pgFirst } from './helpers.js';
import {
  NOW,
  PANEL_ASSETS,
  PANEL_QUERIES,
  PANEL_CALLS,
  LAUNCHED_ASSETS,
  DOMAIN_ATTEMPTS,
  EXPECTED_ATTEMPTS,
  WEEKLY_ATTEMPTS,
  PERIODIC_FAMILIES,
  providerFetch,
  resetWithFernsLaunched,
} from './dataforseo-dumps-fixture';

beforeEach(resetWithFernsLaunched);

describe('DataForSEO weekly archives', () => {
  it('archives each family once and spends nothing when automation repeats inside its cadence', async () => {
    const { fetchImpl, calls } = providerFetch();
    const first = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    expect(first).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: EXPECTED_ATTEMPTS,
      unchanged: 0,
      failed: 0,
    });
    expect(first.costUsd).toBeCloseTo(
      DOMAIN_ATTEMPTS * 0.011 + PANEL_CALLS * 0.004,
    );
    // The domain-driven families are one call each; the panel is one per query.
    expect(calls).toHaveLength(DOMAIN_ATTEMPTS + PANEL_CALLS);
    expect(new Set(calls.map((call) => call.authorization))).toEqual(
      new Set([
        `Basic ${btoa('operator-login:operator-password')}`,
      ]),
    );
    expect(
      calls.find((call) => call.url.endsWith('/ranked_keywords/live'))?.task,
    ).toMatchObject({
      location_code: 2840,
      language_code: 'en',
      limit: 200,
    });
    expect(
      calls.find((call) =>
        call.url.endsWith('/timeseries_new_lost_summary/live'),
      )?.task,
    ).toMatchObject({
      date_from: '2026-04-28',
      date_to: '2026-07-26',
      group_range: 'week',
    });
    expect(
      calls
        .filter((call) => call.url.endsWith('/target_metrics/live'))
        .map((call) => call.task.platform)
        .sort(),
      // One llm-mentions call per platform per property.
    ).toEqual([
      ...Array.from({ length: LAUNCHED_ASSETS }, () => 'chat_gpt'),
      ...Array.from({ length: LAUNCHED_ASSETS }, () => 'google'),
    ]);
    expect(
      await pgCount(
        `SELECT count(*) AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo'`,
      ),
    ).toBe(EXPECTED_ATTEMPTS);
    // One final archive per successful family, plus one durable checkpoint per
    // paid panel request. Checkpoints never count as landed manifests.
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(
      EXPECTED_ATTEMPTS + PANEL_CALLS,
    );
    const cost = await pgFirst<{ costUsd: number }>(`SELECT SUM(provider_cost_usd) AS "costUsd"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo'`);
    expect(cost?.costUsd).toBeCloseTo(
      DOMAIN_ATTEMPTS * 0.011 + PANEL_CALLS * 0.004,
    );

    const manifest = await pgFirst<{ objectKey: string }>(`SELECT object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meadow.example'
          AND integration = 'dataforseo'
          AND report = 'ranked-keywords'`);
    const object = await env.RAW_SIGNALS.get(manifest!.objectKey);
    const decompressed = object
      ? object.body.pipeThrough(new DecompressionStream('gzip'))
      : new ReadableStream();
    const archivedText = await new Response(decompressed).text();
    expect(archivedText).toContain('"provider":"dataforseo"');
    expect(archivedText).toContain('"report":"ranked-keywords"');
    expect(archivedText).not.toContain('operator-login');
    expect(archivedText).not.toContain('operator-password');

    const second = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    expect(second).toMatchObject({
      attempted: 0,
      succeeded: 0,
      unchanged: 0,
      failed: 0,
      costUsd: 0,
    });
    expect(calls).toHaveLength(DOMAIN_ATTEMPTS + PANEL_CALLS);
    expect(
      await pgCount(
        `SELECT count(*) AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo'`,
      ),
    ).toBe(EXPECTED_ATTEMPTS);
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(
      EXPECTED_ATTEMPTS + PANEL_CALLS,
    );
  });

  /** Three Mondays in four must not buy the discovery families again: they do
   * not move week to week. */
  it('makes every weekly family due after seven whole UTC days, not six', async () => {
    expect(new Set(Object.values(DATAFORSEO_REPORT_CADENCE_DAYS))).toEqual(
      new Set([7, 28]),
    );
    const { fetchImpl, calls } = providerFetch();
    const cold = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    // A cold start owes everything, both cadences.
    expect(cold).toMatchObject({ attempted: EXPECTED_ATTEMPTS, failed: 0 });
    const firstCallCount = calls.length;

    const early = await runDataForSeoDumps(env, {
      nowMs: NOW + 6 * 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    expect(early).toMatchObject({ attempted: 0, failed: 0, costUsd: 0 });
    expect(calls).toHaveLength(firstCallCount);

    const due = await runDataForSeoDumps(env, {
      nowMs: NOW + 7 * 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    // The steady-state Monday: every weekly family, and NOT the 28-day ones.
    expect(due).toMatchObject({ attempted: WEEKLY_ATTEMPTS, failed: 0 });
    expect(due.attempted).toBeLessThan(EXPECTED_ATTEMPTS);
    for (const outcome of due.outcomes) {
      expect(PERIODIC_FAMILIES).not.toContain(outcome.report);
    }
  });

  it('buys the discovery families again only after twenty-eight whole days', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    // Day 27 is still inside the cadence — the boundary is whole days, the same
    // rule the weekly families are held to.
    const early = await runDataForSeoDumps(env, {
      nowMs: NOW + 27 * 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    for (const outcome of early.outcomes) {
      expect(PERIODIC_FAMILIES).not.toContain(outcome.report);
    }

    const due = await runDataForSeoDumps(env, {
      nowMs: NOW + 28 * 86_400_000,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    const collected = due.outcomes
      .filter((outcome) => PERIODIC_FAMILIES.includes(outcome.report))
      .map((outcome) => outcome.report);
    // serp-competitors for every launched property; keyword-ideas only where a
    // tracked panel supplies the seeds.
    expect(collected.filter((r) => r === 'serp-competitors')).toHaveLength(
      LAUNCHED_ASSETS,
    );
    expect(collected.filter((r) => r === 'keyword-ideas')).toHaveLength(
      PANEL_ASSETS.length,
    );
  });

  /**
   * `keyword-ideas` seeds from the property's own tracked panel — the
   * operator's statement of which head terms matter — rather than from a new
   * config file or an R2 read inside a paid lane.
   */
  it('seeds keyword ideas from the property’s tracked panel', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meadow.example', families: ['keyword-ideas'] },
    });
    const ideas = calls.find((call) =>
      call.url.endsWith('/dataforseo_labs/google/keyword_ideas/live'),
    );
    expect(ideas?.task).toMatchObject({
      keywords: PANEL_QUERIES,
      location_code: 2840,
      language_code: 'en',
      limit: 100,
      tag: 'meadow.example:keyword-ideas',
    });
  });

  /** A property with no panel has no declared head terms, so it gets no ideas
   * rather than ideas grown from a guess — and asking for them by name is a
   * refusal, not a silent $0.00 success. */
  it('does not owe keyword ideas to a property with no tracked panel', () => {
    expect(dataForSeoFamiliesFor('pebble.example')).not.toContain(
      'keyword-ideas',
    );
    expect(dataForSeoFamiliesFor('pebble.example')).toContain(
      'serp-competitors',
    );
    expect(dataForSeoFamiliesFor('meadow.example')).toContain('keyword-ideas');
  });
});
