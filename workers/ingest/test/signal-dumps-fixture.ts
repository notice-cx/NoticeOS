// What the signal-dump collector's test files share: the fixture portfolio's
// counts and a fake GSC, GA4 and Bing. The suite is several files
// (signal-dumps*.test.ts) because Vitest runs each file on one worker, and its
// sweeps are slow.
import { expect } from 'vitest';

export const NOW = Date.parse('2026-07-29T12:15:00.000Z');
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Every domain-bearing, non-retired property the seed carries, each asked for
 * the same six Bing report families. Bing verifies all of them below, so another
 * property is six more archives, not six more failures. */
export const BING_PROPERTIES = 6;
export const BING_ATTEMPTS = BING_PROPERTIES * 6;
/** `queries` and `pages`: the two families Microsoft refreshes weekly, so a
 * second run for the same date does not ask for them again. */
export const BING_WEEKLY_FAMILIES = 2;
export const BING_WEEKLY_ATTEMPTS = BING_PROPERTIES * BING_WEEKLY_FAMILIES;
/** The Google properties vitest.config.ts maps onto the test service account.
 * Two, so that collecting every configured property and collecting the first
 * one are different numbers: a loop that breaks where it should continue, or
 * a candidate list read as `[0]`, fails here. */
export const GOOGLE_PROPERTIES = ['meadow.example', 'northwind.example'] as const;
/** Ten GSC families and eleven GA4 families, both properties buying the same set —
 * `js-errors` and `event-source` included, since config/ga4-custom-dimensions.json registers the
 * event parameters for both. */
export const GOOGLE_FAMILIES = 21;
export const GOOGLE_ATTEMPTS = GOOGLE_PROPERTIES.length * GOOGLE_FAMILIES;
export const EXPECTED_ATTEMPTS = BING_ATTEMPTS + GOOGLE_ATTEMPTS;

export interface FetchFixture {
  fetchImpl: typeof fetch;
  calls: { url: string; body: Record<string, unknown> | null }[];
}

export function providerDumpFetch({
  failGscPageQuery = false,
  failBingReport = null,
  emptyDiscover = false,
  unregisteredCustomDimensions = false,
  bingQueryClicks = 7,
  ga4Quota = null,
}: {
  failGscPageQuery?: boolean;
  failBingReport?: string | null;
  emptyDiscover?: boolean;
  /** Answer any request for an event parameter the way GA4 answers one nobody
   * has registered as a custom dimension. */
  unregisteredCustomDimensions?: boolean;
  /** Move the top-query snapshot, the way a real weekly refresh would. */
  bingQueryClicks?: number;
  /** What the Data API reports the property has spent and has left. */
  ga4Quota?: { consumed: number; remaining: number } | null;
} = {}): FetchFixture {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ url, body });
    if (url === TOKEN_URL) {
      return Response.json({ access_token: 'dump-access-token', expires_in: 3600 });
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === 'ssl.bing.com') {
      expect(parsedUrl.searchParams.get('apikey')).toBe('test-bing-key');
      const method = parsedUrl.pathname.split('/').at(-1);
      if (method === 'GetUserSites') {
        return Response.json({
          d: [
            { Url: 'https://meadow.example/', IsVerified: true },
            { Url: 'https://northwind.example/', IsVerified: true },
            { Url: 'https://pebble.example/', IsVerified: true },
            { Url: 'https://puffin.example/', IsVerified: true },
            { Url: 'https://acorn.example/', IsVerified: true },
            { Url: 'https://ferns.example/', IsVerified: true },
          ],
        });
      }
      if (method === failBingReport) {
        return Response.json(
          { Message: 'Bing report denied' },
          { status: 403 },
        );
      }
      const date = `/Date(${Date.parse('2026-07-27T00:00:00.000Z')})/`;
      if (method === 'GetRankAndTrafficStats') {
        return Response.json({ d: [{ Date: date, Clicks: 19, Impressions: 410 }] });
      }
      if (method === 'GetQueryStats') {
        return Response.json({
          d: [{
            Date: date,
            Query: 'weekly meal plan',
            Clicks: bingQueryClicks,
            Impressions: 140,
            AvgClickPosition: 5,
            AvgImpressionPosition: 8,
          }],
        });
      }
      if (method === 'GetPageStats') {
        return Response.json({
          d: [{
            Date: date,
            Query: 'https://meadow.example/meal-plan',
            Clicks: 9,
            Impressions: 190,
            AvgClickPosition: 4,
            AvgImpressionPosition: 7,
          }],
        });
      }
      if (method === 'GetCrawlStats') {
        return Response.json({
          d: [{
            Date: date,
            CrawledPages: 120,
            InIndex: 95,
            Code2xx: 118,
            Code4xx: 2,
            Code5xx: 0,
            CrawlErrors: 2,
            ContainsMalware: 0,
            BlockedByRobotsTxt: 0,
          }],
        });
      }
      if (method === 'GetCrawlIssues') {
        return Response.json({
          d: [{
            Url: 'https://meadow.example/old-page',
            HttpCode: 404,
            Issues: 4,
            InLinks: 3,
          }],
        });
      }
      if (method === 'GetFeeds') {
        return Response.json({
          d: [{
            Url: 'https://meadow.example/sitemap.xml',
            Type: 'Sitemap',
            Status: 'Success',
            UrlCount: 95,
            LastCrawled: date,
            Submitted: date,
          }],
        });
      }
    }
    if (url.includes('/searchAnalytics/query')) {
      const dimensions = Array.isArray(body?.dimensions)
        ? body.dimensions.filter((value): value is string => typeof value === 'string')
        : [];
      if (
        failGscPageQuery &&
        body?.type === 'web' &&
        dimensions.join(',') === 'page,query'
      ) {
        return Response.json(
          { error: { message: 'Search Console report denied' } },
          { status: 403 },
        );
      }
      // Search Console answers a property with no data for a search type with
      // a body that carries no `rows` key at all.
      if (emptyDiscover && body?.type === 'discover') return Response.json({});
      return Response.json({
        rows: [
          {
            keys: dimensions.map((dimension) => `${dimension}-value`),
            clicks: 11,
            impressions: 210,
            ctr: 11 / 210,
            position: 7.4,
          },
        ],
        responseAggregationType: 'byPage',
      });
    }
    if (url.includes('analyticsdata.googleapis.com')) {
      const dimensions = Array.isArray(body?.dimensions) ? body.dimensions : [];
      const metrics = Array.isArray(body?.metrics) ? body.metrics : [];
      const custom = dimensions
        .map((entry) =>
          entry !== null && typeof entry === 'object' && 'name' in entry
            ? String(entry.name)
            : '',
        )
        .filter((name) => name.startsWith('customEvent:'));
      if (unregisteredCustomDimensions && custom.length > 0) {
        // The Data API's real shape for a field it does not know about.
        return Response.json(
          {
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: `Field ${custom[0]} is not a valid dimension. For a list of valid dimensions and metrics, see https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema`,
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        dimensionHeaders: dimensions.map((entry) => ({
          name:
            entry !== null && typeof entry === 'object' && 'name' in entry
              ? String(entry.name)
              : '',
        })),
        metricHeaders: metrics.map((entry) => ({
          name:
            entry !== null && typeof entry === 'object' && 'name' in entry
              ? String(entry.name)
              : '',
          type: 'TYPE_INTEGER',
        })),
        rows: [
          {
            dimensionValues: dimensions.map((_, index) => ({ value: `dimension-${index}` })),
            metricValues: metrics.map((_, index) => ({ value: String(index + 1) })),
          },
        ],
        rowCount: 1,
        metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' },
        ...(ga4Quota
          ? {
              propertyQuota: {
                tokensPerDay: ga4Quota,
                tokensPerHour: { consumed: 1, remaining: 39_999 },
              },
            }
          : {}),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
