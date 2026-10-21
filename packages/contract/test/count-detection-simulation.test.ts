import { describe, expect, it } from 'vitest';
import { countHistorySpanDays, countWindowsFrom } from '../src/count-history.js';
import { evaluatePulse, type MetricBaseline } from '../src/rules.js';
import { poissonLowerTail } from '../src/poisson.js';

const CONFIG = { alpha: 0.01, maxWindowDays: 14 };
const WARMUP = countHistorySpanDays(CONFIG.maxWindowDays);
const HELD_OUT_SEEDS = [20261121, 20261122, 20261123];

type Draw = (mean: number) => number;
type Scenario = { name: string; busy?: boolean; value: (day: number, poisson: Draw, random: () => number) => number | undefined };

function randomFrom(seed: number) {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state + 0.5) / 4294967296; };
}

function poissonFrom(random: () => number): Draw {
  return (mean) => {
    // Add independent Poisson chunks instead of underflowing at a large mean.
    if (mean > 30) {
      const parts = Math.ceil(mean / 30);
      let total = 0;
      for (let part = 0; part < parts; part++) total += poissonFrom(random)(mean / parts);
      return total;
    }
    let product = 1;
    let count = 0;
    do { count++; product *= random(); } while (product > Math.exp(-mean));
    return count - 1;
  };
}

function candidate(series: readonly (number | undefined)[], day: number): { judged: boolean; fired: boolean; covered?: boolean } {
  const windows = countWindowsFrom((back) => series[day - back], CONFIG.maxWindowDays, CONFIG.alpha);
  const candidates: MetricBaseline[] = [];
  for (const window of windows) {
    let observed = 0;
    let complete = true;
    for (let back = 0; back < window.days; back++) {
      const value = series[day - back];
      if (value === undefined) { complete = false; break; }
      observed += value;
    }
    candidates.push({ source: 'same-weekday-8-periods', perDay: window.forecast.historicalMean / window.days,
      sampleSize: 8, comparisonDates: [], windowHours: window.days * 24,
      forecast: window.forecast, eligible: window.eligible, pooledGroups: window.pooledGroups,
      ...(complete ? { observed } : {}) });
  }
  const base = candidates[0];
  if (!base) return { judged: false, fired: false };
  const [verdict] = evaluatePulse({ asset: 'example.com', generatedAt: '2026-01-01T03:00:00Z',
    capabilities: ['requests'], metrics: { requests: { last24h: series[day] ?? 0, avg7d: 0, total: 0 } } }, {
    config: CONFIG, requireHistoricalBaseline: true, baselineByMetric: { requests: { ...base, candidates } },
  });
  const prediction = verdict!.inputs.prediction as { lower: number; upper: number };
  const observed = verdict!.inputs.windowObserved;
  return { judged: verdict!.outcome !== 'not-applicable', fired: verdict!.outcome === 'fired',
    ...(typeof observed === 'number' ? { covered: observed >= prediction.lower && observed <= prediction.upper } : {}) };
}

/** Frozen legacy assembly; probabilities call the existing Poisson primitive. */
function legacy(series: readonly (number | undefined)[], day: number): boolean {
  for (let days = 1; days <= CONFIG.maxWindowDays; days++) {
    const spacing = Math.ceil(days / 7) * 7;
    const totals: number[] = [];
    for (let period = 1; period <= 4; period++) {
      let total = 0;
      for (let offset = 0; offset < days; offset++) {
        const value = series[day - period * spacing - offset];
        if (value === undefined) return false;
        total += value;
      }
      totals.push(total);
    }
    const expected = totals.reduce((a, b) => a + b, 0) / totals.length;
    if (poissonLowerTail(0, expected) >= CONFIG.alpha) continue;
    let observed = 0;
    for (let offset = 0; offset < days; offset++) {
      const value = series[day - offset];
      if (value === undefined) return false;
      observed += value;
    }
    return poissonLowerTail(observed, expected) < CONFIG.alpha;
  }
  return false;
}

const scenarios: Scenario[] = [
  { name: 'stable-11', busy: true, value: (_d, poisson) => poisson(11) },
  { name: 'stable-50', busy: true, value: (_d, poisson) => poisson(50) },
  { name: 'sparse', value: (_d, poisson) => poisson(0.3) },
  { name: 'intermittent', value: (_d, poisson, random) => random() < 0.5 ? 0 : poisson(22) },
  { name: 'overdispersed', value: (_d, poisson, random) => poisson(30 * Math.exp(Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()) - 0.5)) },
  { name: 'weekday', busy: true, value: (day, poisson) => poisson(day % 7 < 5 ? 50 : 3) },
  { name: 'growth', busy: true, value: (day, poisson) => poisson(15 * Math.exp(day * 0.0015)) },
  { name: 'decline', busy: true, value: (day, poisson) => poisson(100 * Math.exp(-day * 0.0015)) },
  { name: 'annual-cycle', value: (day, poisson) => poisson(70 * (1 + 0.65 * Math.sin(day * 2 * Math.PI / 365))) },
  { name: 'correlated-bursts', value: (day, poisson) => poisson(day % 21 < 8 ? 1 : 45) },
  { name: 'missing-days', value: (_d, poisson, random) => random() < 0.03 ? undefined : poisson(20) },
];

// A binomial reference for this finite benchmark, not coverage for dependent
// rolling days, arbitrary seasonality, or multiple assets in an installation.
function wilsonUpper(successes: number, n: number): number {
  const z = 1.96;
  const p = successes / n;
  return (p + z * z / (2 * n) + z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

describe('held-out rolling count detection', () => {
  it('measures warning burden and eligibility, including seasonal and intermittent activity', async ({ annotate }) => {
    for (const scenario of scenarios) {
      let days = 0, eligible = 0, warnings = 0, episodes = 0, legacyEpisodes = 0, legacyWarnings = 0, ranges = 0, covered = 0;
      for (const seed of HELD_OUT_SEEDS) {
        const random = randomFrom(seed);
        const poisson = poissonFrom(random);
        const series = Array.from({ length: 930 }, (_, day) => scenario.value(day, poisson, random));
        let previous = false, previousLegacy = false;
        for (let day = WARMUP; day < series.length; day++) {
          const current = candidate(series, day);
          const old = legacy(series, day);
          days++;
          if (current.judged) eligible++;
          if (current.covered !== undefined) { ranges++; if (current.covered) covered++; }
          if (current.fired) { warnings++; if (!previous) episodes++; }
          if (old) { legacyWarnings++; if (!previousLegacy) legacyEpisodes++; }
          previous = current.fired;
          previousLegacy = old;
        }
      }
      const row = { scenario: scenario.name, days, eligible, warnings, episodes, legacyWarnings, legacyEpisodes,
        ranges, covered, empiricalCoverage: ranges ? covered / ranges : null, nominalBinomialUpper: wilsonUpper(warnings, days) };
      await annotate(JSON.stringify(row));
      expect(warnings / days, JSON.stringify(row)).toBeLessThanOrEqual(0.01);
      expect(wilsonUpper(warnings, days), JSON.stringify(row)).toBeLessThanOrEqual(0.02);
      if (scenario.busy) expect(eligible / days, JSON.stringify(row)).toBeGreaterThanOrEqual(0.8);
      if (['intermittent', 'overdispersed', 'correlated-bursts', 'annual-cycle'].includes(scenario.name) && legacyEpisodes >= 4) expect(episodes, JSON.stringify(row)).toBeLessThanOrEqual(legacyEpisodes * 0.25);
    }
  }, 60000);

  it('detects sustained incidents without fitting the current window or future observations', async ({ annotate }) => {
    for (const mean of [11, 50]) for (const fraction of [0, 0.5]) {
      let detected = 0;
      const delays: number[] = [];
      const trials = 60;
      for (let trial = 0; trial < trials; trial++) {
        const random = randomFrom(HELD_OUT_SEEDS[trial % 3]! + trial * 1009);
        const poisson = poissonFrom(random);
        const series: (number | undefined)[] = Array.from({ length: WARMUP + 14 }, (_, day) => poisson(day < WARMUP ? mean : mean * fraction));
        for (let delay = 0; delay < 14; delay++) if (candidate(series, WARMUP + delay).fired) { detected++; delays.push(delay + 1); break; }
      }
      const row = { mean, fraction, trials, detected, delays };
      await annotate(JSON.stringify(row));
      if (fraction === 0) { expect(detected, JSON.stringify(row)).toBeGreaterThanOrEqual(trials * 0.9); expect(delays.filter((d) => d <= 7).length, JSON.stringify(row)).toBeGreaterThanOrEqual(trials * 0.9); }
      if (mean >= 50 && fraction === 0.5) expect(detected, JSON.stringify(row)).toBeGreaterThanOrEqual(trials * 0.7);
    }
  }, 60000);
});
