// What the DataForSEO collector's test files share: the frozen panel's counts
// and a fake provider. The suite is several files (dataforseo-dumps*.test.ts)
// because Vitest runs each file on one worker, and its sweeps are slow.
import { DATAFORSEO_BASE_REPORTS, DATAFORSEO_PERIODIC_REPORTS, SERP_PANEL_DEVICES } from '@noticeos/contract';
import { dataForSeoFamiliesFor, type SerpPanelQuery } from '../src/dataforseo-dumps.js';
import serpPanelConfig from './fixture-config/serp-panel.json';
import { reset } from './helpers.js';
import { changeSites } from './sites';

export const NOW = Date.parse('2026-07-27T12:45:00.000Z');
/** The suite's frozen copy of config/serp-panel.json, never the checkout's
 * own. Whether every shipped panel fits its reserve is checked on the real
 * file in config-seeds.test.ts. */
export const PANEL_ASSETS = Object.keys(serpPanelConfig.assets);

/** A panel entry is a bare query or a query carrying the cluster it measures. */
export function panelEntries(asset: string): SerpPanelQuery[] {
  return (serpPanelConfig.assets as Record<string, { queries: SerpPanelQuery[] }>)[
    asset
  ]!.queries;
}
export const panelKeyword = (entry: SerpPanelQuery): string =>
  typeof entry === 'string' ? entry : entry.query;
export const panelLabel = (entry: SerpPanelQuery): string | undefined =>
  typeof entry === 'string' ? undefined : entry.label;

export const PANEL_QUERIES = panelEntries('meadow.example').map(panelKeyword);
/** Every panel call a property buys: one per tracked query per device,
 * derived from the shipped device list. The cluster label is never
 * transmitted and costs nothing. */
export const panelCallCount = (entries: readonly unknown[]): number =>
  entries.length * SERP_PANEL_DEVICES.length;
/** Every panel call across every seeded property: this — not the property
 * count — is the bill. */
export const PANEL_CALLS = Object.values(serpPanelConfig.assets).reduce(
  (sum, entry) => sum + panelCallCount(entry.queries),
  0,
);
/** The panel's terms in the order the collector asks for them: each query on
 * every device, devices inner, so a query's two result pages are adjacent and
 * the DESKTOP call is the last word on that query. */
export const panelKeywordOrder = (queries: readonly string[]): string[] =>
  queries.flatMap((keyword) => SERP_PANEL_DEVICES.map(() => keyword));
/** The collector covers every property past pre-launch; the suite sets that
 * lifecycle fact in beforeEach. */
export const LAUNCHED_ASSETS = 6;
/** The launched properties by name, so a count is derived per property:
 * `keyword-ideas` seeds from the tracked panel, so a property without one is
 * not due it. */
export const LAUNCHED = [
  'acorn.example',
  'ferns.example',
  'meadow.example',
  'northwind.example',
  'pebble.example',
  'puffin.example',
] as const;
/** Every single-call (non-panel) family attempt a first sweep makes, derived
 * per property from the shipped registry. On a first sweep every family is
 * due, including the 28-day ones; see the weekly-cadence test. */
export const DOMAIN_ATTEMPTS = LAUNCHED.reduce(
  (total, asset) =>
    total +
    dataForSeoFamiliesFor(asset).filter((family) => family !== 'serp-panel')
      .length,
  0,
);
/** Plus each configured tracked panel. */
export const EXPECTED_ATTEMPTS = DOMAIN_ATTEMPTS + PANEL_ASSETS.length;
/** What a sweep owes once the 28-day families are fresh — every weekly family
 * for every property, plus the panels. The steady state, as opposed to the
 * cold-start number above. */
export const WEEKLY_ATTEMPTS =
  LAUNCHED_ASSETS * DATAFORSEO_BASE_REPORTS.length + PANEL_ASSETS.length;
/** The 28-day families, as the suite asserts their absence from a weekly run. */
export const PERIODIC_FAMILIES: readonly string[] = DATAFORSEO_PERIODIC_REPORTS;
export const SERP_PATH = '/serp/google/organic/live/advanced';

export interface FetchCall {
  url: string;
  authorization: string | null;
  task: Record<string, unknown>;
}

/** Retry waits the suite uses wherever a transient failure is in play: the same
 * two retries the collector ships with, without the four seconds of sleeping. */
export const FAST_RETRY = [0, 0];

export function providerFetch({
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
                          references: [{ domain: 'registry.example' }],
                        },
                      ]
                    : []),
                  {
                    type: 'organic',
                    rank_group: 2,
                    domain: 'meadow.example',
                    url: 'https://meadow.example/',
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
                    url: 'https://meadow.example/meal-plan',
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

/** The free account read, which states the prepaid credit and bills nothing. */
export const ACCOUNT_PATH = '/appendix/user_data';

/** Each test's start: an empty store, with ferns.example launched (`LAUNCHED`). */
export async function resetWithFernsLaunched(): Promise<void> {
  await reset();
  await changeSites(['ferns.example'], { status: 'live' });
}
