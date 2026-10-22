import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alignComparisonMinutes, backfillComparison, collectComparison, emptyComparison, updateComparison, type SharedComparisons } from '../src/ga4-comparison.js';
import { reset } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00Z');
function report(rows: [string, string, number][] = [['today', '202607290000', 4], ['today', '202607290800', 6], ['today', '202607290801', 5], ['last_week', '202607220000', 2]], metadata = {}) {
  return { dimensionHeaders: [{ name: 'dateHourMinute' }, { name: 'dateRange' }], metricHeaders: [{ name: 'activeUsers' }],
    rowCount: rows.length, rows: rows.map(([range, date, value]) => ({ dimensionValues: [{ value: date }, { value: range }], metricValues: [{ value: String(value) }] })),
    metadata: { timeZone: 'UTC', ...metadata }, propertyQuota: { tokensPerDay: { consumed: 10, remaining: 190_000 }, tokensPerHour: { consumed: 10, remaining: 39_000 } } };
}
const fetchReport = (body = report()) => vi.fn<typeof fetch>(async () => Response.json(body));
beforeEach(reset);

describe('GA4 activity comparison backfill', () => {
  it('backfills the same weekday immediately and stops today before the processing edge', async () => {
    const provider = fetchReport();
    const result = await collectComparison('123456', 'synthetic', provider, NOW, 'UTC');
    expect(result.day.minutes.slice(479, 483)).toEqual([0, 6, null, null]);
    expect(result.day.minutes[0]).toBe(4);
    expect(result.day.sameDayLastWeek?.slice(0, 3)).toEqual([2, 0, 0]);
    const request = JSON.parse(String(provider.mock.calls[0]![1]?.body));
    expect(request.dimensions).toEqual([{ name: 'dateHourMinute' }]);
    expect(request.dateRanges).toHaveLength(2);
    expect(request.dateRanges[1]).toMatchObject({ startDate: '2026-07-21', endDate: '2026-07-23' });
    expect(request.returnPropertyQuota).toBe(true);
  });

  it('keeps an all-zero current report unknown while a completed prior day can be zero', async () => {
    const empty = { ...report([]), rowCount: undefined };
    const result = await collectComparison('123456', 'synthetic', vi.fn<typeof fetch>(async () => Response.json(empty)), NOW, 'UTC');
    expect(result.day.minutes.every(value => value === null)).toBe(true);
    expect(result.day.sameDayLastWeek?.every(value => value === 0)).toBe(true);
  });

  it('reads a busy site whose minutes Google sends as more than a megabyte', async () => {
    // Every minute of both ranges, in a property and installation clock that is not UTC.
    const rows: [string, string, number][] = [];
    const minutesOf = (range: string, date: string, hours: number) => {
      for (let hour = 0; hour < hours; hour++) for (let minute = 0; minute < 60; minute++)
        rows.push([range, `${date}${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`, 1]);
    };
    minutesOf('today', '20260728', 24); minutesOf('today', '20260729', 5);
    for (const date of ['20260721', '20260722', '20260723']) minutesOf('last_week', date, 24);
    const text = JSON.stringify(report(rows, { timeZone: 'America/Los_Angeles' }), null, 2);
    expect(text.length).toBeGreaterThan(1_000_000);
    const result = await collectComparison('123456', 'synthetic', vi.fn<typeof fetch>(async () => new Response(text)), NOW, 'America/Los_Angeles');
    expect(result.day.date).toBe('2026-07-29');
    expect(result.day.minutes.slice(0, 299).every(value => value === 1)).toBe(true);
    expect(result.day.sameDayLastWeek?.every(value => value === 1)).toBe(true);
  });

  it.each([{ dataLossFromOtherRow: true }, { subjectToThresholding: true }, { samplingMetadatas: [{}] }, { timeZone: 'invalid' }])('rejects incomplete or unplaceable reports %j', async metadata => {
    await expect(collectComparison('123456', 'synthetic', fetchReport(report([], metadata)), NOW, 'UTC')).rejects.toThrow('incomplete activity comparison');
  });

  it('refuses a truncated response rather than inventing zero minutes for omitted rows', async () => {
    const body = { ...report(), rowCount: 10_001 };
    await expect(collectComparison('123456', 'synthetic', fetchReport(body), NOW, 'UTC')).rejects.toThrow();
  });

  it('converts the property clock to the installation clock', async () => {
    const result = await collectComparison('123456', 'synthetic', fetchReport(), NOW, 'Asia/Kolkata');
    expect(result.day.startAt).toBe('2026-07-28T18:30:00.000Z');
    expect(result.day.minutes[330]).toBe(4);
    expect(result.day.sameDayLastWeek?.[330]).toBe(2);
  });

  it('shares one report and retains the last success through a failed refresh', async () => {
    const provider = fetchReport();
    const shared: SharedComparisons = new Map();
    const input = { property: '123456', token: 'synthetic', zone: 'UTC', nowMs: NOW, fetchImpl: provider, cache: null, shared };
    await updateComparison(env, { ...input, asset: 'meadow.example' });
    await updateComparison(env, { ...input, asset: 'northwind.example' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await updateComparison(env, { ...input, asset: 'meadow.example', nowMs: NOW + 30 * 60_000 })).toBeNull();
    const failed = vi.fn<typeof fetch>(async () => Response.json({ error: {} }, { status: 503 }));
    await updateComparison(env, { ...input, shared: new Map(), asset: 'meadow.example', nowMs: NOW + 3_600_000, fetchImpl: failed });
    const day = emptyComparison(NOW + 3_600_000, 'UTC');
    day.minutes[720] = 9;
    await backfillComparison(env.STORE, 'meadow.example', '123456', day);
    expect(day.sameDayLastWeek?.[0]).toBe(2);
    expect(day.minutes[720]).toBe(9);
    expect(day.minutes[0]).toBe(4);
    expect(day.comparisonError).toBeTruthy();
    const other = emptyComparison(NOW, 'UTC');
    await backfillComparison(env.STORE, 'meadow.example', '654321', other);
    expect(other.sameDayLastWeek).toBeNull();
  });

  it('backs off the Core comparison independently of realtime quota', async () => {
    const body = report(); body.propertyQuota.tokensPerDay.remaining = 30_000;
    const result = await updateComparison(env, { asset: 'meadow.example', property: '123456', token: 'synthetic', zone: 'UTC', nowMs: NOW,
      fetchImpl: fetchReport(body), cache: null, shared: new Map() });
    expect(result?.nextAttemptAt).toBe(new Date(NOW + 4 * 3_600_000).toISOString());
  });

  it('leaves both folds unknown when the provider hour resolves to the later fold', async () => {
    const body = report([['today', '202610250200', 8], ['today', '202610250400', 1], ['last_week', '202610180200', 4]], { timeZone: 'Europe/Berlin' });
    const result = await collectComparison('123456', 'synthetic', fetchReport(body), Date.parse('2026-10-25T12:00:00Z'), 'UTC');
    expect(result.day.minutes[0]).toBeNull();
    expect(result.day.minutes[60]).toBeNull();
    expect(result.day.minutes[120]).toBe(0);
  });

  it('aligns clock minutes across DST while excluding the repeated hour', () => {
    const values = Array<number | null>(1440).fill(7);
    const aligned = alignComparisonMinutes(values, Date.parse('2026-10-25T07:00:00Z'), Date.parse('2026-11-01T07:00:00Z'), 1500, 'America/Los_Angeles');
    expect(aligned.slice(60, 180).every(value => value === null)).toBe(true);
    expect(aligned[180]).toBe(7);
    expect(aligned[1499]).toBe(7);
  });
});
