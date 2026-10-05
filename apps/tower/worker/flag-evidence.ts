// The readings behind an open alert's summary (`noticeos.flag_evidence`,
// bead `ro-ujb9.220`).
//
// A lane that keeps one open flag for a condition lasting several runs
// refreshes that flag each run and keeps each run's own reading in
// `flag_evidence`. The nightly pull lane is the first to: every failed fetch is
// a row. Two readers:
//
//   - an alert's Evidence lists its readings (`readFlagReadings`, attached by
//     `readingsOf` as `readings` to the alert rows of the asset page, `/alerts`
//     and the alert history; `pullFailed` in shared/alert-language.ts renders
//     them);
//   - a site's Data sources tab lists its failed fetches
//     (`readSiteFetchFailures`).
//
// `noticeos.flag_evidence` is keyed here by
// each alert's workspace number. Every lane that keeps one open alert appends
// its readings there now (the store never rewrites a firing), but only the
// nightly pull's alert lists them (`pullFailed` in shared/alert-language.ts
// renders them), so the readings read here are that alert's. An empty list
// means no readings are recorded; a failed read throws.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { READINGS_SHOWN, type FlagReading } from "../shared/alert-language";
import type { FetchFailure } from "../shared/asset-detail";

/** `workers/ingest` PULL_FAILED_RULE_ID, restated because the Tower does not
 * build the ingest worker's source (the same practice as `shared/wall`'s
 * freshness rule id). */
const PULL_FAILED_RULE_ID = "asset-pull-failed";

type ReadingRow = {
  flagId: number;
  at: string;
  message: string | null;
  ruleInputs: string | null;
};

function parseInputs(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toReading(row: Pick<ReadingRow, "at" | "message" | "ruleInputs">): FlagReading {
  return { at: javascriptInstant(row.at), message: row.message, ruleInputs: parseInputs(row.ruleInputs) };
}

/**
 * The stored readings of these alerts (by workspace number), newest first, at
 * most {@link READINGS_SHOWN} each. An alert with none is absent from the map.
 */
export async function readFlagReadings(
  store: WorkspaceStore,
  flagIds: readonly number[],
): Promise<Map<number, FlagReading[]>> {
  const byFlag = new Map<number, FlagReading[]>();
  const ids = [...new Set(flagIds)];
  if (ids.length === 0) return byFlag;
  const rows = await store.read((tx) =>
    tx.query<ReadingRow>(
      `SELECT f.flag_number::int AS "flagId", e.observed_at AS at, e.message, e.rule_inputs::text AS "ruleInputs"
         FROM noticeos.flags f
         JOIN noticeos.flag_evidence e ON e.workspace_id = f.workspace_id AND e.flag_id = f.flag_id
        WHERE f.flag_number = ANY($1::bigint[]) AND f.rule_id = $2
        ORDER BY f.flag_number, e.observed_at DESC`,
      [ids, PULL_FAILED_RULE_ID],
    ),
  );
  for (const row of rows) {
    const readings = byFlag.get(row.flagId) ?? [];
    if (readings.length < READINGS_SHOWN) readings.push(toReading(row));
    byFlag.set(row.flagId, readings);
  }
  return byFlag;
}

/** The `readings` field for one alert row: present only when it has some, so a
 * row without readings is exactly the row it always was. */
export function readingsOf(
  readings: ReadonlyMap<number, FlagReading[]>,
  flagId: number,
): { readings?: FlagReading[] } {
  const own = readings.get(flagId);
  return own ? { readings: own } : {};
}

/**
 * This site's most recent failed nightly-report fetches, newest first, across
 * every `asset-pull-failed` alert it has had, each saying whether its alert is
 * still open.
 */
export async function readSiteFetchFailures(
  store: WorkspaceStore,
  asset: string,
  limit: number = READINGS_SHOWN,
): Promise<FetchFailure[]> {
  const rows = await store.read((tx) =>
    tx.query<Omit<ReadingRow, "flagId"> & { ongoing: boolean }>(
      `SELECT e.observed_at AS at, e.message, e.rule_inputs::text AS "ruleInputs",
              f.resolved_at IS NULL AS ongoing
         FROM noticeos.flag_evidence e
         JOIN noticeos.flags f ON f.workspace_id = e.workspace_id AND f.flag_id = e.flag_id
        WHERE f.asset_id = $1 AND f.rule_id = $2
        ORDER BY e.observed_at DESC
        LIMIT $3`,
      [asset, PULL_FAILED_RULE_ID, limit],
    ),
  );
  return rows.map((row) => ({ ...toReading(row), ongoing: row.ongoing }));
}
