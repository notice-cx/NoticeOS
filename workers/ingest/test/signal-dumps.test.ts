import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveCollectedDump, runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgAll, pgCount, pgFirst, reset } from './helpers.js';
import {
  NOW,
  TOKEN_URL,
  BING_PROPERTIES,
  BING_WEEKLY_ATTEMPTS,
  GOOGLE_PROPERTIES,
  EXPECTED_ATTEMPTS,
  providerDumpFetch,
} from './signal-dumps-fixture';

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
        WHERE asset = 'meadow.example'
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
      siteUrl: 'https://meadow.example/',
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
          WHERE asset = 'meadow.example' AND integration = 'bing-webmaster'
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

describe('an archive larger than the store keeps', () => {
  it('is refused as archive_too_large and stores nothing', async () => {
    const before = (await env.RAW_SIGNALS.list()).objects.length;
    const oversized = 'x'.repeat(32 * 1024 * 1024 + 1);
    await expect(archiveCollectedDump(env, {
      provider: 'google',
      target: { asset: 'meadow.example', integration: 'gsc', credentialRef: 'fixture', propertyRef: 'sc-domain:meadow.example' },
      report: 'query',
      reportDate: '2026-07-28',
      requestedAt: new Date(NOW).toISOString(),
      dataState: 'provider-final',
      collected: { pages: [{ request: {}, response: { blob: oversized } }], providerRows: 1, providerTruncated: false },
    })).rejects.toMatchObject({ code: 'archive_too_large' });

    expect((await env.RAW_SIGNALS.list()).objects).toHaveLength(before);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE asset = 'meadow.example'`)).toBe(0);
  });
});
