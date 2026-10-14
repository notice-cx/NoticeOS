// The window a metric is judged over, built from the stored reports before it:
// the shortest whole-day window in which a run of zeros would fire, compared
// with four earlier windows of the same length that end on the same weekday
// and overlap neither one another nor the window being judged.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_CONFIG, evaluatePulse, type PulseEnvelope } from '@noticeos/contract';
import { seasonalHistorySpanDays, seasonalInputsFrom, shiftDate } from '../src/db.js';

const TODAY = '2026-07-05';

function report(date: string, metrics: Record<string, number>): PulseEnvelope {
  return {
    asset: 'meadow.example',
    generatedAt: `${date}T03:00:00.000Z`,
    capabilities: Object.keys(metrics),
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([metric, value]) => [metric, { last24h: value, avg7d: value, total: 0 }]),
    ),
  };
}

/** Each of the `days` days before today, with the counts `counts(back)` gives
 * for the day `back` days ago. */
function history(days: number, counts: (back: number) => Record<string, number>): Map<string, PulseEnvelope> {
  const reports = new Map<string, PulseEnvelope>();
  for (let back = 1; back <= days; back++) {
    const date = shiftDate(TODAY, -back);
    reports.set(date, report(date, counts(back)));
  }
  return reports;
}

const ago = (back: number) => shiftDate(TODAY, -back);

/** Busy: 10 a day. Newsletter: 2 and 1 on alternate days, 1.5 a day. Quiet: 1
 * every other day, ending on a 1 at each two-week mark. Silent: none. */
function counts(back: number): Record<string, number> {
  return {
    busy: 10,
    newsletter: back % 2 === 0 ? 1 : 2,
    quiet: back % 2 === 0 ? 1 : 0,
    silent: 0,
  };
}

const today = report(TODAY, { busy: 10, newsletter: 0, quiet: 0, silent: 0 });

describe('seasonalInputsFrom — the window each metric is judged over', () => {
  const full = history(seasonalHistorySpanDays(DEFAULT_RULE_CONFIG), counts);
  const { baselineByMetric, windowObservedByMetric } = seasonalInputsFrom(full, today, DEFAULT_RULE_CONFIG);

  it('judges a busy metric on one day against its four matching weekdays', () => {
    expect(baselineByMetric.busy).toMatchObject({
      perDay: 10,
      windowHours: 24,
      comparisonDates: [ago(7), ago(14), ago(21), ago(28)],
    });
    expect(windowObservedByMetric.busy).toBeUndefined();
  });

  it('widens a 1.5-a-day metric to four days, where four empty days could fire', () => {
    // Three days hold 4.5 on average (e^-4.5 ~= 0.011); four hold 6 (e^-6 ~= 0.0025).
    expect(baselineByMetric.newsletter).toMatchObject({
      perDay: 1.5,
      windowHours: 96,
      comparisonDates: [ago(7), ago(14), ago(21), ago(28)],
    });
    // Today's 0 and the three days before it: 2 + 1 + 2.
    expect(windowObservedByMetric.newsletter).toBe(5);
  });

  it('spaces the earlier windows two weeks apart once a window is longer than one', () => {
    // Nine days ending on a two-week mark hold five; eight hold four (e^-4 ~= 0.018).
    expect(baselineByMetric.quiet).toMatchObject({
      windowHours: 9 * 24,
      comparisonDates: [ago(14), ago(28), ago(42), ago(56)],
    });
    expect(baselineByMetric.quiet!.perDay).toBeCloseTo(5 / 9, 10);
    // The newest earlier window ends 14 days back and starts 22 back; the window
    // being judged covers today and the 8 days before it.
    expect(windowObservedByMetric.quiet).toBe(4);
  });

  it('measures a metric too quiet for the longest window over that window, and the rule leaves it unjudged', () => {
    expect(baselineByMetric.silent).toMatchObject({ perDay: 0, windowHours: 14 * 24 });
    const verdict = evaluatePulse(today, {
      config: DEFAULT_RULE_CONFIG,
      baselineByMetric,
      windowObservedByMetric,
      requireHistoricalBaseline: true,
    }).find((v) => v.inputs.metric === 'silent');
    expect(verdict).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'not-applicable' });
    expect(verdict?.inputs.reason).toBe('too-few-expected');
  });

  it('fires on four empty days of a 1.5-a-day metric', () => {
    const emptied = history(seasonalHistorySpanDays(DEFAULT_RULE_CONFIG), (back) => ({
      ...counts(back),
      newsletter: back <= 3 ? 0 : counts(back).newsletter!,
    }));
    const seasonal = seasonalInputsFrom(emptied, today, DEFAULT_RULE_CONFIG);
    const verdict = evaluatePulse(today, {
      config: DEFAULT_RULE_CONFIG,
      ...seasonal,
      requireHistoricalBaseline: true,
    }).find((v) => v.inputs.metric === 'newsletter');
    expect(verdict).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'fired' });
    expect(verdict?.inputs).toMatchObject({ windowObserved: 0, lambda: 6, windowHours: 96 });
  });

  it('leaves a metric without a baseline when a day its window needs has no report', () => {
    const gap = history(seasonalHistorySpanDays(DEFAULT_RULE_CONFIG), counts);
    // Inside the earlier four-day window that ends a week ago, and not one of
    // the four matching weekdays a one-day test reads.
    gap.delete(ago(9));
    const seasonal = seasonalInputsFrom(gap, today, DEFAULT_RULE_CONFIG);
    expect(seasonal.baselineByMetric.newsletter).toBeUndefined();
    expect(seasonal.baselineByMetric.busy?.windowHours).toBe(24);
  });

  it('stops at the configured longest window', () => {
    const short = { ...DEFAULT_RULE_CONFIG, maxWindowDays: 3 };
    const seasonal = seasonalInputsFrom(history(seasonalHistorySpanDays(short), counts), today, short);
    expect(seasonal.baselineByMetric.newsletter?.windowHours).toBe(72);
    const verdict = evaluatePulse(today, { config: short, ...seasonal, requireHistoricalBaseline: true })
      .find((v) => v.inputs.metric === 'newsletter');
    expect(verdict).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'not-applicable' });
  });
});

describe('seasonalHistorySpanDays — how far back the baseline reads', () => {
  it.each([
    [1, 28],
    [3, 30],
    [7, 34],
    [8, 63],
    [14, 69],
  ])('a longest window of %d days reads %d days back', (maxWindowDays, span) => {
    expect(seasonalHistorySpanDays({ ...DEFAULT_RULE_CONFIG, maxWindowDays })).toBe(span);
  });
});
