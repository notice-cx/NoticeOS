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

describe('seasonalInputsFrom — stored counts and prediction evidence', () => {
  const config = DEFAULT_RULE_CONFIG;
  const full = history(seasonalHistorySpanDays(config), counts);
  const evaluate = (reports: Map<string, PulseEnvelope>, current = today) => evaluatePulse(current, {
    config, ...seasonalInputsFrom(reports, current, config), requireHistoricalBaseline: true,
  });

  it('keeps eight nonoverlapping matching periods and the full prediction', () => {
    const { baselineByMetric } = seasonalInputsFrom(full, today, config);
    expect(baselineByMetric.busy).toMatchObject({ perDay: 10, source: 'same-weekday-8-periods',
      sampleSize: 8, windowHours: 48, comparisonDates: [7,14,21,28,35,42,49,56].map(ago),
      forecast: { model: 'weekday-log-predictive-v1', comparisonCounts: Array(8).fill(20) } });
    const long = baselineByMetric.quiet!.candidates!.find((c) => c.windowHours === 14 * 24)!;
    expect(long.comparisonDates).toEqual([14,28,42,56,70,84,98,112].map(ago));
    expect(long.forecast!.comparisonCounts).toEqual(Array(8).fill(7));
  });

  it('leaves silence unjudged rather than treating it as confirmed health', () => {
    const verdict = evaluate(full).find((v) => v.inputs.metric === 'silent');
    expect(verdict).toMatchObject({ outcome: 'not-applicable', inputs: { reason: 'insufficient-predictive-evidence' } });
  });

  it('allows a sparse complete outage to accumulate several days of evidence', () => {
    const healthy = history(seasonalHistorySpanDays(config), () => ({ signups: 2 }));
    const current = report(TODAY, { signups: 0 });
    const first = evaluate(healthy, current)[0]!;
    expect(first.outcome).not.toBe('fired');
    for (let back = 1; back <= 13; back++) healthy.set(ago(back), report(ago(back), { signups: 0 }));
    const outage = evaluate(healthy, current)[0]!;
    expect(outage.outcome).toBe('fired');
    expect(outage.inputs.windowHours).toBeGreaterThan(24);
    expect(outage.inputs.windowObserved).toBe(0);
  });

  it('never turns a missing current-window day into a zero', () => {
    const reports = history(seasonalHistorySpanDays(config), () => ({ signups: 2 }));
    for (let back = 1; back <= 13; back++) reports.set(ago(back), report(ago(back), { signups: 0 }));
    reports.delete(ago(1));
    expect(evaluate(reports, report(TODAY, { signups: 0 }))[0]!.outcome).not.toBe('fired');
  });

  it('requires eight periods, ignores future reports, and retains real zeros', () => {
    expect(seasonalInputsFrom(history(28, counts), today, config).baselineByMetric.busy).toBeUndefined();
    const withFuture = new Map(full);
    withFuture.set(shiftDate(TODAY, 1), report(shiftDate(TODAY, 1), { busy: 100000 }));
    withFuture.set(TODAY, report(TODAY, { busy: 100000 }));
    expect(seasonalInputsFrom(withFuture, today, config)).toEqual(seasonalInputsFrom(full, today, config));
    expect(seasonalInputsFrom(full, today, config).baselineByMetric.silent!.forecast!.comparisonCounts).toEqual(Array(8).fill(0));
  });

  it('withholds a prediction when a required comparison is missing or invalid', () => {
    for (const bad of [undefined, NaN, -1, 1.5]) {
      const reports = new Map(full);
      if (bad === undefined) reports.delete(ago(14));
      else reports.set(ago(14), report(ago(14), { busy: bad }));
      expect(seasonalInputsFrom(reports, today, config).baselineByMetric.busy).toBeUndefined();
    }
  });

  it('keeps a shorter complete comparison when a longer window encounters a gap', () => {
    const reports = new Map(full);
    reports.delete(ago(9));
    const { baselineByMetric } = seasonalInputsFrom(reports, today, config);
    expect(baselineByMetric.busy!.windowHours).toBe(48);
    expect(baselineByMetric.busy!.candidates!.every((c) => c.windowHours < 4 * 24)).toBe(true);
  });
});

describe('seasonalHistorySpanDays', () => {
  it.each([[1,62],[3,64],[7,68],[8,125],[14,131],[28,257]])('bounds a %d-day model at %d prior days', (maxWindowDays, span) => {
    expect(seasonalHistorySpanDays({ ...DEFAULT_RULE_CONFIG, maxWindowDays })).toBe(span);
  });
});
