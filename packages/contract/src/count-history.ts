import { COUNT_HISTORY_PERIODS, fitCountTrend, forecastCounts, forecastLowerTail, type CountForecast } from './count-forecast.js';

export interface CountWindow {
  days: number;
  endOffsets: number[];
  forecast: CountForecast;
  pooledGroups: number;
  eligible: boolean;
}

/** The maximum prior-day offset needed, including other weekdays' residuals. */
export function countHistorySpanDays(maxWindowDays: number): number {
  return COUNT_HISTORY_PERIODS * 7 * Math.ceil(maxWindowDays / 7) + maxWindowDays - 1 + 6;
}

/** Training only: back=1 is yesterday; the function never requests back=0 or
 * any day within the window being tested. Missing counts are never zeroed. */
export function countWindowsFrom(
  pastCount: (back: number) => number | undefined,
  maxWindowDays: number,
  alpha: number,
): CountWindow[] {
  const windows: CountWindow[] = [];
  const decisionAlpha = Math.min(0.499999, alpha / (2 * maxWindowDays));
  const total = (end: number, days: number): number | undefined => {
    let sum = 0;
    for (let j = 0; j < days; j++) {
      const value = pastCount(end + j);
      if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
      sum += value;
    }
    return Number.isSafeInteger(sum) ? sum : undefined;
  };
  for (let days = 1; days <= maxWindowDays; days++) {
    const spacing = Math.ceil(days / 7) * 7;
    const endOffsets = Array.from({ length: COUNT_HISTORY_PERIODS }, (_, i) => (i + 1) * spacing);
    const comparisons = endOffsets.map((end) => total(end, days));
    if (comparisons.some((value) => value === undefined)) return windows;
    // Removing each weekday's own level and trend prevents predictable
    // weekend zeros from being treated as unexplained weekday variation.
    const variances: number[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const counts = endOffsets.map((end) => total(end + weekday, days));
      if (counts.some((value) => value === undefined)) continue;
      const fit = fitCountTrend(counts as number[]);
      if (fit) variances.push(fit.variance);
    }
    if (variances.length < 4) return windows;
    const pooledVariance = Math.max(...variances);
    const forecast = forecastCounts(comparisons as number[], decisionAlpha, pooledVariance);
    if (!forecast) return windows;
    const eligible = forecast.lower > 0 && forecastLowerTail(0, forecast) < decisionAlpha;
    windows.push({ days, endOffsets, forecast, pooledGroups: variances.length, eligible });
  }
  return windows;
}

/** Training-only preferred window, useful when showing the available evidence
 * before the current observation is scored. Evaluation tests every candidate. */
export function countWindowFrom(pastCount: (back: number) => number | undefined, maxWindowDays: number, alpha: number): CountWindow | undefined {
  const windows = countWindowsFrom(pastCount, maxWindowDays, alpha);
  return windows.find((window) => window.eligible) ?? windows.at(-1);
}
