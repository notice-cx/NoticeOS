import { moneyCurrency, moneyFigure } from '@noticeos/contract/money';
import type { WorkspaceStore } from '@noticeos/postgres';
import type { LedgerFigure } from '../shared/wall';
import { shiftRevenueDate } from '../shared/revenue-projection';
import { cents, monthDate } from './ledger-history';
import { loadStripeMonthShifts } from './stripe-calendar';

/** One (asset, booking state) money total for the shown period, in integer
 * cents — the single row shape both the portfolio headline and every asset
 * card are derived from. */
interface LedgerStateRow {
  currency: string;
  asset: string;
  bookingState: string;
  revenueMinor: number;
  costMinor: number;
  revenueRecorded: boolean;
  dailySources: string[] | null;
}

export const previousLedgerPeriod = (month: string) => shiftRevenueDate(monthDate(month), -1).slice(0, 7);

/** The portfolio and per-site rows used by the Wall's current-month revenue. */
export async function loadWallLedger(store: WorkspaceStore, currentPeriod: string, osTimeZone: string) {
  const latestLedgerPeriod =
    (
      await store.read((tx) =>
        tx.query<{ period: string | null }>(
          `SELECT to_char(MAX(period_month), 'YYYY-MM') AS period
             FROM noticeos.financial_ledger
            WHERE period_month <= $1::date`,
          [monthDate(currentPeriod)],
        ),
      )
    )[0]?.period ?? null;
  const period = latestLedgerPeriod ?? currentPeriod;
  const periodIsCurrent = period === currentPeriod;

  const ledgerRows: LedgerStateRow[] = (
    await store.read((tx) =>
      tx.query<Omit<LedgerStateRow, 'revenueMinor' | 'costMinor'> & { revenueMinor: bigint; costMinor: bigint }>(
        `SELECT asset_id AS asset, booking_state AS "bookingState", currency,
                BOOL_OR(kind = 'revenue') AS "revenueRecorded",
                ARRAY_AGG(DISTINCT source) FILTER (WHERE entry_id < 0) AS "dailySources",
                COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE 0 END), 0)::bigint AS "revenueMinor",
                COALESCE(SUM(CASE WHEN kind='cost'    THEN amount_minor ELSE 0 END), 0)::bigint AS "costMinor"
           FROM noticeos.financial_ledger
          WHERE period_month = $1::date
          GROUP BY asset_id, booking_state, currency`,
        [monthDate(period)],
      ),
    )
  ).map((row) => ({ ...row, revenueMinor: cents(row.revenueMinor), costMinor: cents(row.costMinor) }));

  const portfolioFigure = (bookingState: string): LedgerFigure =>
    moneyFigure(ledgerRows.filter(row => row.bookingState === bookingState),
      moneyCurrency(ledgerRows.map(row => moneyFigure([row]))) ?? 'USD');
  const booked = portfolioFigure("reconciled");
  const forecast = portfolioFigure("estimated");
  const shifts = await loadStripeMonthShifts(store, osTimeZone, [...new Set([period, currentPeriod, previousLedgerPeriod(period), previousLedgerPeriod(currentPeriod)])]);
  const wallPeriod = shifts.some(row => row.toPeriod === currentPeriod) ? currentPeriod : period;
  const stripeShift = (month: string) => shifts.reduce((total, row) => total
    + (row.toPeriod === month ? row.amountMinor : 0) - (row.fromPeriod === month ? row.amountMinor : 0), 0);
  const wallRevenueUsd = (state: string) => {
    const rows = wallPeriod === period ? ledgerRows.filter(row => row.bookingState === state && row.currency === 'USD' && row.revenueRecorded) : [];
    const moved = state === 'estimated' ? stripeShift(wallPeriod) : 0;
    if (rows.length === 0 && !shifts.some(row => state === 'estimated' && row.toPeriod === wallPeriod)) return null;
    const total = moneyFigure([
      ...rows.map(row => ({ ...row, costMinor: 0 })), { currency: 'USD', revenueMinor: moved, costMinor: 0 },
    ]).revenue;
    return total;
  };
  // First-run state: the portfolio stays in the empty state until a reconciled
  // row exists. Estimated rows do not book P&L; they show as forecast.
  const [reconciled] = await store.read((tx) =>
    tx.query<{ x: number }>(
      `SELECT 1 AS x FROM noticeos.financial_ledger WHERE booking_state = 'reconciled' LIMIT 1`,
    ),
  );
  const firstRun = !reconciled;

  const portfolio = {
    period,
    periodIsCurrent,
    booked,
    forecast,
    firstRun,
    wallRevenueUsd: { booked: wallRevenueUsd('reconciled'), forecast: wallRevenueUsd('estimated'), period: wallPeriod, periodIsCurrent: wallPeriod === currentPeriod },
  };
  return { ledgerRows, portfolio, shifts, stripeShift };
}
