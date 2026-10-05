import { moneyFigure } from '@noticeos/contract/money';
// The financial ledger's shared read primitives and the per-asset month
// history built from them.
//
// /financials (`financials-payload.ts`) and the Wall's asset cards
// (`wall-payload.ts`, `netByMonth`) both need every asset's net month by month,
// and they must not answer it two ways (beads `ro-78qo.29`, `ro-78qo.35`). So
// the one grouping lives here, beside what every ledger read in those builders
// shares: the minor-unit figure (subtract in cents, divide once) and the exact
// read of a cents total the store sums.
//
// EVERY MONEY READ IS OF `noticeos.financial_ledger` ALONE (the Postgres
// store, bead ro-ujb9.76.6.1). That view holds only current money entries: no
// entry another replaces (bead `ro-ujb9.69`), no change entry (D36), and a month
// of Mediavine daily estimates standing in for the estimate they cover
// (0001_baseline.sql). D1's readers added a current-row guard to every read
// (`CURRENT`, beads `ro-ujb9.69`, `ro-ujb9.101`); on Postgres it can keep no
// row the view does not already keep, because a correction names a stored
// entry (a positive identity) and the view's daily months carry negative ones,
// so it is gone. `apps/tower/test/ledger-current-guard.test.ts` holds the old
// guard as the specification and proves the view keeps exactly its rows.

import { assetDisplayName } from "@noticeos/contract/asset-name";
import type { WorkspaceStore } from "@noticeos/postgres";
import type { FinancialPropertyMonth, MoneyFigure } from "../shared/financials";
import { shiftLabel } from "../shared/surface";

/**
 * Integer cents the store returned (an `int8` column, or a SUM cast back to
 * one) as the number every figure below is made of: exact, since money past
 * 2^53 cents is refused rather than rounded. Never a float between the store
 * and the figure.
 */
export function cents(value: bigint | null): number {
  if (value === null) return 0;
  const exact = Number(value);
  if (!Number.isSafeInteger(exact)) throw new RangeError(`${value} cents is past 2^53 and no longer exact`);
  return exact;
}

/** A ledger month, 'YYYY-MM', as the store's `period_month` date for it;
 * readers read it back with `to_char(period_month, 'YYYY-MM')`. */
export const monthDate = (period: string): string => `${period}-01`;

export function figure(revenueMinor: number, costMinor: number, currency = 'USD'): MoneyFigure {
  return moneyFigure([{ currency, revenueMinor, costMinor }]);
}

/** One asset's whole ledger history, as the two payloads that need it read it. */
export interface AssetLedgerHistory {
  displayName: string;
  isOs: boolean;
  /** Ascending, one entry per month this asset has a current row in. */
  months: FinancialPropertyMonth[];
}

/**
 * EVERY ASSET'S NET, MONTH BY MONTH — the desk's ONE per-asset ledger
 * derivation (beads `ro-78qo.29`, `ro-78qo.35`).
 *
 * Three surfaces ask this question and they must not answer it three ways:
 * /financials' by-asset table prints one month of it as figures and the rest as
 * a sparkline, and /assets' comparison table draws it per row off the wall
 * payload. So it is one grouping, run once, handed to whoever asked.
 *
 * WHAT THE ARITHMETIC IS. Revenue minus this asset's DIRECT cost, in minor
 * units divided once on the way out; superseded rows excluded by the one view
 * every other money query in this worker reads; portfolio overhead
 * left on asset #0 and allocated to nobody, which is the two-tier read
 * /financials exists to carry. Asset #0 is in the map like any other asset —
 * nothing here is special-cased on `is_os`, and the callers decide what to do
 * with the overhead line.
 *
 * THE JOIN IS INNER on purpose: a ledger row naming an asset the assets table
 * has never heard of has no display name and no page, and no by-asset read has
 * ever listed one.
 *
 * A MONTH AN ASSET HOLDS NO ROW FOR GETS NO ENTRY — never a zero. /financials
 * spends a whole section on the difference between "zero" and "not measured",
 * and a manufactured run of zeroes would draw a cliff the ledger never
 * recorded. Ordered by month, then by asset id byte for byte, the order D1's
 * grouping returned them in, so each list is ascending and the assets reach
 * the map in the order they always did.
 */
export async function loadAssetMonths(
  store: WorkspaceStore,
): Promise<Map<string, AssetLedgerHistory>> {
  const rows = await store.read((tx) =>
    tx.query<{
      period: string;
      asset: string;
      displayName: string;
      isOs: boolean;
      currency: string;
      revenueMinor: bigint;
      costMinor: bigint;
    }>(
      `SELECT to_char(l.period_month, 'YYYY-MM') AS period,
              l.asset_id AS asset, l.currency,
              a.display_name AS "displayName",
              a.is_os AS "isOs",
              COALESCE(SUM(CASE WHEN l.kind='revenue' THEN l.amount_minor ELSE 0 END), 0)::bigint AS "revenueMinor",
              COALESCE(SUM(CASE WHEN l.kind='cost'    THEN l.amount_minor ELSE 0 END), 0)::bigint AS "costMinor"
         FROM noticeos.financial_ledger l
         JOIN noticeos.assets a ON a.workspace_id = l.workspace_id AND a.asset_id = l.asset_id
        GROUP BY l.period_month, l.asset_id, a.display_name, a.is_os, l.currency
        ORDER BY l.period_month ASC, l.asset_id COLLATE "C"`,
    ),
  );

  const history = new Map<string, AssetLedgerHistory>();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = JSON.stringify([row.asset, row.period]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const row = group[0]!;
    const entry = history.get(row.asset) ?? {
      displayName: assetDisplayName(row.isOs, row.displayName), isOs: row.isOs, months: [],
    };
    entry.months.push({ period: row.period,
      figure: moneyFigure(group.map(item => ({ currency: item.currency,
        revenueMinor: cents(item.revenueMinor), costMinor: cents(item.costMinor) }))),
    });
    history.set(row.asset, entry);
  }
  // THE HOLES ARE FILLED IN LAST, and only between an asset's own first and
  // last row (bead `ro-78qo.37`). The axis is the ASSET's: a asset registered
  // in July has no June, and prefixing one would invent a month it did not
  // exist in — a different mistake from the gap this closes.
  for (const entry of history.values()) {
    entry.months = onMonthAxis(entry.months);
  }
  return history;
}

/**
 * One asset's months, with every skipped month present and NULL.
 *
 * The input is already ascending (`ORDER BY period ASC`) and holds only real
 * rows; what comes back is the same list with the calendar between its ends
 * filled in. A hole is `figure: null` — not a zero, which would be a figure
 * nobody booked, and not an omission, which is what made a sparkline draw three
 * months a year apart as three consecutive ones.
 */
function onMonthAxis(months: FinancialPropertyMonth[]): FinancialPropertyMonth[] {
  const first = months[0]?.period;
  const last = months.at(-1)?.period;
  if (first === undefined || last === undefined) return months;
  const booked = new Map(months.map((month) => [month.period, month.figure]));
  const axis: FinancialPropertyMonth[] = [];
  // Bounded by the asset's own span, and defensively by a guard: a ledger row
  // with a malformed period must not hang the read model.
  let period = first;
  for (let guard = 0; guard < 1200; guard += 1) {
    axis.push({ period, figure: booked.get(period) ?? null });
    if (period === last) break;
    period = shiftLabel(period, 1);
  }
  return axis;
}
