import { chartSources, revenueChartSource, type MoneyChartSource } from "@/lib/money-chart";
import type { AssetCard } from "@shared/wall";
import { yesterdayRevenue } from "@shared/daily-revenue";
import { reportingCalendarTrend } from '@shared/reporting-calendar';
import { isReady, type MonthRevenuePoint } from "@shared/month-revenue";

export { monthRevenue, type MonthPace } from "@shared/month-revenue";

/** Split observed revenue by source on the dates shown by the chart. */
export function cumulativeRevenueSources(
  assets: readonly Pick<AssetCard, "revenueProjection" | "revenueProjectionSources">[],
  period: string,
  points: readonly MonthRevenuePoint[],
  includeUnpaced: boolean,
): { sources: MoneyChartSource[]; contributions: ReadonlyMap<string, ReadonlyMap<string, number>> } {
  const byDay = new Map<string, Map<string, number>>();
  const labels: MoneyChartSource[] = [];
  for (const asset of assets) {
    const paced = asset.revenueProjection?.period === period && isReady(asset.revenueProjection);
    for (const source of asset.revenueProjectionSources ?? []) {
      if (!includeUnpaced && (!paced || source.includedInProjection === false)) continue;
      const days = source.days.filter(day => day.date.startsWith(period));
      if (days.length === 0) continue;
      labels.push(revenueChartSource(source.source, source.displayName));
      for (const day of days) {
        const values = byDay.get(day.date) ?? new Map<string, number>();
        values.set(source.source, (values.get(source.source) ?? 0) + day.amountMinor);
        byDay.set(day.date, values);
      }
    }
  }
  const contributions = new Map<string, ReadonlyMap<string, number>>();
  const running = new Map<string, number>();
  for (const point of points) {
    for (const [id, amount] of byDay.get(point.date) ?? []) running.set(id, (running.get(id) ?? 0) + amount);
    if (running.size) contributions.set(point.date, new Map([...running].map(([id, amount]) => [id, amount / 100])));
  }
  return { sources: chartSources(labels), contributions };
}

/**
 * A site with a daily revenue source: the Worker built its month from saved
 * reports, whatever state that projection is in. This is the site rows' own
 * test — a site this says `false` for is the row that reads "no revenue
 * source" — so the Wall never counts a site in one place that it calls
 * sourceless in another.
 */
export function hasRevenueSource(asset: Pick<AssetCard, "revenueProjection">): boolean {
  return asset.revenueProjection !== undefined && asset.revenueProjection.status !== "no-revenue";
}

/** Yesterday's provider estimates, summed over the sites with a revenue source. */
export interface YesterdayTotal {
  /** Dollars across the sites whose report for yesterday is in; `null` when
   * none is — never a $0 nobody reported. A recorded $0 is a real 0. */
  amount: number | null;
  /** Sites whose report for yesterday is in. */
  reported: number;
  /** Sites with a revenue source: the ones that owe yesterday a report. */
  sites: number;
  /** One common provider day/clock, never an assumed operator or provider day. */
  basis: { date: string; timeZone: string; label?: string } | null;
  /** At least one reporting boundary was estimated on the selected calendar. */
  estimated?: true;
}

/** Yesterday on the selected display calendar. Fresh provider reports and
 * their stored history supply estimates for shifted daily boundaries. */
export function yesterdayTotal<T extends Pick<AssetCard, "revenueProjection" | "dailyRevenue" | "wallDailyRevenue">>(
  assets: readonly T[],
  nowMs: number,
  timeZone?: string,
): (YesterdayTotal & { coverage: { asset: T; reported: boolean }[] }) | null {
  const sources = assets.filter(asset => asset.wallDailyRevenue === undefined ? hasRevenueSource(asset) : asset.wallDailyRevenue !== null);
  if (sources.length === 0) return null;
  const coverage = sources.map(asset => ({ asset, reported: false }));
  const displayZone = timeZone ?? sources.find(source => source.wallDailyRevenue)?.wallDailyRevenue?.timeZone
    ?? sources.find(source => source.dailyRevenue)?.dailyRevenue?.timeZone;
  const date = displayZone && yesterdayOn(displayZone, nowMs);
  if (!date || !displayZone) return { amount: null, reported: 0, sites: sources.length, basis: null, coverage };
  let amountMinor = 0;
  let observed = false;
  let reported = 0;
  let estimated = false;
  const label = sources.find(source => source.dailyRevenue?.timeZone === displayZone)?.dailyRevenue?.timeZoneLabel;
  const basis = { date, timeZone: displayZone, ...(label ? { label } : {}) };
  for (const entry of coverage) {
    const { dailyRevenue: summary, revenueProjection, wallDailyRevenue: reading } = entry.asset;
    if (reading) {
      if (reading.date === date && reading.timeZone === displayZone && reading.amountMinor !== null) {
        amountMinor += reading.amountMinor;
        observed = true;
        estimated ||= reading.estimated;
        entry.reported = reading.complete;
        reported += Number(reading.complete);
      }
      continue;
    }
    if (!summary || summary.amountMinor === null || summary.date !== yesterdayOn(summary.timeZone, nowMs)) continue;
    if (summary.timeZone === displayZone) {
      amountMinor += summary.amountMinor;
    } else {
      let previous = 0;
      const series = (revenueProjection?.points ?? []).filter(point => !point.projected).map(point => {
        const value = point.cumulativeMinor - previous;
        previous = point.cumulativeMinor;
        return { t: point.date, v: value };
      }).filter(point => point.t !== summary.date);
      series.push({ t: summary.date, v: summary.amountMinor });
      series.sort((a, b) => a.t.localeCompare(b.t));
      const adjusted = reportingCalendarTrend({ series, timeZone: summary.timeZone, timeZoneChanges: [], provisionalFrom: null, collectedAt: null }, displayZone);
      const value = [...(adjusted.contextSeries ?? []), ...adjusted.series].find(point => point.t === date)?.v;
      if (value === undefined) continue;
      amountMinor += value;
      estimated = true;
    }
    entry.reported = true;
    observed = true;
    reported += 1;
  }
  return { amount: observed ? amountMinor / 100 : null, reported, sites: sources.length, basis, coverage, ...(estimated ? { estimated: true as const } : {}) };
}

/** Yesterday's date at `nowMs` on the clock a summary was dated on; `null` for
 * a zone this browser cannot read, which then trusts nothing. */
function yesterdayOn(timeZone: string, nowMs: number): string | null {
  try {
    return yesterdayRevenue(new Date(nowMs), timeZone, []).date;
  } catch {
    return null;
  }
}
