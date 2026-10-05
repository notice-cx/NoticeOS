// The portfolio's accounting, for an operator who is reading rather than
// glancing (bead `ro-kukv.7`).
//
// The Wall's ROI card is one cell in a TV row: a net figure, its revenue and
// cost, its booking state, and a door. Everything stripped out of that card when
// it blew the 1080p layout is real and belongs here.
//
// THE ONE IDEA THIS PAGE EXISTS TO CARRY. Most of the portfolio's cost is not
// attributable to any asset — Claude Code and the Cloudflare plan pay for all
// of it — and splitting them would need an allocation key nobody measured. So
// overhead books to asset #0 and the read is TWO-TIER:
//
//   asset net   = its revenue − its DIRECT cost
//   portfolio net  = Σ asset nets − asset #0 overhead
//
// A page that showed one blended margin per asset would look more finished
// and be less true.

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

/**
 * One asset's own month, in the ledger's monthly grain.
 *
 * The same arithmetic as `FinancialProperty.figure` — revenue minus DIRECT
 * cost, superseded rows excluded — run for every month rather than for the
 * selected one. It exists so a row of the by-asset table can carry its own
 * shape: a share bar answers which asset is carrying THIS month, and only a
 * series answers which one is getting better (bead `ro-78qo.29`).
 */
export interface FinancialPropertyMonth {
  /** `YYYY-MM`. */
  period: string;
  /**
   * NULL IS A MONTH ON THE AXIS THAT BOOKED NOTHING (bead `ro-78qo.37`).
   *
   * Not a zero, and not an absent entry. A sparkline spaces its points by
   * POSITION, so an asset with rows in January, June and August would otherwise
   * draw the same three-across shape as one with June, July and August — a
   * claim about which months these are that the ledger never made. The month is
   * present so the spacing is right; its value is null so the line breaks over
   * it, and so nobody can read a figure where there is none.
   */
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
   * THIS ASSET'S OWN MONTH AXIS, ascending and unbroken: every month from its
   * first ledger row to its last, with `figure: null` wherever it booked
   * nothing.
   *
   * The axis is the ASSET's, not the ledger's. A asset registered in July has
   * no June, and prefixing one would be inventing a month it did not exist in —
   * a different mistake from the gap this fills.
   *
   * A month with no row is a HOLE, never a zero. The two are not the same fact
   * anywhere else on this page — `revenueReported` keeps "zero" and "not
   * reported" apart in the same table — and they are not the same fact here: a
   * run of manufactured zeroes would draw a cliff the ledger never recorded.
   *
   * `figure` above is this list's entry for the SELECTED period, not a second
   * derivation — one grouping answers both, so the row's line can never
   * disagree with the row's figures.
   */
  months: FinancialPropertyMonth[];
  /**
   * DID ANY REVENUE ROW ARRIVE FOR THIS ASSET IN THE SELECTED MONTH (bead
   * `ro-ujb9.96.6.9`).
   *
   * `figure.revenue` is 0 both for an asset that reported earning nothing and
   * for one nothing reported at all, and those are different facts: the second
   * is "not measured", never "zero". The page used to carry a paragraph saying
   * so under a "what this page does not know" heading; the flag lets the row
   * itself draw the difference — a dash, not $0.00 — where the reader looks.
   */
  revenueReported: boolean;
}

/**
 * How a cost figure came to be known — the distinction an operator needs before
 * trusting it, and the one a bare family name loses.
 *
 * - `metered` — the OS recorded it on the manifest of the call that spent it.
 *   Nobody stated it; it is derived. The only cost genuinely attributable to a
 *   asset.
 * - `stated` — a card is charged monthly and the only record is a statement, so
 *   the operator wrote it into `config/recurring-costs.json` once.
 * - `amortized` — a prepaid annual term (a domain), spread over the twelve
 *   months it covers.
 * - `unclassified` — a row from before this vocabulary existed. Shown as itself
 *   rather than folded into a neighbour, because guessing which bucket a legacy
 *   row belongs to is how a total quietly stops adding up.
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
 * One row of `config/recurring-costs.json`, EXACTLY as the file holds it.
 *
 * The derived reads beside it (`costLines`, `properties`) answer "what booked";
 * this answers "what was declared", and it is the shape the Tower's own editor
 * writes back — so it may not be reshaped, reordered or enriched on the way
 * out. A row's position in the array is its ADDRESS (`/costs/3`), and the
 * `expect` a guarded write is refused against is the row itself.
 *
 * A `type`, NOT an `interface`, and it has to stay one: only a type alias gets
 * TypeScript's implicit index signature, which is what lets a row be handed
 * straight to the collection editor as the `JsonValue` it literally is. An
 * `interface` here compiles everywhere except the one line that matters.
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

/**
 * One row of `config/domain-costs.json`, EXACTLY as the file holds it — the
 * same contract, and the same reason, as `RecurringCost` above.
 */
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
  /**
   * The period the asset and cost breakdowns describe — NOT always the month
   * the reader is standing in (bead `ro-69vb`).
   *
   * Every row in this ledger arrives by import or by hand, so the first days of
   * a month hold none. Reading the current calendar month and nothing else made
   * an accounting page print $0.00 three times directly under a table showing
   * August at +$200.25 — the exact "zero versus not measured" confusion the
   * page exists to prevent, reproduced by the page itself.
   */
  period: string;
  /**
   * Every period the ledger holds a current row for, ascending — the months
   * this page can be asked to describe, and the options behind its selector.
   *
   * Same rows, same superseded-exclusion, as `months`: one query answers both,
   * so the selector can never offer a month the trajectory table does not have.
   */
  periods: string[];
  /**
   * False when `period` is not the calendar month the reader is standing in.
   *
   * The fallback is never silent — the header names the month and says it is
   * the latest one with rows. The same pair the Wall's ROI card ships
   * (`shared/wall.ts`, bead `ro-bdkp`), because it is the same rule.
   */
  periodIsCurrent: boolean;
  /**
   * The calendar month the reader is standing in on the operator's SAVED clock
   * (bead `ro-ujb9.88`) — the open month, whatever `period` shows. The page
   * reads it rather than working the month out in the browser, which has no
   * store to read the saved zone from.
   */
  currentPeriod: string;
  /** Oldest first, so the reader sees the trajectory in reading order. */
  months: FinancialMonth[];
  properties: FinancialProperty[];
  /** Asset #0's line, pulled out of `properties` for the two-tier read. */
  overhead: MoneyFigure;
  costLines: FinancialCostLine[];
  domains: DomainSchedule[];
  /**
   * THE TWO COST REGISTERS AS THEIR FILES HOLD THEM, IN FILE ORDER (bead
   * `ro-x5gu.2`).
   *
   * Everything else on this payload is derived — summed, sorted, amortized.
   * These two are not: they are what `/financials` EDITS, and a collection
   * editor addresses an array row by its index (`/costs/3`) and guards the
   * write with the row itself. Sorting them for presentation would silently
   * re-point every pointer at the wrong row, so the order here is the file's
   * and nothing may re-sort it.
   *
   * They also mean the page reads these files through the payload it already
   * fetches rather than opening a second read of a file it is already showing.
   */
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

/**
 * THE WORD ON THE CHIP, AND THE WHOLE EXPLANATION (bead `ro-ujb9.96.6.9`).
 *
 * The chips used to read Metered / Stated / Amortized / Unclassified — an
 * accountant's vocabulary — and each carried a one-to-two sentence tooltip
 * glossary to translate it. A label that needs a glossary is the wrong label:
 * these are the words the operator already uses for the same four things (a
 * per-use API bill, a monthly subscription, a domain paid for a year, a row
 * with no source), so the chip needs nothing behind it.
 */
export const PROVENANCE_LABEL: Readonly<Record<CostProvenance, string>> =
  Object.freeze({
    metered: "Usage",
    stated: "Subscription",
    amortized: "Prepaid yearly",
    unclassified: "No source",
  });

/**
 * `YYYY-MM`, and a real month number — the shape of every `?period=` this page
 * accepts.
 *
 * It lives in the shared contract rather than in the worker (bead `ro-dm67`)
 * because BOTH sides need it: the worker refuses a value that fails it, and the
 * page has to know whether the value it is naming back to the reader is a month
 * ("January 2020") or a typo (`“last-quarter”`).
 */
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
