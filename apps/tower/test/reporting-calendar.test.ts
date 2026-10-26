import { describe, expect, it } from 'vitest';
import { calendarDayStart, reportingCalendarTrend } from '@shared/reporting-calendar';
import type { SignalTrend } from '@shared/wall';

const trend = (series: SignalTrend['series'], overrides: Partial<SignalTrend> = {}): SignalTrend => ({
  series, contextSeries: [], timeZone: 'America/New_York', timeZoneChanges: [], provisionalFrom: null, collectedAt: null, ...overrides,
});

describe('reporting days on the selected display calendar', () => {
  it('weights adjacent New York reports into Pacific days and preserves the provider observations', () => {
    const raw = trend([{ t: '2026-09-21', v: 240 }, { t: '2026-09-22', v: 480 }, { t: '2026-09-23', v: 720 }]);
    const adjusted = reportingCalendarTrend(raw, 'America/Los_Angeles');
    expect(adjusted.series[0]).toEqual({ t: '2026-09-21', v: 270 });
    expect(adjusted.timeZone).toBe('America/Los_Angeles');
    expect(adjusted.estimatedDates).toContain('2026-09-21');
    expect(raw.series[0]!.v).toBe(240);
    expect(reportingCalendarTrend(adjusted, 'America/Los_Angeles')).toBe(adjusted);
  });

  it('weights rate metrics as averages instead of adding them', () => {
    const raw = trend([{ t: '2026-09-21', v: 10 }, { t: '2026-09-22', v: 20 }]);
    expect(reportingCalendarTrend(raw, 'America/Los_Angeles', 'average').series[0]!.v).toBe(11.25);
  });

  it('preserves signed financial adjustments when daily reports use different clocks', () => {
    const raw = trend([{ t: '2026-09-21', v: -240 }, { t: '2026-09-22', v: 0 }]);
    expect(reportingCalendarTrend(raw, 'America/Los_Angeles').series[0]!.v).toBe(-210);
  });

  it('fills a timezone-created missing day, preserves measured zero and leaves unrelated outages missing', () => {
    const raw = trend([{ t: '2026-09-01', v: 240 }, { t: '2026-09-03', v: 240 }, { t: '2026-09-04', v: 0 }, { t: '2026-09-07', v: 240 }], {
      timeZoneChanges: [{ effectiveOn: '2026-09-03', from: 'UTC', to: 'America/New_York' }],
    });
    const adjusted = reportingCalendarTrend(raw);
    expect(adjusted.series.find(point => point.t === '2026-09-02')!.v).toBeGreaterThan(0);
    expect(adjusted.estimatedDates).toContain('2026-09-02');
    expect(adjusted.series.find(point => point.t === '2026-09-04')!.v).toBe(0);
    expect(adjusted.series.some(point => point.t === '2026-09-06')).toBe(false);
  });

  it('uses the actual 23- and 25-hour calendar day lengths', () => {
    const zone = 'America/Los_Angeles';
    expect((calendarDayStart('2026-03-09', zone) - calendarDayStart('2026-03-08', zone)) / 3_600_000).toBe(23);
    expect((calendarDayStart('2026-11-02', zone) - calendarDayStart('2026-11-01', zone)) / 3_600_000).toBe(25);
  });

  it('does not reapply an old provider transition when converting an already adjusted series', () => {
    const raw = trend([{ t: '2026-09-01', v: 240 }, { t: '2026-09-02', v: 240 }, { t: '2026-09-03', v: 240 }], {
      timeZoneChanges: [{ effectiveOn: '2026-09-02', from: 'UTC', to: 'America/New_York' }],
    });
    const pacific = reportingCalendarTrend(raw, 'America/Los_Angeles');
    const withHistory = reportingCalendarTrend(pacific, 'UTC');
    const withoutHistory = reportingCalendarTrend({ ...pacific, timeZoneChanges: [] }, 'UTC');
    expect(withHistory.series).toEqual(withoutHistory.series);
  });
});
