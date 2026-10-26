import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alignComparisonMinutes, backfillComparison, collectComparison, emptyComparison, updateComparison, type SharedComparisons } from '../src/ga4-comparison.js';
import { reset } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00Z');
type Row = [range: 'today' | 'last_week', stamp: string, value: number];
const ROWS: Row[] = [['today', '202607290000', 4], ['today', '202607290800', 6], ['today', '202607290801', 5], ['last_week', '202607220000', 2]];
/** One range's answer as GA4 sends it for a single-range request. */
function answer(rows: [string, number][] = [], metadata = {}) {
  return { dimensionHeaders: [{ name: 'dateHourMinute' }], metricHeaders: [{ name: 'activeUsers' }],
    rowCount: rows.length, rows: rows.map(([stamp, value]) => ({ dimensionValues: [{ value: stamp }], metricValues: [{ value: String(value) }] })),
    metadata: { timeZone: 'UTC', ...metadata }, propertyQuota: { tokensPerDay: { consumed: 10, remaining: 190_000 }, tokensPerHour: { consumed: 10, remaining: 39_000 } } };
}
/** Answers each range's request with that range's rows; today's range ends `today`. */
function provider(rows: Row[] = ROWS, metadata = {}, format = (body: unknown) => Response.json(body)) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const current = JSON.parse(String(init?.body)).dateRanges[0].endDate === 'today';
    return format(answer(rows.filter(([range]) => (range === 'today') === current).map(([, stamp, value]): [string, number] => [stamp, value]), metadata));
  });
}
const sameAnswer = (body: unknown) => vi.fn<typeof fetch>(async () => Response.json(body));
const everyMinute = (date: string, hours: number) => Array.from({ length: hours * 60 }, (_, i) =>
  `${date}${String(Math.floor(i / 60)).padStart(2, '0')}${String(i % 60).padStart(2, '0')}`);
beforeEach(reset);

describe('GA4 activity comparison backfill', () => {
  it('backfills the same weekday immediately and stops today before the processing edge', async () => {
    const fetchImpl = provider();
    const result = await collectComparison('123456', 'synthetic', fetchImpl, NOW, 'UTC');
    expect(result.day.minutes.slice(479, 483)).toEqual([0, 6, null, null]);
    expect(result.day.minutes[0]).toBe(4);
    expect(result.day.sameDayLastWeek?.slice(0, 3)).toEqual([2, 0, 0]);
    const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests.map(request => request.dateRanges)).toEqual([
      [{ startDate: '2026-07-28', endDate: 'today' }],
      [{ startDate: '2026-07-21', endDate: '2026-07-23' }],
    ]);
    for (const request of requests) {
      expect(request.dimensions).toEqual([{ name: 'dateHourMinute' }]);
      expect(request.returnPropertyQuota).toBe(true);
    }
    expect(result.quota?.tokensPerDay).toEqual({ consumed: 20, remaining: 190_000 });
  });

  it('keeps an all-zero current report unknown while a completed prior day can be zero', async () => {
    const empty = { ...answer(), rowCount: undefined };
    const result = await collectComparison('123456', 'synthetic', sameAnswer(empty), NOW, 'UTC');
    expect(result.day.minutes.every(value => value === null)).toBe(true);
    expect(result.day.sameDayLastWeek?.every(value => value === 0)).toBe(true);
  });

  it('reads a busy site with every minute of both ranges, as Google formats it', async () => {
    const rows: Row[] = [
      ...[...everyMinute('20260728', 24), ...everyMinute('20260729', 5)].map((stamp): Row => ['today', stamp, 1]),
      ...['20260721', '20260722', '20260723'].flatMap(date => everyMinute(date, 24)).map((stamp): Row => ['last_week', stamp, 1]),
    ];
    const pretty = (body: unknown) => new Response(JSON.stringify(body, null, 2));
    const result = await collectComparison('123456', 'synthetic', provider(rows, { timeZone: 'America/Los_Angeles' }, pretty), NOW, 'America/Los_Angeles');
    expect(result.day.date).toBe('2026-07-29');
    expect(result.day.minutes.slice(0, 299).every(value => value === 1)).toBe(true);
    expect(result.day.sameDayLastWeek?.every(value => value === 1)).toBe(true);
  });

  it('reads an answer near its row limit past the shared megabyte', async () => {
    const stamps = ['20260725', '20260726', '20260727', '20260728', '20260729', '20260730', '20260731'].flatMap(date => everyMinute(date, 24)).slice(0, 9_900);
    const text = JSON.stringify(answer(stamps.map((stamp): [string, number] => [stamp, 1])), null, 2);
    expect(text.length).toBeGreaterThan(1_000_000);
    const result = await collectComparison('123456', 'synthetic', vi.fn<typeof fetch>(async () => new Response(text)), NOW, 'UTC');
    expect(result.day.minutes[0]).toBe(1);
  });

  const row = (stamp: string, value = '1') => ({ dimensionValues: [{ value: stamp }], metricValues: [{ value }] });
  const withRows = (rows: unknown[], metadata = {}) => ({ ...answer([], metadata), rows, rowCount: rows.length });
  it.each([
    ['a dateRange column', { ...answer(), dimensionHeaders: [{ name: 'dateHourMinute' }, { name: 'dateRange' }] }, 'malformed_headers'],
    ['another metric', { ...answer(), metricHeaders: [{ name: 'sessions' }] }, 'malformed_headers'],
    ['no property time zone', answer([], { timeZone: undefined }), 'malformed_time_zone'],
    ['an unknown property time zone', answer([], { timeZone: 'invalid' }), 'malformed_time_zone'],
    ['an (other) row', answer([], { dataLossFromOtherRow: true }), 'incomplete_other_row'],
    ['thresholded counts', answer([], { subjectToThresholding: true }), 'incomplete_thresholded'],
    ['sampled counts', answer([], { samplingMetadatas: [{}] }), 'incomplete_sampled'],
    ['more rows than were sent', { ...answer([['202607290000', 1]]), rowCount: 2 }, 'incomplete_row_count'],
    ['a row with a second dimension', withRows([{ dimensionValues: [{ value: '202607290000' }, { value: 'today' }], metricValues: [{ value: '1' }] }]), 'malformed_row'],
    ['a short time stamp', withRows([row('2026072900')]), 'malformed_stamp'],
    ['a negative count', withRows([row('202607290000', '-1')]), 'malformed_count'],
    ['the same minute twice', withRows([row('202607290000'), row('202607290000')]), 'malformed_duplicate_row'],
    ['an hour past 23', withRows([row('202607292400')]), 'malformed_minute'],
    ['an hour that begins on another day', withRows([row('202609060000')], { timeZone: 'America/Santiago' }), 'malformed_hour_date'],
    ['a minute the clock skips', withRows([row('202603080230')], { timeZone: 'America/Los_Angeles' }), 'malformed_clock'],
  ])('refuses %s under its own code', async (_case, body, check) => {
    await expect(collectComparison('123456', 'synthetic', sameAnswer(body), NOW, 'UTC'))
      .rejects.toMatchObject({ code: `ga4_comparison_${check}` });
  });

  it('converts each range using its reported property clock after a timezone change', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json(answer([], {
      timeZone: JSON.parse(String(init?.body)).dateRanges[0].endDate === 'today' ? 'UTC' : 'America/Los_Angeles' })));
    const result = await collectComparison('123456', 'synthetic', fetchImpl, NOW, 'UTC');
    expect(result.day.timeZone).toBe('UTC');
    expect(result.day.sameDayLastWeek).toHaveLength(1440);
  });

  it('logs the refusal code with the attempt it stored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await updateComparison(env, { asset: 'meadow.example', property: '123456', token: 'synthetic', zone: 'UTC', nowMs: NOW,
        fetchImpl: sameAnswer(answer([], { subjectToThresholding: true })), cache: null, shared: new Map() });
      expect(result).toMatchObject({ ok: false, code: 'ga4_comparison_incomplete_thresholded' });
      expect(warn).toHaveBeenCalledWith(JSON.stringify(
        { event: 'ga4_comparison_refused', asset: 'meadow.example', propertyRef: '123456', code: 'ga4_comparison_incomplete_thresholded' }));
    } finally { warn.mockRestore(); }
  });

  it('converts the property clock to the installation clock', async () => {
    const result = await collectComparison('123456', 'synthetic', provider(), NOW, 'Asia/Kolkata');
    expect(result.day.startAt).toBe('2026-07-28T18:30:00.000Z');
    expect(result.day.minutes[330]).toBe(4);
    expect(result.day.sameDayLastWeek?.[330]).toBe(2);
  });

  it('shares one report and retains the last success through a failed refresh', async () => {
    const fetchImpl = provider();
    const shared: SharedComparisons = new Map();
    const input = { property: '123456', token: 'synthetic', zone: 'UTC', nowMs: NOW, fetchImpl, cache: null, shared };
    await updateComparison(env, { ...input, asset: 'meadow.example' });
    await updateComparison(env, { ...input, asset: 'northwind.example' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    const body = answer(); body.propertyQuota.tokensPerDay.remaining = 30_000;
    const result = await updateComparison(env, { asset: 'meadow.example', property: '123456', token: 'synthetic', zone: 'UTC', nowMs: NOW,
      fetchImpl: sameAnswer(body), cache: null, shared: new Map() });
    expect(result?.nextAttemptAt).toBe(new Date(NOW + 4 * 3_600_000).toISOString());
  });

  it('leaves both folds unknown when the provider hour resolves to the later fold', async () => {
    const fetchImpl = provider([['today', '202610250200', 8], ['today', '202610250400', 1], ['last_week', '202610180200', 4]], { timeZone: 'Europe/Berlin' });
    const result = await collectComparison('123456', 'synthetic', fetchImpl, Date.parse('2026-10-25T12:00:00Z'), 'UTC');
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
