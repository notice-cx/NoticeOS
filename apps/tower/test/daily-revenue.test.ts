import { describe, expect, it } from 'vitest';
import { MEDIAVINE_REPORTING_CLOCK, siteRevenueWindow, yesterdayRevenue } from '../shared/daily-revenue';

/** Explicit source clock; this generic helper never chooses a provider. */
const ZONE = 'America/Los_Angeles';

describe('yesterday revenue', () => {
  it('uses the provider calendar across UTC midnight, month boundaries and daylight saving', () => {
    expect(yesterdayRevenue(new Date('2026-09-10T00:30:00Z'), ZONE, []).date).toBe('2026-09-08');
    expect(yesterdayRevenue(new Date('2026-01-01T08:30:00Z'), ZONE, []).date).toBe('2025-12-31');
    expect(yesterdayRevenue(new Date('2026-03-09T07:30:00Z'), ZONE, []).date).toBe('2026-03-08');
  });
  it('reads yesterday on the explicitly supplied source clock', () => {
    const at = new Date('2026-09-10T00:30:00Z');
    expect(yesterdayRevenue(at, 'America/Los_Angeles', [])).toMatchObject({ date: '2026-09-08', timeZone: 'America/Los_Angeles' });
    expect(yesterdayRevenue(at, 'UTC', [])).toMatchObject({ date: '2026-09-09', timeZone: 'UTC' });
  });
  it('keeps reported zero distinct from a missing report and ignores today', () => {
    const now = new Date('2026-09-10T17:00:00Z');
    const days = [{ date: '2026-09-08', amountMinor: 1567 }, { date: '2026-09-10', amountMinor: 99999 }];
    expect(yesterdayRevenue(now, ZONE, days)).toEqual({ date: '2026-09-09', amountMinor: null, reportedThrough: '2026-09-08', timeZone: ZONE });
    expect(yesterdayRevenue(now, ZONE, [...days, { date: '2026-09-09', amountMinor: 0 }])).toEqual({ date: '2026-09-09', amountMinor: 0, reportedThrough: '2026-09-09', timeZone: ZONE });
    expect(yesterdayRevenue(now, ZONE, [])).toEqual({ date: '2026-09-09', amountMinor: null, reportedThrough: null, timeZone: ZONE });
  });
  it.each([
    ['2026-03-08T09:59:59Z', '2026-03-07'],
    ['2026-03-08T10:00:00Z', '2026-03-07'],
    ['2026-11-01T08:30:00Z', '2026-10-31'],
    ['2026-11-01T09:30:00Z', '2026-10-31'],
  ])('retains the provider day across the DST transition at %s', (instant, date) => {
    const now = new Date(instant);
    expect(yesterdayRevenue(now, MEDIAVINE_REPORTING_CLOCK.timeZone, [{ date, amountMinor: 0 }])).toMatchObject({ date, amountMinor: 0 });
    expect(siteRevenueWindow(undefined, now.getTime(), MEDIAVINE_REPORTING_CLOCK.timeZone, 7).to).toBe(date);
  });
});
