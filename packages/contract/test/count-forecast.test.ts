import { isLegacyEnvelopeCountWarning, parseLegacyCountWarning } from '../src/legacy-count-warning.js';
import { describe, expect, it } from 'vitest';
import { countTailUpperBound, fitCountTrend, forecastCounts, forecastLowerTail, studentLowerTail, studentQuantile } from '../src/count-forecast.js';
import { countHistorySpanDays, countWindowFrom } from '../src/count-history.js';
import { poissonLowerTail } from '../src/poisson.js';

const ALPHA = 0.01;
const MAX_DAYS = 14;

describe('future count predictions', () => {
  it('pins Student-t probabilities to Cauchy and df=2 identities and tabulated df=6 quantiles', () => {
    expect(studentLowerTail(1, 1)).toBeCloseTo(0.75, 12);
    expect(studentLowerTail(2, 2)).toBeCloseTo(0.5 + 1 / Math.sqrt(6), 12);
    expect(studentQuantile(0.99, 6)).toBeCloseTo(3.1426684033, 8);
    expect(studentQuantile(0.999, 6)).toBeCloseTo(5.2076262388, 8);
    for (const x of [0, 0.01, 1, 3, 10, 100]) expect(studentLowerTail(-x, 6)).toBeCloseTo(1 - studentLowerTail(x, 6), 12);
    expect(studentLowerTail(-Infinity, 6)).toBe(0);
    expect(studentLowerTail(Infinity, 6)).toBe(1);
    expect(() => studentQuantile(0.5, 0)).toThrow();
  });

  it('uses predictive rather than mean-only uncertainty and a count-noise floor', () => {
    const counts = Array(8).fill(20) as number[];
    const fit = fitCountTrend(counts)!;
    const forecast = forecastCounts(counts, ALPHA / (2 * MAX_DAYS))!;
    expect(fit.leverage).toBeCloseTo(0.6071428571, 8);
    expect(forecast.scale ** 2).toBeCloseTo((1 / 21) * (1 + fit.leverage), 12);
    expect(forecast.degreesOfFreedom).toBe(6);
    expect(forecastLowerTail(19, forecast)).toBeGreaterThan(forecast.alpha);
    expect(forecastLowerTail(0, forecast)).toBeLessThan(forecast.alpha);
  });

  it('does not treat an average from zero-heavy history as a known rate', () => {
    const varied = forecastCounts([4, 8, 0, 32, 4, 8, 0, 32], ALPHA / (2 * MAX_DAYS))!;
    expect(varied.historicalMean).toBe(11);
    expect(varied.lower).toBe(0);
    expect(forecastLowerTail(3, varied)).toBeGreaterThan(varied.alpha);
  });

  it('widens for pooled unexplained variation instead of treating a quiet weekday sample as certainty', () => {
    const plain = forecastCounts(Array(8).fill(30) as number[], 0.001)!;
    const pooled = forecastCounts(Array(8).fill(30) as number[], 0.001, 1)!;
    expect(pooled.scale).toBeGreaterThan(plain.scale);
    expect(pooled.lower).toBeLessThan(plain.lower);
  });

  it('uses prior trend rather than a flat average for growing and declining activity', () => {
    const growth = forecastCounts(Array.from({ length: 8 }, (_, i) => Math.round(100 * Math.exp(-0.1 * (i + 1)))), 0.001)!;
    const decline = forecastCounts(Array.from({ length: 8 }, (_, i) => Math.round(20 * Math.exp(0.1 * (i + 1)))), 0.001)!;
    expect(growth.typical).toBeGreaterThan(growth.historicalMean);
    expect(decline.typical).toBeLessThan(decline.historicalMean);
  });

  it('rejects short, missing, negative, fractional and unsafe history and keeps huge-count scores bounded', () => {
    expect(forecastCounts([4, 8, 0, 32], 0.001)).toBeNull();
    for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(forecastCounts([bad, ...Array(7).fill(10)], 0.001)).toBeNull();
    expect(forecastCounts(Array(8).fill(0) as number[], 1e-30)).toBeNull();
    const large = forecastCounts(Array(8).fill(1e12) as number[], 0.001)!;
    expect(Number.isFinite(large.upper)).toBe(true);
    expect(forecastLowerTail(1e10, large)).toBeGreaterThanOrEqual(0);
    for (const lambda of [0.5, 1, 3, 10, 100]) for (let count = 0; count < lambda; count++) expect(countTailUpperBound(count, lambda) + 1e-12).toBeGreaterThanOrEqual(poissonLowerTail(count, lambda));
  });
});

describe('history-only window choice', () => {
  it('uses eight complete same-weekday periods and never reads the tested window', () => {
    const reads: number[] = [];
    const result = countWindowFrom((back) => { reads.push(back); return 50; }, MAX_DAYS, ALPHA)!;
    expect(result.days).toBe(1);
    expect(result.endOffsets).toEqual([7, 14, 21, 28, 35, 42, 49, 56]);
    expect(Math.min(...reads)).toBeGreaterThanOrEqual(result.days);
    expect(Math.max(...reads)).toBeLessThanOrEqual(countHistorySpanDays(MAX_DAYS));
  });

  it('pools sparse counts over a longer window, while zero activity has insufficient evidence', () => {
    const sparse = countWindowFrom((back) => back % 2, MAX_DAYS, ALPHA)!;
    expect(sparse.days).toBeGreaterThan(1);
    const silent = countWindowFrom(() => 0, MAX_DAYS, ALPHA)!;
    expect(silent.eligible).toBe(false);
    expect(silent.days).toBe(MAX_DAYS);
  });

  it('keeps missing days unknown and does not skip a missing required comparison', () => {
    expect(countWindowFrom((back) => back === 14 ? undefined : 20, MAX_DAYS, ALPHA)).toBeUndefined();
    expect(countWindowFrom((back) => back > 40 ? undefined : 20, MAX_DAYS, ALPHA)).toBeUndefined();
  });

  it('does not mix weekend levels into unexplained weekday variation', () => {
    const result = countWindowFrom((back) => back % 7 === 0 || back % 7 === 6 ? 1 : 100, MAX_DAYS, ALPHA)!;
    expect(result.forecast.pooledVariance).toBeCloseTo(0, 12);
  });
});


describe('recognized legacy warning handoff', () => {
  const envelope = { asset: 'example.com', generatedAt: '2026-01-01T03:00:00Z', capabilities: ['requests'],
    metrics: { requests: { last24h: 0, avg7d: 6.2, total: 10 } } };
  const warning = { severity: 'warn', kind: 'anomaly', metric: 'requests', msg: 'last24h 0 vs avg7d 6.2 (rule poisson-24h, P<=0.002)' };
  it('requires both canonical arithmetic and agreement with its owning report', () => {
    expect(isLegacyEnvelopeCountWarning(warning, envelope)).toBe(true);
    expect(isLegacyEnvelopeCountWarning({ ...warning, msg: 'last72h 0 vs 3d baseline 18.6 (rule poisson-72h, P<=1e-8)' }, envelope)).toBe(true);
    expect(isLegacyEnvelopeCountWarning({ ...warning, severity: 'error' }, envelope)).toBe(false);
    expect(isLegacyEnvelopeCountWarning(warning, { ...envelope, capabilities: [] })).toBe(false);
    expect(isLegacyEnvelopeCountWarning(warning, { ...envelope, metrics: { requests: { last24h: 4, avg7d: 6.2, total: 10 } } })).toBe(false);
    expect(isLegacyEnvelopeCountWarning({ ...warning, msg: warning.msg.replace('6.2', '99') }, envelope)).toBe(false);
  });
  it('rejects malformed, unsafe and unbounded signatures', () => {
    for (const message of ['Database unavailable', warning.msg.replace('0 vs', '1.5 vs'), warning.msg.replace('0.002', '-1'), warning.msg + 'x'.repeat(250)])
      expect(parseLegacyCountWarning(message)).toBeNull();
  });
});
