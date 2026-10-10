import { env } from 'cloudflare:test';
import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PANEL_REPORT,
  DATAFORSEO_PERIODIC_REPORTS,
  dataForSeoReportsFor,
} from '@noticeos/contract';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  DATAFORSEO_REPORT_CADENCE_DAYS,
  DATAFORSEO_REPORTS,
  DATAFORSEO_CHECKPOINT_PREFIX,
  MAX_REPORT_COST_USD as REPORT_RESERVE_USD,
  SERP_PANEL_CALL_USD as CALL_USD,
  SERP_PANEL_DEVICES,
  SERP_PANEL_QUERY_LIMIT as PANEL_CEILING,
  dataForSeoFamiliesFor,
  retryAfterWaitMs,
  runDataForSeoDumps,
  runDataForSeoRecovery,
  trackedQueries,
  type SerpPanelQuery,
} from '../src/dataforseo-dumps.js';
import { SignalError } from '../src/signal-store.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { SIGNAL_DUMPS_CRON } from '../src/crons.js';
import { runCron } from '../src/dispatch.js';
import constantsFixture from './fixture-config/constants.json';
import { credentialSummary, putCredential } from '../src/credentials.js';
import { recordResearch } from '../src/research-log.js';
import serpPanelConfig from './fixture-config/serp-panel.json';
import { EGRESS_BEACONS, EGRESS_DOWN_CODE, EgressGate } from '../src/egress.js';
import {
  ARCHIVE_RUNS,
  WORKERD_TRANSPORT_ERROR,
  cutUplink,
  openEgressFlags,
  pgAll,
  pgCount,
  pgFirst,
  reset,
  emptyTables,
  storedHealthStates,
} from './helpers.js';
import { changeSites, inSiteOrder } from './sites';

const NOW = Date.parse('2026-07-27T12:45:00.000Z');
/** The suite's frozen copy of config/serp-panel.json, never the checkout's
 * own. Whether every shipped panel fits its reserve is checked on the real
 * file in config-seeds.test.ts. */
const PANEL_ASSETS = Object.keys(serpPanelConfig.assets);

/** A panel entry is a bare query or a query carrying the cluster it measures. */
function panelEntries(asset: string): SerpPanelQuery[] {
  return (serpPanelConfig.assets as Record<string, { queries: SerpPanelQuery[] }>)[
    asset
  ]!.queries;
}
const panelKeyword = (entry: SerpPanelQuery): string =>
  typeof entry === 'string' ? entry : entry.query;
const panelLabel = (entry: SerpPanelQuery): string | undefined =>
  typeof entry === 'string' ? undefined : entry.label;

const PANEL_QUERIES = panelEntries('meals.example').map(panelKeyword);
/** Every panel call a property buys: one per tracked query per device,
 * derived from the shipped device list. The cluster label is never
 * transmitted and costs nothing. */
const panelCallCount = (entries: readonly unknown[]): number =>
  entries.length * SERP_PANEL_DEVICES.length;
/** Every panel call across every seeded property: this — not the property
 * count — is the bill. */
const PANEL_CALLS = Object.values(serpPanelConfig.assets).reduce(
  (sum, entry) => sum + panelCallCount(entry.queries),
  0,
);
/** The panel's terms in the order the collector asks for them: each query on
 * every device, devices inner, so a query's two result pages are adjacent and
 * the DESKTOP call is the last word on that query. */
const panelKeywordOrder = (queries: readonly string[]): string[] =>
  queries.flatMap((keyword) => SERP_PANEL_DEVICES.map(() => keyword));
/** The collector covers every property past pre-launch; the suite sets that
 * lifecycle fact in beforeEach. */
const LAUNCHED_ASSETS = 6;
/** The launched properties by name, so a count is derived per property:
 * `keyword-ideas` seeds from the tracked panel, so a property without one is
 * not due it. */
const LAUNCHED = [
  'areas.example',
  'fees.example',
  'meals.example',
  'nosh.example',
  'pacer.example',
  'pullups.example',
] as const;
/** Every single-call (non-panel) family attempt a first sweep makes, derived
 * per property from the shipped registry. On a first sweep every family is
 * due, including the 28-day ones; see the weekly-cadence test. */
const DOMAIN_ATTEMPTS = LAUNCHED.reduce(
  (total, asset) =>
    total +
    dataForSeoFamiliesFor(asset).filter((family) => family !== 'serp-panel')
      .length,
  0,
);
/** Plus each configured tracked panel. */
const EXPECTED_ATTEMPTS = DOMAIN_ATTEMPTS + PANEL_ASSETS.length;
/** What a sweep owes once the 28-day families are fresh — every weekly family
 * for every property, plus the panels. The steady state, as opposed to the
 * cold-start number above. */
const WEEKLY_ATTEMPTS =
  LAUNCHED_ASSETS * DATAFORSEO_BASE_REPORTS.length + PANEL_ASSETS.length;
/** The 28-day families, as the suite asserts their absence from a weekly run. */
const PERIODIC_FAMILIES: readonly string[] = DATAFORSEO_PERIODIC_REPORTS;
const SERP_PATH = '/serp/google/organic/live/advanced';

interface FetchCall {
  url: string;
  authorization: string | null;
  task: Record<string, unknown>;
}

/** Retry waits the suite uses wherever a transient failure is in play: the same
 * two retries the collector ships with, without the four seconds of sleeping. */
const FAST_RETRY = [0, 0];

function providerFetch({
  failPath = null,
  failWith = null,
  failTimes = Number.POSITIVE_INFINITY,
  failSerpKeyword = null,
  aiOverview = true,
  accountBalanceUsd = null,
  accountFailWith = null,
}: {
  failPath?: string | null;
  /** The exact response `failPath` gets, when the shape of the failure is the
   * thing under test. Defaults to a 503 whose envelope carries the reason.
   * `headers` is how a 429 states its `Retry-After` — the one failure whose
   * repair is decided outside the body. */
  failWith?: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  } | null;
  /** How many calls to `failPath` fail before it starts answering — a blip
   * rather than an outage. Counted per property, so each one sees the same
   * failure and the same recovery. */
  failTimes?: number;
  /** One tracked query the provider accepts and cannot answer. */
  failSerpKeyword?: string | null;
  aiOverview?: boolean;
  /** The prepaid credit the free account endpoint reports. Null means the
   * account answered without a figure, which the collector treats as 'nothing
   * seen', never as a zero balance. */
  accountBalanceUsd?: number | null;
  /** What the free account read gets instead of an answer, when the failure of
   * that one call is the thing under test. */
  accountFailWith?: { status: number; body?: unknown } | null;
} = {}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const failuresByTarget = new Map<string, number>();
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const tasks =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>[])
        : [];
    const task = tasks[0] ?? {};
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      task,
    });
    // The free account read: never a report, never billed, and answered before
    // the fail/report branches so no paid-path condition applies to it.
    if (url.endsWith('/appendix/user_data')) {
      if (accountFailWith) {
        return Response.json(
          accountFailWith.body ?? { status_code: 50000, status_message: 'Unavailable.' },
          { status: accountFailWith.status },
        );
      }
      return Response.json({
        status_code: 20000,
        status_message: 'Ok.',
        tasks: [
          {
            status_code: 20000,
            result: [
              {
                login: 'op@example.test',
                ...(accountBalanceUsd === null ? {} : { money: { balance: accountBalanceUsd } }),
              },
            ],
          },
        ],
      });
    }

    if (failPath && url.endsWith(failPath)) {
      const key = String(task.target ?? task.keyword ?? '');
      const failed = failuresByTarget.get(key) ?? 0;
      if (failed < failTimes) {
        failuresByTarget.set(key, failed + 1);
        if (failWith) {
          return Response.json(failWith.body, {
            status: failWith.status,
            headers: failWith.headers,
          });
        }
        return Response.json(
          {
            status_code: 50000,
            status_message: 'Provider unavailable.',
            cost: 0,
            tasks: [],
          },
          { status: 503 },
        );
      }
    }

    const path = new URL(url).pathname;
    if (path.endsWith(SERP_PATH)) {
      if (task.keyword === failSerpKeyword) {
        return Response.json({
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0.004,
          tasks: [
            {
              status_code: 40501,
              status_message: 'Invalid Field: keyword.',
              cost: 0.004,
              result: null,
            },
          ],
        });
      }
      return Response.json({
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.004,
        tasks: [
          {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.004,
            result: [
              {
                keyword: task.keyword,
                items_count: 3,
                items: [
                  ...(aiOverview
                    ? [
                        {
                          type: 'ai_overview',
                          asynchronous_ai_overview: true,
                          references: [{ domain: 'meals.gov' }],
                        },
                      ]
                    : []),
                  {
                    type: 'organic',
                    rank_group: 2,
                    domain: 'meals.example',
                    url: 'https://meals.example/',
                  },
                ],
              },
            ],
          },
        ],
      });
    }

    const result =
      path.endsWith('/ranked_keywords/live')
        ? {
            items_count: 1,
            items: [
              {
                keyword_data: {
                  keyword: 'meal planner',
                  keyword_info: { search_volume: 9900, cpc: 1.42 },
                  keyword_properties: { keyword_difficulty: 18 },
                  search_intent_info: { main_intent: 'commercial' },
                },
                ranked_serp_element: {
                  serp_item: {
                    type: 'organic',
                    rank_group: 7,
                    rank_absolute: 9,
                    url: 'https://meals.example/meal-plan',
                    etv: 240,
                    estimated_paid_traffic_cost: 340.8,
                  },
                },
              },
            ],
          }
        : path.endsWith('/summary/live')
          ? {
              target: task.target,
              rank: 211,
              backlinks: 480,
              referring_domains: 120,
              referring_main_domains: 95,
            }
          : path.endsWith('/timeseries_new_lost_summary/live')
            ? {
                items_count: 1,
                items: [
                  {
                    date: '2026-07-26 00:00:00 +00:00',
                    new_backlinks: 8,
                    lost_backlinks: 3,
                    new_referring_domains: 4,
                    lost_referring_domains: 1,
                  },
                ],
              }
            : {
                total_count: 0,
                items_count: 0,
                aggregated_metrics: {
                  platform: [
                    {
                      key: task.platform,
                      mentions: 14,
                      ai_search_volume: 720,
                    },
                  ],
                },
              };

    return Response.json({
      status_code: 20000,
      status_message: 'Ok.',
      cost: 0.011,
      tasks: [
        {
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0.011,
          result: [result],
        },
      ],
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(async () => {
  await reset();
  await changeSites(['fees.example'], { status: 'live' });
});

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
        WHERE asset = 'meals.example'
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
      scope: { asset: 'meals.example', families: ['keyword-ideas'] },
    });
    const ideas = calls.find((call) =>
      call.url.endsWith('/dataforseo_labs/google/keyword_ideas/live'),
    );
    expect(ideas?.task).toMatchObject({
      keywords: PANEL_QUERIES,
      location_code: 2840,
      language_code: 'en',
      limit: 100,
      tag: 'meals.example:keyword-ideas',
    });
  });

  /** A property with no panel has no declared head terms, so it gets no ideas
   * rather than ideas grown from a guess — and asking for them by name is a
   * refusal, not a silent $0.00 success. */
  it('does not owe keyword ideas to a property with no tracked panel', () => {
    expect(dataForSeoFamiliesFor('pacer.example')).not.toContain(
      'keyword-ideas',
    );
    expect(dataForSeoFamiliesFor('pacer.example')).toContain(
      'serp-competitors',
    );
    expect(dataForSeoFamiliesFor('meals.example')).toContain('keyword-ideas');
  });

  it('fills only the missing families after a partial prior sweep', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meals.example', families: ['backlinks-summary'] },
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
          call.task.tag === 'meals.example:backlinks-summary',
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
      scope: { asset: 'meals.example', families: ['llm-mentions-google'] },
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
        asset: 'meals.example',
        report: 'backlinks-summary',
        latestReportDate: '2026-07-27',
        nextDueDate: '2026-08-03',
      });
      expect(complete?.skippedFresh).toContainEqual({
        asset: 'meals.example',
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
        asset: 'meals.example',
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
          WHERE asset = 'meals.example'
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

  /** DataForSEO's envelope status ('Ok.') is about the call being accepted and
   * says nothing about the task inside it; a failure row must not carry that
   * phrase as its reason. */
  describe('a failure never speaks in the provider’s success phrase', () => {
    async function backlinksFailures(): Promise<
      { errorCode: string; errorMessage: string }[]
    > {
      return (
        await pgAll<{ errorCode: string; errorMessage: string }>(`SELECT DISTINCT error_code AS "errorCode", error_message AS "errorMessage"
             FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo'
              AND report = 'backlinks-summary'
              AND status = 'error'`)
      ).results;
    }

    it('takes the failing task’s reason from under an "Ok." envelope', async () => {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 500,
          body: {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0,
            tasks: [
              {
                status_code: 50000,
                status_message: 'Internal Error.',
                cost: 0,
                result: null,
              },
            ],
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

      expect(result).toMatchObject({ failed: LAUNCHED_ASSETS });
      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_http_500',
          errorMessage: 'Internal Error. Gave up after 3 attempts.',
        },
      ]);
    });

    it('states the failure in its own words when every level says "Ok."', async () => {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 500,
          body: { status_code: 20000, status_message: 'Ok.', cost: 0, tasks: [] },
        },
      });
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });

      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_http_500',
          errorMessage:
            'DataForSEO backlinks-summary returned HTTP 500. Gave up after 3 attempts.',
        },
      ]);
    });

    it('names the family when an accepted task reports only that it was created', async () => {
      // 20100 "Task Created." is the async handshake, not an answer: the family
      // collected nothing, and the row must not claim a success phrase as why.
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith: {
          status: 200,
          body: {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.011,
            tasks: [
              {
                status_code: 20100,
                status_message: 'Task Created.',
                cost: 0.011,
                result: null,
              },
            ],
          },
        },
      });
      await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
      });

      expect(await backlinksFailures()).toEqual([
        {
          errorCode: 'dataforseo_task_20100',
          errorMessage: 'DataForSEO backlinks-summary returned no successful task.',
        },
      ]);
    });
  });

  /** A domain the provider has never crawled answers with an empty result:
   * that is an answer, not an unreadable response. */
  describe('a provider that holds nothing for a target has still answered', () => {
    const backlinksBody = (task: Record<string, unknown>) => ({
      status: 200,
      body: {
        status_code: 20000,
        status_message: 'Ok.',
        cost: 0.0102,
        tasks: [
          {
            status_code: 20000,
            status_message: 'Ok.',
            cost: 0.0102,
            ...task,
          },
        ],
      },
    });

    async function backlinksOutcomes(failWith: {
      status: number;
      body: unknown;
    }) {
      const { fetchImpl } = providerFetch({
        failPath: '/backlinks/summary/live',
        failWith,
      });
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        retryBackoffMs: FAST_RETRY,
      });
      return result.outcomes.filter(
        (outcome) => outcome.report === 'backlinks-summary',
      );
    }

    it('stores an explicit zero as a zero-row collection, body and all', async () => {
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 0, result: [] }),
      );

      expect(outcomes).toHaveLength(LAUNCHED_ASSETS);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: 'success',
          providerRows: 0,
          errorCode: null,
        });
        // The verbatim response is archived, so the NEXT reader of this shape
        // has the body itself rather than a 500-character error message — a
        // failed family writes a manifest row and no object at all.
        expect(typeof outcome.objectKey).toBe('string');
      }
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
              AND status = 'error'`,
        ),
      ).toBe(0);
    });

    it('will not read a response that contradicts itself as nothing', async () => {
      // `result_count: 1` with an empty array is not the provider counting to
      // zero, it is an answer we could not read. Storing it as an empty
      // success would turn "we could not read it" into "there was nothing".
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 1, result: [] }),
      );

      expect(outcomes[0]).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_invalid_response',
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      // The row says what the response carried, because no object was written
      // and this row is the whole of the evidence.
      expect(stored?.errorMessage).toBe(
        'DataForSEO backlinks-summary returned a task with no readable result ' +
          '(result_count 1, result items 0).',
      );
    });

    it('will not read a null result item as nothing either', async () => {
      const outcomes = await backlinksOutcomes(
        backlinksBody({ result_count: 1, result: [null] }),
      );

      expect(outcomes[0]).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_invalid_response',
      });
      const stored = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'dataforseo' AND report = 'backlinks-summary'
            AND status = 'error' LIMIT 1`);
      expect(stored?.errorMessage).toBe(
        'DataForSEO backlinks-summary returned a task with no readable result ' +
          '(result_count 1, result items 1).',
      );
    });
  });

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
        scope: { asset: 'meals.example', families: ['backlinks-summary'] },
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
        scope: { asset: 'meals.example', families: ['serp-panel'] },
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
          scope: { asset: 'nosh.example', families: ['backlinks-summary'] },
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
        asset: 'meals.example',
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

describe('tracked-query SERP panel', () => {
  /** The archived page envelope: what the collector stored about one provider
   * call. `body` is the only part that was transmitted. */
  interface ArchivedPage {
    request: {
      path: string;
      body: Record<string, unknown>;
      attempts: number;
      label?: string;
    };
    response: unknown;
  }

  async function archivedPanelPages(asset: string): Promise<ArchivedPage[]> {
    const row = await pgFirst<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel' AND asset = $1
          AND object_key IS NOT NULL
        ORDER BY run_seq DESC LIMIT 1`, [asset]);
    const object = await env.RAW_SIGNALS.get(row!.objectKey);
    return (
      JSON.parse(
        await new Response(
          object!.body.pipeThrough(new DecompressionStream('gzip')),
        ).text(),
      ) as { pages: ArchivedPage[] }
    ).pages;
  }

  it.each(['current', 'legacy', 'invalid', 'failed-read'] as const)(
    'resumes paid pages after interruption with %s checkpoints', async (mode) => {
    const panel = {
      assets: { 'meals.example': { queries: ['my plate', 'meals meal plan'] } },
    };
    const firstProvider = providerFetch();
    let attempted = 0;
    const interruptedFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      attempted += 1;
      if (attempted === 3) throw new Error('socket closed mid-panel');
      return firstProvider.fetchImpl(input, init);
    }) as typeof fetch;

    const interrupted = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: interruptedFetch,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [],
      serpPanelConfig: panel,
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });
    expect(interrupted).toMatchObject({ attempted: 1, failed: 1, costUsd: 0.008 });
    const workspacePrefix = `workspaces/${await env.STORE.workspaceId()}/`;
    const saved = (await env.RAW_SIGNALS.list({
      prefix: `${workspacePrefix}${DATAFORSEO_CHECKPOINT_PREFIX}/meals.example/2026-07-27/serp-panel/`,
    })).objects;
    expect(saved).toHaveLength(2);
    // A pre-upgrade paid page has the same request identity but no namespace.
    // Populate both paths for preference/failure controls, not a second provider.
    for (const { key } of saved) {
      const checkpoint = await env.RAW_SIGNALS.get(key);
      await env.RAW_SIGNALS.put(key.slice(workspacePrefix.length), await checkpoint!.text());
      if (mode === 'legacy') await env.RAW_SIGNALS.delete(key);
      if (mode === 'invalid') await env.RAW_SIGNALS.put(key, '{}');
    }
    const get = vi.spyOn(env.RAW_SIGNALS, 'get');
    if (mode === 'failed-read') get.mockRejectedValue(new Error('fixture object read failed'));

    const secondProvider = providerFetch();
    let resumed: Awaited<ReturnType<typeof runDataForSeoDumps>>;
    let readKeys: string[];
    try { resumed = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: secondProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [],
      serpPanelConfig: panel,
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });
      readKeys = get.mock.calls.map(([key]) => key as string);
    } finally { get.mockRestore(); }
    if (mode !== 'legacy') {
      // Missing pages may probe a proven legacy path too. The current/invalid
      // pages already present must never consult their older counterparts.
      const olderKeys = saved.map(({ key }) => key.slice(workspacePrefix.length));
      expect(readKeys!.filter((key) => olderKeys.includes(key))).toEqual([]);
    }
    if (mode === 'failed-read') {
      expect(secondProvider.calls).toHaveLength(0);
      expect(resumed!).toMatchObject({ attempted: 1, failed: 1, costUsd: 0 });
      return;
    }
    // Valid current/legacy pages are not re-bought. Invalid current bytes never
    // silently borrow the older object: all four requests must be observed anew.
    const newCalls = mode === 'invalid' ? 4 : 2;
    expect(secondProvider.calls).toHaveLength(newCalls);
    expect(resumed!).toMatchObject({ attempted: 1, succeeded: 1, costUsd: newCalls * 0.004 });
    expect(await archivedPanelPages('meals.example')).toHaveLength(4);
    const spend = await pgFirst<{ costUsd: number }>(`SELECT SUM(provider_cost_usd) AS "costUsd"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meals.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'`);
    expect(spend?.costUsd).toBeCloseTo(0.008 + newCalls * 0.004);
  });

  /** The refusal code one panel earns from the collector's own validation, or
   * null when the panel is fine. Checked directly because a sweep per case is
   * slow; `panelError` below proves a refusal reaches the sweep's outcome. */
  function panelRefusal(queries: SerpPanelQuery[]): string | null {
    try {
      trackedQueries({ assets: { 'meals.example': { queries } } }, 'meals.example');
      return null;
    } catch (error) {
      if (error instanceof SignalError) return error.code;
      throw error;
    }
  }

  /** The `config_invalid` code one panel earns from a whole sweep, or null when
   * the config is fine. */
  async function panelError(
    queries: SerpPanelQuery[],
    fetchImpl: typeof fetch,
  ): Promise<string | null | undefined> {
    await reset();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: { assets: { 'meals.example': { queries } } },
    });
    return result.outcomes.find((outcome) => outcome.report === 'serp-panel')
      ?.errorCode;
  }

  it('collects the configured panel as one archive of per-query result pages', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const panelCalls = calls.filter((call) => call.url.endsWith(SERP_PATH));
    // Every seeded panel's terms, verbatim and in file order, each asked once
    // per device, site by site in the order the site list gives them.
    expect(panelCalls.map((call) => call.task.keyword)).toEqual(
      (await inSiteOrder(PANEL_ASSETS)).flatMap((asset) =>
        panelKeywordOrder(panelEntries(asset).map(panelKeyword)),
      ),
    );
    expect(panelCalls[0]?.task).toMatchObject({
      location_code: 2840,
      language_code: 'en',
      device: 'mobile',
      depth: 20,
      load_async_ai_overview: true,
    });
    // The device rides in the request body, which is archived verbatim: that is
    // how an observation records its device with no manifest column. Devices are
    // asked in a fixed order, desktop last, so a query's two pages are adjacent;
    // which device a one-row-per-query reader reports is named in that reader.
    expect(
      panelCalls.slice(0, SERP_PANEL_DEVICES.length).map((call) => call.task.device),
    ).toEqual([...SERP_PANEL_DEVICES]);
    expect(SERP_PANEL_DEVICES.at(-1)).toBe('desktop');
    expect(panelCalls.at(-1)?.task.device).toBe('desktop');

    const manifest = await pgAll<{
      asset: string;
      reportDate: string;
      status: string;
      requestCount: number;
      providerTruncated: number;
      costUsd: number;
      objectKey: string;
    }>(`SELECT asset, report_date AS "reportDate", status, request_count AS "requestCount",
              provider_truncated AS "providerTruncated", provider_cost_usd AS "costUsd",
              object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'
        ORDER BY asset`);
    // One manifest row per property per run, not one per query.
    expect(manifest.results).toHaveLength(PANEL_ASSETS.length);
    const meals = manifest.results.find(
      (row) => row.asset === 'meals.example',
    );
    expect(meals).toMatchObject({
      reportDate: '2026-07-27',
      status: 'success',
      requestCount: panelCallCount(PANEL_QUERIES),
      // The panel reads two pages of a result set that continues past them.
      providerTruncated: 1,
    });
    // Both devices are billed and both land on the one manifest row, so the
    // Tower's month-to-date spend meter reads the real weekly bill without
    // knowing the panel gained a dimension.
    expect(meals!.costUsd).toBeCloseTo(panelCallCount(PANEL_QUERIES) * 0.004);
    // Each property is billed for its own terms, never the portfolio's.
    expect(
      manifest.results.reduce((sum, row) => sum + row.requestCount, 0),
    ).toBe(PANEL_CALLS);

    const object = await env.RAW_SIGNALS.get(meals!.objectKey);
    const archived = JSON.parse(
      await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text(),
    ) as { report: string; pages: { response: unknown }[] };
    expect(archived.report).toBe('serp-panel');
    expect(archived.pages).toHaveLength(panelCallCount(PANEL_QUERIES));
    expect(JSON.stringify(archived.pages[0])).toContain('ai_overview');
  });

  /** A phone reading and a desktop reading of the same term are two
   * observations. Both are pages of one archive, so the content hash compares
   * whole archives; this proves a provider answering both devices identically
   * still stores two distinguishable pages, because the archived request body
   * carries the device. */
  it('never lets one device\'s result page stand in for the other\'s', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: { assets: { 'meals.example': { queries: ['my plate'] } } },
    });

    const row = await pgFirst<{ objectKey: string; requestCount: number }>(`SELECT object_key AS "objectKey", request_count AS "requestCount"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'
          AND asset = 'meals.example'`);
    expect(row?.requestCount).toBe(SERP_PANEL_DEVICES.length);

    const object = await env.RAW_SIGNALS.get(row!.objectKey);
    const archived = JSON.parse(
      await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text(),
    ) as { pages: { request: { body: { keyword: string; device: string } } }[] };
    expect(
      archived.pages.map((page) => [page.request.body.keyword, page.request.body.device]),
    ).toEqual(SERP_PANEL_DEVICES.map((device) => ['my plate', device]));
  });

  /** The label is stored with the observation and nowhere else: the flattened
   * CSV derives only from the immutable archive, so a label looked up in
   * today's config would relabel already-collected rows when a cluster is
   * renamed. `device` is a provider field and is posted; the label is our
   * taxonomy and is not. */
  it('archives each query beside the cluster it measures, and tells the provider nothing new', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    // Nothing about the label is transmitted. The POSTed body carries the same
    // provider-documented fields it always did, and `tag` — the provider's own
    // free-text slot, which the label was NOT folded into — still holds exactly
    // the join key an archive reader matches on.
    for (const call of calls.filter((one) => one.url.endsWith(SERP_PATH))) {
      expect(call.task).not.toHaveProperty('label');
      expect(call.task.tag).toMatch(/^[a-z0-9.]+:serp-panel$/);
    }

    // Every page says which bet it was, one page per device, both carrying the
    // same label: a cluster is a property of the term, not of the surface.
    const nom = await archivedPanelPages('nosh.example');
    expect(
      nom.map((page) => [page.request.body.keyword, page.request.label]),
    ).toEqual(
      panelEntries('nosh.example').flatMap((entry) =>
        SERP_PANEL_DEVICES.map(() => [panelKeyword(entry), panelLabel(entry)]),
      ),
    );
    expect(new Set(nom.map((page) => page.request.label))).toEqual(
      new Set([
        'Calculator seam',
        'Item head',
        'Guide anomaly',
        'Category head',
        'GLP-1',
        'Stats hub',
        'Restaurant hubs',
      ]),
    );

    // An unlabelled panel archives the envelope it always archived — no `label`
    // key at all, rather than one holding an empty string. That is what lets an
    // older archive flatten to exactly the columns it had before labels existed.
    for (const page of await archivedPanelPages('meals.example')) {
      expect(Object.keys(page.request)).toEqual(['path', 'body', 'attempts']);
    }
  });

  it('rejects a mis-spelled cluster rather than quietly grouping by it', () => {
    // Labelling is optional per QUERY as well as per property: a panel may mix
    // the two shapes, and that must stay valid.
    expect(panelRefusal([{ query: 'my plate', label: 'Brand' }, 'meals calculator'])).toBeNull();
    // An entry that is neither shape names the file rather than collecting a
    // panel that means something else.
    expect(panelRefusal([42 as unknown as SerpPanelQuery])).toBe('config_invalid');
    // A blank label is not "no label" — omitting the field is.
    expect(panelRefusal([{ query: 'my plate', label: '  ' }])).toBe('config_invalid');
    expect(panelRefusal([{ query: 'my plate', label: 'x'.repeat(61) }])).toBe('config_invalid');
    // Grouping is an exact-string match on the archived label, so one cluster
    // spelled two ways is two bets in the readout and one in the operator's
    // head — the duplicate-query rule, applied to the group name.
    expect(
      panelRefusal([
        { query: 'my plate', label: 'Item head' },
        { query: 'big mac calories', label: 'item head' },
      ]),
    ).toBe('config_invalid');
  });

  it('skips a property with no panel configured without an attempt row', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const assets = await pgAll<{ asset: string }>(`SELECT DISTINCT asset FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'`);
    // Absence of config is not a failed collection: no success row, and no
    // error row either.
    expect(assets.results.map((row) => row.asset).sort()).toEqual(
      [...PANEL_ASSETS].sort(),
    );
  });

  it('publishes answered-query evidence as degraded and repairs only the failed query', async () => {
    const firstProvider = providerFetch({
      failSerpKeyword: PANEL_QUERIES[0],
    });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: firstProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });

    const panel = result.outcomes.find(
      (outcome) =>
        outcome.report === 'serp-panel' && outcome.asset === 'meals.example',
    );
    expect(panel?.status).toBe('success');
    const attempts = await pgAll<{
      status: string;
      errorCode: string | null;
      errorMessage: string | null;
      costUsd: number;
      costState: string;
    }>(`SELECT status, error_code AS "errorCode", error_message AS "errorMessage",
              provider_cost_usd AS "costUsd", cost_state AS "costState"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meals.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'
        ORDER BY run_seq`);
    expect(attempts.results).toHaveLength(2);
    expect(attempts.results[0]).toMatchObject({ status: 'success' });
    expect(attempts.results[1]).toMatchObject({
      status: 'error',
      errorCode: 'dataforseo_partial_40501',
      costUsd: 0,
      costState: 'reported',
    });
    // Counted values, then DataForSEO's own words.
    expect(attempts.results[1]!.errorMessage).toBe(
      '2 of 60 calls unanswered · 58 answered · DataForSEO: Invalid Field: keyword.',
    );
    expect(
      (
        await env.RAW_SIGNALS.list({
          prefix: `workspaces/${await env.STORE.workspaceId()}/${DATAFORSEO_CHECKPOINT_PREFIX}/meals.example/2026-07-27/serp-panel/`,
        })
      ).objects,
    ).toHaveLength(panelCallCount(PANEL_QUERIES));

    const repairProvider = providerFetch();
    const repair = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl: repairProvider.fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });
    // The two devices for the failed query are the only calls bought again.
    expect(repairProvider.calls).toHaveLength(SERP_PANEL_DEVICES.length);
    expect(repair).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await archivedPanelPages('meals.example')).toHaveLength(
      panelCallCount(PANEL_QUERIES),
    );
    const latest = await pgFirst<{ status: string }>(`SELECT status FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meals.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND report_date = '2026-07-27'
        ORDER BY finished_at DESC, id DESC LIMIT 1`);
    expect(latest?.status).toBe('success');
  });

  it('spends the bounded family retry budget on an internal search-engine task error', async () => {
    let attempts = 0;
    const provider = providerFetch();
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(SERP_PATH) && attempts < 2) {
        attempts += 1;
        return Response.json({
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          tasks: [
            {
              status_code: 40101,
              status_message: 'Internal SE Server Error.',
              cost: 0,
              result: null,
            },
          ],
        });
      }
      return provider.fetchImpl(input, init);
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [0, 0],
      serpPanelConfig: {
        assets: { 'meals.example': { queries: ['my plate'] } },
      },
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ retries: 2 });
    expect(provider.calls).toHaveLength(SERP_PANEL_DEVICES.length);
  });

  it('settles a reviewable partial panel after three failed attempts shared across calls', async () => {
    const provider = providerFetch();
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Array<{ keyword?: string }>;
      if (path.endsWith(SERP_PATH) && body[0]?.keyword === 'broken query') {
        return Response.json({
          status_code: 20000,
          status_message: 'Ok.',
          cost: 0,
          tasks: [
            {
              status_code: 40101,
              status_message: 'Internal SE Server Error.',
              cost: 0,
              result: null,
            },
          ],
        });
      }
      return provider.fetchImpl(input, init);
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      retryBackoffMs: [0, 0],
      serpPanelConfig: {
        assets: {
          'meals.example': { queries: ['broken query', 'observed query'] },
        },
      },
      scope: { asset: 'meals.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.outcomes[0]).toMatchObject({ retries: 2 });
    const marker = await pgFirst<{ errorMessage: string }>(`SELECT error_message AS "errorMessage"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meals.example' AND integration = 'dataforseo'
          AND report = 'serp-panel' AND status = 'error'
        ORDER BY run_seq DESC LIMIT 1`);
    expect(marker?.errorMessage).toBe(
      '2 of 4 calls unanswered after 3 attempts · 2 answered · DataForSEO: Internal SE Server Error.',
    );
  });

  it('fails the panel when the provider answered none of its queries', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push(url);
      if (!url.endsWith(SERP_PATH)) {
        return Response.json({
          status_code: 20000,
          cost: 0.011,
          tasks: [{ status_code: 20000, cost: 0.011, result: [{ items_count: 0 }] }],
        });
      }
      void init;
      return Response.json({
        status_code: 20000,
        cost: 0.004,
        tasks: [
          {
            status_code: 40501,
            status_message: 'Invalid Field: keyword.',
            cost: 0.004,
            result: null,
          },
        ],
      });
    }) as typeof fetch;

    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });

    const panels = result.outcomes.filter(
      (outcome) => outcome.report === 'serp-panel',
    );
    expect(panels).toHaveLength(PANEL_ASSETS.length);
    for (const panel of panels) {
      expect(panel).toMatchObject({
        status: 'error',
        errorCode: 'dataforseo_task_40501',
      });
    }
    // Every request was still billed and still counts against the cap.
    const spend = await pgFirst<{ costUsd: number }>(`SELECT SUM(provider_cost_usd) AS "costUsd" FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND report = 'serp-panel'`);
    expect(spend?.costUsd).toBeCloseTo(PANEL_CALLS * 0.004);
  });

  it('fails one property\'s panel for an over-cap config without touching the others', async () => {
    const { fetchImpl } = providerFetch();
    // One term past the enforced ceiling, which is what the $0.25 per-report
    // reserve buys at two devices and $0.004 a call.
    const overCapPanel = {
      assets: {
        'meals.example': {
          queries: Array.from(
            { length: PANEL_CEILING + 1 },
            (_, index) => `query ${index}`,
          ),
        },
      },
    };
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      serpPanelConfig: overCapPanel,
    });

    expect(
      result.outcomes.find((outcome) => outcome.report === 'serp-panel'),
    ).toMatchObject({
      asset: 'meals.example',
      status: 'error',
      errorCode: 'config_invalid',
    });
    // The over-cap panel is the only casualty — not `keyword-ideas`, which reads
    // the same config to seed one call and has no stake in a per-(query, device)
    // cost ceiling. Counted against the injected panel, since that decides which
    // properties are due panel-seeded families at all.
    expect(result.failed).toBe(1);
    expect(
      result.outcomes.filter((outcome) => outcome.status === 'error'),
    ).toHaveLength(1);
    expect(result.succeeded).toBe(
      LAUNCHED.reduce(
        (total, asset) =>
          total +
          dataForSeoFamiliesFor(asset, overCapPanel).filter(
            (family) => family !== 'serp-panel',
          ).length,
        0,
      ),
    );
    expect(
      result.outcomes.some((outcome) => outcome.report === 'keyword-ideas'),
    ).toBe(true);
  });

  /** The gate reserves $0.25 for a family before it calls, and the panel is the
   * only family whose cost is a function of config, so the ceiling must be
   * whatever that reserve buys. The invariant is asserted, not the number. */
  it('keeps the biggest legal panel inside the reserve its gate takes', async () => {
    expect(PANEL_CEILING * SERP_PANEL_DEVICES.length * CALL_USD).toBeLessThanOrEqual(
      REPORT_RESERVE_USD,
    );
    expect(
      (PANEL_CEILING + 1) * SERP_PANEL_DEVICES.length * CALL_USD,
    ).toBeGreaterThan(REPORT_RESERVE_USD);
    // That every shipped panel still fits under it is a check of the committed
    // file, in config-seeds.test.ts.
  });

  it('rejects an empty or duplicated panel rather than quietly repairing it', async () => {
    expect(panelRefusal([])).toBe('config_invalid');
    expect(panelRefusal(['my plate', 'My Plate'])).toBe('config_invalid');
    expect(panelRefusal(['my plate', '  '])).toBe('config_invalid');
    // The object form is held to the same two rules as the shorthand.
    expect(panelRefusal([{ query: 'my plate' }, { query: 'My Plate', label: 'Brand' }])).toBe('config_invalid');
    expect(panelRefusal([{ query: '  ' }])).toBe('config_invalid');
    // And a refused panel is the sweep's own outcome for that property, not a
    // repair it quietly made.
    const { fetchImpl, calls } = providerFetch();
    expect(await panelError(['my plate', 'My Plate'], fetchImpl)).toBe('config_invalid');
    expect(calls.filter((call) => call.url.endsWith(SERP_PATH))).toEqual([]);
  });
});

/** A scope is not a second collector: it narrows the sweep plan and nothing
 * else, so what lands is what the Monday lane would have landed for that
 * property. */
describe('a scoped run — the same run, narrowed', () => {
  const NOM_QUERIES = panelEntries('nosh.example');

  /** Every column a downstream reader joins, filters or renders on. `id` is a
   * UUID and `finished_at` is the wall clock at write; everything else must be
   * identical between the two doors. */
  async function manifestRow(
    asset: string,
    report: string,
  ): Promise<Record<string, unknown> | null> {
    return pgFirst(`SELECT asset, integration, report, credential_ref, property_ref, report_date,
              requested_at, status, data_state, schema_version, provider_rows,
              request_count, provider_truncated, object_key, content_sha256,
              object_bytes, error_code, error_message, provider_cost_usd
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'dataforseo' AND asset = $1 AND report = $2`, [asset, report]);
  }

  async function archivedText(objectKey: string): Promise<string> {
    const object = await env.RAW_SIGNALS.get(objectKey);
    return new Response(
      object!.body.pipeThrough(new DecompressionStream('gzip')),
    ).text();
  }

  /** The panel-review filer, the daily refresh and the lane evidence read these
   * rows, and none may need to know which door a run came through. */
  it('lands a row indistinguishable from the Monday one', async () => {
    const { fetchImpl } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
    });
    const weekly = await manifestRow('nosh.example', 'serp-panel');
    const weeklyArchive = await archivedText(weekly!.object_key as string);

    await reset();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'nosh.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await manifestRow('nosh.example', 'serp-panel')).toEqual(weekly);
    // Down to the archived bytes: same object key, same content hash, same body.
    expect(await archivedText(weekly!.object_key as string)).toBe(weeklyArchive);
  });

  it('bills one property and never touches another', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'nosh.example' },
    });

    // Everything nosh.example is due, and nothing else at all.
    expect(result.outcomes.map((outcome) => outcome.report)).toEqual(
      dataForSeoFamiliesFor('nosh.example'),
    );
    expect(calls.every((call) => String(call.task.tag ?? '').startsWith('nosh.example:'))).toBe(
      true,
    );
    expect(
      (
        await pgAll<{ asset: string }>(`SELECT DISTINCT asset FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`)
      ).results,
    ).toEqual([{ asset: 'nosh.example' }]);
    // Every single-call family this property is due, at the stub's $0.011,
    // plus the panel's per-call price. Derived, so a family added to the
    // registry shows up here as spend rather than as a red test.
    const singleCall = dataForSeoFamiliesFor('nosh.example').filter(
      (family) => family !== 'serp-panel',
    ).length;
    expect(result.costUsd).toBeCloseTo(
      singleCall * 0.011 + panelCallCount(NOM_QUERIES) * 0.004,
    );
  });

  it('keeps the cheap families ahead of the long one inside a single property', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'nosh.example' },
    });

    // Breadth-first survives the narrowing: an interruption during the panel
    // cannot take the cheap families with it.
    const firstPanelCall = calls.findIndex((call) => call.url.endsWith(SERP_PATH));
    expect(firstPanelCall).toBe(
      dataForSeoFamiliesFor('nosh.example').filter((f) => f !== 'serp-panel').length,
    );
    expect(calls.slice(firstPanelCall).every((call) => call.url.endsWith(SERP_PATH))).toBe(
      true,
    );
  });

  it('asks for SERP competitors without the property itself among them', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'meals.example', families: ['serp-competitors'] },
    });

    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    const asked = calls.filter((call) => call.url.endsWith('/competitors_domain/live'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.task).toMatchObject({
      target: 'meals.example',
      filters: [['intersections', '>', 0], 'and', ['domain', '<>', 'meals.example']],
    });
  });

  /**
   * Defense in depth. `POST /api/signal-collect` turns this into a 422 before
   * anything runs, but the runner must not bill a family a property does not own
   * even if something later calls it directly: `families` can only ever REMOVE
   * from the set `appliesTo` allows.
   */
  it('cannot be talked into a family the property does not own', async () => {
    const { fetchImpl, calls } = providerFetch();
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: { asset: 'pacer.example', families: ['serp-panel'] },
    });

    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0, costUsd: 0 });
    expect(calls).toHaveLength(0);
    expect(
      await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'dataforseo'`),
    ).toBe(0);
  });

  it('cannot reach a property the weekly lane would not collect', async () => {
    const { fetchImpl, calls } = providerFetch();
    // Lifecycle is a mutable store fact; put fees.example back before launch to
    // prove the gate still excludes it.
    await changeSites(['fees.example'], { status: 'pre-launch' });
    for (const asset of ['fees.example', 'root-os', 'not-a-property']) {
      const result = await runDataForSeoDumps(env, {
        nowMs: NOW,
        fetchImpl,
        login: 'operator-login',
        password: 'operator-password',
        scope: { asset },
      });
      expect(result.attempted).toBe(0);
    }
    expect(calls).toHaveLength(0);
  });

  /** `backlinks-summary` returns a referring-domain count and
   * `backlinks-new-lost` its weekly delta; neither names a domain. Both
   * orderings are asserted because a 100-row cap filled by whichever scraper
   * farm links most would answer a different question. */
  it('asks for referring domains by rank and anchors by reach', async () => {
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      login: 'operator-login',
      password: 'operator-password',
      scope: {
        asset: 'nosh.example',
        families: ['backlinks-referring-domains', 'backlinks-anchors'],
      },
    });

    const domains = calls.find((call) =>
      call.url.endsWith('/backlinks/referring_domains/live'),
    );
    expect(domains?.task).toMatchObject({
      target: 'nosh.example',
      include_subdomains: true,
      backlinks_status_type: 'live',
      limit: 100,
      order_by: ['rank,desc'],
      tag: 'nosh.example:backlinks-referring-domains',
    });

    const anchors = calls.find((call) =>
      call.url.endsWith('/backlinks/anchors/live'),
    );
    expect(anchors?.task).toMatchObject({
      target: 'nosh.example',
      include_subdomains: true,
      backlinks_status_type: 'live',
      limit: 100,
      order_by: ['referring_domains,desc'],
      tag: 'nosh.example:backlinks-anchors',
    });

    // One call each, and nothing else bought on the way past.
    expect(calls).toHaveLength(2);
  });

  /** The row cap is a cost decision, so it is pinned against the reserve:
   * backlinks bills per request plus per row, and a family that could outspend
   * the reserve its own gate takes is how a cap gets crossed. */
  it('keeps a full-limit backlinks call inside the per-family reserve', () => {
    const worstCaseUsd = 0.024 + 100 * 0.000036;
    expect(worstCaseUsd).toBeLessThan(REPORT_RESERVE_USD);
  });

  /** The route validates `families` against this exported list, so the two can
   * never name different families. */
  it('publishes the family names the route validates against', () => {
    expect([...DATAFORSEO_REPORTS].sort()).toEqual(
      [
        ...DATAFORSEO_BASE_REPORTS,
        ...DATAFORSEO_PERIODIC_REPORTS,
        DATAFORSEO_PANEL_REPORT,
      ].sort(),
    );
    // What a week owes and what may be requested are different questions: the
    // requestable set is a superset by exactly the periodic families this
    // property is due.
    const weekly = dataForSeoReportsFor('nosh.example', new Set(PANEL_ASSETS));
    const requestable = dataForSeoFamiliesFor('nosh.example');
    expect(weekly.every((family) => requestable.includes(family))).toBe(true);
    expect(
      requestable
        .filter((family) => !(weekly as string[]).includes(family))
        .sort(),
    ).toEqual([...DATAFORSEO_PERIODIC_REPORTS].sort());
    expect(dataForSeoFamiliesFor('pacer.example')).not.toContain('serp-panel');
    expect(dataForSeoFamiliesFor('areas.example')).toContain('serp-panel');
    expect(dataForSeoFamiliesFor('nosh.example')).toContain('serp-panel');
  });
});

// The prepaid balance decides whether next Monday's sweep can run, and the paid
// report endpoints never state it, so the sweep makes one read of the free
// account endpoint at the end of a run that worked. These pin the price of that:
// one extra call, zero spend, no retry, nothing from a run that failed or had
// nothing to do, and a failure of the read that leaves the sweep green.

const ACCOUNT_PATH = '/appendix/user_data';

describe('DataForSEO account credit', () => {
  /** The password never appears in a verdict, a log or this file's assertions —
   * it is here only so the sweep runs off the STORE rather than off options,
   * which is the only path that stamps a credential. */
  const DFS_PASSWORD = 'SEKRIT-dataforseo-sweep-do-not-echo';
  /** One property, one family: the smallest sweep that still buys something. */
  const ONE_FAMILY = { asset: 'meals.example', families: ['backlinks-summary'] };

  async function storeCredential(): Promise<void> {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
  }

  function accountCalls(calls: FetchCall[]): FetchCall[] {
    return calls.filter((call) => call.url.endsWith(ACCOUNT_PATH));
  }

  it('refreshes the credit with one free read at the end of a sweep that worked', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({ accountBalanceUsd: 12.34 });
    const result = await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    // ONE report, ONE account read, and the account read is last: the run does
    // not spend a call asking about credit it may not get to use.
    expect(calls).toHaveLength(2);
    expect(accountCalls(calls)).toHaveLength(1);
    expect(calls.at(-1)!.url).toContain(ACCOUNT_PATH);
    // Free. The run's billed total is the report's cost and nothing else.
    expect(result.costUsd).toBeCloseTo(0.011, 6);

    const summary = (await credentialSummary(env, 'dataforseo'))!;
    // WITH the instant, always: the card renders "seen 2h ago" off this, and a
    // figure that lost its stamp would be renderable as though it were current.
    expect(summary.metadata?.balance).toEqual({
      usd: '12.34',
      seenAt: new Date(NOW).toISOString(),
    });
  });

  it('records nothing when the account states no figure — an absent one is not a zero', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch();
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    expect(accountCalls(calls)).toHaveLength(1);
    const summary = (await credentialSummary(env, 'dataforseo'))!;
    expect(summary.metadata?.balance ?? null).toBeNull();
    // And the verdict this sweep DID prove is untouched by the absence.
    expect(summary.lastOkAt).not.toBeNull();
  });

  it('asks nothing and records nothing when every report in the sweep failed', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({
      failPath: '/backlinks/summary/live',
      accountBalanceUsd: 12.34,
    });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      retryBackoffMs: FAST_RETRY,
      scope: ONE_FAMILY,
    });

    expect(result.failed).toBe(1);
    // A run that just proved it cannot reach this provider does not ask it one
    // more question, and the card keeps its last sighting with its age.
    expect(accountCalls(calls)).toHaveLength(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
  });

  it('asks nothing when the sweep had nothing due', async () => {
    await storeCredential();
    const { fetchImpl } = providerFetch({ accountBalanceUsd: 12.34 });
    await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl });
    const second = providerFetch({ accountBalanceUsd: 99.99 });
    const repeat = await runDataForSeoDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl: second.fetchImpl,
    });

    // Automation inside the cadence buys nothing, so there is no run to refresh
    // anything at the end of — and the earlier sighting stands, unmoved.
    expect(repeat.attempted).toBe(0);
    expect(second.calls).toHaveLength(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance).toEqual({
      usd: '12.34',
      seenAt: new Date(NOW).toISOString(),
    });
  });

  it('stays green and never retries when the free read itself fails', async () => {
    await storeCredential();
    const { fetchImpl, calls } = providerFetch({ accountFailWith: { status: 503 } });
    const result = await runDataForSeoDumps(env, {
      nowMs: NOW,
      fetchImpl,
      retryBackoffMs: FAST_RETRY,
      scope: ONE_FAMILY,
    });

    // The reports are what a sweep is judged on, and they landed.
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(1);
    // ONE attempt. A courtesy read has nothing to lose by not being repeated.
    expect(accountCalls(calls)).toHaveLength(1);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
    // And the sweep's own verdict on the credential is still the reports'.
    expect((await credentialSummary(env, 'dataforseo'))!.lastOkAt).not.toBeNull();
  });

  it('stays green when the read never gets an answer at all', async () => {
    await storeCredential();
    const provider = providerFetch({ accountBalanceUsd: 12.34 });
    // What an egress refusal looks like from in here: the call throws.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith(ACCOUNT_PATH)) throw new Error('blocked');
      return provider.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl, scope: ONE_FAMILY });

    expect(result.failed).toBe(0);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance ?? null).toBeNull();
  });

  it('says on the completion line whether the credit was refreshed, and never the figure', async () => {
    await storeCredential();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const first = providerFetch({ accountBalanceUsd: 12.34 });
      await runDataForSeoDumps(env, { nowMs: NOW, fetchImpl: first.fetchImpl, scope: ONE_FAMILY });
      expect(completionLine(log)).toMatchObject({ accountCredit: 'refreshed' });
      // The amount is on the card with its age; a log file is not where an
      // account balance belongs.
      expect(JSON.stringify(completionLine(log))).not.toContain('12.34');

      log.mockClear();
      const second = providerFetch({ accountFailWith: { status: 503 } });
      await runDataForSeoDumps(env, {
        nowMs: NOW + 8 * 86_400_000,
        fetchImpl: second.fetchImpl,
        scope: ONE_FAMILY,
      });
      expect(completionLine(log)).toMatchObject({ accountCredit: 'not refreshed' });
    } finally {
      log.mockRestore();
    }
  });

  function completionLine(log: MockInstance<typeof console.log>): Record<string, unknown> {
    const events = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    return events.find((event) => event.event === 'dataforseo_dumps_complete')!;
  }
});

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
    hygiene.recordUnmeasured('meals.example');
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
