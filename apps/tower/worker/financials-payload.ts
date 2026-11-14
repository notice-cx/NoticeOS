import { moneyFigure, minorToMajorUnits, type MinorMoneyFigure } from '@noticeos/contract/money';
import { revenueCalendarDate } from "../shared/daily-revenue";
import { loadPortfolioDailyRevenue } from "./daily-revenue";
// The /financials read model. Money is summed in minor units and divided once
// on the way out, so every figure adds up to the cent. Every money query reads
// the view of current entries only (`./ledger-history`), so a restated figure
// never doubles its month.

import type {
  DomainOrder,
  DomainSchedule,
  FinancialCostLine,
  FinancialMonth,
  FinancialProperty,
  FinancialRevenueLine,
  FinancialsPayload,
  MoneyFigure,
  MoneySourceLine,
  RecurringCost,
} from "../shared/financials";
import type { WorkspaceStore } from "@noticeos/postgres";
import { costProvenance } from "../shared/financials";
import { cents, loadAssetMonths, monthDate } from "./ledger-history";
import { loadBanking } from './banking';

// The cost registers' row shapes live in `../shared/financials`, because the
// page edits these rows.

export interface FinancialsDeps {
  now: Date;
  /** config/domain-costs.json, verbatim. */
  domainOrders: readonly DomainOrder[];
  /**
   * config/recurring-costs.json, verbatim: the declaration behind the rows
   * `scripts/cost-import.mjs` books into the ledger. Absent means no
   * subscriptions declared, a real state.
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
   * The operator's clock: `os_time_zone` as saved. It decides the open month
   * and where the daily revenue window stops.
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

  type SourceRow = {
    period: string;
    state: string;
    kind: MoneySourceLine["kind"];
    family: string;
    source: string | null;
    label: string | null;
    currency: string;
    amountMinor: bigint;
    rows: number;
  };
  const monthRows = await store.read((tx) => tx.query<SourceRow>(
    `SELECT to_char(l.period_month, 'YYYY-MM') AS period,
            l.booking_state AS state, l.kind, l.family, l.source,
            s.display_name AS label, l.currency,
            SUM(l.amount_minor)::bigint AS "amountMinor", count(*)::int AS rows
       FROM noticeos.financial_ledger l
       LEFT JOIN noticeos_ref.revenue_sources s ON l.kind = 'revenue' AND s.source = l.source
      GROUP BY l.period_month, l.booking_state, l.kind, l.family, l.source, s.display_name, l.currency`,
  ));

  const byPeriod = new Map<string, {
    booked: MinorMoneyFigure[];
    estimated: MinorMoneyFigure[];
    sources: Map<string, Omit<MoneySourceLine, "amount"> & { amountMinor: number; rows: number }>;
  }>();
  for (const { period, state, kind, family, source, label, currency, amountMinor, rows } of monthRows) {
    const entry = byPeriod.get(period) ?? { booked: [], estimated: [], sources: new Map() };
    const side = state === "reconciled" ? entry.booked : entry.estimated;
    const amount = cents(amountMinor);
    side.push({ currency, revenueMinor: kind === "revenue" ? amount : 0, costMinor: kind === "cost" ? amount : 0 });
    const key = JSON.stringify([kind, family, source, currency]);
    const line = entry.sources.get(key) ?? { kind, family, source, label, currency, amountMinor: 0, rows: 0 };
    line.amountMinor += amount;
    line.rows += rows;
    entry.sources.set(key, line);
    byPeriod.set(period, entry);
  }
  const months: FinancialMonth[] = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, entry]) => ({
      period,
      booked: moneyFigure(entry.booked, entry.estimated[0]?.currency ?? 'USD'),
      estimated: moneyFigure(entry.estimated, entry.booked[0]?.currency ?? 'USD'),
      total: moneyFigure([...entry.booked, ...entry.estimated]),
      sourceLines: [...entry.sources.values()].map(({ amountMinor, rows: _rows, ...line }) => ({
        ...line, amount: minorToMajorUnits(amountMinor, line.currency),
      })),
    }));

  // --- which period the breakdowns describe ---------------------------------
  // The Wall's ROI card rule (`wall-payload.ts`): the latest period, not in the
  // future, that has any current row — else the current month. Early in a month
  // the current one may hold nothing yet, and the breakdowns must not print
  // $0.00 under a table showing last month's figures. `periods` comes off
  // `months`, so the selector only offers a month the table lists.
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

  // --- by asset, month by month ---------------------------------------------
  // The selected month is a slice of the one grouping the sparklines and the
  // Wall's `netByMonth` read, so a row never disagrees with its own line.
  const history = await loadAssetMonths(store);

  // Which assets reported any revenue this period: a sum of no rows and a sum
  // of a $0.00 row are both 0, and the page draws "not reported" as a dash.
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
      // The table lists assets with a figure in the selected month; a filled
      // hole (null) in an asset's span is not one.
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

  // Keep the selected month's breakdowns in the same order as the ledger.
  const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const lines = [...(byPeriod.get(period)?.sources.values() ?? [])]
    .sort((a, b) => compareText(a.currency, b.currency) || b.amountMinor - a.amountMinor
      || compareText(a.family, b.family) || compareText(a.source ?? "", b.source ?? "")
      || Number(a.source !== null) - Number(b.source !== null));
  const costLines: FinancialCostLine[] = lines.filter(line => line.kind === "cost")
    .map(({ family, source, currency, amountMinor, rows }) => ({
      family, provenance: costProvenance(source), source, currency,
      amount: minorToMajorUnits(amountMinor, currency), rows,
    }));
  const revenueLines: FinancialRevenueLine[] = lines.filter(line => line.kind === "revenue")
    .map(({ family, source, label, currency, amountMinor, rows }) => ({
      family, source, label, currency,
      amount: minorToMajorUnits(amountMinor, currency), rows,
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

  // What the page does not know is drawn on the figure it qualifies, never
  // listed under its own heading.

  return {
    generatedAt: now.toISOString(),
    period,
    periods,
    periodIsCurrent,
    currentPeriod,
    dailyRevenue: await loadPortfolioDailyRevenue(store, period, now, osTimeZone),
    banking: await loadBanking(store),
    months,
    properties,
    overhead,
    costLines,
    revenueLines,
    domains,
    // File order, not the sorted `domains` above: the editor addresses these
    // rows by index, so a sort would point `/domains/3` at the wrong row.
    recurringCosts: [...recurringCosts],
    domainOrders: [...domainOrders],
    empty: months.length === 0,
  };
}
