// Money's page model, read once from the ledger: the shown month as revenue −
// cost = net, its days, last month to measure it against, where its revenue
// came from, and each site ranked by what it earned with its change. A day no
// source reported is a hole, never a zero; a cost nobody wrote down is "none
// recorded", never $0.
import { moneyCurrency } from "@noticeos/contract/money";
import type { BarStripPoint } from "@/components/viz/BarStrip";
import type { PortfolioDailyRevenue } from "@shared/daily-revenue";
import type { FinancialMonth, FinancialProperty, FinancialsPayload, MoneyFigure } from "@shared/financials";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { SeriesPointOrGap } from "@shared/surface";

/** The accounting month before `period` (`YYYY-MM`), by hand: no `Date`, so no
 * viewer timezone in a label that has none. */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export interface MonthEquation {
  period: string;
  /** The month the store is standing in, still being counted. */
  open: boolean;
  /** Null when the month mixes currencies: no single total exists. */
  currency: string | null;
  revenue: number | null;
  cost: number | null;
  net: number | null;
  /** False when no cost line exists and the total is zero: costs nobody
   * recorded, not costs of zero. The net is then revenue only. */
  costRecorded: boolean;
  /** Settled money against the month's whole turnover, both as MAGNITUDES:
   * revenue and cost are each checked against a statement, and a negative
   * estimated adjustment is still money nobody has checked. */
  confirmed: number | null;
  turnover: number | null;
}

const magnitude = (figure: MoneyFigure) =>
  figure.currency === null ? null : Math.abs(figure.revenue ?? 0) + Math.abs(figure.cost ?? 0);

export function monthEquation(month: FinancialMonth, openPeriod: string, costLines: number): MonthEquation {
  const confirmed = magnitude(month.booked);
  const estimated = magnitude(month.estimated);
  return {
    period: month.period,
    open: month.period >= openPeriod,
    currency: month.total.currency,
    revenue: month.total.revenue,
    cost: month.total.cost,
    net: month.total.net,
    // An unknown cost (mixed currencies) is not "none recorded".
    costRecorded: costLines > 0 || month.total.cost !== 0,
    confirmed,
    turnover: confirmed === null || estimated === null ? null : confirmed + estimated,
  };
}

/** Last month's whole revenue from the ledger, the same basis as the shown
 * month's: null when the ledger holds no row for it or its currency differs. */
export function lastMonthRevenue(months: readonly FinancialMonth[], period: string, currency: string | null): { period: string; revenue: number | null } {
  const before = previousPeriod(period);
  const month = months.find((candidate) => candidate.period === before);
  return {
    period: before,
    revenue: month && currency !== null && month.total.currency === currency ? month.total.revenue : null,
  };
}

export interface MonthDays {
  /** Every day of the window, null where no source reported. */
  days: BarStripPoint[];
  /** Days some owed source did not report: their bars are short of the day. */
  partial: string[];
  /** The mean of the complete days, or null with fewer than three. */
  usualDay: number | null;
  /** Each source that missed days of the window, with how many it reported. */
  short: { asset: string; name: string; reported: number; owed: number }[];
}

export function monthDays(history: PortfolioDailyRevenue): MonthDays {
  const amounts = new Map(history.days.map((day) => [day.date, day.amountMinor / 100]));
  const partial = history.coverage.filter((day) => day.reported > 0 && day.missingAssets.length > 0).map((day) => day.date);
  const days = history.coverage.length > 0
    ? history.coverage.map((day) => ({ t: day.date, v: amounts.get(day.date) ?? null }))
    : history.days.map((day) => ({ t: day.date, v: day.amountMinor / 100 }));
  const complete = days.filter((day) => day.v !== null && !partial.includes(day.t)).map((day) => day.v!);
  const short = history.sources.flatMap((source) => {
    const owed = history.coverage.filter((day) => day.date >= source.since);
    const reported = owed.filter((day) => !day.missingAssets.includes(source.asset)).length;
    return owed.length > 0 && reported < owed.length
      ? [{ asset: source.asset, name: source.displayName, reported, owed: owed.length }]
      : [];
  });
  return {
    days,
    partial,
    usualDay: complete.length >= 3 ? complete.reduce((sum, value) => sum + value, 0) / complete.length : null,
    short,
  };
}

export interface SiteShare {
  id: string;
  name: string;
  amount: number;
}

/** Each site that earned in the month, largest first, in the month's currency. */
export function revenueBySite(properties: readonly FinancialProperty[], currency: string | null): SiteShare[] {
  if (currency === null) return [];
  return properties
    .flatMap((property) =>
      !property.isOs && property.revenueReported && property.figure.currency === currency && property.figure.revenue !== null && property.figure.revenue > 0
        ? [{ id: property.asset, name: property.displayName, amount: property.figure.revenue }]
        : [],
    )
    .sort((a, b) => b.amount - a.amount);
}

export interface SiteChange {
  percent: number;
  /** `month`: a closed month against the one before it, a completed
   * comparison. `heading`: an open month's projection against last month, an
   * estimate drawn in neutral ink. */
  kind: "month" | "heading";
  against: string;
}

export interface SiteMoneyRow {
  property: FinancialProperty;
  /** The site's slice of the month's revenue, 0–1, or null when there is no
   * comparable revenue to divide. */
  share: number | null;
  change: SiteChange | null;
}

/**
 * The sites ranked by what they earned this month, the ones with nothing
 * reported after them by net. A closed month's change is its revenue against
 * the month before it; an open month's is where the site is heading against
 * last month, from the same projection Home and the TV read, because a month
 * to date against a whole month is always short.
 */
export function siteMoneyRows(
  properties: readonly FinancialProperty[],
  period: string,
  open: boolean,
  monthRevenue: number | null,
  currency: string | null,
  projections: ReadonlyMap<string, RevenueProjection | undefined>,
): SiteMoneyRow[] {
  const before = previousPeriod(period);
  const earned = (property: FinancialProperty) =>
    property.revenueReported && property.figure.revenue !== null ? property.figure.revenue : null;
  const rank = (property: FinancialProperty) => earned(property) ?? Number.NEGATIVE_INFINITY;
  return properties
    .filter((property) => !property.isOs)
    .map((property): SiteMoneyRow => {
      const revenue = earned(property);
      const share = revenue !== null && revenue > 0 && currency !== null && property.figure.currency === currency && monthRevenue !== null && monthRevenue > 0
        ? revenue / monthRevenue
        : null;
      return { property, share, change: siteChange(property, revenue, before, open, projections.get(property.asset)) };
    })
    .sort((a, b) => rank(b.property) - rank(a.property) || (b.property.figure.net ?? 0) - (a.property.figure.net ?? 0));
}

function siteChange(property: FinancialProperty, revenue: number | null, before: string, open: boolean, projection: RevenueProjection | undefined): SiteChange | null {
  if (revenue === null) return null;
  if (open) {
    return projection?.status === "ready" && projection.changePercent !== null && projection.previousPeriod === before
      ? { percent: projection.changePercent, kind: "heading", against: before }
      : null;
  }
  const last = property.months.find((month) => month.period === before)?.figure;
  if (!last || last.currency !== property.figure.currency || last.revenue === null || last.revenue <= 0) return null;
  return { percent: ((revenue - last.revenue) / last.revenue) * 100, kind: "month", against: before };
}

/** A site's net month by month up to the shown month, holes kept: a month it
 * booked nothing in is null and the line breaks over it. */
export function siteNetSeries(property: FinancialProperty, period: string): { series: SeriesPointOrGap[]; currency: string | null } {
  const currency = moneyCurrency(property.months.flatMap((month) => (month.figure === null ? [] : [month.figure])));
  return {
    currency,
    series: property.months
      .filter((month) => month.period <= period)
      .map((month) => ({ t: month.period, v: currency === null || month.figure?.currency !== currency ? null : month.figure.net })),
  };
}

/** The months up to and including the shown one. */
export function monthsThrough(data: Pick<FinancialsPayload, "months" | "period">): FinancialMonth[] {
  return data.months.filter((month) => month.period <= data.period);
}
