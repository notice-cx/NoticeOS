import { describe, expect, it } from 'vitest';
import type { PulseEnvelope } from '../src/schema.js';
import {
  DEFAULT_RULE_CONFIG,
  evaluatePulse,
  firedFlags,
  flowLowVolumeAnomaly,
  flowPoissonAnomaly,
  quietestJudgedPerDay,
  windowDaysFor,
  zeroCanFire,
} from '../src/rules.js';

describe('windowDaysFor (the shortest window a run of zeros could fire in)', () => {
  it.each([
    [10, 1],
    [4.7, 1],
    [4.6, 2],
    [3, 2],
    [2, 3],
    [1.5, 4],
    [1, 5],
    [0.5, 10],
    [0.33, 14],
    [0.32, undefined],
    [0, undefined],
  ])('a metric averaging %d a day is judged over %s days', (perDay, days) => {
    expect(windowDaysFor(perDay)).toBe(days);
  });

  it('picks a window in which a run of zeros fires and the day shorter one in which it would not', () => {
    for (const perDay of [4.6, 3, 2, 1.5, 1, 0.5, 0.33]) {
      const days = windowDaysFor(perDay)!;
      expect(zeroCanFire(perDay * days)).toBe(true);
      expect(zeroCanFire(perDay * (days - 1))).toBe(false);
    }
  });

  it('stops at the longest window and follows the sensitivity', () => {
    expect(windowDaysFor(1, { alpha: 0.01, maxWindowDays: 3 })).toBeUndefined();
    expect(windowDaysFor(1, { alpha: 0.01, maxWindowDays: 5 })).toBe(5);
    // A looser sensitivity lets three a day fire on one empty day: e^-3 < 0.05.
    expect(windowDaysFor(3, { alpha: 0.05, maxWindowDays: 14 })).toBe(1);
  });

  it('states the quietest daily average any window judges', () => {
    expect(quietestJudgedPerDay()).toBeCloseTo(0.3289, 4);
    expect(windowDaysFor(quietestJudgedPerDay() + 0.0001)).toBe(14);
    expect(windowDaysFor(quietestJudgedPerDay() - 0.0001)).toBeUndefined();
  });
});

describe('flowPoissonAnomaly (one-day drop)', () => {
  it('stands down where even a zero day is too probable to fire', () => {
    const v = flowPoissonAnomaly('plansSaved', 0, 2);
    expect(v.outcome).toBe('not-applicable');
    expect(v.ruleId).toBe('flow-poisson-low');
    expect(v.inputs).toMatchObject({ observed: 0, baselinePerDay: 2 });
    // e^-4.6 ~= 0.0101 is over 0.01; e^-4.7 ~= 0.0091 is under it.
    expect(flowPoissonAnomaly('x', 0, 4.6).outcome).toBe('not-applicable');
    expect(flowPoissonAnomaly('x', 0, 4.7).outcome).toBe('fired');
  });

  it('fires on the docs/02 worked example (0 vs avg7d 6.2)', () => {
    const v = flowPoissonAnomaly('plansSaved', 0, 6.2);
    expect(v.outcome).toBe('fired');
    expect(v.flag).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'plansSaved' });
    expect(v.flag?.message).toContain('avg7d 6.2');
    expect(v.inputs.lambda).toBe(6.2);
    expect(v.inputs.pLowerTail as number).toBeCloseTo(0.0020294, 6);
  });

  it('does not fire when the low count is still plausible (p >= alpha)', () => {
    // P(X<=3 | 10) ~= 0.0103 > 0.01
    const v = flowPoissonAnomaly('x', 3, 10);
    expect(v.outcome).toBe('ok');
    // one fewer crosses the threshold: P(X<=2 | 10) ~= 0.00277 < 0.01
    expect(flowPoissonAnomaly('x', 2, 10).outcome).toBe('fired');
  });

  it('honours a custom alpha', () => {
    // With a looser alpha the plausible count now fires.
    const v = flowPoissonAnomaly('x', 3, 10, { ...DEFAULT_RULE_CONFIG, alpha: 0.02 });
    expect(v.outcome).toBe('fired');
  });
});

describe('flowLowVolumeAnomaly (multi-day window)', () => {
  it('stands down on a one-day window, which belongs to the one-day rule', () => {
    expect(flowLowVolumeAnomaly('x', 0, 10, 1).outcome).toBe('not-applicable');
  });

  it('stands down with no window data (stays quiet rather than guess)', () => {
    const v = flowLowVolumeAnomaly('x', undefined, 2, 3);
    expect(v.outcome).toBe('not-applicable');
    expect(v.inputs.windowObserved).toBeNull();
  });

  it('fires on a surprisingly-empty window', () => {
    // baseline 2/day over 3 days -> lambda 6; P(X<=0 | 6) = e^-6 ~= 0.00248 < 0.01
    const v = flowLowVolumeAnomaly('leads', 0, 2, 3);
    expect(v.outcome).toBe('fired');
    expect(v.ruleId).toBe('flow-lowvol-window');
    expect(v.inputs).toMatchObject({ lambda: 6, windowDays: 3, windowHours: 72, maxWindowDays: 14 });
    expect(v.flag?.message).toContain('last72h');
  });

  it('judges the old blind spot: three a day, empty for two days', () => {
    // One empty day at 3/day is e^-3 ~= 0.05; two are e^-6 ~= 0.0025.
    const v = flowLowVolumeAnomaly('trials', 0, 3, 2);
    expect(v.outcome).toBe('fired');
    expect(v.flag?.message).toContain('last48h');
  });

  it('does not fire when the window is consistent with the baseline', () => {
    // baseline 2/day -> lambda 6; observing 6 over three days is right on the mean
    expect(flowLowVolumeAnomaly('leads', 6, 2, 3).outcome).toBe('ok');
  });

  it('records a window too short for even a run of zeros to fire as not judged', () => {
    const v = flowLowVolumeAnomaly('leads', 0, 0.2, 14);
    expect(v.outcome).toBe('not-applicable');
    expect(v.inputs).toMatchObject({ reason: 'too-few-expected', windowHours: 336 });
    expect(v.inputs.lambda as number).toBeCloseTo(2.8, 10);
  });

  it('stands down when no baseline is established yet (lambda <= 0)', () => {
    expect(flowLowVolumeAnomaly('leads', 0, 0, 3).outcome).toBe('not-applicable');
  });
});

describe('evaluatePulse (per-metric regime routing)', () => {
  const envelope: PulseEnvelope = {
    asset: 'meadow.example',
    generatedAt: '2026-07-05T03:00:00.000Z',
    capabilities: ['signups', 'plansSaved', 'leads'],
    metrics: {
      signups: { last24h: 11, avg7d: 9.3, total: 4210 }, // healthy, high volume
      plansSaved: { last24h: 0, avg7d: 6.2, total: 1880 }, // drop, high volume
      leads: { last24h: 0, avg7d: 2.0, total: 140 }, // low volume
    },
  };

  it('routes each metric to the right rule and fires appropriately', () => {
    const verdicts = evaluatePulse(envelope, { windowObservedByMetric: { leads: 0 } });
    expect(verdicts).toHaveLength(3);

    const byMetric = Object.fromEntries(verdicts.map((v) => [v.inputs.metric, v]));
    expect(byMetric.signups?.outcome).toBe('ok');
    expect(byMetric.signups?.ruleId).toBe('flow-poisson-low');

    expect(byMetric.plansSaved?.outcome).toBe('fired');
    expect(byMetric.plansSaved?.ruleId).toBe('flow-poisson-low');

    expect(byMetric.leads?.outcome).toBe('fired');
    expect(byMetric.leads?.ruleId).toBe('flow-lowvol-window');
  });

  it('gives a flat avg7d the shortest window it needs', () => {
    const quiet: PulseEnvelope = {
      ...envelope,
      capabilities: ['trials', 'newsletter'],
      metrics: {
        trials: { last24h: 0, avg7d: 3.5, total: 300 },
        newsletter: { last24h: 0, avg7d: 1.5, total: 90 },
      },
    };
    const verdicts = evaluatePulse(quiet, { windowObservedByMetric: { trials: 0, newsletter: 0 } });
    const byMetric = Object.fromEntries(verdicts.map((v) => [v.inputs.metric, v]));
    expect(byMetric.trials).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'fired' });
    expect(byMetric.trials?.inputs.windowDays).toBe(2);
    expect(byMetric.newsletter).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'fired' });
    expect(byMetric.newsletter?.inputs.windowDays).toBe(4);
  });

  it('leaves the low-volume metric quiet when no window data is supplied', () => {
    const verdicts = evaluatePulse(envelope);
    const leads = verdicts.find((v) => v.inputs.metric === 'leads');
    expect(leads?.outcome).toBe('not-applicable');
  });

  it('requires a complete central baseline when the caller enables seasonal mode', () => {
    const verdicts = evaluatePulse(envelope, {
      requireHistoricalBaseline: true,
      baselineByMetric: {
        signups: {
          perDay: 10,
          source: 'same-weekday-4w',
          sampleSize: 4,
          comparisonDates: ['2026-06-28', '2026-06-21', '2026-06-14', '2026-06-07'],
          windowHours: 24,
        },
      },
    });
    expect(verdicts.find((v) => v.inputs.metric === 'signups')?.outcome).toBe('ok');
    const plans = verdicts.find((v) => v.inputs.metric === 'plansSaved');
    expect(plans).toMatchObject({
      ruleId: 'flow-seasonal-baseline',
      outcome: 'not-applicable',
    });
    expect(plans?.inputs.reason).toBe('insufficient-same-weekday-history');
  });

  it('uses the central same-weekday baseline instead of the asset avg7d', () => {
    const verdict = evaluatePulse(envelope, {
      requireHistoricalBaseline: true,
      baselineByMetric: {
        plansSaved: {
          perDay: 2,
          source: 'same-weekday-4w',
          sampleSize: 4,
          comparisonDates: ['2026-06-28', '2026-06-21', '2026-06-14', '2026-06-07'],
          windowHours: 72,
        },
      },
      windowObservedByMetric: { plansSaved: 5 },
    }).find((v) => v.inputs.metric === 'plansSaved');
    expect(verdict?.ruleId).toBe('flow-lowvol-window');
    expect(verdict?.outcome).toBe('ok');
    expect(verdict?.inputs).toMatchObject({
      baselinePerDay: 2,
      baselineSource: 'same-weekday-4w',
      baselineSampleSize: 4,
      baselineWindowHours: 72,
    });
  });

  it('judges a central baseline on the window it was measured over', () => {
    const verdicts = evaluatePulse(envelope, {
      requireHistoricalBaseline: true,
      baselineByMetric: {
        // A one-day baseline too low for a zero day to fire: not judged.
        plansSaved: {
          perDay: 2,
          source: 'same-weekday-4w',
          sampleSize: 4,
          comparisonDates: ['2026-06-28', '2026-06-21', '2026-06-14', '2026-06-07'],
          windowHours: 24,
        },
        // The same rate measured over a four-day window: judged, and empty.
        leads: {
          perDay: 1.5,
          source: 'same-weekday-4w',
          sampleSize: 4,
          comparisonDates: ['2026-06-28', '2026-06-21', '2026-06-14', '2026-06-07'],
          windowHours: 96,
        },
      },
      windowObservedByMetric: { leads: 0 },
    });
    const byMetric = Object.fromEntries(verdicts.map((v) => [v.inputs.metric, v]));
    expect(byMetric.plansSaved).toMatchObject({ ruleId: 'flow-poisson-low', outcome: 'not-applicable' });
    expect(byMetric.leads).toMatchObject({ ruleId: 'flow-lowvol-window', outcome: 'fired' });
    expect(byMetric.leads?.inputs).toMatchObject({ lambda: 6, windowDays: 4, baselineWindowHours: 96 });
  });

  it('firedFlags extracts only the fired verdicts', () => {
    const verdicts = evaluatePulse(envelope, { windowObservedByMetric: { leads: 0 } });
    const fired = firedFlags(verdicts);
    expect(fired).toHaveLength(2);
    expect(fired.every((v) => v.outcome === 'fired' && v.flag)).toBe(true);
  });
});
