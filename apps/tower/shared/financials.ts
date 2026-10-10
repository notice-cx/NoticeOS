// The portfolio's accounting, for an operator who is reading rather than
// glancing. Most of the portfolio's cost is not attributable to any asset, so
// overhead books to asset #0 and the read is two-tier:
//
//   asset net      = its revenue − its direct cost
//   portfolio net  = Σ asset nets − asset #0 overhead

/** Revenue, cost and their difference. Cost is positive; net is revenue − cost. */
export type { MoneyFigure } from '@noticeos/contract/money';
import type { MoneyFigure } from '@noticeos/contract/money';

/** One accounting period, split by what has actually settled. */
export interface FinancialMonth {
  /** `YYYY-MM`. */
  period: string;
  booked: MoneyFigure;
  estimated: MoneyFigure;
  /** Every current row, whatever its booking state — the shape of the month. */
  total: MoneyFigure;
}

/** One asset's own month, in the ledger's monthly grain: the same arithmetic
 * as `FinancialProperty.figure`, run for every month rather than the selected
 * one. */
export interface FinancialPropertyMonth {
  /** `YYYY-MM`. */
  period: string;
  /** Null is a month on the axis that booked nothing: not a zero, and not an
   * absent entry, so a sparkline's spacing is right and the line breaks. */
  figure: MoneyFigure | null;
}

/** One asset's contribution for the period. */
export interface FinancialProperty {
  asset: string;
  displayName: string;
  /** True for asset #0, which carries portfolio overhead and has no card. */
  isOs: boolean;
  figure: MoneyFigure;
  /**
   * This asset's own month axis, ascending and unbroken: every month from its
   * first ledger row to its last, with `figure: null` wherever it booked
   * nothing. The axis is the asset's, not the ledger's. `figure` above is this
   * list's entry for the selected period, not a second derivation.
   */
  months: FinancialPropertyMonth[];
  /** Did any revenue row arrive for this asset in the selected month?
   * `figure.revenue` is 0 both for an asset that reported earning nothing and
   * for one nothing reported at all; the row draws the difference (a dash,
   * not $0.00). */
  revenueReported: boolean;
}

/**
 * How a cost figure came to be known. `metered` — the OS recorded it on the
 * manifest of the call that spent it; the only cost genuinely attributable to
 * an asset. `stated` — the operator wrote it into
 * `config/recurring-costs.json`. `amortized` — a prepaid annual term, spread
 * over the months it covers. `unclassified` — a row with no source, shown as
 * itself rather than folded into a neighbour.
 */
export type CostProvenance = "metered" | "stated" | "amortized" | "unclassified";

export interface FinancialCostLine {
  currency: string;
  family: string;
  provenance: CostProvenance;
  source: string | null;
  amount: number;
  /** Rows behind the figure — a one-row line and a forty-row line differ. */
  rows: number;
}

/**
 * One row of `config/recurring-costs.json`, exactly as the file holds it: the
 * shape the Tower's own editor writes back, so it may not be reshaped,
 * reordered or enriched. A row's position in the array is its address
 * (`/costs/3`), and a guarded write's `expect` is the row itself.
 *
 * A `type`, not an `interface`, and it has to stay one: only a type alias
 * gets the implicit index signature that lets a row be handed to the
 * collection editor as the `JsonValue` it is.
 */
export type RecurringCost = {
  id: string;
  label: string;
  asset: string;
  family: string;
  amountUsdPerMonth: number;
  /** First month to book, `YYYY-MM`. */
  from: string;
  /** Last month, `YYYY-MM`. Absent while the subscription is live. */
  to?: string;
  note?: string;
};

/** One row of `config/domain-costs.json`, exactly as the file holds it — the
 * same contract as `RecurringCost`. */
export type DomainOrder = {
  domain: string;
  asset: string;
  kind: string;
  paidUsd: number;
  paidOn: string;
};

/** One domain order and the term it is being spread across. */
export interface DomainSchedule {
  domain: string;
  asset: string;
  paidUsd: number;
  paidOn: string;
  perMonth: number;
  /** `YYYY-MM` of the first and last month this order books into. */
  firstPeriod: string;
  lastPeriod: string;
}

export interface FinancialsPayload {
  dailyRevenue?: import('./daily-revenue').PortfolioDailyRevenue;
  generatedAt: string;
  /** The period the asset and cost breakdowns describe — not always the month
   * the reader is standing in, since the first days of a month hold no rows. */
  period: string;
  /** Every period the ledger holds a current row for, ascending — the options
   * behind the selector. Same rows as `months`, so the selector can never
   * offer a month the trajectory table does not have. */
  periods: string[];
  /** False when `period` is not the calendar month the reader is standing in;
   * the header then names the month. The same pair the Wall's ROI card ships. */
  periodIsCurrent: boolean;
  /** The calendar month the reader is standing in on the operator's saved
   * clock — the open month, whatever `period` shows. */
  currentPeriod: string;
  /** Oldest first, so the reader sees the trajectory in reading order. */
  months: FinancialMonth[];
  properties: FinancialProperty[];
  /** Asset #0's line, pulled out of `properties` for the two-tier read. */
  overhead: MoneyFigure;
  costLines: FinancialCostLine[];
  domains: DomainSchedule[];
  /** The two cost registers as their files hold them, in file order: they are
   * what `/financials` edits, and a collection editor addresses a row by its
   * index and guards the write with the row itself, so nothing may re-sort
   * them. */
  recurringCosts: RecurringCost[];
  domainOrders: DomainOrder[];
  /** True when no ledger row exists at all — the page says so and stops. */
  empty: boolean;
}

/** `metered:dataforseo` → `metered`; `recurring:cloudflare` → `stated`. */
export function costProvenance(source: string | null): CostProvenance {
  if (source === null) return "unclassified";
  if (source.startsWith("metered:")) return "metered";
  if (source.startsWith("recurring:")) return "stated";
  if (source === "domains") return "amortized";
  return "unclassified";
}

/** The word on the chip, in the operator's own words for the four things, so
 * the chip needs nothing behind it. */
export const PROVENANCE_LABEL: Readonly<Record<CostProvenance, string>> =
  Object.freeze({
    metered: "Usage",
    stated: "Subscription",
    amortized: "Prepaid yearly",
    unclassified: "No source",
  });

/** `YYYY-MM`, and a real month number — the shape of every `?period=` this
 * page accepts. Shared because the worker refuses a value that fails it and
 * the page has to know whether it is naming a month or a typo. */
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
