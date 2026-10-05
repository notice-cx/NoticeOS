// Metered provider spend, counted from the OS's own evidence — never by
// calling a provider.
//
// Several surfaces read these and no page owns them: the Wall's SYSTEM band
// (today's DataForSEO spend against the day's share of the cap), the Health
// page's integration matrix and the budget meter on `/settings` (the month
// against the cap), and each provider card's budget line (`loadProviderMeter`,
// wired through the router into `integrations-route.ts`). They live here so no
// page builder has to import another page's payload module to state the same
// sum.
// Read from the call's store (`noticeos.archive_runs`, `noticeos.research_log`,
// bead ro-ujb9.76.5.4), so the tests run this exact SQL against a Postgres copy.

import type { WorkspaceStore } from "@noticeos/postgres";
import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PERIODIC_REPORTS,
  MAX_REPORT_COST_USD,
  METERED_DATA_PROVIDER,
  loadMeteredDataSpend as loadDataForSeoSpend,
  type AssetDayMeterReading,
  type IntegrationMeter,
  type MeteredSpendWindow as SpendWindow,
  type ProviderMeterReading,
  type SiteSpendPreview,
} from "@noticeos/contract";

/** The accounting period every reader of the metered month names it by,
 * 'YYYY-MM' and UTC — written once so the matrix's spend summary and a provider
 * card's budget line cannot label the same sum with two different months. */
export function utcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Metered spend on the one metered provider over ONE window — per asset, and
 * the portfolio total as their sum.
 *
 * THE BODY IS NOT HERE, and that is the point (bead `ro-ukus`). What the desk
 * draws has to be what the cap gate enforces, and while this page owned its own
 * SELECT the two could disagree — they did: this one summed the report runs
 * alone while the collector's gate summed those PLUS the research log, so every
 * meter on the desk under-reported by exactly the ad-hoc research an agent had
 * bought on the same account. A budget display that errs low is the one error a
 * budget display must not make. So the sum moved to `@noticeos/contract`,
 * where the Worker that spends the money and the Worker that draws it read one
 * body: `loadMeteredDataSpend`.
 *
 * The name stays because four surfaces and three docs point at it, and because
 * this module is where a Tower reader looks first.
 *
 * TWO WINDOWS, ONE SUM (bead `ro-sq42`). `/integrations` and `/settings` draw
 * the MONTH against the cap; the Wall's SYSTEM band draws TODAY against the
 * day's share of it. Those are different questions, so the Wall genuinely needs
 * its own reading — but a second function summing the same tables would be free
 * to disagree with this one, which is the defect `ro-4cm` closed inside the
 * monthly figure and `ro-qpas` refused to reopen across pages.
 *
 * GROUPED BY ASSET (bead `ro-4cm`) rather than summed flat: the cap is
 * portfolio-wide, but "is this asset worth what its data costs" cannot be
 * answered by a total. The headline is the sum of the groups plus the research
 * that names no property, so the split always adds up to it.
 */
export { loadDataForSeoSpend };
export type { SpendWindow };

/**
 * WHAT A METERED PROVIDER HAS SPENT TODAY, per asset (bead `ro-vu8d.25`).
 *
 * THE SAME ROWS THE SPEND SUMMARY ABOVE READS, and deliberately in the same
 * module: the report runs are the OS's own record of every call it made, so
 * "how much budget is left" is arithmetic over evidence already held rather than
 * a fresh provider call. On a ten-a-day cap a meter that called the provider
 * would be spending the thing it measures.
 *
 * ROWS, NOT `request_count`. That column carries the number of PAGES archived,
 * and a failed call archives none — so summing it would report a rejected token
 * or an exhausted cap as budget still available, which is the one direction a
 * quota display must not err in. The Clarity lane makes exactly one provider
 * call per manifest row (its module header is where that is written down), so a
 * row is a call whether it worked or not.
 *
 * UTC days, like the monthly figure above: the OS cannot know the provider's own
 * reset clock, and the card says which calendar it counted in rather than
 * implying it knows Clarity's.
 */
export async function loadMeteredCallsToday(
  store: WorkspaceStore,
  dataSource: string,
  now: Date,
): Promise<AssetDayMeterReading> {
  const day = now.toISOString().slice(0, 10);
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; calls: number }>(
      `SELECT asset_id AS asset, count(*)::int AS calls
         FROM noticeos.archive_runs
        WHERE integration = $1 AND requested_at >= $2::timestamptz
        GROUP BY asset_id`,
      [dataSource, `${day}T00:00:00.000Z`],
    ),
  );
  return {
    window: "asset-day",
    day,
    assets: rows
      .map((row) => ({ asset: row.asset, spent: Number(row.calls) || 0 }))
      .sort((a, b) => b.spent - a.spent || a.asset.localeCompare(b.asset)),
  };
}

/**
 * THE ONE READER A PROVIDER CARD ASKS FOR, whichever window the provider
 * meters (beads `ro-vu8d.25`, `ro-qpas`).
 *
 * Two metered providers, two ceilings, ONE representation each. Clarity's is
 * calls per asset per day and is counted above. DataForSEO's is dollars per
 * calendar month, and it is deliberately NOT a second sum: it calls
 * `loadDataForSeoSpend` — the same reader the Health page's spend summary and
 * `/settings`' budget meter already read — so the three surfaces cannot report
 * three different months. A second aggregate over the same rows would be free
 * to disagree with them by a float, which is the defect bead `ro-4cm` closed
 * inside that one figure and this would have reopened across pages.
 *
 * NEITHER BRANCH CALLS A PROVIDER. On a ten-a-day cap the meter would spend
 * what it measures; on a prepaid account it would ask a vendor a question the
 * OS's own archive already answers. What no branch can answer is DataForSEO's
 * account CREDIT — the probe is the only thing that reads it and nothing stores
 * it — so the card names that as a separate number rather than showing a stale
 * one (bead `ro-qpas`).
 */
export async function loadProviderMeter(
  store: WorkspaceStore,
  meter: IntegrationMeter,
  now: Date,
  capUsd: number,
): Promise<ProviderMeterReading> {
  if (meter.window === "portfolio-month") {
    const { spentUsd, unknownPrices } = await loadDataForSeoSpend(store, now);
    return { window: "portfolio-month", period: utcMonth(now), spentUsd, unknownPrices, capUsd };
  }
  return loadMeteredCallsToday(store, meter.countedFrom, now);
}

/** How far back a site's recorded weekly cost is averaged: four weekly sweeps,
 * so one monthly family (every 28 days) is counted once in the average. */
const SPEND_PREVIEW_DAYS = 28;

/**
 * WHAT STARTING A METERED PROVIDER WILL COST, before the press (bead
 * `ro-ujb9.96.7.2`). DataForSEO is paid per report, so the connect panel shows
 * this beside Start and nothing is bought without the press.
 *
 * EVERY FIGURE IS THE OS'S OWN RECORD. The month's spend and cap are the same
 * reader the cap gate sums (`loadDataForSeoSpend`). The typical week is one
 * site's recorded report costs per report date, averaged over the last four
 * sweeps — null when nothing has been recorded yet, never an invented price.
 * The ceiling is what the lane's budget gate reserves before each report
 * (`MAX_REPORT_COST_USD`) times every family it may collect, so "at most" is a
 * figure the lane enforces rather than a guess.
 */
export async function loadSpendPreview(
  store: WorkspaceStore,
  now: Date,
  capUsd: number,
): Promise<SiteSpendPreview> {
  const { spentUsd, unknownPrices } = await loadDataForSeoSpend(store, now);
  const since = new Date(now.getTime() - SPEND_PREVIEW_DAYS * 86_400_000).toISOString();
  // A report date whose every price is unknown recorded no spend: 0, as D1's
  // zeros summed to.
  const weeks = (
    await store.read((tx) =>
      tx.query<{ spent: string | null }>(
        `SELECT SUM(cost_usd)::text AS spent
           FROM noticeos.archive_runs
          WHERE integration = $1 AND requested_at >= $2::timestamptz
          GROUP BY asset_id, report_date`,
        [METERED_DATA_PROVIDER, since],
      ),
    )
  ).map((row) => Number(row.spent) || 0);
  const families = DATAFORSEO_BASE_REPORTS.length + DATAFORSEO_PERIODIC_REPORTS.length + 1;
  return {
    period: utcMonth(now),
    spentUsd,
    unknownPrices,
    capUsd,
    perSiteWeekUsd: weeks.length === 0 ? null : weeks.reduce((sum, value) => sum + value, 0) / weeks.length,
    perSiteCeilingUsd: families * MAX_REPORT_COST_USD,
  };
}
