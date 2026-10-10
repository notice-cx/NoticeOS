import { moneyFigure } from '@noticeos/contract/money';
// The financial ledger's shared read primitives and the one per-asset month
// history /financials and the Wall both read, so they cannot answer it two
// ways. Every money read is of `noticeos.financial_ledger` alone: the view
// holds only current entries (nothing replaced, no change entries, a month of
// Mediavine daily estimates in place of the estimate they cover).

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
 * Every asset's net, month by month: revenue minus the asset's direct cost, in
 * minor units divided once. Portfolio overhead stays on asset #0, which is in
 * the map like any other; callers decide what to do with it. The join is inner:
 * a ledger row for an unknown asset has no page to list it on. A month with no
 * row gets no entry here, never a zero (holes are filled later, as null).
 * Ordered by month, then asset id byte for byte.
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
  // Holes are filled only between an asset's own first and last row: an asset
  // registered in July has no June.
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
 * nobody booked, and not an omission, which would draw distant months as
 * consecutive ones.
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
