import type { AssetCard, PortfolioBand } from "./wall";
import type { RevenueProjection } from "./revenue-projection";
import { portfolioHeadline } from "./portfolio-headline";

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

export function isReady(projection: RevenueProjection | undefined): projection is ReadyProjection {
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
  portfolio: Pick<PortfolioBand, "period" | "periodIsCurrent" | "booked" | "forecast" | "firstRun" | "wallRevenueUsd" | "revenueRecorded" | "netTrend" | "previousRevenue">,
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
