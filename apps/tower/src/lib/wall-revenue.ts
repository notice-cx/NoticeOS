// The month's revenue as the Wall's revenue widget states it (docs/25-the-wall.md
// § Revenue, bead `ro-trai.4`).
//
// THE FIGURE IS THE LEDGER'S, THE PACE IS THE PROJECTIONS'. The large number is
// the selected ledger side's revenue when revenue rows exist. A cost-only side
// establishes no revenue amount, so another recorded revenue side or the sources'
// reported days lead instead. Missing current reports are not a reported zero. The pace is the sum of every site's `revenueProjection` that is
// `ready` for that month (`shared/revenue-projection.ts`, which owns the
// arithmetic: weekday-weighted traffic times the median earning rate, one
// settling GA4 day accepted since `ro-eqda`), plus whatever revenue no
// projection covers — a source with no daily report still earned its money.
//
// THE SHAPE AND THE COMPARISON ARE LIKE FOR LIKE. Revenue no projection covers
// has no days, so it cannot be drawn by day, and it has no last-month total to
// be compared with. The month chart and the "vs last month" change are
// therefore over the covered sites only: the same sites, both months. In the
// ordinary case every revenue source has a projection and the two agree.
//
// Nothing here re-derives a projection; it only adds up the ones the Worker
// built, day by day.
//
// YESTERDAY IS THE PROVIDERS' OWN ESTIMATE, SUMMED (bead `ro-trai.32`). Each
// site's `dailyRevenue` is yesterday's saved report on the provider's clock;
// `yesterdayTotal` adds up the ones that are in, over the sites that have a
// revenue source at all, and counts the ones that are not. Missing is never
// zero: a site whose report has not arrived is left out of the sum and counted
// as not reported, while a recorded $0 is a report like any other.

import type { AssetCard, PortfolioBand } from "@shared/wall";
import type { RevenueProjection } from "@shared/revenue-projection";
import { yesterdayRevenue } from "@shared/daily-revenue";
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
  /** The covered sites' whole previous month, in dollars; null when any of
   * them has no complete previous month to add. */
  previousTotal: number | null;
  /** The covered sites' projection against their own previous month. A
   * projection is not a completed comparison, so it is drawn in neutral ink. */
  changePercent: number | null;
  points: MonthRevenuePoint[];
  crossing: MonthCrossing | null;
  /** How many site projections the pace adds up. */
  sites: number;
}

export interface MonthRevenue {
  /** 'YYYY-MM' the figure is about. */
  period: string;
  /** False when the ledger's latest month is not the current one (`ro-bdkp`). */
  periodIsCurrent: boolean;
  /** The month's revenue so far, in dollars; null while no revenue source has
   * reported a complete day this month and the ledger has no revenue row for it. */
  revenue: number | null;
  state: "booked" | "forecast";
  /** Complete previous-month provider estimates, with explicit source coverage;
   * dated context only, never the whole portfolio or a comparison basis. */
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
 * ledger row this month and no site with a revenue source (`hasRevenueSource`)
 * — the widget then says "No revenue source" in one line. A site whose source
 * reports but has no pace yet (a new installation's first three weeks, bead
 * `ro-trai.33`) is something to state: the month so far from its reported
 * days, and why there is no pace.
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
  const sources = assets
    .filter(hasRevenueSource)
    .map((asset) => asset.revenueProjection)
    .filter((projection): projection is RevenueProjection => projection !== undefined);
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
  const previousReports = current.filter(projection => projection.previousMonthMinor !== null);
  const previousMonth = previousReports.length > 0 && current.every(projection =>
    projection.previousPeriod === current[0]!.previousPeriod)
    ? { period: current[0]!.previousPeriod, revenue: sum(previousReports.map(projection => projection.previousMonthMinor!)) / 100,
        reported: previousReports.length, sites: current.length }
    : null;
  const waiting = revenue === null && ready.length > 0 ? "Waiting for revenue reports." :
    ready.length === 0
      ? (current.find((projection) => projection.status !== "ready" && projection.reason !== null)?.reason ?? (revenue === null ? "Waiting for revenue reports." : null))
      : null;
  const readyEarnedMinor = sum(ready.map((projection) => projection.earnedMinor ?? 0));

  return {
    period,
    periodIsCurrent: lead || ledgerState !== null ? portfolio.periodIsCurrent : true,
    revenue,
    state: ledgerState ?? "forecast",
    previousMonth,
    // What no ready projection covers — another source's booked money, or a
    // learning site's reported days — joins the pace whole.
    pace: ready.length > 0 ? monthPace(ready, Math.round((revenue ?? 0) * 100) - readyEarnedMinor) : null,
    waiting,
  };
}

function monthPace(ready: readonly ReadyProjection[], uncoveredMinor: number): MonthPace {
  const coveredMinor = sum(ready.map((projection) => projection.projectedMinor));
  const previous = ready.map((projection) => projection.previousMonthMinor);
  const previousMinor = previous.every((value): value is number => value !== null)
    ? sum(previous)
    : null;

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

  const previousTotal = previousMinor === null ? null : previousMinor / 100;
  const reached =
    previousTotal !== null && previousTotal > 0
      ? points.find((point) => point.cumulative >= previousTotal)
      : undefined;

  return {
    projected: (coveredMinor + Math.max(0, uncoveredMinor)) / 100,
    daysLeft: points.filter((point) => point.projected).length,
    previousPeriod: ready[0]!.previousPeriod,
    previousTotal,
    changePercent:
      previousMinor !== null && previousMinor > 0 ? (coveredMinor / previousMinor - 1) * 100 : null,
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
  /** One common provider day/clock, never an assumed operator or Pacific day. */
  basis: { date: string; timeZone: string } | null;
  /** Received reports use incompatible dates/clocks, so no total is valid. */
  mixedBasis?: true;
}

/**
 * Yesterday's revenue across the sites, or `null` when no site has a revenue
 * source (the Wall then says nothing about yesterday).
 *
 * A summary counts only while it still describes yesterday. The Worker dates it
 * on its provider's reporting clock (`DailyRevenueSummary.timeZone`, D42),
 * and a last-good payload the Wall is still holding can cross
 * midnight, so "yesterday" is asked again at `nowMs` on that same clock: the day
 * before yesterday's figure is never shown as yesterday's.
 */
export function yesterdayTotal(
  assets: readonly Pick<AssetCard, "revenueProjection" | "dailyRevenue">[],
  nowMs: number,
): YesterdayTotal | null {
  const sources = assets.filter(hasRevenueSource);
  if (sources.length === 0) return null;
  let amountMinor = 0;
  let reported = 0;
  const bases = sources.flatMap(({ dailyRevenue: summary }) => {
    if (!summary) return [];
    const date = yesterdayOn(summary.timeZone, nowMs);
    return date ? [{ date, timeZone: summary.timeZone }] : [];
  });
  const basis = bases[0] && bases.every(value => value.date === bases[0]!.date && value.timeZone === bases[0]!.timeZone) ? bases[0] : null;
  let reportedBasis: { date: string; timeZone: string } | null = null;
  let mixedBasis = false;
  for (const { dailyRevenue: summary } of sources) {
    if (!summary || summary.amountMinor === null || summary.date !== yesterdayOn(summary.timeZone, nowMs)) continue;
    if (reportedBasis && (reportedBasis.date !== summary.date || reportedBasis.timeZone !== summary.timeZone)) {
      mixedBasis = true;
    }
    reportedBasis = { date: summary.date, timeZone: summary.timeZone };
    amountMinor += summary.amountMinor;
    reported += 1;
  }
  if (mixedBasis) return { amount: null, reported, sites: sources.length, basis: null, mixedBasis: true };
  return { amount: reported > 0 ? amountMinor / 100 : null, reported, sites: sources.length, basis: reported > 0 ? reportedBasis : basis };
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
