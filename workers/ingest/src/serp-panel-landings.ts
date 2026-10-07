// Which properties have a fresh weekly DataForSEO collection in the archive —
// the read the runner's review filer acts on (scripts/runner/panel-review.mjs, doc 08 §S1b).
//
// The collector already records every collection as one report run
// (`noticeos.archive_runs`) per property per report family per run
// (`integration = 'dataforseo'`). Nothing new is written for this lane: the manifest IS the
// record of what landed, so a filer built on it is idempotent by construction —
// it re-derives the same (asset, collection day) pair every pass and files
// against a spoke that already knows whether it holds that review.
//
// THE ANCHOR IS THE COLLECTION, NOT THE PANEL (ro-478). This read used to answer
// only about `report = 'serp-panel'`, which meant a property with no entry in
// config/serp-panel.json never landed anything here and so never owed a review —
// even though it buys five report families every Monday. That was defensible
// while the review's scope WAS the panel; ro-540.2 widened the scope to the
// week's whole collection, and a trigger narrower than the scope is how
// three assets with no panel ended up buying
// collections nobody was ever asked to read. The panel is now one family of the
// collection this reports, so a property that has one is unaffected: its panel
// and its other five families share a `report_date`, so the day this returns is
// the day the old query returned, and every review already filed still dedupes.
//
// The name — the route, this file, the `panelDate` field — stays put on purpose.
// `noticeos_panel_date` is the review bead's metadata key and a contract with a
// rendered surface (the Tower's panel-review marker), so the vocabulary is frozen
// at the far end; keeping one word for one thing end to end beats a wire field
// that disagrees with the metadata it becomes.
//
// One row per property, the newest COMPLETE collection day only. A complete
// weekly collection supersedes the one before it; a newer partial day does not.
// Asking an operator to triage mixed-date evidence is worse than keeping the
// last coherent review identity until the missing families land.

import { dataForSeoReportsFor } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { readCollectorConfigs } from './config-store.js';
import serpPanelConfig from '../../../config/serp-panel.json';

/**
 * Which properties own a tracked-query panel, store-first (bead `ro-syok.7`).
 *
 * The panel roster decides which report families a collection day OWED, so a
 * property added to `config/serp-panel.json` in the product and read from a
 * bundle here would be graded against the roster of the last deploy. It comes
 * through the one collector reader; `undefined` from it means the store holds
 * nothing usable, and the copy compiled into this Worker answers unchanged.
 *
 * Resolved per call rather than at module scope for the same reason the rest of
 * this bead exists: module scope is fixed at build time, which is the state this
 * is undoing. The reader's own one-second cache is what keeps that cheap.
 */
async function panelAssets(env: IngestEnv): Promise<Set<string>> {
  const { documents } = await readCollectorConfigs(env, ['config/serp-panel.json']);
  const stored = documents['config/serp-panel.json'] as
    | { assets: Record<string, unknown> }
    | undefined;
  return new Set(Object.keys((stored ?? serpPanelConfig).assets));
}

/** A landed collection, as the runner reads it. */
export interface SerpPanelLanding {
  asset: string;
  /** The collection's `report_date` — the UTC day the property's families were
   * pulled, and the grain the whole convention is keyed on
   * (`noticeos_panel_date`, the review bead's title, the filer's dedupe). */
  panelDate: string;
  /** When the last manifest row of that day was written. Strictly later than
   * `panelDate`'s midnight and carried for display; it is NOT the dedupe key,
   * because every row of one collection day is one landing. */
  landedAt: string;
  /** `success`, or `unchanged` only when EVERY family that day was a re-fetch
   * whose bytes matched what was already stored. Both mean the archive holds
   * that day's collection. */
  status: string;
  /** Whether the S1b tracked-query panel was one of the families that landed —
   * i.e. whether this property has an entry in config/serp-panel.json. The
   * review the filer writes asks for the panel walk only when this is true. */
  panel: boolean;
  /** Provider calls in the panel — how big the panel a reviewer is being handed
   * actually is, or null when no panel landed.
   *
   * It was one call per tracked query until ro-o1n added the phone; it is now one
   * per (tracked query, device), so it counts the ROWS the reviewer walks in
   * `dataforseo-serp-panel.csv` rather than the terms in
   * `config/serp-panel.json` — 56 for a 28-term panel. That is the honest number
   * for the work, and it is what the manifest can say without a column of its
   * own; the review bead's wording still calls them "tracked queries", which
   * `ro-1b0.3` corrects on the filer's side. */
  queries: number | null;
  /** How many report families landed that day. The evidence that something was
   * bought at all, and what the review is being asked to cover. */
  families: number;
  /** Those families by name: what a published panel must hold before the
   * filer asks anybody to read it (epic ro-cvl9). */
  reports: string[];
}

/**
 * How far back a landing still counts as actionable.
 *
 * Three weekly collections. Wide enough that a runner down for a fortnight
 * still files the review it missed (the catch-up case this window exists for),
 * narrow enough that a collector broken for a month does not eventually hand
 * somebody a triage task about a stale result page. A collection older than this
 * with no review filed is a different problem — a collection lane that stopped
 * — and belongs to the hygiene guard, not to this read.
 */
export const SERP_PANEL_LANDING_WINDOW_DAYS = 21;

export interface SerpPanelLandingsResult {
  windowDays: number;
  landings: SerpPanelLanding[];
}

/** The oldest collection day this read will report, as the YYYY-MM-DD the
 * manifest stores. */
export function serpPanelLandingCutoff(nowMs: number): string {
  return new Date(nowMs - SERP_PANEL_LANDING_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** One collection day, as the store hands it back before the flags are typed. */
type LandingRow = {
  asset: string;
  panelDate: string;
  landedAt: string;
  status: string;
  reports: string | null;
  queries: number | null;
};

/**
 * The newest COMPLETE collection per property inside the window.
 *
 * Grouped by (asset, day) before TypeScript compares its report names with the
 * collector's own registry. The query intentionally returns every candidate day
 * newest-first: if today's sweep stopped after four families, yesterday's last
 * complete collection remains the review identity instead of disappearing.
 *
 * `MIN(status)` reports `success` whenever any family that day actually changed
 * ('success' sorts before 'unchanged'), so a collection is only called unchanged
 * when all of it was.
 *
 * `error` rows are excluded because nothing landed. That is not enough on its
 * own: four successes plus one error is still partial. Completeness requires
 * EXACTLY the families `dataForSeoFamiliesFor(asset)` says this property owns,
 * including `serp-panel` for config/serp-panel.json members. That same answer
 * supplies the `panel` flag, so the filer's noun cannot disagree with config.
 */
export async function readSerpPanelLandings(
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<SerpPanelLandingsResult> {
  const panels = await panelAssets(env);
  // On Postgres (bead ro-ujb9.76.5.4); text compared byte by byte, as D1 did.
  const found = await env.STORE.read((tx) =>
    tx.query<LandingRow>(
      `SELECT asset_id AS asset,
              report_date AS "panelDate",
              max(finished_at) AS "landedAt",
              min(status COLLATE "C") AS status,
              string_agg(DISTINCT report, ',') AS reports,
              max(CASE WHEN report = 'serp-panel' THEN request_count END) AS queries
         FROM noticeos.archive_runs
        WHERE integration = 'dataforseo'
          AND status IN ('success','unchanged')
          AND report_date >= $1::date
        GROUP BY asset_id, report_date
        ORDER BY asset_id COLLATE "C", report_date DESC`,
      [serpPanelLandingCutoff(nowMs)],
    ),
  );
  const rows = found.map((row) => ({ ...row, landedAt: javascriptInstant(row.landedAt) }));

  const selected = new Set<string>();
  const landings: SerpPanelLanding[] = [];
  for (const row of rows) {
    if (selected.has(row.asset)) continue;
    // Graded against what was due on THIS collection's day, not on today's
    // family list — a family registered later was never owed by this row
    // (ro-cda6.1). Without the date the filer would stop recognising every
    // landing stored before the newest family shipped, and silently stop
    // filing reviews for collections that were complete when they ran.
    const expected = dataForSeoReportsFor(row.asset, panels, row.panelDate);
    const landed = new Set(
      (row.reports ?? '').split(',').filter((report) => report.length > 0),
    );
    // Complete means EVERY DUE FAMILY ARRIVED — a superset test, not set
    // equality. An extra family is not an incompleteness: it is a family
    // collected on a day it was not yet owed (the boundary run on the day one
    // is registered) or one since retired. Equality called both of those a torn
    // week, which is the opposite of what the row shows.
    if (!expected.every((report) => landed.has(report))) continue;
    const panel = expected.includes('serp-panel');
    selected.add(row.asset);
    landings.push({
      asset: row.asset,
      panelDate: row.panelDate,
      landedAt: row.landedAt,
      status: row.status,
      panel,
      queries: panel ? row.queries : null,
      families: expected.length,
      reports: [...expected],
    });
  }

  return {
    windowDays: SERP_PANEL_LANDING_WINDOW_DAYS,
    landings,
  };
}
