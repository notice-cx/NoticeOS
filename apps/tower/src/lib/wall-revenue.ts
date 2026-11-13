// The month's revenue as the Wall's revenue widget states it.
//
// The figure is the ledger's, the pace is the projections'. The large number
// is the selected ledger side's revenue when revenue rows exist; a cost-only
// side establishes no revenue amount, and missing current reports are not a
// reported zero. The pace is the sum of every site's `revenueProjection` that
// is `ready` for that month (`shared/revenue-projection.ts` owns the
// arithmetic), plus whatever revenue no projection covers.
//
// The chart sums the ready projections day by day. The percentage compares
// the displayed projection against the available previous-month totals.
//
// Yesterday is the providers' own estimate, summed: a site whose report has
// not arrived is left out of the sum and counted as not reported, while a
// recorded $0 is a report like any other.

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
  assets: readonly Pick<AssetCard, "revenueProjection">[],
): MonthRevenue | null {
  const lead = portfolioHeadline(portfolio);
  const hasRecordedRevenue = (state: "booked" | "forecast") =>
    portfolio.revenueRecorded?.[state] ?? portfolio[state].revenue !== 0;
  // The net headline can be cost-led. Revenue needs its own recorded side,
  // without combining estimates and reconciled money or inventing a zero.
  const ledgerState = lead && hasRecordedRevenue(lead.state) ? lead.state
    : hasRecordedRevenue("forecast") ? "forecast"
      : hasRecordedRevenue("booked") ? "booked" : null;
  const sources = assets.flatMap(asset => hasRevenueSource(asset) && asset.revenueProjection ? [asset.revenueProjection] : []);
  if (ledgerState === null && sources.length === 0) return null;
  // The month the figure is about. A projection is always about the month the
  // operator is standing in; the ledger's period can be an older one.
  const period = lead || ledgerState !== null ? portfolio.period : (sources.find(isReady) ?? sources[0]!).period;
  const current = sources.filter((projection) => projection.period === period);
  const ready = current.filter(isReady);

  // Without a revenue ledger row the reported days ARE the month's revenue so far:
  // every revenue source's, paced or still learning. A source whose month is
  // not complete yet (`earnedMinor` null) adds nothing, and with none complete
  // there is no figure — never a $0 nobody reported.
  const reported = current.filter((projection) => projection.earnedMinor !== null);
  const revenue = ledgerState !== null
    ? portfolio[ledgerState].revenue
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
  const previousRevenue = portfolio.previousRevenue;
  const previousTotal = previousRevenue?.period === previousPeriod && previousRevenue?.currency === 'USD'
    ? previousRevenue.amount : previousMonth?.revenue ?? null;

  return {
    period,
    periodIsCurrent: lead || ledgerState !== null ? portfolio.periodIsCurrent : true,
    revenue,
    state: ledgerState ?? "forecast",
    previousMonth,
    // What no ready projection covers — another source's booked money, or a
    // learning site's reported days — joins the pace whole.
    pace: ready.length > 0 ? monthPace(ready, Math.round((revenue ?? 0) * 100) - readyEarnedMinor, previousTotal) : null,
    waiting,
  };
}

function monthPace(ready: readonly ReadyProjection[], uncoveredMinor: number, previousTotal: number | null): MonthPace {
  const coveredMinor = sum(ready.map((projection) => projection.projectedMinor));
  const projected = (coveredMinor + Math.max(0, uncoveredMinor)) / 100;

  // Day by day across the covered sites. Every ready projection carries every
  // day of its month, so the dates line up; a date one site lacks is left to
  // the others rather than guessed.
  const byDate = new Map<string, { cumulativeMinor: number; projected: boolean }>();
  for (const projection of ready) {
    for (const point of projection.points) {
      const day = byDate.get(point.date) ?? { cumulativeMinor: 0, projected: false };
      day.cumulativeMinor += point.cumulativeMinor;
      day.projected ||= point.projected;
      byDate.set(point.date, day);
    }
  }
  const points = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      day: Number(date.slice(8, 10)),
      date,
      cumulative: day.cumulativeMinor / 100,
      projected: day.projected,
    }));
  const last = points.at(-1);
  if (last && uncoveredMinor > 0) {
    // Money with no daily series contributes at the endpoint only.
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
export function yesterdayTotal<T extends Pick<AssetCard, "revenueProjection" | "dailyRevenue">>(
  assets: readonly T[],
  nowMs: number,
  timeZone?: string,
): (YesterdayTotal & { coverage: { asset: T; reported: boolean }[] }) | null {
  const sources = assets.filter(hasRevenueSource);
  if (sources.length === 0) return null;
  const coverage = sources.map(asset => ({ asset, reported: false }));
  const displayZone = timeZone ?? sources.find(source => source.dailyRevenue)?.dailyRevenue?.timeZone;
  const date = displayZone && yesterdayOn(displayZone, nowMs);
  if (!date || !displayZone) return { amount: null, reported: 0, sites: sources.length, basis: null, coverage };
  let amountMinor = 0;
  let reported = 0;
  let estimated = false;
  const label = sources.find(source => source.dailyRevenue?.timeZone === displayZone)?.dailyRevenue?.timeZoneLabel;
  const basis = { date, timeZone: displayZone, ...(label ? { label } : {}) };
  for (const entry of coverage) {
    const { dailyRevenue: summary, revenueProjection } = entry.asset;
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
    reported += 1;
  }
  return { amount: reported > 0 ? amountMinor / 100 : null, reported, sites: sources.length, basis, coverage, ...(estimated ? { estimated: true as const } : {}) };
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
