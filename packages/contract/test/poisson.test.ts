import { describe, expect, it } from 'vitest';
import {
  lnFactorial,
  lnGamma,
  lnPoissonPmf,
  poissonLowerTail,
  poissonPmf,
} from '../src/poisson.js';

describe('lnGamma / lnFactorial', () => {
  it('matches known Gamma values', () => {
    expect(lnGamma(1)).toBeCloseTo(0, 10); // Gamma(1) = 1
    expect(lnGamma(2)).toBeCloseTo(0, 10); // Gamma(2) = 1
    expect(lnGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 10); // ln(sqrt(pi))
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 10); // Gamma(5) = 4! = 24
  });

  it('lnFactorial(n) = ln(n!)', () => {
    expect(lnFactorial(0)).toBeCloseTo(0, 10);
    expect(lnFactorial(1)).toBeCloseTo(0, 10);
    expect(lnFactorial(5)).toBeCloseTo(Math.log(120), 10);
    expect(lnFactorial(10)).toBeCloseTo(Math.log(3628800), 8);
  });
});

describe('poissonPmf', () => {
  it('reproduces the docs/02 worked example P(X=0 | lambda=6.2) ~= 0.002', () => {
    // docs/02: "0 in last24h (avg7d 6.2, P(0)<0.002)". e^-6.2 = 0.00202943.
    expect(poissonPmf(0, 6.2)).toBeCloseTo(0.0020294, 7);
    expect(poissonPmf(0, 6.2)).toBeCloseTo(Math.exp(-6.2), 12);
  });

  it('handles the lambda = 0 degenerate case (all mass at 0)', () => {
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(3, 0)).toBe(0);
  });

  it('lnPoissonPmf returns -Infinity for impossible counts', () => {
    expect(lnPoissonPmf(-1, 5)).toBe(Number.NEGATIVE_INFINITY);
    expect(lnPoissonPmf(2.5, 5)).toBe(Number.NEGATIVE_INFINITY); // non-integer
    expect(lnPoissonPmf(3, 0)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('poissonLowerTail P(X <= k | lambda)', () => {
  it('matches hand-computed CDF values', () => {
    expect(poissonLowerTail(0, 6.2)).toBeCloseTo(Math.exp(-6.2), 12);
    expect(poissonLowerTail(2, 1)).toBeCloseTo(0.9196986, 6);
    expect(poissonLowerTail(2, 10)).toBeCloseTo(0.0027693957, 9);
    expect(poissonLowerTail(3, 10)).toBeCloseTo(0.0103360, 6); // just above alpha=0.01
  });

  it('is monotonic non-decreasing in k and bounded in [0,1]', () => {
    let prev = 0;
    for (let k = 0; k <= 20; k++) {
      const p = poissonLowerTail(k, 5);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    expect(poissonLowerTail(200, 5)).toBeCloseTo(1, 10); // whole mass captured
  });

  it('edge cases: negative k, lambda = 0, floored k', () => {
    expect(poissonLowerTail(-1, 5)).toBe(0);
    expect(poissonLowerTail(0, 0)).toBe(1);
    expect(poissonLowerTail(5, 0)).toBe(1);
    expect(poissonLowerTail(2.9, 10)).toBe(poissonLowerTail(2, 10)); // k floored
  });

  it('stays finite and non-negative for large lambda (log-space stability)', () => {
    const deepTail = poissonLowerTail(0, 745);
    expect(Number.isNaN(deepTail)).toBe(false);
    expect(deepTail).toBeGreaterThanOrEqual(0);
    const p = poissonLowerTail(50, 100);
    expect(Number.isFinite(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it('throws on negative lambda', () => {
    expect(() => poissonLowerTail(1, -1)).toThrow(RangeError);
  });
});
