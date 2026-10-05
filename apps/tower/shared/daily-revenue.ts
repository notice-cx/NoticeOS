import type { RevenueDay } from './revenue-projection';
import { shiftRevenueDate } from './revenue-projection';
export { MEDIAVINE_REPORTING_CLOCK } from '../../../packages/mediavine/src/index';

/** Provider-reported estimates, separate from reconciled monthly accounting. */
export interface DailyRevenueSummary {
  date: string;
  amountMinor: number | null;
  reportedThrough: string | null;
  /** The source's reporting clock (D42). A reader checking whether this still
   * describes yesterday uses the same clock, never the operator's preference. */
  timeZone: string;
}

/** Saved provider estimates, in USD minor units. An absent date is not zero. */
export interface DailyRevenueHistory {
  from: string;
  to: string;
  days: RevenueDay[];
  reportedThrough: string | null;
}

export interface PortfolioDailyRevenue extends DailyRevenueHistory {
  /** Each source owed at least one day of the window. `since` is its first
   * reported day: it owes no day before it (bead `ro-rd6r`). */
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
 * whose first source is ad revenue, its Overview draw (bead `ro-ujb9.146`). A
 * site with no history yet gets the same window, empty. */
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
