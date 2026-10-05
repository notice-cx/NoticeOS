// The DataForSEO family contract shared by the collector and every read model.
//
// A collection is coherent only when it contains exactly the families this
// module names for the property. Keeping the vocabulary here prevents the
// provider writer, review filer, integration light and Wall marker from each
// inventing their own meaning of "the weekly collection".

export const DATAFORSEO_BASE_REPORTS = [
  'ranked-keywords',
  'backlinks-summary',
  'backlinks-new-lost',
  'backlinks-referring-domains',
  'backlinks-anchors',
  'llm-mentions-google',
  'llm-mentions-chatgpt',
] as const;

export const DATAFORSEO_PANEL_REPORT = 'serp-panel' as const;

/**
 * Families on a slower-than-weekly cadence — collected by the same sweep, and
 * deliberately NOT part of the weekly collection identity above (ro-cda6.2).
 *
 * WHY THEY ARE SEPARATE. `DATAFORSEO_BASE_REPORTS` is what three read models
 * grade a `report_date` COMPLETE against. A 28-day family is legitimately
 * absent from three `report_date`s out of four, so listing it there would call
 * three weeks in four torn — the same retroactive-accusation failure the
 * availability map exists to prevent, arriving through the other door.
 *
 * "Was this week whole" and "what may this property be asked for" are two
 * questions. They had one answer while every family shared one cadence.
 */
export const DATAFORSEO_PERIODIC_REPORTS = [
  'keyword-ideas',
  'serp-competitors',
] as const;

/**
 * The market a site's DataForSEO families ask in — its own saved one, or the
 * baseline — and that market in words: one rule the collector
 * (workers/ingest/src/lane-mapping.ts), the findings (scripts/signal-insights.mjs)
 * and the Tower read, from the portable module the plain-Node analyzer can
 * import (bead ro-ujb9.207).
 */
export { DATAFORSEO_BASELINE_MARKET, marketLabel, savedSearchMarket, type SearchMarket } from './search-market.mjs';

export const DATAFORSEO_WEEKLY_CADENCE_DAYS = 7;
/**
 * Four weeks, not a calendar month: the sweep runs on Mondays, so a cadence
 * that drifted against the weekday would make a family due on a day nothing
 * collects and then a week late. 28 is the shortest interval that is both a
 * whole number of sweeps and long enough that the answer has changed.
 */
export const DATAFORSEO_MONTHLY_CADENCE_DAYS = 28;

export type DataForSeoReport =
  | (typeof DATAFORSEO_BASE_REPORTS)[number]
  | (typeof DATAFORSEO_PERIODIC_REPORTS)[number]
  | typeof DATAFORSEO_PANEL_REPORT;

/**
 * The first `report_date` each family could have been collected on.
 *
 * WHY THIS EXISTS. Three read models judge a stored collection COMPLETE by
 * comparing the families it contains against the families this module names:
 * the Wall's panel-landing filer (`loadLatestPanelLandings`), the integrations
 * lane (`aggregateDataForSeoRuns`) and the review filer
 * (`readSerpPanelLandings`). All three ask "how many were due?" and all three
 * used to get a portfolio constant back.
 *
 * That constant is only correct for TODAY. Adding a family on 2026-08-31 makes
 * every collection ever stored two families short, retroactively: the panel
 * filer stops recognising any landing and stops filing reviews, and every
 * property's integration light turns amber for families that did not exist when
 * those rows were written. The collector would be accused of missing something
 * nobody had asked it for.
 *
 * So "what was due" is a question about a DATE, not about the portfolio.
 *
 * WHY THE FOUNDING FAMILIES ARE NOT LISTED. This map holds only families
 * registered AFTER the collector shipped; an absent family is a founding one,
 * has no "before", and is therefore owed by every stored collection. Dating the
 * founders to their real first `report_date` (2026-07-30 in `signal_dump_runs`)
 * would add no protection — nothing was stored before them — while making any
 * collection dated earlier owe NOTHING, which reads as complete. A map of
 * exceptions cannot fail that way: the failure mode is over-strict rather than
 * silently green.
 *
 * `serp-panel` is deliberately absent too, though it shipped one day after the
 * rest. Listing it would change how a single real collection (2026-07-30, long
 * outside the landing window) is graded, in exchange for nothing.
 */
export const DATAFORSEO_REPORT_AVAILABLE_FROM: Readonly<
  Partial<Record<DataForSeoReport, string>>
> = Object.freeze({
  // Added 2026-08-31 (ro-cda6.1). Dated to the day AFTER, because 2026-08-31
  // already carries a completed collection of the older families: a family
  // cannot be owed by a sweep that finished before it was registered.
  'backlinks-referring-domains': '2026-09-01',
  'backlinks-anchors': '2026-09-01',
});

/**
 * The exact WEEKLY family set for one property, in collector order — the
 * identity a stored `report_date` is graded complete against.
 *
 * Periodic families are excluded by construction; see
 * `DATAFORSEO_PERIODIC_REPORTS`. To ask what a property may be REQUESTED for
 * rather than what a week owes, ask the collector's `dataForSeoFamiliesFor` —
 * it reads the REPORTS registry and its per-family `appliesTo`, which is the
 * only authority on that question and cannot drift from a copy here.
 *
 * `reportDate` asks what was due ON A GIVEN DAY — pass the `report_date` of the
 * collection being judged, and families registered after it are excluded. Omit
 * it to ask what is due NOW.
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
  // A malformed or unparseable date must not silently shrink the expected set
  // to nothing and declare every collection complete. ISO dates compare
  // lexically, so the guard is a shape check rather than a parse.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) return all;
  return all.filter((report) => {
    const from = DATAFORSEO_REPORT_AVAILABLE_FROM[report];
    // Unlisted is a founding family: always due (see the map's comment).
    return from === undefined || from <= reportDate;
  });
}


// ---------------------------------------------------------------------------
// What a tracked-query panel COSTS — the money facts two workspaces need
// ---------------------------------------------------------------------------
//
// These lived in `workers/ingest/src/dataforseo-dumps.ts`, beside the budget
// gate that spends them, and that was right while the collector was the only
// reader. It stopped being right when the Tower's Growth tab gained the panel's
// CRUD surface (bead `ro-x5gu.4`): an operator adding a tracked term is
// committing the portfolio to a recurring metered bill, and a surface that
// cannot state the bill is asking for a spend decision without the number.
//
// The collector still owns the DECISION — it enforces the ceiling and it is
// where raising the reserve is argued (config/serp-panel.README.md) — and it
// re-exports these so nothing that already imported them had to move. What
// moved is only where the values are written down, from a Worker's source file
// to the contract both a Worker and the Tower already depend on. A second copy
// in the Tower would have been a price the two halves could disagree about.

/**
 * What the budget gate reserves for ONE report family before it calls. The
 * panel's query ceiling is derived from it, and a test asserts that derivation
 * against this number rather than against a copy.
 */
export const MAX_REPORT_COST_USD = 0.25;

/**
 * The devices every tracked query is collected on, in call order (`ro-o1n`,
 * operator's "Yes" on 2026-08-04).
 *
 * WHY BOTH. Most food/health search happens on a phone, and a phone result page
 * is not a narrower desktop one: AI Overviews and other click-consuming blocks
 * appear there on different queries. "Is this click consumed?" is the question
 * this family exists to answer, and a desktop-only panel was asking it where the
 * traffic is not.
 *
 * WHY DESKTOP IS LAST. A query's two calls sit side by side in the archive with
 * the desktop one as the last word on that term, which is how the archive reads
 * in the order a person would ask about it. It is deliberately NOT a contract:
 * the executive snapshot's two panel readers each reduce the family to one row
 * per query and break ties in OPPOSITE directions (one keeps the first, one the
 * last), so no call order could have satisfied both. They name the device they
 * read instead — `PANEL_SNAPSHOT_DEVICE` in `scripts/signal-insights.mjs`. A
 * device dimension must not change what an existing rule means as a side effect
 * of being collected, and the place to guarantee that is the reader, not the
 * call order.
 *
 * `device` is a documented request field, so it is archived verbatim with every
 * page and the flattener reads it back off the stored request: the archive
 * records the device with the observation, and no manifest column had to change.
 */
export const SERP_PANEL_DEVICES = ['mobile', 'desktop'] as const;

/**
 * Observed price of one live/advanced SERP call — $0.004 quoted, ~$0.0035 seen
 * on the real runs. The quoted figure is used because a ceiling built on the
 * cheaper number would let the family outspend its reserve on a normal week.
 */
export const SERP_PANEL_CALL_USD = 0.004;

/**
 * How many terms a panel may track — **derived from the per-family reserve, not
 * chosen.**
 *
 * doc 08 §S1b sized the panel at 10–25 head terms; it was raised to a hand-set 40
 * on 2026-08-01 when the cluster-discovery rules earned tracked terms of their own
 * (water intake, weight-loss percentage, ffmi). A hand-set number was safe while a
 * term cost one call: 40 × $0.004 = $0.16, inside the $0.25 the budget gate
 * reserves before every family. With two devices a term costs two calls, and 40
 * terms would cost $0.32 — a family that quietly outspends the reserve its own gate
 * took, which is how a portfolio cap gets crossed by calls nobody reserved for.
 *
 * So the ceiling is exactly what one report's reserve buys: 31 terms (62 calls,
 * $0.248). Adding a device halves it, and raising it is a decision about
 * `MAX_REPORT_COST_USD` — i.e. about money — instead of a number someone can
 * nudge. The collector enforces it, so a panel still cannot raise its own limit.
 */
export const SERP_PANEL_QUERY_LIMIT = Math.floor(
  MAX_REPORT_COST_USD / (SERP_PANEL_DEVICES.length * SERP_PANEL_CALL_USD),
);

/** What one tracked term costs every Monday: one metered result page per device.
 * The single place a surface reads "what does adding a query cost", so the Add
 * control and the collector's own ceiling are priced off one number. */
export const SERP_PANEL_TERM_WEEKLY_USD = SERP_PANEL_DEVICES.length * SERP_PANEL_CALL_USD;
