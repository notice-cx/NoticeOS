import type { LedgerSlice } from "@shared/asset-detail";
import type { DailyRevenueHistory } from "@shared/daily-revenue";
import { shiftRevenueDate } from "@shared/revenue-projection";
import { figureHasMoney } from "@shared/wall";
import { monthDays, previousPeriod, type MonthDays, type MonthEquation } from "@/lib/money-page";
import type { LedgerMonth } from "@/routes/asset-detail/overview-metrics";

// One site's month in the Money page's own terms, so the site's Money tab
// draws the same equation, days and pace the portfolio's does. The side of
// the ledger is `ledgerMonth`'s: the booked rows when the month has any, its
// estimates otherwise, and never the two added together. The days and the
// pace are the daily ad revenue estimates, which a booked month does not
// replace.

/** The ledger month as the equation draws it. */
export function siteEquation(ledger: LedgerSlice, month: LedgerMonth, openPeriod: string): MonthEquation | null {
  const current = ledger.periods.find((period) => period.period === month.period);
  if (!current) return null;
  const rollup = month.booking === "booked" ? current.booked : current.forecast;
  const { figure } = rollup;
  if (figure.currency === null) return null;
  return {
    period: current.period,
    open: current.period >= openPeriod,
    currency: figure.currency,
    revenue: figure.revenue,
    cost: figure.cost,
    net: figure.net,
    costRecorded: rollup.costByFamily.length > 0 || figure.cost !== 0,
    confirmed: null,
    turnover: null,
  };
}

/** The month before on the ledger, on the side that has money for it, in the
 * equation's currency; null revenue when there is nothing to measure against. */
export function siteLastMonth(ledger: LedgerSlice, equation: MonthEquation): { period: string; revenue: number | null } {
  const period = previousPeriod(equation.period);
  const before = ledger.periods.find((candidate) => candidate.period === period);
  const side = before ? (figureHasMoney(before.booked.figure) ? before.booked : before.forecast) : null;
  return {
    period,
    revenue: side && figureHasMoney(side.figure) && side.figure.currency === equation.currency ? side.figure.revenue : null,
  };
}

const monthEnd = (period: string) => shiftRevenueDate(`${shiftRevenueDate(`${period}-28`, 4).slice(0, 7)}-01`, -1);

/**
 * The month's days of saved ad revenue, through the newest day the source
 * owes, as the Money page reads a portfolio's: a day the site did not report
 * after its first report is a gap, never a zero. One site has no other source
 * to blame a gap on, so nothing is named short.
 */
export function siteMonthDays(history: DailyRevenueHistory | undefined, period: string, through: string, asset: string, name: string): MonthDays | null {
  if (!history || history.days.length === 0) return null;
  const from = `${period}-01`;
  const end = monthEnd(period);
  const to = through < end ? through : end;
  if (to < from) return null;
  const reported = new Set(history.days.map((day) => day.date));
  const since = [...reported].sort()[0]!;
  const coverage: { date: string; reported: number; missingAssets: string[] }[] = [];
  for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
    const has = reported.has(date);
    coverage.push({ date, reported: has ? 1 : 0, missingAssets: has || date < since ? [] : [asset] });
  }
  const days = history.days.filter((day) => day.date >= from && day.date <= to);
  return {
    ...monthDays({ from, to, days, reportedThrough: history.reportedThrough, sources: [{ asset, displayName: name, since }], coverage }),
    short: [],
  };
}

export interface EstimatePace {
  period: string;
  /** The month so far, every day through `through` reported. */
  value: number;
  previousPeriod: string;
  /** The month before through the same day of the month; null when any of
   * those days is missing or the month is shorter. */
  previousAtSameDay: number | null;
  /** The whole month before; null when any of its days is missing. */
  previousTotal: number | null;
}

/**
 * The month's ad revenue estimates so far against the month before, from the
 * saved days alone: a sum over a stretch with a missing day is no sum, so
 * each side is stated only when every one of its days reported.
 */
export function siteEstimatePace(history: DailyRevenueHistory | undefined, period: string, through: string): EstimatePace | null {
  if (!history) return null;
  const amounts = new Map(history.days.map((day) => [day.date, day.amountMinor / 100]));
  const sum = (from: string, to: string): number | null => {
    if (to < from) return null;
    let total = 0;
    for (let date = from; date <= to; date = shiftRevenueDate(date, 1)) {
      const amount = amounts.get(date);
      if (amount === undefined) return null;
      total += amount;
    }
    return total;
  };
  const end = monthEnd(period);
  const value = sum(`${period}-01`, through < end ? through : end);
  if (value === null) return null;
  const before = previousPeriod(period);
  const beforeEnd = monthEnd(before);
  const sameDay = `${before}-${(through < end ? through : end).slice(8, 10)}`;
  return {
    period,
    value,
    previousPeriod: before,
    previousAtSameDay: sameDay <= beforeEnd ? sum(`${before}-01`, sameDay) : null,
    previousTotal: sum(`${before}-01`, beforeEnd),
  };
}
