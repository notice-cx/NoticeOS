// The weekly review obligation behind an asset's panel-review marker — the
// newest DataForSEO collection each asset has landed, and the review bead the
// task-hub snapshot holds for it.
//
// Both the Wall's asset card and the asset page render this marker, and they
// must word and gate one asset's obligation identically (beads `ro-elf`,
// `ro-z0g`, `ro-1tu`). So neither page builder owns the readers: both compose
// `loadLatestPanelLandings` and `cardPanelReviewsOf` from here, and the state
// rule itself (`panelReviewState`) lives in `shared/wall.ts`. The landings are
// read from the call's store (bead ro-ujb9.76.5.4), so the tests run this
// exact SQL against a Postgres copy.

import { dataForSeoReportsFor } from "@noticeos/contract";
import type { WorkspaceStore } from "@noticeos/postgres";
import type { BeadsSnapshot } from "./beads-snapshot";
import type { PanelReview } from "../shared/wall";

const MS_PER_DAY = 86_400_000;

/** The panel-review half of a task-hub snapshot (the same photograph the Wall
 * card's work widget reads), keyed by asset id. Projects the poller could not
 * read never land here (`readProject` already nulled them), and neither does a
 * snapshot written before the field existed — both become
 * `panelReview: null` on the card, which renders nothing at all.
 *
 * `panelAssets` is the only thing added on the way out, and it is the one fact
 * the hub cannot know: which assets bought a tracked SERP panel
 * (config/serp-panel.json, the same key set the collector gates the sixth report
 * family on). It picks the NOUN the marker states the obligation in and nothing
 * else — a panel-less asset owes exactly the same weekly read since `ro-478`.
 * Both payload builders call this, so the Wall and the asset page cannot word
 * one asset's obligation two ways (bead `ro-z0g`).
 *
 * `asset` answers for one asset (`ro-ntu`), for the same reason the loader
 * below takes one: the asset page asks about one row, and it should say so
 * rather than build every asset's review and keep a key. */
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
 * read. Three weekly collections, matching `SERP_PANEL_LANDING_WINDOW_DAYS` in
 * `workers/ingest/src/serp-panel-landings.ts` — the read the runner's filer acts
 * on — because the Tower must render a marker for exactly the set of landings
 * the filer writes reviews for. A number that disagreed with the filer's would
 * hide a review the same minute it was created, or keep one on the board after
 * the filer stopped renewing it. `apps/tower/test/wall-payload.test.ts` asserts
 * the two stay equal.
 */
export const PANEL_LANDING_WINDOW_DAYS = 21;

/**
 * The newest weekly DataForSEO COLLECTION DAY each asset has landed — the day
 * a finished review has to be about for it to still count.
 *
 * THE ANCHOR IS THE COLLECTION, NOT THE PANEL (`ro-478`, mirrored here by
 * `ro-1tu`). This read used to ask only about `report = 'serp-panel'`, which
 * meant an asset with no entry in config/serp-panel.json never landed anything
 * and so never showed a review — even though it buys five report families every
 * Monday. The panel is now one family of the collection this reports, so a
 * asset that has one is unaffected: its panel and its other five families
 * share a `report_date`, so the day this returns is the day the old query
 * returned.
 *
 * A day lands only when the exact configured family set has succeeded or proved
 * unchanged. A partial sweep is not reviewable evidence, so its newer date must
 * not supersede the last coherent collection. Candidate days are ordered by
 * `report_date`, not `finished_at`: a backfill or re-archive of an OLDER
 * collection writes a LATER `finished_at`, and ordering by it would promote last
 * month's collection over this week's and quietly un-review a card that was
 * fine (agreed with `ro-9hx`, 2026-08-02).
 *
 * `success` and `unchanged` both count, matching the writer exactly. An
 * `unchanged` row means the archive already held byte-identical content for
 * that same day, so it is never a landing the other status does not already
 * cover — but the two sides state the identical predicate rather than relying on
 * that, because "equal in practice" is how the two halves of a join drift apart.
 * An `error` run collected nothing and is excluded.
 *
 * Grouped per asset off the manifest index rather than ranked over the whole
 * table (`ro-48p.1`): the site list first, then each site's DataForSEO runs
 * down the runs' (site, lane, …) index. Bounded by the landing window above:
 * collections are weekly and kept for thirteen months, so an unbounded read
 * would grow to answer a question about one row per asset. Sites and days are
 * listed byte by byte, as D1 listed them.
 *
 * `asset` narrows THIS query rather than the caller filtering the returned map
 * (`ro-ntu`, the shape `ro-48p.2` set for `loadSignalTrends`): the asset page
 * wants one asset and the Wall wants them all, and one equality is the whole
 * difference. A filtered COPY of this SQL is the thing that must never exist:
 * divergent completeness or ordering would un-review one surface's card and not
 * the other's, exactly the disagreement `ro-elf` shares the derivation to
 * prevent.
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
    // Judged against what was due ON THIS COLLECTION'S DATE. A family
    // registered after `panelDate` was never owed by this row, and grading it
    // against today's family list would un-recognise every landing stored
    // before the newest family shipped — the filer would quietly stop filing
    // reviews for collections that were complete when they ran.
    const expected = dataForSeoReportsFor(
      row.asset,
      panelAssets,
      row.panelDate,
    );
    const landed = new Set(
      (row.reports ?? "").split(",").filter((report) => report.length > 0),
    );
    // Complete means EVERY DUE FAMILY ARRIVED — a superset test, not set
    // equality. An extra family is a family collected on a day it was not yet
    // owed (the boundary run on the day one is registered) or one since
    // retired; neither is a torn week, and equality called both one.
    if (expected.every((report) => landed.has(report))) {
      out.set(row.asset, row.panelDate);
    }
  }
  return out;
}
