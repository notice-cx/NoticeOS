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
  pgAll,
  pgCount,
  pgFirst,
  pgRows,
  reset,
  storeArchiveRun,
  storedHealthStates,
} from './helpers.js';

const NOW = Date.parse('2026-07-29T12:15:00.000Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Every domain-bearing, non-retired property the seed carries, each asked for
 * the same six Bing report families. Bing verifies all of them below, so another
 * property is six more archives, not six more failures. */
const BING_PROPERTIES = 6;
const BING_ATTEMPTS = BING_PROPERTIES * 6;
/** `queries` and `pages`: the two families Microsoft refreshes weekly, so a
 * second run for the same date does not ask for them again. */
const BING_WEEKLY_FAMILIES = 2;
const BING_WEEKLY_ATTEMPTS = BING_PROPERTIES * BING_WEEKLY_FAMILIES;
/** The Google properties vitest.config.ts maps onto the test service account.
 * Two, so that collecting every configured property and collecting the first
 * one are different numbers: a loop that breaks where it should continue, or
 * a candidate list read as `[0]`, fails here. */
const GOOGLE_PROPERTIES = ['meals.example', 'nosh.example'] as const;
/** Ten GSC families and nine GA4 families, both properties buying the same set —
 * `js-errors` included, since config/ga4-custom-dimensions.json registers the
 * event parameters for both. */
const GOOGLE_FAMILIES = 19;
const GOOGLE_ATTEMPTS = GOOGLE_PROPERTIES.length * GOOGLE_FAMILIES;
const EXPECTED_ATTEMPTS = BING_ATTEMPTS + GOOGLE_ATTEMPTS;

interface FetchFixture {
  fetchImpl: typeof fetch;
  calls: { url: string; body: Record<string, unknown> | null }[];
}

function providerDumpFetch({
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
            { Url: 'https://meals.example/', IsVerified: true },
            { Url: 'https://nosh.example/', IsVerified: true },
            { Url: 'https://pacer.example/', IsVerified: true },
            { Url: 'https://pullups.example/', IsVerified: true },
            { Url: 'https://areas.example/', IsVerified: true },
            { Url: 'https://fees.example/', IsVerified: true },
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
            Query: 'https://meals.example/meal-plan',
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
            Url: 'https://meals.example/old-page',
            HttpCode: 404,
            Issues: 4,
            InLinks: 3,
          }],
        });
      }
      if (method === 'GetFeeds') {
        return Response.json({
          d: [{
            Url: 'https://meals.example/sitemap.xml',
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

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
  it('archives bounded provider responses in local R2 and deduplicates unchanged revisions', async () => {
    const { fetchImpl, calls } = providerDumpFetch();
    const first = await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl,
      revisionDays: 1,
    });

    expect(first).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: EXPECTED_ATTEMPTS,
      unchanged: 0,
      failed: 0,
      skipped: 0,
    });
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(2);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(EXPECTED_ATTEMPTS);
    const listed = await env.RAW_SIGNALS.list();
    expect(listed.objects).toHaveLength(EXPECTED_ATTEMPTS);

    const manifest = await pgFirst<{
      reportDate: string;
      status: string;
      dataState: string;
      providerRows: number;
      requestCount: number;
      objectKey: string;
      contentSha256: string;
    }>(`SELECT report_date AS "reportDate", status, data_state AS "dataState",
              provider_rows AS "providerRows", request_count AS "requestCount",
              object_key AS "objectKey", content_sha256 AS "contentSha256"
         FROM ${ARCHIVE_RUNS}
        WHERE integration = 'gsc' AND report = 'page-query'`);
    expect(manifest).toMatchObject({
      reportDate: '2026-07-28',
      status: 'success',
      dataState: 'provider-final',
      providerRows: 1,
      requestCount: 1,
    });
    expect(manifest?.contentSha256).toMatch(/^[a-f0-9]{64}$/);

    const object = await env.RAW_SIGNALS.get(manifest!.objectKey);
    expect(object?.httpMetadata?.contentEncoding).toBe('gzip');
    const decompressed = object
      ? object.body.pipeThrough(new DecompressionStream('gzip'))
      : new ReadableStream();
    const archivedText = await new Response(decompressed).text();
    const archived = JSON.parse(archivedText) as {
      schemaVersion: number;
      integration: string;
      report: string;
      reportDate: string;
      pages: { request: Record<string, unknown>; response: unknown }[];
    };
    expect(archived).toMatchObject({
      schemaVersion: 1,
      integration: 'gsc',
      report: 'page-query',
      reportDate: '2026-07-28',
    });
    expect(archived.pages[0]?.request).toMatchObject({
      dimensions: ['page', 'query'],
      dataState: 'final',
      rowLimit: 25_000,
      startRow: 0,
    });
    expect(archivedText).not.toContain('dump-access-token');
    expect(archivedText).not.toContain('PRIVATE KEY');

    const rollingGa4 = calls.find(
      (call) =>
        call.url.includes('analyticsdata.googleapis.com') &&
        Array.isArray(call.body?.dateRanges) &&
        (call.body.dateRanges[0] as { startDate?: string }).startDate === '2026-07-01',
    );
    expect(rollingGa4?.body).toMatchObject({
      dateRanges: [{ startDate: '2026-07-01', endDate: '2026-07-28' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    });

    const bingManifest = await pgFirst<{
      dataState: string;
      providerRows: number;
      objectKey: string;
    }>(`SELECT data_state AS "dataState", provider_rows AS "providerRows",
              object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE asset = 'meals.example'
          AND integration = 'bing-webmaster'
          AND report = 'crawl-issues'`);
    expect(bingManifest).toMatchObject({
      dataState: 'provider-snapshot',
      providerRows: 1,
    });
    const bingObject = await env.RAW_SIGNALS.get(bingManifest!.objectKey);
    const bingDecompressed = bingObject
      ? bingObject.body.pipeThrough(new DecompressionStream('gzip'))
      : new ReadableStream();
    const bingArchivedText = await new Response(bingDecompressed).text();
    const bingArchived = JSON.parse(bingArchivedText) as {
      provider: string;
      integration: string;
      report: string;
      pages: { request: Record<string, unknown> }[];
    };
    expect(bingArchived).toMatchObject({
      provider: 'microsoft',
      integration: 'bing-webmaster',
      report: 'crawl-issues',
    });
    expect(bingArchived.pages[0]?.request).toEqual({
      method: 'GetCrawlIssues',
      siteUrl: 'https://meals.example/',
    });
    expect(bingArchivedText).not.toContain('test-bing-key');

    // The weekly BWT families already hold this date's snapshot, so the second
    // pass does not ask for them at all — everything else re-fetches and
    // deduplicates on content.
    const REPEATED = EXPECTED_ATTEMPTS - BING_WEEKLY_ATTEMPTS;
    const second = await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl,
      revisionDays: 1,
    });
    expect(second).toMatchObject({
      attempted: REPEATED,
      succeeded: 0,
      unchanged: REPEATED,
      failed: 0,
      skipped: BING_WEEKLY_ATTEMPTS,
    });
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS}`)).toBe(
      EXPECTED_ATTEMPTS + REPEATED,
    );
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(EXPECTED_ATTEMPTS);
  });

  describe('GA4 quota accounting', () => {
    /** The archived envelope for one GA4 family. */
    async function archivedGa4(report = 'pages-screens'): Promise<Record<string, unknown>> {
      const manifest = await pgFirst<{ objectKey: string }>(`SELECT object_key AS "objectKey" FROM ${ARCHIVE_RUNS}
          WHERE integration = 'ga4' AND report = $1 AND object_key IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`, [report]);
      const object = await env.RAW_SIGNALS.get(manifest!.objectKey);
      const text = await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text();
      return JSON.parse(text) as Record<string, unknown>;
    }

    async function quotaFlag(): Promise<{ message: string; ruleInputs: string } | null> {
      const [row] = await pgRows<{ message: string; ruleInputs: string }>(
        `SELECT message, rule_inputs::text AS "ruleInputs" FROM noticeos.current_flags
          WHERE rule_id = 'ga4-quota-pressure' AND resolved_at IS NULL
          ORDER BY fired_at, flag_number LIMIT 1`,
      );
      return row ?? null;
    }

    it('asks the Data API what every archive request costs', async () => {
      const { fetchImpl, calls } = providerDumpFetch({
        ga4Quota: { consumed: 500, remaining: 199_500 },
      });
      await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1 });

      const ga4Calls = calls.filter((call) => call.url.includes('analyticsdata.googleapis.com'));
      expect(ga4Calls.length).toBeGreaterThan(0);
      for (const call of ga4Calls) expect(call.body?.returnPropertyQuota).toBe(true);
    });

    it('archives the quota beside the pages and never inside the content hash', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });

      const archived = await archivedGa4();
      expect(archived.providerQuota).toMatchObject({
        tokensPerDay: { consumed: 500, remaining: 199_500 },
      });
      // The quota is lifted OUT of the response bytes: leaving it there would
      // put a number that moves on every call into the archived page.
      const pages = archived.pages as { response: Record<string, unknown> }[];
      expect(pages[0]?.response.propertyQuota).toBeUndefined();
      expect(pages[0]?.response.rowCount).toBe(1);

      // Same data, different spend: still `unchanged`, so the dedup that keeps
      // this lane's R2 footprint honest survives asking for quota at all.
      const objectsAfterFirst = (await env.RAW_SIGNALS.list()).objects.length;
      const second = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 9_000, remaining: 191_000 } })
          .fetchImpl,
        revisionDays: 1,
      });
      expect(second.succeeded).toBe(0);
      expect(second.unchanged).toBeGreaterThan(0);
      expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(objectsAfterFirst);
    });

    it('says nothing while the budget is comfortable', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });
      expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags WHERE rule_id = 'ga4-quota-pressure'`)).toBe(0);
    });

    it('raises ONE flag per property while the budget is thin, however many families spend it', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        // 5% of the day's tokens left, well under the 20% line.
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 190_000, remaining: 10_000 } })
          .fetchImpl,
        revisionDays: 1,
      });

      // Nine GA4 families spend from one property's budget; one budget is one
      // problem. The budget is per property, so the flag is too.
      const flagged = await pgRows<{ asset: string }>(
        `SELECT asset_id AS asset FROM noticeos.current_flags WHERE rule_id = 'ga4-quota-pressure' ORDER BY asset_id COLLATE "C"`,
      );
      expect(flagged.map((row) => row.asset)).toEqual([...GOOGLE_PROPERTIES]);
      const flag = await quotaFlag();
      // The headline with its share; the tokens are the inputs the Alerts row
      // draws as "Tokens left · 10,000 of 200,000".
      expect(flag!.message).toBe('GA4 daily quota at 5% for 123456');
      const inputs = JSON.parse(flag!.ruleInputs) as Record<string, unknown>;
      expect(inputs).toMatchObject({
        lane: 'signal-dumps',
        threshold_ratio: 0.2,
        tokensPerDay: { consumed: 190_000, remaining: 10_000 },
      });
      expect(inputs.observations).toBeGreaterThan(1); // refreshed, not re-fired
      expect(
        (inputs.pressured as { bucket: string; share: number }[])[0],
      ).toMatchObject({ bucket: 'tokensPerDay', share: 0.05 });
    });

    it('retracts the flag once the buckets refill, but never on silence', async () => {
      await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 190_000, remaining: 10_000 } })
          .fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).not.toBeNull();

      // A provider that reported no quota at all is not evidence of recovery.
      await runSignalDumps(env, {
        nowMs: NOW + 86_400_000,
        fetchImpl: providerDumpFetch().fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).not.toBeNull();

      await runSignalDumps(env, {
        nowMs: NOW + 2 * 86_400_000,
        fetchImpl: providerDumpFetch({ ga4Quota: { consumed: 500, remaining: 199_500 } }).fetchImpl,
        revisionDays: 1,
      });
      expect(await quotaFlag()).toBeNull();
    });
  });

  /** The dedup above is a same-date rule by decision: `reportDate` is in the
   * WHERE clause and inside the hashed bytes, so a snapshot family whose payload
   * has not moved since yesterday still writes its own object. Reaching across
   * dates would cost the panel dir its dates, because a shared object's envelope
   * names the first date and the flattener reads every row's `report_date` out
   * of that envelope. */
  it('gives each report date its own object even when the provider bytes repeat', async () => {
    const { fetchImpl } = providerDumpFetch();
    await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1 });
    // The next day, same fixture: Bing answers the daily crawl families with
    // exactly what it answered yesterday.
    await runSignalDumps(env, {
      nowMs: NOW + 86_400_000,
      fetchImpl,
      revisionDays: 1,
    });

    const rows = (
      await pgAll<{
        reportDate: string;
        status: string;
        objectKey: string;
        contentSha256: string;
      }>(`SELECT report_date AS "reportDate", status, object_key AS "objectKey",
                content_sha256 AS "contentSha256"
           FROM ${ARCHIVE_RUNS}
          WHERE asset = 'meals.example' AND integration = 'bing-webmaster'
            AND report = 'crawl-issues'
          ORDER BY report_date`)
    ).results;

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.reportDate)).toEqual(['2026-07-28', '2026-07-29']);
    // Both are collections, not one collection and one pointer at it.
    expect(rows.every((row) => row.status === 'success')).toBe(true);
    expect(rows[0]!.objectKey).not.toBe(rows[1]!.objectKey);
    expect(rows[0]!.contentSha256).not.toBe(rows[1]!.contentSha256);

    // And the payload really was identical — the hashes differ only because
    // `reportDate` is inside the bytes they cover.
    const pagesOf = async (objectKey: string) => {
      const object = await env.RAW_SIGNALS.get(objectKey);
      const text = await new Response(
        object!.body.pipeThrough(new DecompressionStream('gzip')),
      ).text();
      return JSON.stringify((JSON.parse(text) as { pages: unknown }).pages);
    };
    expect(await pagesOf(rows[0]!.objectKey)).toBe(await pagesOf(rows[1]!.objectKey));
  });

  it('records one report failure without blocking the other archive families', async () => {
    const { fetchImpl } = providerDumpFetch({ failGscPageQuery: true });
    const result = await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl,
      revisionDays: 1,
    });

    // Search Console refuses `page,query` for BOTH properties, and each one
    // loses exactly that family — failure is isolated per (property, family).
    const FAILED = GOOGLE_PROPERTIES.length;
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: EXPECTED_ATTEMPTS - FAILED,
      unchanged: 0,
      failed: FAILED,
    });
    expect(result.outcomes.find((outcome) => outcome.status === 'error')).toMatchObject({
      integration: 'gsc',
      report: 'page-query',
      reportDate: '2026-07-28',
      errorCode: 'gsc_dump_http_403',
    });
    const failures = await pgAll<{
      asset: string;
      status: string;
      errorCode: string;
      errorMessage: string;
      objectKey: string | null;
    }>(`SELECT asset, status, error_code AS "errorCode", error_message AS "errorMessage",
              object_key AS "objectKey"
         FROM ${ARCHIVE_RUNS}
        WHERE status = 'error' ORDER BY asset`);
    expect(failures.results).toEqual(
      GOOGLE_PROPERTIES.map((asset) => ({
        asset,
        status: 'error',
        errorCode: 'gsc_dump_http_403',
        errorMessage: 'Search Console report denied',
        objectKey: null,
      })),
    );
    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(EXPECTED_ATTEMPTS - FAILED);
  });

  it('collects the rolling 28-day event aggregate once per property per run', async () => {
    const { fetchImpl } = providerDumpFetch();
    const result = await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl,
      revisionDays: 2,
    });

    // Once per PROPERTY: the aggregate does not walk the revision window, but
    // it is still a per-property report, so two properties means two of them.
    expect(
      result.outcomes.filter(
        (outcome) => outcome.integration === 'ga4' && outcome.report === 'events-28d',
      ),
    ).toMatchObject(
      GOOGLE_PROPERTIES.map((asset) => ({
        asset,
        reportDate: '2026-07-28',
        status: 'success',
      })),
    );
    expect(
      result.outcomes.filter(
        (outcome) => outcome.integration === 'ga4' && outcome.report === 'events',
      ),
    ).toHaveLength(2 * GOOGLE_PROPERTIES.length);
  });

  describe('the js_error event-parameter family', () => {
    it('asks for message and source next to the page, filtered to js_error', async () => {
      const { fetchImpl, calls } = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl,
        revisionDays: 1,
      });

      expect(
        result.outcomes.find((outcome) => outcome.report === 'js-errors'),
      ).toMatchObject({
        asset: 'meals.example',
        integration: 'ga4',
        reportDate: '2026-07-28',
        status: 'success',
        errorCode: null,
      });

      const request = calls.find((call) =>
        JSON.stringify(call.body?.dimensions ?? '').includes('customEvent:message'),
      )?.body;
      expect(request).toMatchObject({
        dateRanges: [{ startDate: '2026-07-28', endDate: '2026-07-28' }],
        dimensions: [
          { name: 'customEvent:message' },
          { name: 'customEvent:source' },
          { name: 'unifiedPagePathScreen' },
        ],
        metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            stringFilter: { matchType: 'EXACT', value: 'js_error' },
          },
        },
      });

      // The filter is what makes these rows readable as js_error and not as a
      // property-wide total, so it has to survive into the archive.
      const objectKey = result.outcomes.find(
        (outcome) => outcome.report === 'js-errors',
      )?.objectKey;
      const object = await env.RAW_SIGNALS.get(objectKey!);
      const archived = JSON.parse(
        await new Response(
          object!.body.pipeThrough(new DecompressionStream('gzip')),
        ).text(),
      ) as { pages: { request: Record<string, unknown> }[] };
      expect(archived.pages[0]?.request).toMatchObject({
        dimensionFilter: {
          filter: { stringFilter: { value: 'js_error' } },
        },
      });
    });

    it('records unregistered custom dimensions as their own state, never as an empty success', async () => {
      const { fetchImpl } = providerDumpFetch({
        unregisteredCustomDimensions: true,
      });
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl,
        revisionDays: 1,
      });

      expect(
        result.outcomes.filter((outcome) => outcome.report === 'js-errors'),
      ).toMatchObject(
        GOOGLE_PROPERTIES.map((asset) => ({
          asset,
          integration: 'ga4',
          status: 'error',
          errorCode: 'ga4_custom_dimension_unregistered',
          providerRows: 0,
          objectKey: null,
        })),
      );

      const failure = await pgFirst<{ status: string; errorCode: string; errorMessage: string }>(`SELECT status, error_code AS "errorCode", error_message AS "errorMessage"
           FROM ${ARCHIVE_RUNS}
          WHERE report = 'js-errors' LIMIT 1`);
      expect(failure?.status).toBe('error');
      expect(failure?.errorMessage).toContain('customEvent:message');
      expect(failure?.errorMessage).toContain('register');

      // A rejected dimension must not be mistaken for a property with no
      // errors, and must not take the other GA4 families down with it.
      expect(
        await pgCount(
          `SELECT count(*) AS n FROM ${ARCHIVE_RUNS}
            WHERE report = 'js-errors' AND status IN ('success','unchanged')`,
        ),
      ).toBe(0);
      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS,
        succeeded: EXPECTED_ATTEMPTS - GOOGLE_PROPERTIES.length,
        failed: GOOGLE_PROPERTIES.length,
      });
    });

    it('is offered only to properties the config says have the dimensions registered', async () => {
      const { fetchImpl, calls } = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl,
        revisionDays: 1,
        // The test property is absent, exactly like a property whose operator
        // has not registered the parameters.
        ga4CustomDimensions: { assets: {} },
      });

      // Skipped, not failed: no request, no manifest row, no error to triage.
      expect(result.outcomes.filter((outcome) => outcome.report === 'js-errors')).toEqual(
        [],
      );
      expect(
        calls.filter((call) =>
          JSON.stringify(call.body?.dimensions ?? '').includes('customEvent:'),
        ),
      ).toEqual([]);
      expect(
        await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report = 'js-errors'`),
      ).toBe(0);
      // Its neighbours are untouched — one fewer family on each property,
      // nothing else changed.
      expect(result).toMatchObject({
        attempted: EXPECTED_ATTEMPTS - GOOGLE_PROPERTIES.length,
        succeeded: EXPECTED_ATTEMPTS - GOOGLE_PROPERTIES.length,
        failed: 0,
      });
    });

    it('skips a property that has registered only some of the parameters', async () => {
      const { fetchImpl } = providerDumpFetch();
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl,
        revisionDays: 1,
        // `source` is missing, so the request would fail on that field. Asking
        // anyway would turn a known gap into a daily error row.
        ga4CustomDimensions: {
          assets: { 'meals.example': { eventParams: ['message'] } },
        },
      });

      expect(result.outcomes.filter((outcome) => outcome.report === 'js-errors')).toEqual(
        [],
      );
    });

    /** Reject the js-errors family with the given body/status, pass the rest. */
    function rejectingJsErrors(body: unknown, status: number): typeof fetch {
      const { fetchImpl } = providerDumpFetch();
      return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (
          url.includes('analyticsdata.googleapis.com') &&
          String(init?.body ?? '').includes('customEvent:message')
        ) {
          return Response.json(body, { status });
        }
        return fetchImpl(input, init);
      }) as typeof fetch;
    }

    it('leaves an ordinary GA4 rejection on the generic error path', async () => {
      // A 429 with no quota in it is a concurrent-request limit: it recovers on
      // its own and is nobody's morning.
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: rejectingJsErrors(
          { error: { code: 429, message: 'Too many concurrent requests.' } },
          429,
        ),
        revisionDays: 1,
      });

      expect(
        result.outcomes.find((outcome) => outcome.report === 'js-errors'),
      ).toMatchObject({
        status: 'error',
        errorCode: 'ga4_dump_http_429',
      });
    });

    it('gives an exhausted quota its own manifest state', async () => {
      const result = await runSignalDumps(env, {
        nowMs: NOW,
        fetchImpl: rejectingJsErrors(
          {
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'Exhausted property tokens.',
            },
          },
          429,
        ),
        revisionDays: 1,
      });

      expect(
        result.outcomes.find((outcome) => outcome.report === 'js-errors'),
      ).toMatchObject({
        status: 'error',
        errorCode: 'ga4_quota_exhausted',
      });
      const row = await pgFirst<{ errorCode: string }>(`SELECT error_code AS "errorCode" FROM ${ARCHIVE_RUNS}
          WHERE report = 'js-errors' AND status = 'error'
          ORDER BY finished_at DESC LIMIT 1`);
      // The manifest, not just the in-memory outcome: this is what an operator
      // reads without opening the archive.
      expect(row?.errorCode).toBe('ga4_quota_exhausted');
    });
  });

  it('isolates one Bing report failure without suppressing its other evidence', async () => {
    const { fetchImpl } = providerDumpFetch({ failBingReport: 'GetCrawlIssues' });
    const result = await runSignalDumps(env, {
      nowMs: NOW,
      fetchImpl,
      revisionDays: 1,
    });

    // The dead method is one family per property, so it fails once per property.
    expect(result).toMatchObject({
      attempted: EXPECTED_ATTEMPTS,
      succeeded: EXPECTED_ATTEMPTS - BING_PROPERTIES,
      unchanged: 0,
      failed: BING_PROPERTIES,
    });
    expect(
      result.outcomes.filter(
        (outcome) =>
          outcome.integration === 'bing-webmaster' &&
          outcome.report === 'crawl-issues',
      ),
    ).toHaveLength(BING_PROPERTIES);
    expect(
      result.outcomes.find(
        (outcome) =>
          outcome.integration === 'bing-webmaster' &&
          outcome.report === 'crawl-issues',
      ),
    ).toMatchObject({
      status: 'error',
      errorCode: 'bwt_http_403',
    });
    expect(
      await pgCount(
        `SELECT count(*) AS n
           FROM ${ARCHIVE_RUNS}
          WHERE integration = 'bing-webmaster'
            AND report = 'crawl-issues'
            AND status = 'error'`,
      ),
    ).toBe(BING_PROPERTIES);
  });

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

  describe('when the OS is what is down', () => {
    const ALL_PROPERTIES = [
      'meals.example',
      'nosh.example',
      'pacer.example',
      'pullups.example',
      'areas.example',
      'fees.example',
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

    it('holds the same line when the uplink dies after the token and the site list', async () => {
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
        id: 'probe-error-fixture', asset: 'meals.example', integration: 'gsc', report: 'discover-page',
        credential_ref: 'test-signals', property_ref: 'sc-domain:meals.example', report_date: '2026-07-27',
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

  describe('re-collecting what an outage cost', () => {
    /** The run that never reached Google. */
    const OUTAGE_RUN = '2026-09-14T12:15:00.000Z';
    /** A scheduled run ten days on: its own window is 2026-09-23 alone. */
    const LATER = Date.parse('2026-09-24T12:15:00.000Z');
    const GOOGLE_REF: Record<string, Record<string, string>> = {
      'meals.example': { ga4: '123456', gsc: 'sc-domain:meals.example' },
      'nosh.example': { ga4: '654321', gsc: 'sc-domain:nosh.example' },
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
      await failedDump('meals.example', 'ga4', 'pages-screens', '2026-09-10', 'request_failed');
      await failedDump('nosh.example', 'gsc', 'page-query', '2026-09-10', 'request_timeout');
      await failedDump('meals.example', 'ga4', 'events-28d', '2026-09-13', 'request_failed');

      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, { nowMs: LATER, fetchImpl: fixture.fetchImpl, revisionDays: 1 });

      expect(result.retried).toBe(3);
      expect(result.attempted).toBe(EXPECTED_ATTEMPTS + 3);
      expect(result.failed).toBe(0);
      expect(await latest('meals.example', 'ga4', 'pages-screens', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('nosh.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('meals.example', 'ga4', 'events-28d', '2026-09-13')).toMatchObject({ status: 'success' });
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
      await failedDump('meals.example', 'gsc', 'page-query', '2026-09-10', 'gsc_dump_http_403');
      await failedDump('meals.example', 'ga4', 'pages-screens', '2026-09-10', 'ga4_quota_exhausted');
      // Network first, then the provider's own answer: the LATEST attempt decides.
      await failedDump('nosh.example', 'ga4', 'events', '2026-09-10', 'request_failed', '2026-09-14T12:15:00.000Z');
      await failedDump('nosh.example', 'ga4', 'events', '2026-09-10', 'ga4_dump_http_400', '2026-09-15T12:15:00.000Z');

      const fixture = providerDumpFetch();
      const result = await runSignalDumps(env, { nowMs: LATER, fetchImpl: fixture.fetchImpl, revisionDays: 1 });

      expect(result.retried).toBe(0);
      expect(askedFor(fixture, '2026-09-10')).toHaveLength(0);
      expect(await latest('meals.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ errorCode: 'gsc_dump_http_403' });
    });

    it('names a date this machine failed to save as its own fault, and never asks Google again for it', async () => {
      // Google answered pages-screens for meals.example; the file store refused it.
      const refusing = new Proxy(env.RAW_SIGNALS, {
        get(target, prop) {
          if (prop === 'put') {
            return (key: string, ...rest: unknown[]) =>
              key.includes('/ga4/meals.example/pages-screens/')
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
      expect(await latest('meals.example', 'ga4', 'pages-screens', '2026-09-23')).toMatchObject({
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
      await failedDump('meals.example', 'ga4', 'pages-screens', '2026-09-23', 'request_failed', '2026-09-24T12:15:00.000Z');

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
        await failedDump('meals.example', 'ga4', 'pages-screens', date, 'request_failed');
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
      await failedDump('meals.example', 'ga4', 'pages-screens', '2026-09-10', 'request_failed');
      await failedDump('nosh.example', 'gsc', 'page-query', '2026-09-10', 'request_failed');

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
      expect(await latest('meals.example', 'ga4', 'pages-screens', '2026-09-10')).toMatchObject({ status: 'success' });
      expect(await latest('nosh.example', 'gsc', 'page-query', '2026-09-10')).toMatchObject({ status: 'success' });
    });

    it('stops after one ask when the provider still drops the connection', async () => {
      for (const date of ['2026-09-08', '2026-09-09', '2026-09-10']) {
        await failedDump('meals.example', 'ga4', 'pages-screens', date, 'request_failed');
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
      expect(await latest('meals.example', 'ga4', 'pages-screens', '2026-09-08')).toMatchObject({
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

  it('shifts a manual pre-cutoff run back instead of archiving an open US date', async () => {
    const { fetchImpl } = providerDumpFetch();
    const result = await runSignalDumps(env, {
      nowMs: Date.parse('2026-07-30T00:01:00.000Z'),
      fetchImpl,
      revisionDays: 1,
    });

    expect(new Set(result.outcomes.map((outcome) => outcome.reportDate))).toEqual(
      new Set(['2026-07-28']),
    );
  });
});
