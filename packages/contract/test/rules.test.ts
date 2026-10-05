import { describe, expect, it } from 'vitest';
import type { PulseEnvelope } from '../src/schema.js';
import {
  DEFAULT_RULE_CONFIG,
  evaluatePulse,
  firedFlags,
  flowLowVolumeAnomaly,
  flowPoissonAnomaly,
  percentageDropAnomaly,
} from '../src/rules.js';

describe('flowPoissonAnomaly (normal-volume drop)', () => {
  it('stands down below the minimum baseline', () => {
    const v = flowPoissonAnomaly('plansSaved', 0, 2);
    expect(v.outcome).toBe('not-applicable');
    expect(v.ruleId).toBe('flow-poisson-low');
    expect(v.inputs).toMatchObject({ observed: 0, baselinePerDay: 2 });
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

  it('is applicable-but-quiet at exactly the baseline floor', () => {
    // baseline == 3 (applies); P(X<=0 | 3) = e^-3 ~= 0.0498 > 0.01 -> ok
    const v = flowPoissonAnomaly('x', 0, 3);
    expect(v.outcome).toBe('ok');
    expect(v.inputs.lambda).toBe(3);
  });

  it('honours a custom alpha', () => {
    // With a looser alpha the plausible count now fires.
    const v = flowPoissonAnomaly('x', 3, 10, { ...DEFAULT_RULE_CONFIG, alpha: 0.02 });
    expect(v.outcome).toBe('fired');
  });
});

describe('flowLowVolumeAnomaly (multi-day window)', () => {
  it('stands down at/above the normal-volume baseline', () => {
    expect(flowLowVolumeAnomaly('x', 0, 3).outcome).toBe('not-applicable');
  });

  it('stands down with no window data (stays quiet rather than guess)', () => {
    const v = flowLowVolumeAnomaly('x', undefined, 2);
    expect(v.outcome).toBe('not-applicable');
    expect(v.inputs.windowObserved).toBeNull();
  });

  it('fires on a surprisingly-empty window', () => {
    // baseline 2/day -> lambda over 72h = 6; P(X<=0 | 6) = e^-6 ~= 0.00248 < 0.01
    const v = flowLowVolumeAnomaly('leads', 0, 2);
    expect(v.outcome).toBe('fired');
    expect(v.ruleId).toBe('flow-lowvol-window');
    expect(v.inputs.lambda).toBe(6);
    expect(v.flag?.message).toContain('last72h');
  });

  it('does not fire when the window is consistent with the baseline', () => {
    // baseline 2/day -> lambda 6; observing 6 over 72h is right on the mean
    expect(flowLowVolumeAnomaly('leads', 6, 2).outcome).toBe('ok');
  });

  it('stands down when no baseline is established yet (lambda <= 0)', () => {
    expect(flowLowVolumeAnomaly('leads', 0, 0).outcome).toBe('not-applicable');
  });
});

describe('percentageDropAnomaly (gated on min absolute count)', () => {
  it('stands down below the absolute-count gate', () => {
    // default minAbsoluteCount = 5; a 4/day metric never trips this rule
    expect(percentageDropAnomaly('x', 0, 4).outcome).toBe('not-applicable');
  });

  it('fires on a large relative drop above the gate', () => {
    const v = percentageDropAnomaly('x', 2, 10);
    expect(v.outcome).toBe('fired');
    expect(v.inputs.dropFraction as number).toBeCloseTo(0.8, 10);
    expect(v.flag?.message).toContain('80% below');
  });

  it('does not fire on a modest drop', () => {
    expect(percentageDropAnomaly('x', 8, 10).outcome).toBe('ok');
  });

  it('respects custom gate/threshold options', () => {
    const v = percentageDropAnomaly('x', 0, 4, { minAbsoluteCount: 3, minDropFraction: 0.5 });
    expect(v.outcome).toBe('fired');
    expect(v.inputs.dropFraction).toBe(1);
  });
});

describe('evaluatePulse (per-metric regime routing)', () => {
  const envelope: PulseEnvelope = {
    asset: 'meals.example',
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

  it('firedFlags extracts only the fired verdicts', () => {
    const verdicts = evaluatePulse(envelope, { windowObservedByMetric: { leads: 0 } });
    const fired = firedFlags(verdicts);
    expect(fired).toHaveLength(2);
    expect(fired.every((v) => v.outcome === 'fired' && v.flag)).toBe(true);
  });
});
