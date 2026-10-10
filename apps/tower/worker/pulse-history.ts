// The nightly-report read the Wall and the asset page share. A report is a
// day's newest revision (`noticeos.current_pulses`). The statement walks each
// asset's indexes only as far as it needs, so its cost follows the number of
// assets, not the nights of history; it is one round trip per poll.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { SETUP_BASELINE_DAYS } from "../shared/asset-setup";

/**
 * First and last arrival and the 28-day report count, per asset.
 *
 * Arrival and coverage are different facts: one old pulse proves an arrival,
 * not 28 days of reports. The count is of report DATES in the last
 * `SETUP_BASELINE_DAYS` completed UTC days, today excluded — one current
 * revision per day makes every row one date, so a range count is that exact
 * number.
 *
 * `latest` is NULL for an asset that has never reported. `latest` and
 * `first` are the newest and earliest arrival of a day's current revision; each
 * walks `pulses_received` from its end to the first current revision. `$1` is
 * the clock, `$2` the days counted.
 */
export const PULSE_COVERAGE_SQL = `SELECT a.asset_id AS asset,
       (SELECT p.received_at FROM noticeos.current_pulses p
         WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
         ORDER BY p.received_at DESC LIMIT 1) AS latest,
       (SELECT p.received_at FROM noticeos.current_pulses p
         WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
         ORDER BY p.received_at LIMIT 1) AS first,
       (SELECT count(*) FROM noticeos.current_pulses p
         WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
           AND p.pulse_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date - $2::int
           AND p.pulse_date < ($1::timestamptz AT TIME ZONE 'UTC')::date)::int AS "reportDays"
  FROM noticeos.assets a`;

export interface PulseCoverage {
  latest: string;
  first: string;
  reportDays: number;
}

/**
 * Arrival and coverage for every asset that has reported, or for one asset.
 *
 * An asset that never reported is ABSENT from the map, never present with a
 * zero: both payloads read "no entry" as "has never reported", and the
 * reporting summary counts it from the asset rows, not from this map.
 * `asset` narrows the same statement, so the Wall and the asset page agree.
 */
export async function readPulseCoverage(
  store: WorkspaceStore,
  nowIso: string,
  asset?: string,
): Promise<Map<string, PulseCoverage>> {
  const rows = await store.read((tx) =>
    asset === undefined
      ? tx.query<CoverageRow>(PULSE_COVERAGE_SQL, [nowIso, SETUP_BASELINE_DAYS])
      : tx.query<CoverageRow>(`${PULSE_COVERAGE_SQL} WHERE a.asset_id = $3`, [nowIso, SETUP_BASELINE_DAYS, asset]),
  );
  const out = new Map<string, PulseCoverage>();
  for (const row of rows) {
    if (row.latest === null || row.first === null) continue;
    out.set(row.asset, {
      latest: javascriptInstant(row.latest),
      first: javascriptInstant(row.first),
      reportDays: row.reportDays,
    });
  }
  return out;
}

type CoverageRow = { asset: string; latest: string | null; first: string | null; reportDays: number };
