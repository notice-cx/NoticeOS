// Everything a local script needs out of the central store's signal archive.
//
// WHY A WORKER READ AND NOT `wrangler d1 execute`. These readers serve plain
// Node processes — the standing panel refresh and the hand-run downloader — and
// the obvious implementation is the one both used to use: shell out to
// `wrangler d1 execute --local --persist-to ../../.wrangler/state` and
// `wrangler r2 object get`. Each of those starts a SECOND miniflare over the
// same sqlite file the live runtime already holds open as its D1DatabaseObject,
// which is the exact topology that produced the 2026-08-02 store corruption
// (beads ro-mad, ro-icq; the whole point of apps/tower/vite/runner-door.ts).
//
// An operator doing that by hand, once, is a judgement call — but it is the
// SAME judgement call every time, made beside a live `os:up`, which is the only
// way these scripts are ever run. So both lanes read through the runtime that
// already owns the file, over the loopback ingest door, and nothing under
// scripts/ opens the store a second time (bead ro-2zk.3).
//
// Every read here is READ-ONLY and operator-authed. Nothing here writes, and
// nothing here calls a provider — the archives were already bought by the
// `15 12 * * *` and `45 12 * * 1` collectors, and materializing them locally
// costs $0.00 against the monthly data cap (config/constants.json
// `monthly_caps.data_usd`).

/** How far back the refresh reads when the caller names no window. Wider than
 * GA4's rolling 28-day aggregate so a month-boundary pass still carries it. */
export const PANEL_SOURCE_DEFAULT_WINDOW_DAYS = 35;

/** The widest window this read will serve. A caller asking for "everything"
 * would walk the whole archive on every nightly pass; the panel dir keeps what
 * earlier passes already wrote, so history is preserved by the filesystem
 * rather than re-fetched. */
export const PANEL_SOURCE_MAX_WINDOW_DAYS = 400;

import { ASSET_ID_RE } from '@noticeos/contract/configuration';
import { javascriptInstant } from '@noticeos/postgres';
import { signalObjectScope } from './signal-objects.js';
export { ASSET_ID_RE } from '@noticeos/contract/configuration';
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Integration and report ids as the collectors write them ('bing-webmaster',
 * 'page-query'). Shape only, no vocabulary: a filter naming a report family
 * this OS does not collect is an empty manifest, not a 400. */
export const SLUG_RE = /^[a-z0-9-]+$/;

/** One archived provider response a caller may need on disk. The panel refresh
 * and the hand-run downloader read the SAME rows through the same resolver, so
 * the two write byte-identical files. */
export interface PanelSourceManifestRow {
  integration: string;
  report: string;
  reportDate: string;
  finishedAt: string;
  objectKey: string;
  contentSha256: string;
  providerRows: number;
  providerTruncated: number;
}

/** One day of one normalized site-level series. */
export interface PanelSourceTrendRow {
  date: string;
  integration: string;
  metric: string;
  value: number;
  /** 1 when the provider had not finished reporting this date at collection
   * time. Carried rather than dropped: a provisional day is a real observation
   * that may still be revised, and hiding it would read as a traffic cliff. */
  provisional: number;
}

export interface PanelSourceResult {
  asset: string;
  from: string;
  windowDays: number;
  manifest: PanelSourceManifestRow[];
  trend: PanelSourceTrendRow[];
}

/** The oldest report date a window of `windowDays` reaches. */
export function panelSourceCutoff(nowMs: number, windowDays: number): string {
  return new Date(nowMs - windowDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Clamp a caller's `windowDays` into something a nightly job can afford.
 *
 * A bad value is corrected rather than refused: the refresh must not stop
 * because a config edit typed `"35"` instead of `35`, and the default is always
 * a safe answer.
 */
export function panelSourceWindowDays(raw: string | null): number {
  if (raw === null || raw.trim() === '') return PANEL_SOURCE_DEFAULT_WINDOW_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return PANEL_SOURCE_DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(parsed), PANEL_SOURCE_MAX_WINDOW_DAYS);
}

/**
 * How a caller narrows the manifest.
 *
 * The panel refresh sets `from` alone — its window is the whole filter. The
 * hand downloader sets whichever of the four the operator typed, and sets NONE
 * of them by default: `pnpm signals:download -- --asset x` means every report
 * day this store has ever archived, and a window silently applied on its behalf
 * would drop history the operator asked for.
 */
export interface PanelManifestFilters {
  from?: string | null;
  to?: string | null;
  integration?: string | null;
  report?: string | null;
}

/**
 * The newest surviving revision of every archived report the filters reach.
 *
 * `ROW_NUMBER()` over (integration, report, report_date) is the revision
 * resolver both lanes need, and for the same reason: the collector re-archives
 * a day inside its revision window, and a directory built from two revisions of
 * one day would double-count it.
 *
 * `status IN ('success','unchanged')` and `object_key IS NOT NULL` are not
 * filters the caller may relax — a failed collection has no bytes to hand back,
 * and offering the row would invite an empty file that reads as a real zero.
 */
export async function readPanelManifest(
  env: IngestEnv,
  asset: string,
  filters: PanelManifestFilters = {},
): Promise<PanelSourceManifestRow[]> {
  const objects = await signalObjectScope(env);
  const params: string[] = [asset];
  // A stored run always names its object (a row check), so a success or
  // unchanged run IS a run with bytes to hand back.
  const where = [`r.asset_id = $1`, `r.status IN ('success','unchanged')`];
  const narrow = (column: string, operator: string, value: string, cast = ''): void => {
    params.push(value);
    where.push(`${column} ${operator} $${params.length}${cast}`);
  };
  if (filters.from) narrow('r.report_date', '>=', filters.from, '::date');
  if (filters.to) narrow('r.report_date', '<=', filters.to, '::date');
  if (filters.integration) narrow('r.integration', '=', filters.integration);
  if (filters.report) narrow('r.report', '=', filters.report);

  // On Postgres (bead ro-ujb9.76.5.4): of one day's revisions the newest
  // finished, two finished in one instant broken by the run's id as on D1;
  // text ordered byte by byte, as D1 ordered it.
  const rows = await env.STORE.read((tx) =>
    tx.query<Omit<PanelSourceManifestRow, 'providerTruncated'> & { providerTruncated: boolean }>(
      `SELECT integration, report, "reportDate", "finishedAt", "objectKey",
              "contentSha256", "providerRows", "providerTruncated"
         FROM (
           SELECT DISTINCT ON (r.integration, r.report, r.report_date)
                  r.integration, r.report,
                  r.report_date        AS "reportDate",
                  r.finished_at        AS "finishedAt",
                  o.object_key         AS "objectKey",
                  o.content_sha256     AS "contentSha256",
                  r.provider_rows      AS "providerRows",
                  r.provider_truncated AS "providerTruncated"
             FROM noticeos.archive_runs r
             JOIN noticeos.archive_objects o ON o.workspace_id = r.workspace_id AND o.object_seq = r.object_seq
            WHERE ${where.join(' AND ')}
            ORDER BY r.integration, r.report, r.report_date,
                     r.finished_at DESC, r.run_id COLLATE "C" DESC
         ) newest
        ORDER BY "reportDate", integration COLLATE "C", report COLLATE "C"`,
      params,
    ),
  );
  return rows.filter((row) => objects.canReadArchive(row.objectKey)).map((row) => ({
    ...row,
    finishedAt: javascriptInstant(row.finishedAt),
    providerTruncated: row.providerTruncated ? 1 : 0,
  }));
}

/**
 * The daily site-level series — the panel's answer to "what happened this week".
 *
 * The per-report CSVs are top-row provider exports: they are the right shape for
 * "which query moved" and the wrong shape for "did clicks fall", because a
 * top-1000 export silently drops the tail. `signal_observations` is the
 * normalized daily total the 15-minute and nightly lanes store, so this is the
 * one series in the panel dir that can be summed and differenced honestly.
 *
 * Only successful runs, newest revision per (integration, date, metric): a later
 * run that re-reported an earlier date supersedes it, which is exactly how
 * provider backfills should land.
 *
 * Only the CURRENT provider resource per integration (ro-ujb9.70): the
 * `property_ref` of that integration's latest successful run. An asset repointed
 * at another GA4 property or Search Console site is measuring something else,
 * and older days the new resource never reported must fall out of the series
 * rather than splice the old resource's numbers onto the new one's. Credential
 * rotation keeps `property_ref`, so it keeps the whole series. Each lane's
 * current resource is one `LIMIT 1` seek down the runs' latest-first index;
 * the three lanes are the ones the collectors write. The newest write of a day
 * is the one whose run finished last, and between two runs that finished in
 * the same instant the one whose id sorts last, as on D1.
 *
 * A day's provisional flag comes from its newest CONFIRMATION, not from the
 * run that wrote its value (epic ro-cvl9). The store keeps a change log: a run
 * that re-reports a day with the same number writes nothing for it
 * (`recordSignalSuccess`), so the writer of a day first reported while still
 * filling in stays provisional forever. The confirmation is the newest
 * successful run of the same resource and time zone whose window covers the
 * day — the collectors report every day of their window, zeroes included — or
 * the writer itself. A failed run or another resource confirms nothing, and
 * age alone never finalizes a day.
 *
 * Read on Postgres (bead ro-ujb9.76.5.3); text is ordered byte by byte, as D1
 * ordered it.
 */
export async function readPanelTrend(
  env: IngestEnv,
  asset: string,
  from: string,
): Promise<PanelSourceTrendRow[]> {
  return env.STORE.read((tx) =>
    tx.query<{ date: string; integration: string; metric: string; value: number; provisional: number }>(
      `WITH current_property AS MATERIALIZED (
         SELECT lanes.integration,
                (SELECT latest.property_ref
                   FROM noticeos.signal_runs AS latest
                  WHERE latest.asset_id = $1
                    AND latest.integration = lanes.integration
                    AND latest.status = 'success'
                  ORDER BY latest.finished_at DESC, latest.run_seq DESC
                  LIMIT 1) AS property_ref
           FROM (VALUES ('ga4'), ('gsc'), ('bing-webmaster')) AS lanes(integration)
       ),
       newest AS (
         SELECT DISTINCT ON (o.observed_date, r.integration COLLATE "C", s.metric COLLATE "C")
                o.observed_date,
                r.integration,
                s.metric,
                o.value,
                r.run_seq,
                s.workspace_id,
                s.property_ref,
                s.time_zone
           FROM current_property AS current
           JOIN noticeos.measurement_series AS s
             ON s.asset_id = $1 AND s.integration = current.integration AND s.property_ref = current.property_ref
           JOIN noticeos.signal_observations AS o
             ON o.workspace_id = s.workspace_id AND o.series_id = s.series_id AND o.observed_date >= $2::date
           JOIN noticeos.signal_runs AS r
             ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq AND r.status = 'success'
          ORDER BY o.observed_date, r.integration COLLATE "C", s.metric COLLATE "C",
                   r.finished_at DESC, r.run_id COLLATE "C" DESC
       )
       SELECT newest.observed_date AS date,
              newest.integration,
              newest.metric,
              newest.value,
              CASE
                WHEN confirmation.provisional_from IS NOT NULL
                 AND newest.observed_date >= confirmation.provisional_from
                THEN 1 ELSE 0
              END AS provisional
         FROM newest
        CROSS JOIN LATERAL (
              SELECT c.provisional_from
                FROM noticeos.signal_runs AS c
               WHERE c.workspace_id = newest.workspace_id
                 AND c.asset_id = $1
                 AND c.integration = newest.integration
                 AND c.property_ref = newest.property_ref
                 AND c.time_zone IS NOT DISTINCT FROM newest.time_zone
                 AND c.status = 'success'
                 AND (c.run_seq = newest.run_seq
                      OR newest.observed_date BETWEEN c.window_start AND c.window_end)
               ORDER BY c.finished_at DESC, c.run_id COLLATE "C" DESC
               LIMIT 1
              ) AS confirmation
        ORDER BY newest.observed_date, newest.integration COLLATE "C", newest.metric COLLATE "C"`,
      [asset, from],
    ),
  );
}

export async function readPanelSource(
  env: IngestEnv,
  asset: string,
  windowDays: number,
  nowMs: number = Date.now(),
): Promise<PanelSourceResult> {
  const from = panelSourceCutoff(nowMs, windowDays);
  const [manifest, trend] = await Promise.all([
    readPanelManifest(env, asset, { from }),
    readPanelTrend(env, asset, from),
  ]);
  return { asset, from, windowDays, manifest, trend };
}

/**
 * One archived object, decompressed, as the JSON the analyzer expects on disk.
 *
 * The selected workspace must own the namespace and its RLS manifest must
 * record the key (`noticeos.archive_objects`). Only explicit standalone reads
 * accept legacy paths, still through that owner's manifest. Entries establish
 * admission before this reader. `null` means "no such archive" — a 404 rather
 * than an empty file, because an empty archive would flatten to a CSV that
 * reads as a real zero.
 */
export async function readPanelObject(
  env: IngestEnv,
  objectKey: string,
): Promise<string | null> {
  const objects = await signalObjectScope(env);
  if (!objects.canReadArchive(objectKey)) return null;
  const known = await env.STORE.read((tx) =>
    tx.query(`SELECT 1 AS ok FROM noticeos.archive_objects WHERE object_key = $1`, [objectKey]),
  );
  if (known.length === 0) return null;

  return readRawSignalObject(env.RAW_SIGNALS, objectKey);
}

/** Byte decoding stays private behind workspace and manifest checks. */
async function readRawSignalObject(
  bucket: R2Bucket,
  objectKey: string,
): Promise<string | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;

  // Stored gzipped (archiveCollectedDump sets contentEncoding: 'gzip'). R2 does
  // not decode it for us, so unwrap here and hand the caller plain JSON — the
  // runner writes those bytes straight to the downloads tree.
  const decompressed = object.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(decompressed).text();
}
