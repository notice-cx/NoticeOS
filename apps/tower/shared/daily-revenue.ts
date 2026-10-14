import type { RevenueDay, RevenueReportingClock } from './revenue-projection';
import { revenueExpectedThrough, shiftRevenueDate } from './revenue-projection';

/** The clock a revenue source counts its days on, as the store's revenue
 * source vocabulary (`noticeos_ref.revenue_sources`) states it, with the name
 * people read for it. */
export interface RevenueClock extends RevenueReportingClock {
  readonly label: string;
}

/** A revenue source as the store's vocabulary describes it. */
export interface RevenueSource {
  source: string;
  /** The connected provider that reports it. */
  provider: string;
  /** Its revenue family: ads, affiliate, subs or licensing. */
  family: string;
  /** The name readers show, such as "Mediavine Journey ad revenue". */
  displayName: string;
  clock: RevenueClock;
}

/** One source's saved figures for one site, summed per day, in its currency. */
export interface RevenueSourceHistory extends RevenueSource {
  currency: string;
  /** Its first reported day: it owes no day before it. */
  since: string;
  days: RevenueDay[];
  reportedThrough: string | null;
}

/** The clock a site with no revenue source dates its empty window on: the
 * operator's, whose day ends at midnight. It names no source's reporting day,
 * so a history built on it carries no `clock`. */
export function operatorRevenueClock(timeZone: string): RevenueClock {
  return { timeZone, label: timeZone, readyAfterMinute: 0 };
}

/** The one clock several sources' days are read on: theirs when they share it,
 * otherwise the one whose expected report is oldest at `now`, so its
 * yesterday is a day every source has finished. Null for no source. */
export function commonRevenueClock(clocks: readonly RevenueClock[], now: Date): RevenueClock | null {
  let chosen: RevenueClock | null = null;
  for (const clock of clocks) {
    if (chosen === null || revenueExpectedThrough(now, clock) < revenueExpectedThrough(now, chosen)) chosen = clock;
  }
  return chosen;
}

/** The zone a site's revenue days are counted on: its history's clock, or
 * the operator's for a payload that states none. */
export function revenueTimeZone(history: Pick<DailyRevenueHistory, 'clock'> | undefined, operatorTimeZone: string): string {
  return history?.clock?.timeZone ?? operatorTimeZone;
}

/** What a site's revenue is called on a screen: ad revenue while every source
 * behind it is an ad source, revenue otherwise. */
export function revenueNoun(sources: readonly Pick<RevenueSource, 'family'>[] | undefined): 'Ad revenue' | 'Revenue' {
  return (sources ?? []).every(source => source.family === 'ads') ? 'Ad revenue' : 'Revenue';
}

/** Provider-reported estimates, separate from reconciled monthly accounting. */
export interface DailyRevenueSummary {
  date: string;
  amountMinor: number | null;
  reportedThrough: string | null;
  /** The source's reporting clock. A reader checking whether this still
   * describes yesterday uses the same clock, never the operator's preference. */
  timeZone: string;
  /** The name people read for that clock, such as "Pacific". Absent on an
   * older payload. */
  timeZoneLabel?: string;
}

/** Saved provider estimates, in USD minor units. An absent date is not zero. */
export interface DailyRevenueHistory {
  from: string;
  to: string;
  /** Each day's figures summed across the sources behind them. */
  days: RevenueDay[];
  reportedThrough: string | null;
  /** The clock the days are counted on: the sources' own
   * (`commonRevenueClock`). Absent when no source reports, whose empty window
   * is dated on the operator's clock, and on an older payload. */
  clock?: RevenueClock;
  /** Each source behind `days`. Absent on an older payload. */
  bySource?: RevenueSourceHistory[];
  /** Days a source the site owes did not report: `days` holds only what the
   * others did. Absent on an older payload. */
  partialDates?: string[];
}

/** A site's history as the Worker reads it now: its sources and partial days
 * always present, and its clock whenever a source reports. */
export type SiteRevenueHistory = DailyRevenueHistory & Required<Pick<DailyRevenueHistory, 'bySource' | 'partialDates'>>;

export interface PortfolioDailyRevenue extends DailyRevenueHistory {
  /** Each source owed at least one day of the window. `since` is its first
   * reported day: it owes no day before it. */
  sources: { asset: string; displayName: string; since: string }[];
  /** Per day: sources that reported, and the asset IDs of owed sources that
   * did not. Resolve names through `sources` only when displaying them. */
  coverage: { date: string; reported: number; missingAssets: string[] }[];
}

export function revenueWindowDays(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1);
}

export function dailyRevenueWindow(history: DailyRevenueHistory, range: number): DailyRevenueHistory {
  const from = shiftRevenueDate(history.to, -(range - 1));
  return { ...history, from, days: history.days.filter(day => day.date >= from && day.date <= history.to) };
}

/** A calendar date on an explicit clock. Provider reports pass their declared
 * clock; ledger-period callers pass the saved operator clock. No default. */
export function revenueCalendarDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** One site's saved estimates over the page's range, ending yesterday on the
 * source's reporting clock — what the site's Financials tab and, for a site
 * whose first source is ad revenue, its Overview draw. A site with no history
 * yet gets the same window, empty. */
export function siteRevenueWindow(
  history: DailyRevenueHistory | undefined,
  nowMs: number,
  timeZone: string,
  range: number,
): DailyRevenueHistory {
  const to = shiftRevenueDate(revenueCalendarDate(new Date(nowMs), timeZone), -1);
  return dailyRevenueWindow(history ?? { from: shiftRevenueDate(to, -89), to, days: [], reportedThrough: null }, range);
}

/** An older report never substitutes for yesterday. Zero is a recorded value. */
export function yesterdayRevenue(now: Date, timeZone: string, days: readonly RevenueDay[]): DailyRevenueSummary {
  const date = shiftRevenueDate(revenueCalendarDate(now, timeZone), -1);
  const observed = days.filter(day => day.date <= date && Number.isSafeInteger(day.amountMinor));
  return {
    date,
    amountMinor: observed.find(day => day.date === date)?.amountMinor ?? null,
    reportedThrough: observed.map(day => day.date).sort().at(-1) ?? null,
    timeZone,
  };
}
