import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runSignalDumps } from '../src/signal-dumps.js';
import { ARCHIVE_RUNS, pgCount, reset } from './helpers.js';
import { NOW, providerDumpFetch } from './signal-dumps-fixture';

beforeEach(reset);
const families = ['content-groups', 'event-source', 'event-state'];
const registered = { assets: { 'meadow.example': { eventParams: ['source', 'state'] } } };

function hasDimension(body: Record<string, unknown> | null, name: string): boolean {
  return Array.isArray(body?.dimensions) && body.dimensions.some((dimension: unknown) =>
    dimension !== null && typeof dimension === 'object' && 'name' in dimension && dimension.name === name);
}

describe('daily content groups and event parameter archives', () => {
  it('archives each completed date with the exact dimensions and metrics', async () => {
    const { fetchImpl, calls } = providerDumpFetch();
    const result = await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 2, ga4CustomDimensions: registered });
    for (const [report, dimensions, metrics] of [
      ['content-groups', ['contentGroup'], ['screenPageViews', 'sessions']],
      ['event-source', ['eventName', 'customEvent:source'], ['eventCount', 'totalUsers']],
      ['event-state', ['eventName', 'customEvent:state'], ['eventCount', 'totalUsers']],
    ] as const) {
      const outcomes = result.outcomes.filter((row) => row.report === report && row.asset === 'meadow.example');
      expect(outcomes.map((row) => row.reportDate)).toEqual(['2026-07-27', '2026-07-28']);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('success');
        const object = await env.RAW_SIGNALS.get(outcome.objectKey!);
        const archive = JSON.parse(await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).text());
        expect(archive.pages[0].request).toMatchObject({
          dateRanges: [{ startDate: outcome.reportDate, endDate: outcome.reportDate }],
          dimensions: dimensions.map((name) => ({ name })), metrics: metrics.map((name) => ({ name })),
        });
        expect(archive.pages[0].request.dimensionFilter).toBeUndefined();
      }
    }
    expect(calls.some((call) => hasDimension(call.body, 'customEvent:state'))).toBe(true);
  });

  it('skips unregistered parameters without writing an empty success', async () => {
    const { fetchImpl, calls } = providerDumpFetch();
    const result = await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1, ga4CustomDimensions: { assets: {} } });
    expect(result.outcomes.filter((row) => row.report === 'event-source' || row.report === 'event-state')).toEqual([]);
    expect(calls.filter((call) => hasDimension(call.body, 'customEvent:source') || hasDimension(call.body, 'customEvent:state'))).toEqual([]);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report IN ('event-source','event-state')`)).toBe(0);
    expect(result.outcomes.filter((row) => row.report === 'content-groups')).toHaveLength(2);
  });

  it.each(['source', 'state'])('collects registered %s independently of the other parameter', async (parameter) => {
    const { fetchImpl } = providerDumpFetch();
    const result = await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1,
      ga4CustomDimensions: { assets: { 'meadow.example': { eventParams: [parameter] } } } });
    expect(result.outcomes.filter((row) => row.report.startsWith('event-'))).toMatchObject([
      { asset: 'meadow.example', report: `event-${parameter}`, status: 'success' },
    ]);
  });

  it('preserves not-set values and genuine zero metrics in the raw archive', async () => {
    const fixture = providerDumpFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await fixture.fetchImpl(input, init);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (!hasDimension(body, 'contentGroup') && !hasDimension(body, 'customEvent:state')) return response;
      const json = await response.json() as { rows: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] };
      for (const row of json.rows) { row.dimensionValues.at(-1)!.value = '(not set)'; row.metricValues[0]!.value = '0'; }
      return Response.json(json);
    };
    const result = await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1, ga4CustomDimensions: registered });
    for (const outcome of result.outcomes.filter((row) => row.report === 'content-groups' || row.report === 'event-state')) {
      const object = await env.RAW_SIGNALS.get(outcome.objectKey!);
      const archive = JSON.parse(await new Response(object!.body.pipeThrough(new DecompressionStream('gzip'))).text());
      expect(archive.pages[0].response.rows[0].dimensionValues.at(-1).value).toBe('(not set)');
      expect(archive.pages[0].response.rows[0].metricValues[0].value).toBe('0');
    }
  });

  it('records invalid custom dimensions as unavailable while content groups still succeed', async () => {
    const { fetchImpl } = providerDumpFetch({ unregisteredCustomDimensions: true });
    const result = await runSignalDumps(env, { nowMs: NOW, fetchImpl, revisionDays: 1, ga4CustomDimensions: registered });
    expect(result.outcomes.filter((row) => families.includes(row.report) && row.asset === 'meadow.example')).toMatchObject([
      { report: 'content-groups', status: 'success' },
      { report: 'event-source', status: 'error', errorCode: 'ga4_custom_dimension_unregistered', providerRows: 0, objectKey: null },
      { report: 'event-state', status: 'error', errorCode: 'ga4_custom_dimension_unregistered', providerRows: 0, objectKey: null },
    ]);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE report IN ('event-source','event-state') AND status IN ('success','unchanged')`)).toBe(0);
  });
});
