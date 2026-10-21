import { lnGamma } from './poisson.js';

/** Eight comparable periods support a weekday/trend fit; fewer stay unjudged. */
export const COUNT_HISTORY_PERIODS = 8;
export const COUNT_FORECAST_MODEL = 'weekday-log-predictive-v1' as const;

export interface CountForecast {
  model: typeof COUNT_FORECAST_MODEL;
  comparisonCounts: number[];
  historicalMean: number;
  typical: number;
  logTypical: number;
  slope: number;
  scale: number;
  degreesOfFreedom: number;
  alpha: number;
  lower: number;
  upper: number;
  pooledVariance: number;
}

/** Student-t CDF using the regularized incomplete beta continued fraction. */
export function studentLowerTail(value: number, degrees: number): number {
  if (!(degrees > 0) || !Number.isFinite(degrees) || Number.isNaN(value)) throw new RangeError('invalid Student-t inputs');
  if (value === 0) return 0.5;
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  const x = degrees / (degrees + value * value);
  const tail = 0.5 * regularizedBeta(x, degrees / 2, 0.5);
  return value < 0 ? tail : 1 - tail;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(1 - x, b, a);
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  const tiny = 1e-300;
  const nonzero = (v: number) => Math.abs(v) < tiny ? tiny : v;
  let c = 1;
  let d = 1 / nonzero(1 - (a + b) * x / (a + 1));
  let fraction = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let term = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 / nonzero(1 + term * d);
    c = nonzero(1 + term / c);
    fraction *= d * c;
    term = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 / nonzero(1 + term * d);
    c = nonzero(1 + term / c);
    const delta = d * c;
    fraction *= delta;
    if (Math.abs(delta - 1) < 3e-14) return Math.max(0, Math.min(1, front * fraction / a));
  }
  throw new RangeError('Student-t probability did not converge');
}

export function studentQuantile(probability: number, degrees: number): number {
  if (!(degrees > 0) || !Number.isFinite(degrees) || !(probability > 0 && probability < 1)) throw new RangeError('probability must be between zero and one');
  if (probability === 0.5) return 0;
  if (probability < 0.5) return -studentQuantile(1 - probability, degrees);
  let low = 0;
  let high = 1;
  while (studentLowerTail(high, degrees) < probability && high < 1e8) high *= 2;
  for (let i = 0; i < 64; i++) {
    const middle = (low + high) / 2;
    if (studentLowerTail(middle, degrees) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Counts are newest first at equally spaced, non-overlapping prior periods.
 * Zero is an observation. A missing or invalid count is never imputed. */
export function fitCountTrend(counts: readonly number[]): { location: number; slope: number; variance: number; leverage: number } | null {
  if (counts.length < COUNT_HISTORY_PERIODS || counts.some((v) => !Number.isSafeInteger(v) || v < 0)) return null;
  const n = counts.length;
  const ys = counts.map(Math.log1p);
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  const meanX = -(n + 1) / 2;
  let xx = 0;
  let xy = 0;
  for (let i = 0; i < n; i++) {
    const dx = -(i + 1) - meanX;
    xx += dx * dx;
    xy += dx * (ys[i]! - meanY);
  }
  const slope = xy / xx;
  const location = meanY - slope * meanX;
  let squaredError = 0;
  for (let i = 0; i < n; i++) squaredError += (ys[i]! - (location - slope * (i + 1))) ** 2;
  return { location, slope, variance: squaredError / (n - 2), leverage: 1 / n + meanX ** 2 / xx };
}

const criticalCache = new Map<string, number>();

const boundedCount = (logCount: number) => Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.expm1(Math.min(logCount, Math.log1p(Number.MAX_SAFE_INTEGER)))));

/** A future-observation interval, including residual variation and uncertainty
 * in the fitted trend. Pooled weekday residuals can widen, never narrow it.
 * Log-count Student-t intervals are approximate, not a distribution-free bound. */
export function forecastCounts(counts: readonly number[], alpha: number, pooledVariance = 0): CountForecast | null {
  const trend = fitCountTrend(counts);
  if (!trend || !(alpha > 0 && alpha < 0.5) || !Number.isFinite(pooledVariance) || pooledVariance < 0) return null;
  const typical = boundedCount(trend.location);
  const historicalMean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = Math.max(trend.variance, pooledVariance, 1 / (typical + 1));
  const scale = Math.sqrt(variance * (1 + trend.leverage));
  const degreesOfFreedom = counts.length - 2;
  if (1 - alpha === 1) return null;
  const cacheKey = `${alpha}:${degreesOfFreedom}`;
  let critical = criticalCache.get(cacheKey);
  if (critical === undefined) {
    critical = studentQuantile(1 - alpha, degreesOfFreedom);
    if (criticalCache.size >= 64) criticalCache.clear();
    criticalCache.set(cacheKey, critical);
  }
  const lower = Math.max(0, Math.ceil(boundedCount(trend.location - critical * scale) - 0.5));
  const upper = Math.max(lower, Math.floor(boundedCount(trend.location + critical * scale) - 0.5));
  return { model: COUNT_FORECAST_MODEL, comparisonCounts: [...counts], historicalMean, typical,
    logTypical: trend.location, slope: trend.slope, scale, degreesOfFreedom, alpha, lower, upper, pooledVariance };
}

/** Both a count-noise test and the uncertainty-aware prediction must support
 * the decline. Continuity correction keeps the transformed score conservative
 * at zero. This score is model-based, not a calibrated portfolio error rate. */
export function forecastLowerTail(observed: number, forecast: CountForecast): number {
  if (!Number.isSafeInteger(observed) || observed < 0) return 1;
  const predicted = studentLowerTail((Math.log1p(observed + 0.5) - forecast.logTypical) / forecast.scale, forecast.degreesOfFreedom);
  const countNoise = countTailUpperBound(observed, Math.min(forecast.typical, forecast.historicalMean));
  return Math.max(predicted, countNoise);
}

/** Poisson Chernoff upper bound, constant-time even for very large counters.
 * A fitted reference rate is not a known process rate; this is an additional
 * conservative noise filter, not an independently calibrated p-value. */
export function countTailUpperBound(observed: number, rate: number): number {
  if (!(rate > 0) || observed >= rate) return 1;
  if (observed <= 0) return Math.exp(-rate);
  return Math.min(1, Math.exp(observed - rate + observed * Math.log(rate / observed)));
}
