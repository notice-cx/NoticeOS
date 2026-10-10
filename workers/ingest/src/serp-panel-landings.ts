// Which properties have a fresh weekly DataForSEO collection in the archive:
// the read the runner's review filer acts on. Nothing new is written: the
// manifest is the record of what landed, so a filer built on it is idempotent
// by construction. The anchor is the collection, not the panel: a property
// with no tracked panel still buys its other families and owes a review. The
// name (the route, this file, `panelDate`) stays, because `noticeos_panel_date`
// is the review task's metadata key and a contract with a rendered surface.
// One row per property, the newest complete collection day only: a complete
// weekly collection supersedes the one before it; a newer partial day does not.

import { dataForSeoReportsFor } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { readCollectorConfigs } from './config-store.js';
import serpPanelConfig from '../../../config/serp-panel.json';

/**
 * Which properties own a tracked-query panel, store-first: the roster decides
 * which families a collection day owed, and a property added in the product
 * must not be graded against the roster of the last deploy. Resolved per call
 * because module scope is fixed at build time; the reader's cache keeps that
 * cheap.
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
  /** The collection's `report_date`: the UTC day the property's families were
   * pulled, and the grain the whole convention is keyed on. */
  panelDate: string;
  /** When the last manifest row of that day was written. For display; not the
   * dedupe key. */
  landedAt: string;
  /** `success`, or `unchanged` only when every family that day was a re-fetch
   * whose bytes matched. Both mean the archive holds that day's collection. */
  status: string;
  /** Whether the tracked-query panel was one of the families that landed. */
  panel: boolean;
  /** Provider calls in the panel, one per (tracked query, device): the rows
   * the reviewer walks, or null when no panel landed. */
  queries: number | null;
  /** How many report families landed that day. */
  families: number;
  /** Those families by name. */
  reports: string[];
}

/**
 * How far back a landing still counts as actionable: three weekly collections,
 * wide enough that a runner down for a fortnight still files the review it
 * missed, narrow enough that a collector broken for a month does not hand
 * somebody a triage task about a stale result page.
 */
export const SERP_PANEL_LANDING_WINDOW_DAYS = 21;

export interface SerpPanelLandingsResult {
  windowDays: number;
  landings: SerpPanelLanding[];
}

/** The oldest collection day this read will report. */
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
 * The newest complete collection per property inside the window. The query
 * returns every candidate day newest-first, so if today's sweep stopped after
 * four families, yesterday's complete collection remains the review identity.
 * `MIN(status)` reports `success` whenever any family that day changed.
 * Completeness requires every family `dataForSeoReportsFor` says this property
 * owned on that day; that same answer supplies the `panel` flag.
 */
export async function readSerpPanelLandings(
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<SerpPanelLandingsResult> {
  const panels = await panelAssets(env);
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
    // Graded against what was due on this collection's day, not today's family
    // list: a family registered later was never owed by this row.
    const expected = dataForSeoReportsFor(row.asset, panels, row.panelDate);
    const landed = new Set(
      (row.reports ?? '').split(',').filter((report) => report.length > 0),
    );
    // Complete means every due family arrived: a superset test. An extra family
    // is one collected on a day it was not yet owed, or one since retired.
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
