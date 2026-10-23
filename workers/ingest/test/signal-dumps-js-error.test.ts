import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgCount, pgFirst, reset } from './helpers.js';
import {
  NOW,
  GOOGLE_PROPERTIES,
  EXPECTED_ATTEMPTS,
  providerDumpFetch,
} from './signal-dumps-fixture';

beforeEach(reset);

describe('analysis-grade signal dumps', () => {
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
        asset: 'meadow.example',
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
          assets: { 'meadow.example': { eventParams: ['message'] } },
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
});
