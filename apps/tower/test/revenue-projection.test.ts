// @vitest-environment node
import { MEDIAVINE_REPORTING_CLOCK } from '../shared/daily-revenue';
import { describe, expect, it } from 'vitest';
import { projectRevenue, revenueExpectedThrough, shiftRevenueDate, type RevenueDay, type RevenueHoliday } from '../shared/revenue-projection';
import type { SignalTrend, PortfolioBand } from '../shared/wall';
import { monthRevenue } from '../src/lib/wall-revenue';
import { revenueHolidays } from '../worker/revenue-holidays';
import { createTestStore } from "./postgres-store";
import { addSites } from './sites';
import { seedRevenueHistory } from './revenue-fixture';
import { writeMediavine } from './money';
import { buildWallPayload } from '../worker/wall-payload';
import { generateDemoScenario } from '../../../scripts/demo-scenario.mjs';

const NOW = new Date('2026-09-09T15:00:00Z');
/** Explicit Mediavine report clock; Settings cannot replace it. */
const ZONE = MEDIAVINE_REPORTING_CLOCK;
function history(modify?: (date: string, value: number) => number) {
  const revenue: RevenueDay[] = [];
  const traffic: SignalTrend = { contextSeries: [], series: [], provisionalFrom: '2026-09-09', collectedAt: NOW.toISOString(), timeZoneChanges: [] };
  for (let date = '2026-06-17'; date <= '2026-09-08'; date = shiftRevenueDate(date, 1)) {
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    const sessions = modify?.(date, day === 0 || day === 6 ? 100 : 1000) ?? (day === 0 || day === 6 ? 100 : 1000);
    traffic.series.push({ t: date, v: sessions });
    revenue.push({ date, amountMinor: sessions });
  }
  return { revenue, traffic };
}
describe('monthly revenue projection', () => {
  it.each([
    ['2026-03-08T13:09:59Z', '2026-03-06'],
    ['2026-03-08T13:10:00Z', '2026-03-07'],
    ['2026-11-01T14:09:59Z', '2026-10-30'],
    ['2026-11-01T14:10:00Z', '2026-10-31'],
  ])('expects the correct Mediavine report across DST/cutoff at %s', (instant, through) => {
    expect(revenueExpectedThrough(new Date(instant), MEDIAVINE_REPORTING_CLOCK)).toBe(through);
  });
  it('refuses an undeclared readiness cutoff instead of applying a universal provider default', () => {
    expect(() => revenueExpectedThrough(NOW, { timeZone: 'UTC' } as Parameters<typeof revenueExpectedThrough>[1])).toThrow('declared');
    for (const readyAfterMinute of [-1, 1440, Number.NaN]) {
      expect(() => revenueExpectedThrough(NOW, { timeZone: 'UTC', readyAfterMinute })).toThrow('declared');
    }
  });
  it('learns weekday traffic and similar-traffic earnings, rather than multiplying the month-to-date average', () => {
    const { revenue, traffic } = history();
    const result = projectRevenue(NOW, ZONE, revenue, traffic);
    expect(result).toMatchObject({ status: 'ready', earnedMinor: 6200, projectedMinor: 22800, dailyPaceMinor: 755, previousMonthMinor: 22000 });
    expect(result.points).toHaveLength(30);
    expect(result.points.filter(point => !point.projected)).toHaveLength(8);
    expect(result.projectedMinor).not.toBe(Math.round(6200 / 8 * 30));
    expect(result.points[12]!.cumulativeMinor - result.points[11]!.cumulativeMinor).toBe(100);
  });
  it('learns a different weekday pattern for another asset', () => {
    const { revenue, traffic } = history((_date, value) => value === 100 ? 1000 : 100);
    expect(projectRevenue(NOW, ZONE, revenue, traffic).projectedMinor).toBe(10200);
  });
  it('uses earnings from comparable traffic instead of averaging rates from very different volumes', () => {
    const { revenue, traffic } = history();
    revenue.forEach(day => { if (day.amountMinor === 100) day.amountMinor = 300; });
    const result = projectRevenue(NOW, ZONE, revenue, traffic);
    expect(result.projectedMinor).toBe(24400); // 22 weekdays × $10, eight weekends × $3.
  });
  it.each([0.1, 2])('learns holiday traffic effects of %s from this asset, with no fixed holiday discount', ratio => {
    const holidays: RevenueHoliday[] = [{ date: '2026-06-19', name: 'First holiday' }, { date: '2026-07-03', name: 'Second holiday' }, { date: '2026-09-21', name: 'Upcoming holiday' }];
    const { revenue, traffic } = history((date, value) => holidays.some(holiday => holiday.date === date) ? value * ratio : value);
    const result = projectRevenue(NOW, ZONE, revenue, traffic, holidays);
    expect(result.status).toBe('ready');
    expect(result.holidayHistoryDays).toBe(2);
    expect(result.points[20]!.cumulativeMinor - result.points[19]!.cumulativeMinor).toBe(1000 * ratio);
  });
  it('does not quietly assume an unlearned future holiday behaves normally', () => {
    const { revenue, traffic } = history();
    expect(projectRevenue(NOW, ZONE, revenue, traffic, [{ date: '2026-09-21', name: 'New holiday' }])).toMatchObject({ status: 'insufficient-history', projectedMinor: null });
  });
  it('keeps a past holiday out of the normal weekday traffic baseline', () => {
    const { revenue, traffic } = history((date, value) => date === '2026-09-07' ? 100 : value);
    const result = projectRevenue(NOW, ZONE, revenue, traffic, [{ date: '2026-09-07', name: 'Holiday' }]);
    expect(result.status).toBe('ready');
    expect(result.points[13]!.cumulativeMinor - result.points[12]!.cumulativeMinor).toBe(1000);
  });
  it('does not convert a revenue gap, a missing day or stale traffic into a forecast', () => {
    const { revenue, traffic } = history();
    expect(projectRevenue(NOW, ZONE, revenue.filter(day => day.date !== '2026-09-03'), traffic)).toMatchObject({ status: 'waiting-revenue', earnedMinor: null, projectedMinor: null });
    expect(projectRevenue(NOW, ZONE, revenue.slice(0, -1), traffic).status).toBe('waiting-revenue');
    expect(projectRevenue(NOW, ZONE, revenue, { ...traffic, collectedAt: '2026-09-05T00:00:00Z' }).status).toBe('waiting-traffic');
    expect(projectRevenue(NOW, ZONE, revenue, { ...traffic, series: traffic.series.slice(0, -1) }).status).toBe('waiting-traffic');
  });
  it('projects while GA4 still settles yesterday, but not when the collector has stalled', () => {
    const { revenue, traffic } = history();
    // Yesterday (2026-09-08) collected but provisional until D+2.
    expect(projectRevenue(NOW, ZONE, revenue, { ...traffic, provisionalFrom: '2026-09-08' }).status).toBe('ready');
    // A provisional boundary three days back is a stalled collector, not settling.
    expect(projectRevenue(NOW, ZONE, revenue, { ...traffic, provisionalFrom: '2026-09-06' })).toMatchObject({ status: 'waiting-traffic', projectedMinor: null });
    // Yesterday missing outright, with nothing marked provisional, still waits.
    expect(projectRevenue(NOW, ZONE, revenue, { ...traffic, provisionalFrom: null, series: traffic.series.slice(0, -1) }).status).toBe('waiting-traffic');
  });
  it('does not use partial today or future observations as training data', () => {
    const { revenue, traffic } = history();
    const expected = projectRevenue(NOW, ZONE, revenue, traffic);
    traffic.series.push({ t: '2026-09-09', v: 999999 }, { t: '2026-09-10', v: 999999 });
    revenue.push({ date: '2026-09-09', amountMinor: 999999 });
    expect(projectRevenue(NOW, ZONE, revenue, traffic)).toEqual(expected);
  });
  it('accepts genuine zero earnings and withholds forecasts with too little history', () => {
    const { revenue, traffic } = history();
    expect(projectRevenue(NOW, ZONE, revenue.map(day => ({ ...day, amountMinor: 0 })), traffic)).toMatchObject({ status: 'ready', earnedMinor: 0, projectedMinor: 0, changePercent: null });
    expect(projectRevenue(NOW, ZONE, revenue.slice(-8), traffic)).toMatchObject({ status: 'insufficient-history', historyDays: 8, projectedMinor: null });
    expect(projectRevenue(NOW, ZONE, [], traffic).status).toBe('no-revenue');
  });
  it('keeps a month with no current revenue report unknown, including the first day', () => {
    const { revenue, traffic } = history();
    for (let date = '2026-09-09'; date <= '2026-09-30'; date = shiftRevenueDate(date, 1)) {
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      const value = weekday === 0 || weekday === 6 ? 100 : 1000;
      revenue.push({ date, amountMinor: value }); traffic.series.push({ t: date, v: value });
    }
    const now = new Date('2026-10-01T15:00:00Z');
    const fresh = { ...traffic, collectedAt: now.toISOString(), provisionalFrom: '2026-10-01' };
    const first = projectRevenue(now, ZONE, revenue, fresh);
    expect(first).toMatchObject({ period: '2026-10', status: 'ready', earnedMinor: null, projectedMinor: 22900, previousMonthMinor: 22800 });
    expect(first.points.every(point => point.projected)).toBe(true);
    expect(projectRevenue(new Date('2026-10-02T15:00:00Z'), ZONE, revenue, fresh)).toMatchObject({ earnedMinor: null, status: 'waiting-revenue' });
    const zero = projectRevenue(new Date('2026-10-02T15:00:00Z'), ZONE, [...revenue, { date: '2026-10-01', amountMinor: 0 }], { ...fresh, collectedAt: '2026-10-02T15:00:00Z' });
    expect(zero.earnedMinor).toBe(0);
  });
  it.each(['2026-10-01T12:00:00.000Z', '2026-10-03T12:00:00.000Z'])('reads recorded software income without a traffic forecast at %s', cutoff => {
    const scenario = generateDemoScenario({ seed: 'month-start', cutoff, release: '1'.repeat(40) });
    const period = cutoff.slice(0, 7);
    const currentLedger = scenario.ledger.filter(row => row.period === period);
    const income = currentLedger.filter(row => row.kind === 'revenue');
    expect(income).toHaveLength(2);
    expect(income.every(row => row.coverageComplete === false && row.coverageEnd === cutoff.slice(0, 10))).toBe(true);
    const projections = scenario.assets.filter(asset => !asset.isOs).map(asset => {
      const days = scenario.daily.filter(day => day.asset === asset.id);
      const projection = projectRevenue(new Date(cutoff), { timeZone: 'UTC', readyAfterMinute: 0 }, [], { series: days.filter(day => !day.reportMissing).map(day => ({ t: day.date, v: day.sessions })), provisionalFrom: null, collectedAt: cutoff, timeZoneChanges: [] });
      expect(projection.status).toBe('no-revenue');
      expect(projection.earnedMinor).toBeNull();
      return { revenueProjection: projection };
    });
    const revenue = income.reduce((sum, row) => sum + row.minor, 0) / 100;
    const cost = currentLedger.filter(row => row.kind === 'cost').reduce((sum, row) => sum + row.minor, 0) / 100;
    const zero = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
    const band: PortfolioBand = { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD', period, periodIsCurrent: true, booked: { currency: 'USD', revenue, cost, net: revenue - cost }, forecast: zero,
      revenueRecorded: { booked: true, forecast: false }, netTrend: [], netTrendAll: [], trendGranularity: 'monthly', bookedDelta: null,
      residue: { booked: zero, forecast: zero }, firstRun: false, daysIn: 400 };
    const model = monthRevenue(band, projections);
    expect(model).toMatchObject({ period, periodIsCurrent: true, revenue, state: 'booked', pace: null, previousMonth: null });
    expect(revenue).toBeGreaterThan(0);
  });
  it('does not compare a projected whole month with an incomplete prior month', () => {
    const { revenue, traffic } = history();
    expect(projectRevenue(NOW, ZONE, revenue.filter(day => day.date !== '2026-08-01'), traffic)).toMatchObject({ status: 'ready', previousMonthMinor: null, changePercent: null });
  });
  it('excludes days distorted by a reporting timezone change', () => {
    const { revenue, traffic } = history();
    traffic.timeZoneChanges = [{ effectiveOn: '2026-08-24', from: 'America/New_York', to: 'America/Los_Angeles' }];
    traffic.series.find(day => day.t === '2026-08-24')!.v = 999999;
    expect(projectRevenue(NOW, ZONE, revenue, traffic).projectedMinor).toBe(22800);
  });
  it('respects the Pacific 6:10 availability boundary', () => {
    const { revenue, traffic } = history();
    expect(projectRevenue(new Date('2026-09-09T13:09:00Z'), ZONE, revenue.slice(0, -1), { ...traffic, collectedAt: '2026-09-09T12:00:00Z' }).status).toBe('ready');
    expect(projectRevenue(new Date('2026-09-09T13:10:00Z'), ZONE, revenue.slice(0, -1), { ...traffic, collectedAt: '2026-09-09T12:00:00Z' }).status).toBe('waiting-revenue');
  });
  it('requires each source to declare its month clock and readiness cutoff', () => {
    const { revenue, traffic } = history();
    // An independent UTC source with a 02:00 cutoff must not inherit
    // Mediavine's Pacific clock or its 06:10 cutoff.
    const at = new Date('2026-09-09T13:09:00Z');
    const fresh = { ...traffic, collectedAt: '2026-09-09T12:00:00Z' };
    expect(projectRevenue(at, MEDIAVINE_REPORTING_CLOCK, revenue.slice(0, -1), fresh).status).toBe('ready');
    expect(projectRevenue(at, { timeZone: 'UTC', readyAfterMinute: 120 }, revenue.slice(0, -1), fresh).status).toBe('waiting-revenue');
    expect(revenueExpectedThrough(at, MEDIAVINE_REPORTING_CLOCK)).toBe('2026-09-07');
    expect(revenueExpectedThrough(at, { timeZone: 'UTC', readyAfterMinute: 120 })).toBe('2026-09-08');
    // Past 10 a.m. UTC on the 30th it is already the 1st on Kiritimati.
    expect(projectRevenue(new Date('2026-09-30T20:00:00Z'), { timeZone: 'Pacific/Kiritimati', readyAfterMinute: 0 }, revenue, fresh).period).toBe('2026-10');
    expect(projectRevenue(new Date('2026-09-30T20:00:00Z'), { timeZone: 'UTC', readyAfterMinute: 0 }, revenue, fresh).period).toBe('2026-09');
  });
});
describe('maintained public-holiday calendar', () => {
  it('supplies movable and observed dates for the configured country only', () => {
    expect(revenueHolidays('US', 2026).map(day => day.date)).toEqual(expect.arrayContaining(['2026-07-03', '2026-09-07', '2026-11-26']));
    expect(revenueHolidays('CA', 2026).map(day => day.date)).toContain('2026-07-01');
    expect(revenueHolidays('none', 2026)).toEqual([]);
  });
});
it('derives the Wall projection from current stored revisions without writing projected money into accounting', async () => {
  const raw = await createTestStore();
  try {
    await addSites(raw, [{ id: 'sample.test', displayName: 'Sample', status: 'live', senseOnly: 0, createdAt: NOW.toISOString() }]);
    const store = raw.call;
    await seedRevenueHistory(store, 'sample.test', NOW.toISOString(), '2026-09-08');
    const options = { now: NOW, osTimeZone: ZONE.timeZone, constants: { dataUsd: 25 }, integrations: { catalog: [], assets: {} }, pullConfig: [], dashboard: {}, serpPanel: { assets: {} } };
    const dailyRows = async () => (await store.read((tx) => tx.query<{ count: number }>('SELECT count(*)::int AS count FROM noticeos.mediavine_daily')))[0];
    const before = await dailyRows();
    const wall = await buildWallPayload(store, options);
    expect(wall.assets[0]!.revenueProjection).toMatchObject({ status: 'ready', earnedMinor: 12400, projectedMinor: 45600 });
    expect(wall.assets[0]!.forecast.revenue).toBe(124);
    expect(wall.assets[0]!.dailyRevenue).toEqual({ date: '2026-09-08', amountMinor: 2000, reportedThrough: '2026-09-08', timeZone: ZONE.timeZone });
    expect(await dailyRows()).toEqual(before);
    await writeMediavine(store, [{ id: 'revised-revenue', asset: 'sample.test', siteId: 'forecast-site', start: '2026-09-08', end: '2026-09-08',
      attemptedAt: NOW.toISOString(), days: [['2026-09-08', 2200]] }]);
    const updated = await buildWallPayload(store, options);
    expect(updated.assets[0]!.revenueProjection?.earnedMinor).toBe(12600);
    expect(updated.assets[0]!.forecast.revenue).toBe(126);
    expect(updated.assets[0]!.dailyRevenue?.amountMinor).toBe(2200);
  } finally { await raw.close(); }
});
