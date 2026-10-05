import { moneyFigure, minorToMajorUnits, type MinorMoneyFigure } from '@noticeos/contract/money';
import { revenueCalendarDate } from "../shared/daily-revenue";
import { loadPortfolioDailyRevenue } from "./daily-revenue";
// The /financials read model (bead `ro-kukv.7`).
//
// Money is summed in MINOR UNITS throughout and divided once on the way out.
// `db/0020` dropped the original `amount REAL` column for exactly this reason:
// a sum of binary floats is never provably cent-exact, and this page's whole
// job is being addable.
//
// SUPERSEDED ROWS ARE EXCLUDED EVERYWHERE: every money query in this worker
// reads the one view that holds only current entries (`./ledger-history`). A
// restated figure is a new row that supersedes the old one, so counting both
// would double a month the day it reconciles.

import type {
  DomainOrder,
  DomainSchedule,
  FinancialCostLine,
  FinancialMonth,
  FinancialProperty,
  FinancialsPayload,
  MoneyFigure,
  RecurringCost,
} from "../shared/financials";
import type { WorkspaceStore } from "@noticeos/postgres";
import { costProvenance } from "../shared/financials";
import { cents, loadAssetMonths, monthDate } from "./ledger-history";

// The two cost registers' ROW shapes (`DomainOrder`, `RecurringCost`) live in
// the shared contract beside the payload that carries them (bead `ro-x5gu.2`):
// the page edits these rows, so the browser needs the same type this builder
// does. Callers import them from `../shared/financials`, not from this builder.

export interface FinancialsDeps {
  now: Date;
  /** config/domain-costs.json, verbatim. */
  domainOrders: readonly DomainOrder[];
  /**
   * config/recurring-costs.json, verbatim.
   *
   * The ledger already holds what these rows BOOKED — `scripts/cost-import.mjs`
   * writes one row per entry per month. This is the DECLARATION behind those
   * rows, which is the thing /financials edits. Optional so every existing
   * caller keeps compiling: a register nobody injected is an empty list, which
   * is a real state (no subscriptions declared), never an error.
   */
  recurringCosts?: readonly RecurringCost[];
  /**
   * The month the reader asked for (`?period=YYYY-MM`), or absent for the
   * page's own choice. A period the ledger has no row for is a 404 rather than
   * an empty page: a URL somebody bookmarked or mistyped must not come back
   * looking like a portfolio that earned and spent nothing.
   */
  period?: string | null;
  /**
   * The operator's clock: config/constants.json `os_time_zone` as SAVED,
   * resolved store first (bead `ro-ujb9.88`). It decides the open month and
   * where the daily revenue window stops.
   */
  osTimeZone: string;
}

/**
 * An explicit `?period=` the ledger holds no current row for.
 *
 * It carries the periods it does hold, so the route can answer 404 with the
 * list rather than a bare refusal the caller has to make a second request to
 * act on.
 */
export class PeriodNotFound extends Error {
  readonly periods: string[];

  constructor(periods: string[]) {
    super("period_not_found");
    this.name = "PeriodNotFound";
    this.periods = periods;
  }
}

/** The twelve months a domain order covers, starting the month it was bought. */
function termOf(order: DomainOrder): { first: string; last: string } {
  const parts = order.paidOn.slice(0, 7).split("-").map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const period = (m: number) =>
    `${year + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, "0")}`;
  return { first: period(month), last: period(month + 11) };
}

export async function buildFinancialsPayload(
  /** The call's store: the ledger, its daily revenue and the site list are all on Postgres. */
  store: WorkspaceStore,
  { now, domainOrders, recurringCosts = [], period: requested = null, osTimeZone }: FinancialsDeps,
): Promise<FinancialsPayload> {
  /** The calendar month the reader is standing in. It decides whether the
   * chosen period is the open one — never, by itself, which period is shown. */
  const currentPeriod = revenueCalendarDate(now, osTimeZone).slice(0, 7);

  // --- month by month, split by booking state ------------------------------
  const monthRows = await store.read((tx) =>
    tx.query<{ period: string; state: string; currency: string; revenueMinor: bigint; costMinor: bigint }>(
      `SELECT to_char(period_month, 'YYYY-MM') AS period,
              booking_state AS state, currency,
              COALESCE(SUM(CASE WHEN kind='revenue' THEN amount_minor ELSE 0 END), 0)::bigint AS "revenueMinor",
              COALESCE(SUM(CASE WHEN kind='cost'    THEN amount_minor ELSE 0 END), 0)::bigint AS "costMinor"
         FROM noticeos.financial_ledger
        GROUP BY period_month, booking_state, currency
        ORDER BY period_month ASC`,
    ),
  );

  const byPeriod = new Map<string, { booked: MinorMoneyFigure[]; estimated: MinorMoneyFigure[] }>();
  for (const row of monthRows) {
    const entry = byPeriod.get(row.period) ?? { booked: [], estimated: [] };
    const side = row.state === "reconciled" ? entry.booked : entry.estimated;
    side.push({ currency: row.currency, revenueMinor: cents(row.revenueMinor), costMinor: cents(row.costMinor) });
    byPeriod.set(row.period, entry);
  }
  const months: FinancialMonth[] = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, entry]) => ({ period,
      booked: moneyFigure(entry.booked, entry.estimated[0]?.currency ?? 'USD'),
      estimated: moneyFigure(entry.estimated, entry.booked[0]?.currency ?? 'USD'),
      total: moneyFigure([...entry.booked, ...entry.estimated]),
    }));

  // --- WHICH PERIOD THE BREAKDOWNS DESCRIBE (bead `ro-69vb`) ----------------
  // The same rule the Wall's ROI card runs on (`wall-payload.ts`, bead
  // `ro-bdkp`), stated once more here because this page reaches the ledger by
  // its own query and the two surfaces must not disagree about what "this
  // period" means: THE LATEST PERIOD, NOT IN THE FUTURE, THAT HAS ANY CURRENT
  // ROW — else the current month.
  //
  // The current month wins the moment it holds one row, so twenty-six days out
  // of thirty this is byte-identical to reading the clock. It is the other four
  // that this exists for: on 2026-09-04 the store held June through August, and
  // the by-asset, cost and portfolio-net blocks all printed $0.00 directly under
  // a table showing August at +$200.25.
  //
  // `periods` comes off `months` rather than a second query, so the selector
  // can only ever offer a month the trajectory table already lists.
  const periods = months.map((month) => month.period);
  const latestWithRows =
    [...periods].reverse().find((candidate) => candidate <= currentPeriod) ?? null;
  // An explicit ask is honoured or refused — never quietly redirected to a
  // neighbouring month, which would hand back figures for a period the caller
  // did not request under the URL that requested one.
  if (requested !== null && !periods.includes(requested)) {
    throw new PeriodNotFound(periods);
  }
  const period = requested ?? latestWithRows ?? currentPeriod;
  const periodIsCurrent = period === currentPeriod;

  // --- BY ASSET, MONTH BY MONTH (beads `ro-78qo.29`, `ro-78qo.35`) ----------
  // ONE grouping, not two, and since `.35` not two payloads either: the table's
  // figures, the sparkline in each of its rows and the wall card's `netByMonth`
  // are the same arithmetic asked for different months. The selected month is a
  // SLICE of this result rather than a second read of the ledger, so a row can
  // never print a net its own line disagrees with.
  const history = await loadAssetMonths(store);

  // WHICH ASSETS REPORTED ANY REVENUE THIS PERIOD (bead `ro-ujb9.96.6.9`) —
  // the one fact the monthly sums cannot keep: a sum of no rows and a sum of a
  // $0.00 row are both 0. The page draws "not reported" as a dash in the row
  // rather than explaining under a separate heading that $0.00 might not mean
  // zero.
  const reporting = new Set(
    (
      await store.read((tx) =>
        tx.query<{ asset: string }>(
          `SELECT DISTINCT asset_id AS asset
             FROM noticeos.financial_ledger
            WHERE period_month = $1::date AND kind = 'revenue'`,
          [monthDate(period)],
        ),
      )
    ).map((row) => row.asset),
  );

  const properties: FinancialProperty[] = [...history.entries()]
    .flatMap(([asset, entry]) => {
      // The table lists the assets with a row in the SELECTED month, and this
      // is where that filter now lives. An asset with history but nothing this
      // period is not a row of a table describing this period — and since
      // `ro-78qo.37` that includes an asset whose axis merely SPANS this month
      // with a hole in it, which is why the null is rejected here too.
      const shown = entry.months.find((month) => month.period === period);
      if (!shown?.figure) return [];
      return [
        {
          asset,
          displayName: entry.displayName,
          isOs: entry.isOs,
          figure: shown.figure,
          months: entry.months,
          revenueReported: reporting.has(asset),
        },
      ];
    })
    // Currency groups first; compare contributions only inside the same group.
    .sort((a, b) => (a.figure.currency ?? "").localeCompare(b.figure.currency ?? "")
      || (b.figure.net ?? -Infinity) - (a.figure.net ?? -Infinity)
      || a.asset.localeCompare(b.asset));

  const os = properties.find((p) => p.isOs);
  const overhead: MoneyFigure = os?.figure ?? moneyFigure([], months.find(month => month.period === period)?.total.currency ?? 'USD');

  // --- this period, by cost family and how it was learned -------------------
  // Equal totals keep the order D1's grouping gave them: family, then source
  // with no source first, byte for byte.
  const costRows = await store.read((tx) =>
    tx.query<{ family: string; source: string | null; currency: string; amountMinor: bigint; rows: number }>(
      `SELECT family, source, currency,
              COALESCE(SUM(amount_minor), 0)::bigint AS "amountMinor",
              count(*)::int AS rows
         FROM noticeos.financial_ledger
        WHERE period_month = $1::date AND kind = 'cost'
        GROUP BY family, source, currency
        ORDER BY currency COLLATE "C", "amountMinor" DESC, family COLLATE "C", source COLLATE "C" NULLS FIRST`,
      [monthDate(period)],
    ),
  );

  const costLines: FinancialCostLine[] = costRows.map((row) => ({
    family: row.family,
    provenance: costProvenance(row.source),
    source: row.source,
    currency: row.currency,
    amount: minorToMajorUnits(cents(row.amountMinor), row.currency),
    rows: row.rows,
  }));

  // --- the domain schedule, from config rather than the ledger --------------
  // The ledger holds one summed `infra` row per asset per month; this is the
  // orders behind it, which is what an operator checking a figure against a
  // receipt actually needs.
  const domains: DomainSchedule[] = domainOrders
    .map((order) => {
      const term = termOf(order);
      return {
        domain: order.domain,
        asset: order.asset,
        paidUsd: order.paidUsd,
        paidOn: order.paidOn,
        perMonth: Math.round((order.paidUsd / 12) * 100) / 100,
        firstPeriod: term.first,
        lastPeriod: term.last,
      };
    })
    .sort((a, b) => b.paidUsd - a.paidUsd);

  // WHAT THE PAGE DOES NOT KNOW IS DRAWN WHERE IT APPLIES (bead
  // `ro-ujb9.96.6.9`), not listed as paragraphs under its own heading: a month
  // with nothing reconciled is the Reconciled figure's own all-estimated bar,
  // an asset with no revenue row is a dash in its Revenue cell
  // (`revenueReported`), and a domain term about to renew is marked on its
  // order. Each fact sits once, on the figure it qualifies.

  return {
    generatedAt: now.toISOString(),
    period,
    periods,
    periodIsCurrent,
    currentPeriod,
    dailyRevenue: await loadPortfolioDailyRevenue(store, period, now),
    months,
    properties,
    overhead,
    costLines,
    domains,
    // FILE ORDER, both of them — and deliberately NOT the sorted `domains`
    // above. These are the rows the page's editor addresses by index and
    // guards by value (bead `ro-x5gu.2`); a convenience sort here would point
    // every `/domains/3` at a different row than the operator clicked.
    recurringCosts: [...recurringCosts],
    domainOrders: [...domainOrders],
    empty: months.length === 0,
  };
}
