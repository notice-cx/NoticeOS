// Metered provider spend, counted from the OS's own evidence (the report runs
// and the research log) — never by calling a provider, which on a capped plan
// would spend what it measures. The Wall, Health, `/settings` and each
// provider card read these, so no page states the same sum its own way.

import type { WorkspaceStore } from "@noticeos/postgres";
import type { DataSpendSummary } from "../shared/integrations";
import {
  DATAFORSEO_BASE_REPORTS,
  DATAFORSEO_PANEL_REPORT,
  DATAFORSEO_PERIODIC_REPORTS,
  MAX_REPORT_COST_USD,
  METERED_DATA_PROVIDER,
  loadMeteredDataBudget,
  loadMeteredDataSpend,
  meteredSpendBounds,
  summarizeMeteredDataSpend,
  type AssetDayMeterReading,
  type IntegrationMeter,
  type MeteredSpendWindow as SpendWindow,
  type MeteredSpendRow,
  type ProviderMeterReading,
  type SiteSpendPreview,
} from "@noticeos/contract";

/** The accounting month every reader of the metered month names, 'YYYY-MM' UTC. */
export function utcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Metered spend on the one metered provider over one window (the month, or the
 * Wall's today), per asset and in total. The body is `loadMeteredDataSpend` in
 * `@noticeos/contract`, the same sum the collector's cap gate enforces, so the
 * desk can never under-report. The headline is the sum of the asset groups plus
 * the research that names no property.
 */
export async function loadDataForSeoSpend(store: WorkspaceStore, now: Date, window: SpendWindow = 'month', backupPreview = false) {
  if (backupPreview) {
    const [since, until] = meteredSpendBounds(now, window).map(bound => bound.slice(0, 10));
    const rows = await store.read(async tx => {
      const [projection] = await tx.query<{ present: boolean }>(`SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_schema='noticeos_shadow' AND table_name='metered_spend'
      ) AS present`);
      return projection?.present ? tx.query<MeteredSpendRow>(`
        SELECT asset_id AS asset, SUM(spent_usd)::text AS spent, SUM(unknown_prices)::text AS unknown
        FROM noticeos_shadow.metered_spend WHERE day >= $1::date AND day < $2::date GROUP BY asset_id`, [since!, until!]) : null;
    });
    if (rows) return summarizeMeteredDataSpend(rows);
  }
  return loadMeteredDataSpend(store, now, window);
}
export type { SpendWindow };

/** Backup projections carry past bills only. No purchasing balance is inferred from them. */
export async function loadDataForSeoMonth(store: WorkspaceStore, now: Date, capUsd: number, backupPreview = false): Promise<DataSpendSummary> {
  return {
    period: utcMonth(now),
    ...(backupPreview ? { ...await loadDataForSeoSpend(store, now, 'month', true), capUsd }
      : await loadMeteredDataBudget(store, now, capUsd)),
  };
}

/**
 * What a call-metered provider has spent today, per asset. Counts rows, not
 * `request_count`: that column is pages archived and a failed call archives
 * none, which would report an exhausted cap as budget left. The Clarity lane
 * makes one provider call per manifest row. UTC days: the OS cannot know the
 * provider's reset clock, and the card names the calendar it counted in.
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
 * The one reader a provider card asks for, whichever window the provider
 * meters: Clarity's calls per asset per day, or DataForSEO's dollars per month
 * through `loadDataForSeoSpend`, the reader Health and `/settings` use. Neither
 * branch calls a provider, so DataForSEO's account credit (read only by the
 * probe, never stored) stays a separate number on the card.
 */
export async function loadProviderMeter(
  store: WorkspaceStore,
  meter: IntegrationMeter,
  now: Date,
  capUsd: number,
  backupPreview = false,
): Promise<ProviderMeterReading> {
  if (meter.window === "portfolio-month") {
    const { spentUsd, unknownPrices, capUsd: effectiveCap, period, budget } = await loadDataForSeoMonth(store, now, capUsd, backupPreview);
    return { window: "portfolio-month", period, spentUsd, unknownPrices, capUsd: effectiveCap, ...(budget ? { budget } : {}) };
  }
  return loadMeteredCallsToday(store, meter.countedFrom, now);
}

/** How far back a site's recorded weekly cost is averaged: four weekly sweeps,
 * so one monthly family (every 28 days) is counted once in the average. */
const SPEND_PREVIEW_DAYS = 28;

/**
 * What starting a metered provider will cost, shown beside Start before
 * anything is bought, and what collecting one site's panel again will cost.
 * Every figure is the OS's own record: the month's spend
 * and cap are the reader the cap gate sums (`loadDataForSeoSpend`). The
 * typical week is one site's recorded report costs per report date, averaged
 * over the last four sweeps — null when nothing has been recorded yet, never
 * an invented price.
 * The ceiling is what the lane's budget gate reserves before each report
 * (`MAX_REPORT_COST_USD`) times every family it may collect, so "at most" is a
 * figure the lane enforces rather than a guess.
 */
export async function loadSpendPreview(
  store: WorkspaceStore,
  now: Date,
  capUsd: number,
): Promise<SiteSpendPreview> {
  const { spentUsd, unknownPrices, capUsd: effectiveCap, budget } = await loadMeteredDataBudget(store, now, capUsd);
  const since = new Date(now.getTime() - SPEND_PREVIEW_DAYS * 86_400_000).toISOString();
  // A report date whose every price is unknown recorded no spend: 0.
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
  // Each site's last panel run prices collecting its panel again now.
  const panelRuns = await store.read((tx) =>
    tx.query<{ asset: string; report_date: string; cost_usd: string | null }>(
      `SELECT DISTINCT ON (asset_id) asset_id AS asset, report_date::text AS report_date, cost_usd::text AS cost_usd
         FROM noticeos.archive_runs
        WHERE integration = $1 AND report = $2 AND status IN ('success', 'unchanged')
        ORDER BY asset_id, requested_at DESC, run_seq DESC`,
      [METERED_DATA_PROVIDER, DATAFORSEO_PANEL_REPORT],
    ),
  );
  const families = DATAFORSEO_BASE_REPORTS.length + DATAFORSEO_PERIODIC_REPORTS.length + 1;
  return {
    period: utcMonth(now),
    spentUsd,
    unknownPrices,
    capUsd: effectiveCap,
    budget,
    perSiteWeekUsd: weeks.length === 0 ? null : weeks.reduce((sum, value) => sum + value, 0) / weeks.length,
    perSiteCeilingUsd: families * MAX_REPORT_COST_USD,
    panelRuns: Object.fromEntries(panelRuns.map((row) => [row.asset, {
      reportDate: row.report_date,
      costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    }])),
  };
}
