// Each property's revenue by source and traffic by provider, day by day: what
// the MCP `list_properties` and `property_history` tools hand an agent. It
// composes the readers the Tower's own pages use — the revenue ledger
// (`./daily-revenue`), the accounting view (`noticeos.financial_ledger`) and
// the signal trends (`./signal-trends`) — and names every figure's source from
// the store's vocabulary (`noticeos_ref`), never from code.

import type { WorkspaceStore } from "@noticeos/postgres";
import { operatorRevenueClock, revenueCalendarDate, type SiteRevenueHistory } from "../shared/daily-revenue";
import { shiftRevenueDate } from "../shared/revenue-projection";
import type { SeriesPoint, SignalTrend, SignalTrendSet, TimeZoneChangePoint } from "../shared/wall";
import { emptyRevenueHistory, loadRevenueHistories } from "./daily-revenue";
import { cents } from "./ledger-history";
import { emptySignalTrendSet, loadSignalTrends } from "./signal-trends";

/** The most days one call reads: the thirteen months signal observations are
 * kept, near enough. */
export const PROPERTY_HISTORY_MAX_DAYS = 365;
/** The most accounting months one call reads. */
export const PROPERTY_HISTORY_MAX_MONTHS = 120;

/** One source's revenue for a property, per day, on the source's own clock. */
export interface RevenueSourceDays {
  source: string;
  displayName: string;
  provider: string;
  family: string;
  clock: { timeZone: string; label: string; readyAfterMinute: number };
  currency: string;
  /** Its first reported day ever; it owes no day before it. */
  since: string;
  reportedThrough: string | null;
  days: { date: string; amountMinor: number }[];
}

/** One accounting month's revenue under one source, family and booking state,
 * as the financial ledger shows it. `sourceName` is null for a source the
 * vocabulary does not name, such as an operator's own import label. */
export interface RevenueMonth {
  period: string;
  source: string | null;
  sourceName: string | null;
  family: string;
  currency: string;
  bookingState: "estimated" | "reconciled";
  amountMinor: number;
  entries: number;
}

/** One traffic series for a property: a metric one provider reports. */
export interface TrafficSeries {
  integration: string;
  /** The provider's name, from the vocabulary: "Google Analytics 4". */
  source: string;
  metric: string;
  unit: string;
  /** Whether days add up: false for people and for rates. */
  additive: boolean;
  /** When the run behind these values finished. */
  collectedAt: string | null;
  /** The first day still being filled in; its value and every later one may rise. */
  provisionalFrom: string | null;
  /** Days the provider's day boundary moved: values either side measure different days. */
  timeZoneChanges: TimeZoneChangePoint[];
  days: { date: string; value: number }[];
}

export interface PropertyHistory {
  asset: string;
  revenue: {
    /** The window the daily figures cover, ending yesterday on `clock`. */
    from: string;
    to: string;
    clock: { timeZone: string; label: string };
    /** The currency `days` is in; null when the sources report in more than one. */
    currency: string | null;
    /** Each day's figures summed across sources. A missing day is not zero. */
    days: { date: string; amountMinor: number }[];
    /** Days a source the property owes did not report: `days` holds only the others. */
    partialDates: string[];
    bySource: RevenueSourceDays[];
    /** Absent when the caller asked for no months. */
    months?: RevenueMonth[];
  };
  traffic: {
    /** The window each series is cut to, ending at its newest day. */
    days: number;
    series: TrafficSeries[];
  };
}

/** People: a person counted on two days is one person, so days never add. */
const PEOPLE = new Set(["active_users"]);

/** Every series a trend set holds, with the (integration, metric) it measures. */
function trendSeries(set: SignalTrendSet): { integration: string; metric: string; trend: SignalTrend }[] {
  return [
    { integration: "ga4", metric: "sessions", trend: set.sessions },
    { integration: "ga4", metric: "active_users", trend: set.activeUsers },
    { integration: "ga4", metric: "page_views", trend: set.pageViews },
    { integration: "ga4", metric: "event_count", trend: set.events },
    { integration: "gsc", metric: "clicks", trend: set.webSearchClicks.google },
    { integration: "gsc", metric: "impressions", trend: set.webSearchImpressions.google },
    { integration: "gsc", metric: "ctr", trend: set.searchCtr },
    { integration: "gsc", metric: "position", trend: set.searchPosition },
    { integration: "bing-webmaster", metric: "clicks", trend: set.webSearchClicks.bing },
    { integration: "bing-webmaster", metric: "impressions", trend: set.webSearchImpressions.bing },
  ];
}

/** A trend's points for the `days` ending at its newest day, windowed by date. */
function lastDays(trend: SignalTrend, days: number): SeriesPoint[] {
  const points = [...(trend.contextSeries ?? []), ...trend.series];
  const newest = points.at(-1)?.t;
  if (!newest) return [];
  const from = shiftRevenueDate(newest, -(days - 1));
  return points.filter((point) => point.t >= from);
}

export interface PropertyHistoryOptions {
  now: Date;
  /** Days of daily revenue and traffic, 1 to PROPERTY_HISTORY_MAX_DAYS. */
  days: number;
  /** Accounting months of revenue, the current one included; 0 reads none. */
  months: number;
  /** The operator's clock: a property with no revenue source dates its window on it. */
  osTimeZone: string;
  /** One property; absent reads every one. */
  asset?: string;
}

/** Each property's history, by id, for every property the store holds (or
 * the one asked for). A property with no source or no traffic has empty
 * lists, never zeros. */
export async function loadPropertyHistories(store: WorkspaceStore, options: PropertyHistoryOptions): Promise<Map<string, PropertyHistory>> {
  const { now, days, months, osTimeZone, asset } = options;
  const fallback = operatorRevenueClock(osTimeZone);
  const assets = asset === undefined ? null : [asset];
  const firstMonth = `${shiftMonth(revenueCalendarDate(now, osTimeZone).slice(0, 7), -(Math.max(months, 1) - 1))}-01`;
  const [{ sites, vocabulary, monthRows }, revenue, traffic] = await Promise.all([
    store.read(async (tx) => ({
      sites: await tx.query<{ asset: string }>(
        `SELECT asset_id AS asset FROM noticeos.assets ${assets ? "WHERE asset_id = ANY($1::text[])" : ""}
          ORDER BY list_position`, assets ? [assets] : []),
      vocabulary: await tx.query<{ integration: string; displayName: string; metric: string; unit: string }>(
        `SELECT i.integration, i.display_name AS "displayName", m.metric, m.unit
           FROM noticeos_ref.integrations i JOIN noticeos_ref.metric_kinds m USING (integration)`),
      monthRows: months === 0 ? [] : await tx.query<{
        asset: string; period: string; source: string | null; sourceName: string | null; family: string; currency: string;
        bookingState: "estimated" | "reconciled"; amountMinor: bigint; entries: number;
      }>(
        `SELECT l.asset_id AS asset, to_char(l.period_month, 'YYYY-MM') AS period, l.source, s.display_name AS "sourceName",
                l.family, l.currency, l.booking_state AS "bookingState", SUM(l.amount_minor)::bigint AS "amountMinor",
                COUNT(*)::int AS entries
           FROM noticeos.financial_ledger l
           LEFT JOIN noticeos_ref.revenue_sources s ON s.source = l.source
          WHERE l.kind = 'revenue' AND l.period_month >= $1::date ${assets ? "AND l.asset_id = ANY($2::text[])" : ""}
          GROUP BY l.asset_id, l.period_month, l.source, s.display_name, l.family, l.currency, l.booking_state
          ORDER BY l.asset_id COLLATE "C", l.period_month, l.source COLLATE "C" NULLS LAST, l.family COLLATE "C", l.booking_state`,
        assets ? [firstMonth, assets] : [firstMonth]),
    })),
    loadRevenueHistories(store, { now, days, fallback, ...(assets ? { assets } : {}) }),
    loadSignalTrends(store, days, { includeWebSearch: true, includeSecondarySeries: true, nowMs: now.getTime(), timeZone: osTimeZone, ...(asset ? { asset } : {}) }),
  ]);
  const named = new Map(vocabulary.map((row) => [`${row.integration}\u0000${row.metric}`, row]));
  const monthsOf = new Map<string, RevenueMonth[]>();
  for (const { asset: site, amountMinor, ...row } of monthRows) {
    monthsOf.set(site, [...(monthsOf.get(site) ?? []), { ...row, amountMinor: cents(amountMinor) }]);
  }
  return new Map(sites.map(({ asset: site }) => {
    const history: SiteRevenueHistory = revenue.get(site) ?? emptyRevenueHistory(now, days, fallback);
    const currencies = new Set(history.bySource.map((source) => source.currency));
    const set = traffic.get(site) ?? emptySignalTrendSet();
    const series = trendSeries(set).flatMap(({ integration, metric, trend }): TrafficSeries[] => {
      const points = lastDays(trend, days);
      const word = named.get(`${integration}\u0000${metric}`);
      if (points.length === 0 || !word) return [];
      return [{
        integration, source: word.displayName, metric, unit: word.unit,
        additive: word.unit === "count" && !PEOPLE.has(metric),
        collectedAt: trend.collectedAt, provisionalFrom: trend.provisionalFrom,
        timeZoneChanges: trend.timeZoneChanges.filter((change) => change.effectiveOn >= points[0]!.t),
        days: points.map((point) => ({ date: point.t, value: point.v })),
      }];
    });
    return [site, {
      asset: site,
      revenue: {
        from: history.from, to: history.to,
        clock: { timeZone: (history.clock ?? fallback).timeZone, label: (history.clock ?? fallback).label },
        currency: currencies.size === 1 ? [...currencies][0]! : null,
        days: history.days, partialDates: history.partialDates,
        bySource: history.bySource,
        ...(months === 0 ? {} : { months: monthsOf.get(site) ?? [] }),
      },
      traffic: { days, series },
    }];
  }));
}

/** 'YYYY-MM' shifted by whole months. */
function shiftMonth(period: string, by: number): string {
  const date = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

/** One property's history in totals, for a list: each source's revenue and
 * each traffic series over the window, with the days behind each total. A
 * total counts only settled days: a provisional traffic day and a partial
 * revenue day are left out and counted apart. People and rates have no total;
 * a daily average stands in for people. */
export function summarizePropertyHistory(history: PropertyHistory) {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const { revenue, traffic } = history;
  const settledRevenue = revenue.days.filter((day) => !revenue.partialDates.includes(day.date));
  return {
    revenue: {
      from: revenue.from, to: revenue.to, clock: revenue.clock, currency: revenue.currency,
      totalMinor: revenue.currency === null || settledRevenue.length === 0 ? null : sum(settledRevenue.map((day) => day.amountMinor)),
      daysReported: settledRevenue.length,
      partialDays: revenue.partialDates.length,
      bySource: revenue.bySource.map(({ days, ...source }) => ({
        ...source,
        totalMinor: days.length === 0 ? null : sum(days.map((day) => day.amountMinor)),
        daysReported: days.length,
      })),
    },
    traffic: traffic.series.map(({ days, timeZoneChanges, ...series }) => {
      const settled = days.filter((day) => series.provisionalFrom === null || day.date < series.provisionalFrom);
      return {
        ...series,
        from: days[0]?.date ?? null, to: days.at(-1)?.date ?? null,
        settledDays: settled.length,
        provisionalDays: days.length - settled.length,
        total: series.additive && settled.length > 0 ? sum(settled.map((day) => day.value)) : null,
        dailyAverage: series.unit === "count" && settled.length > 0 ? sum(settled.map((day) => day.value)) / settled.length : null,
        timeZoneChanged: timeZoneChanges.length > 0,
      };
    }),
  };
}
