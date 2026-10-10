// The weekly review obligation behind an asset's panel-review marker: the
// newest DataForSEO collection each asset has landed, and the review task the
// task-hub snapshot holds for it. The Wall card and the asset page both compose
// these readers so they word and gate one obligation identically; the state
// rule is `panelReviewState` in `shared/wall.ts`.

import { dataForSeoReportsFor } from "@noticeos/contract";
import type { WorkspaceStore } from "@noticeos/postgres";
import type { BeadsSnapshot } from "./beads-snapshot";
import type { PanelReview } from "../shared/wall";

const MS_PER_DAY = 86_400_000;

/** The panel-review half of a task-hub snapshot (the same photograph the Wall
 * card's work widget reads), keyed by asset id. A project the poller could not
 * read, or a snapshot without the field, becomes `panelReview: null`, which
 * renders nothing.
 *
 * `panelAssets` (config/serp-panel.json's keys) picks only the noun the marker
 * states the obligation in; a panel-less asset owes the same weekly read.
 * `asset` narrows to one asset. */
export function cardPanelReviewsOf(
  snapshot: BeadsSnapshot | null,
  panelAssets: ReadonlySet<string>,
  asset?: string,
): Map<string, PanelReview> {
  const out = new Map<string, PanelReview>();
  if (!snapshot) return out;
  for (const project of snapshot.projects) {
    if (asset !== undefined && project.asset !== asset) continue;
    if (project.panelReview) {
      out.set(project.asset, {
        ...project.panelReview,
        panel: panelAssets.has(project.asset),
      });
    }
  }
  return out;
}

/**
 * How long a landed collection still counts as one somebody can be asked to
 * read: three weekly collections. Must equal `SERP_PANEL_LANDING_WINDOW_DAYS`
 * in `workers/ingest/src/serp-panel-landings.ts`, the filer's window, so the
 * Tower marks exactly the landings the filer writes reviews for
 * (`apps/tower/test/wall-payload.test.ts` asserts it).
 */
export const PANEL_LANDING_WINDOW_DAYS = 21;

/**
 * The newest weekly DataForSEO collection day each asset has landed — the day
 * a finished review has to be about for it to still count. The anchor is the
 * whole collection, not the SERP panel family, so a panel-less asset still owes
 * its review.
 *
 * A day lands only when every family due that day succeeded or proved
 * unchanged (the writer's exact predicate); a partial sweep is not reviewable.
 * Candidate days order by `report_date`, not `finished_at`: a re-archive of an
 * older collection writes a later `finished_at` and would otherwise un-review a
 * current card. Bounded by the landing window; sites and days sort byte by byte.
 *
 * `asset` narrows this query itself: a filtered copy of the SQL could diverge
 * and un-review one surface's card and not the other's.
 */
export async function loadLatestPanelLandings(
  store: WorkspaceStore,
  nowMs: number,
  panelAssets: ReadonlySet<string>,
  asset?: string,
): Promise<Map<string, string>> {
  const cutoff = new Date(nowMs - PANEL_LANDING_WINDOW_DAYS * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; panelDate: string | null; reports: string | null }>(
      `SELECT d.asset_id AS asset,
              d.report_date AS "panelDate",
              string_agg(DISTINCT d.report, ',') AS reports
         FROM noticeos.assets a
         JOIN noticeos.archive_runs d
           ON d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id
          AND d.integration = 'dataforseo'
          AND d.status IN ('success', 'unchanged')
          AND d.report_date >= $1::date
        ${asset ? "WHERE a.asset_id = $2" : ""}
        GROUP BY d.asset_id, d.report_date
        ORDER BY d.asset_id COLLATE "C", d.report_date DESC`,
      asset ? [cutoff, asset] : [cutoff],
    ),
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    if (!row.panelDate || out.has(row.asset)) continue;
    // Judged against what was due on this collection's date: a family
    // registered later was never owed by this row.
    const expected = dataForSeoReportsFor(
      row.asset,
      panelAssets,
      row.panelDate,
    );
    const landed = new Set(
      (row.reports ?? "").split(",").filter((report) => report.length > 0),
    );
    // Complete means every due family arrived — a superset test, not set
    // equality: an extra family (not yet owed, or since retired) is not a torn
    // week.
    if (expected.every((report) => landed.has(report))) {
      out.set(row.asset, row.panelDate);
    }
  }
  return out;
}
