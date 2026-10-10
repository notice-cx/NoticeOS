// The DataForSEO family contract shared by the collector and every read model:
// a collection is complete only when it contains exactly the families this
// module names for the property. The family names live in the portable
// signal-families module, which plain-Node scripts import too.

import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PANEL_REPORT,
  DATAFORSEO_PERIODIC_REPORTS,
} from './signal-families.mjs';

export { DATAFORSEO_BASE_REPORTS, DATAFORSEO_PANEL_REPORT, DATAFORSEO_PERIODIC_REPORTS };

/**
 * The market a site's DataForSEO families ask in — its own saved one, or the
 * baseline — re-exported from the portable module the plain-Node analyzer can
 * import.
 */
export { DATAFORSEO_BASELINE_MARKET, marketLabel, savedSearchMarket, type SearchMarket } from './search-market.mjs';

export const DATAFORSEO_WEEKLY_CADENCE_DAYS = 7;
/**
 * Four weeks, not a calendar month: the sweep runs weekly, so a cadence that
 * drifted against the weekday would make a family due on a day nothing
 * collects.
 */
export const DATAFORSEO_MONTHLY_CADENCE_DAYS = 28;

export type DataForSeoReport =
  | (typeof DATAFORSEO_BASE_REPORTS)[number]
  | (typeof DATAFORSEO_PERIODIC_REPORTS)[number]
  | typeof DATAFORSEO_PANEL_REPORT;

/**
 * The first `report_date` each family could have been collected on. The read
 * models that grade a stored collection complete compare it against the
 * families due on its own date, so adding a family does not make every older
 * collection short retroactively.
 *
 * Only families registered after the collector shipped are listed: an absent
 * family is a founding one, owed by every stored collection. The failure mode
 * of a map of exceptions is over-strict, never silently green.
 */
export const DATAFORSEO_REPORT_AVAILABLE_FROM: Readonly<
  Partial<Record<DataForSeoReport, string>>
> = Object.freeze({
  // Dated to the day after the family was added: a family cannot be owed by a
  // sweep that finished before it was registered.
  'backlinks-referring-domains': '2026-09-01',
  'backlinks-anchors': '2026-09-01',
});

/**
 * The exact weekly family set for one property, in collector order — the
 * identity a stored `report_date` is graded complete against. Periodic
 * families are excluded. What a property may be requested for is the
 * collector's `dataForSeoFamiliesFor`, which reads the REPORTS registry.
 *
 * `reportDate` asks what was due on a given day: families registered after it
 * are excluded. Omit it to ask what is due now.
 */
export function dataForSeoReportsFor(
  asset: string,
  panelAssets: ReadonlySet<string>,
  reportDate?: string | null,
): DataForSeoReport[] {
  const all: DataForSeoReport[] = panelAssets.has(asset)
    ? [...DATAFORSEO_BASE_REPORTS, DATAFORSEO_PANEL_REPORT]
    : [...DATAFORSEO_BASE_REPORTS];
  if (!reportDate) return all;
  // A malformed date must not shrink the expected set to nothing and declare
  // every collection complete. ISO dates compare lexically.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return all;
  return all.filter((report) => {
    const from = DATAFORSEO_REPORT_AVAILABLE_FROM[report];
    // Unlisted is a founding family: always due.
    return from === undefined || from <= reportDate;
  });
}


// What a tracked-query panel costs: the money facts the collector's budget
// gate and the Tower's panel surface both read, so the two cannot disagree
// about a price.

/** What the budget gate reserves for one report family before it calls. The
 * panel's query ceiling is derived from it. */
export const MAX_REPORT_COST_USD = 0.25;

/**
 * The devices every tracked query is collected on, in call order. Both,
 * because a phone result page is not a narrower desktop one: click-consuming
 * blocks appear on different queries. The order is not a contract: readers
 * that reduce the family to one row per query name the device they read
 * (`PANEL_SNAPSHOT_DEVICE` in `scripts/signal-insights.mjs`). `device` is a
 * documented request field, archived verbatim with every page.
 */
export const SERP_PANEL_DEVICES = ['mobile', 'desktop'] as const;

/** The quoted price of one live/advanced SERP call. The quoted figure, not
 * the lower observed one: a ceiling built on the cheaper number would let the
 * family outspend its reserve on a normal week. */
export const SERP_PANEL_CALL_USD = 0.004;

/**
 * How many terms a panel may track: exactly what one report's reserve buys,
 * derived rather than chosen, so adding a device halves it and raising it is
 * a decision about `MAX_REPORT_COST_USD`. The collector enforces it.
 */
export const SERP_PANEL_QUERY_LIMIT = Math.floor(
  MAX_REPORT_COST_USD / (SERP_PANEL_DEVICES.length * SERP_PANEL_CALL_USD),
);

/** What one tracked term costs per weekly sweep: one metered result page per
 * device. The one place a surface reads "what does adding a query cost". */
export const SERP_PANEL_TERM_WEEKLY_USD = SERP_PANEL_DEVICES.length * SERP_PANEL_CALL_USD;
