import { chartSources, revenueChartSource, type MoneyChartSource } from "@/lib/money-chart";
// The month's revenue as the Wall's revenue widget states it.
//
// The figure is the ledger's, the pace is the projections'. The large number
// is the selected ledger side's revenue when revenue rows exist; a cost-only
// side establishes no revenue amount, and missing current reports are not a
// reported zero. The pace is the sum of every site's `revenueProjection` that
// is `ready` for that month (`shared/revenue-projection.ts` owns the
// arithmetic), plus whatever revenue no projection covers.
//
// The chart combines daily receipts with forecasts where the data supports them.
// The percentage compares the projection against the previous month's recorded revenue.
//
// Yesterday adds the reports that arrived. The site check requires all of its reports.

import type { AssetCard, PortfolioBand } from "@shared/wall";
import type { RevenueProjection } from "@shared/revenue-projection";
import { yesterdayRevenue } from "@shared/daily-revenue";
import { reportingCalendarTrend } from '@shared/reporting-calendar';
import { portfolioHeadline } from "@/lib/portfolio-headline";

/** One calendar day of the covered sites' month, cumulative. */
export interface MonthRevenuePoint {
  /** Day of the month, 1-based. */
  day: number;
  date: string;
  /** Dollars earned (or projected) from the 1st through this day. */
  cumulative: number;
  /** Observations used by the projections, without their estimates. */
  observed: number;
  /** Any covered site's value for this day is a projection, not a report. */
  projected: boolean;
}

/** The day the month's running total reached last month's whole total. */
export interface MonthCrossing {
  day: number;
  date: string;
  /** Reached on the projection, not yet on reported days. */
  projected: boolean;
}

export interface MonthPace {
  /** Dollars the month lands on: the ready projections plus uncovered revenue. */
  projected: number;
  /** Days the projection still has to cover. */
  daysLeft: number;
  previousPeriod: string;
  /** Available previous-month total in dollars. */
  previousTotal: number | null;
  changePercent: number | null;
  points: MonthRevenuePoint[];
  crossing: MonthCrossing | null;
  /** How many site projections the pace adds up. */
  sites: number;
}

export interface MonthRevenue {
  /** 'YYYY-MM' the figure is about. */
  period: string;
  /** False when the ledger's latest month is not the current one. */
  periodIsCurrent: boolean;
  /** The month's revenue so far, in dollars; null while no revenue source has
   * reported a complete day this month and the ledger has no revenue row for it. */
  revenue: number | null;
  state: "booked" | "forecast";
  /** Recorded previous-month revenue and source coverage. */
  previousMonth: { period: string; revenue: number; reported: number; sites: number } | null;
  pace: MonthPace | null;
  /** Recorded daily revenue to chart when a forecast cannot yet be made. */
  recorded: MonthRevenuePoint[];
  /** Why there is no pace yet, in the projection's own words, or null. */
  waiting: string | null;
}

type ReadyProjection = RevenueProjection & {
  status: "ready";
  earnedMinor: number | null;
  projectedMinor: number;
  dailyPaceMinor: number;
};

function isReady(projection: RevenueProjection | undefined): projection is ReadyProjection {
  return (
    projection?.status === "ready" &&
    projection.projectedMinor !== null &&
    projection.dailyPaceMinor !== null
  );
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * The widget's whole read model. `null` means there is nothing to state: no
 * ledger row this month and no site with a revenue source
 * (`hasRevenueSource`). A site whose source reports but has no pace yet is
 * something to state: the month so far from its reported days, and why there
 * is no pace.
 */
export function monthRevenue(
  portfolio: PortfolioBand,
  assets: readonly Pick<AssetCard, "revenueProjection" | "revenueProjectionSources" | "wallDailyRevenue">[],
): MonthRevenue | null {
  const lead = portfolioHeadline(portfolio);
  const ledgerRevenue = (state: "booked" | "forecast") => portfolio.wallRevenueUsd
    ? portfolio.wallRevenueUsd[state]
    : (portfolio.revenueRecorded?.[state] ?? portfolio[state].revenue !== 0) ? portfolio[state].revenue : null;
  const hasRecordedRevenue = (state: "booked" | "forecast") => ledgerRevenue(state) !== null;
  // The net headline can be cost-led. Revenue needs its own recorded side,
  // without combining estimates and reconciled money or inventing a zero.
  const ledgerState = lead && hasRecordedRevenue(lead.state) ? lead.state
    : hasRecordedRevenue("forecast") ? "forecast"
      : hasRecordedRevenue("booked") ? "booked" : null;
  const sources = assets.flatMap(({ wallDailyRevenue, revenueProjection }) =>
    wallDailyRevenue !== null && revenueProjection && revenueProjection.status !== "no-revenue" ? [revenueProjection] : []);
  if (ledgerState === null && sources.length === 0) return null;
  // The month the figure is about. A projection is always about the month the
  // operator is standing in; the ledger's period can be an older one.
  const period = lead || ledgerState !== null ? portfolio.wallRevenueUsd?.period ?? portfolio.period : (sources.find(isReady) ?? sources[0]!).period;
  const current = sources.filter((projection) => projection.period === period);
  const ready = current.filter(isReady);

  // Without a revenue ledger row the reported days ARE the month's revenue so far:
  // every revenue source's, paced or still learning. A source whose month is
  // not complete yet (`earnedMinor` null) adds nothing, and with none complete
  // there is no figure — never a $0 nobody reported.
  const reported = current.filter((projection) => projection.earnedMinor !== null);
  const revenue = ledgerState !== null
    ? ledgerRevenue(ledgerState)
    : reported.length > 0
      ? sum(reported.map((projection) => projection.earnedMinor!)) / 100
      : null;
  const previousPeriod = ready[0]?.previousPeriod ?? current[0]?.previousPeriod;
  const previousReports = current.flatMap(projection => {
    const amount = projection.previousMonthRecordedMinor ?? projection.previousMonthMinor;
    return projection.previousPeriod === previousPeriod && amount !== null ? [amount] : [];
  });
  const previousMonth = previousPeriod && previousReports.length
    ? { period: previousPeriod, revenue: sum(previousReports) / 100,
        reported: previousReports.length, sites: current.length }
    : null;
  const waiting = revenue === null && ready.length > 0 ? "Waiting for revenue reports." :
    ready.length === 0
      ? (current.find((projection) => projection.status !== "ready" && projection.reason !== null)?.reason ?? (revenue === null ? "Waiting for revenue reports." : null))
      : null;
  const readyEarnedMinor = sum(ready.map((projection) => projection.earnedMinor ?? 0));
  const uncoveredMinor = revenue === null ? 0 : Math.round(revenue * 100) - readyEarnedMinor;
  const reportedDays = new Map<string, number>();
  if (ledgerState !== "booked") {
    for (const asset of assets) {
      const paced = isReady(asset.revenueProjection) && asset.revenueProjection.period === period;
      for (const source of asset.revenueProjectionSources ?? []) {
        if (paced && source.includedInProjection !== false) continue;
        for (const day of source.days) {
          if (day.date.startsWith(period)) reportedDays.set(day.date, (reportedDays.get(day.date) ?? 0) + day.amountMinor);
        }
      }
    }
  }
  let recordedMinor = 0;
  const recorded = [...reportedDays].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => {
    recordedMinor += amount;
    return { day: Number(date.slice(8, 10)), date, cumulative: recordedMinor / 100, observed: recordedMinor / 100, projected: false };
  });
  const previousRevenue = portfolio.previousRevenue;
  const previousTotal = previousRevenue?.period === previousPeriod && previousRevenue?.currency === 'USD'
    ? previousRevenue.amount : previousMonth?.revenue ?? null;

  return {
    period,
    periodIsCurrent: lead || ledgerState !== null ? portfolio.wallRevenueUsd?.periodIsCurrent ?? portfolio.periodIsCurrent : true,
    revenue,
    state: ledgerState ?? "forecast",
    previousMonth,
    recorded,
    pace: ready.length > 0 ? monthPace(ready, reportedDays, uncoveredMinor, previousTotal) : null,
    waiting,
  };
}

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

function monthPace(ready: readonly ReadyProjection[], recorded: ReadonlyMap<string, number>, uncoveredMinor: number, previousTotal: number | null): MonthPace {
  const coveredMinor = sum(ready.map((projection) => projection.projectedMinor));
  const datedMinor = sum([...recorded.values()]);
  // Preserve a ledger-only refund. An accounting subtotal below known daily
  // receipts cannot establish a refund against those receipts.
  const undatedMinor = datedMinor === 0 ? uncoveredMinor : Math.max(0, uncoveredMinor - datedMinor);
  const projected = (coveredMinor + datedMinor + undatedMinor) / 100;

  // Day by day across the covered sites. Every ready projection carries every
  // day of its month, so the dates line up; a date one site lacks is left to
  // the others rather than guessed.
  const byDate = new Map<string, { cumulativeMinor: number; observedMinor: number; projected: boolean }>();
  for (const projection of ready) {
    let previous = 0;
    for (const point of projection.points) {
      const day = byDate.get(point.date) ?? { cumulativeMinor: 0, observedMinor: 0, projected: false };
      day.cumulativeMinor += point.cumulativeMinor;
      if (!point.projected) day.observedMinor += point.cumulativeMinor - previous;
      previous = point.cumulativeMinor;
      day.projected ||= point.projected;
      byDate.set(point.date, day);
    }
  }
  let observedMinor = 0;
  let extraMinor = 0;
  const points = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => {
      extraMinor += recorded.get(date) ?? 0;
      observedMinor += day.observedMinor;
      return {
        day: Number(date.slice(8, 10)), date,
        cumulative: (day.cumulativeMinor + extraMinor) / 100, observed: (observedMinor + extraMinor) / 100, projected: day.projected,
      };
    });
  const last = points.at(-1);
  if (last && undatedMinor !== 0) {
    // Recorded money with no daily series contributes at the endpoint only.
    last.observed += undatedMinor / 100;
    last.cumulative = projected;
    last.projected = true;
  }

  const reached =
    previousTotal !== null && previousTotal > 0
      ? points.find((point) => point.cumulative >= previousTotal)
      : undefined;

  return {
    projected,
    daysLeft: points.filter((point) => point.projected).length,
    previousPeriod: ready[0]!.previousPeriod,
    previousTotal,
    changePercent: previousTotal !== null && previousTotal > 0 ? (projected / previousTotal - 1) * 100 : null,
    points,
    crossing: reached ? { day: reached.day, date: reached.date, projected: reached.projected } : null,
    sites: ready.length,
  };
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
