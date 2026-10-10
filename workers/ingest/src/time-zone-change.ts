// A provider's reporting timezone changing is an event, not a setting. GA4
// buckets each event into a day using the property's reporting timezone at
// processing time and never reprocesses history, so from the moment a property
// moves zones its daily series carries two units at once. The OS reads the
// zone from the provider on every report and compares it with the last run's,
// turning a silent unit change into a dated timeline event every comparison
// can see. An annotation and not only a flag, because this has to be legible
// weeks later when a watch window closes over a baseline that predates it.

import type { WorkspaceStore } from '@noticeos/postgres';
import { writeAnnotation } from './annotations.js';

/** The rule id a timezone change files under. */
export const TIME_ZONE_CHANGE_RULE_ID = 'reporting-time-zone-changed';

export interface TimeZoneChange {
  asset: string;
  integration: string;
  from: string;
  to: string;
  /** The provider day on which the two definitions stop agreeing. */
  effectiveOn: string;
}

/**
 * The timezone the previous successful run of this provider resource recorded,
 * or null when there is no previous run: a first collection establishes the
 * baseline and can never be a change. Scoped to `propertyRef`: repointing an
 * asset at a different property is a different measurement series, not a
 * moved day boundary, so the new property's first run is its own first
 * collection. Two runs that finished in the same instant are taken in the
 * order they were written.
 */
export async function previousTimeZone(
  store: WorkspaceStore,
  asset: string,
  integration: string,
  propertyRef: string,
  excludeRunId?: string,
): Promise<string | null> {
  const [row] = await store.read((tx) =>
    tx.query<{ timeZone: string | null }>(
      `SELECT time_zone AS "timeZone"
         FROM noticeos.signal_runs
        WHERE asset_id = $1 AND integration = $2 AND property_ref = $3
          AND status = 'success'
          AND time_zone IS NOT NULL
          AND ($4::text IS NULL OR run_id <> $4::text)
        ORDER BY finished_at DESC, run_seq
        LIMIT 1`,
      [asset, integration, propertyRef, excludeRunId ?? null],
    ),
  );
  return row?.timeZone ?? null;
}

/**
 * Record a change the collector just observed. Idempotent by the annotation's
 * own identity `(asset, at, kind, ref)`: the lanes run several times a night
 * and each sees the same difference until older runs age out, and `ref` is the
 * change itself, so a second filing is a duplicate rather than a second event.
 */
export async function recordTimeZoneChange(
  env: IngestEnv,
  change: TimeZoneChange,
): Promise<{ filed: boolean; error?: string }> {
  const result = await writeAnnotation(env, {
    asset: change.asset,
    // Dated to the provider day the definitions diverged, not the moment the
    // OS noticed.
    at: `${change.effectiveOn}T00:00:00.000Z`,
    kind: 'config',
    ref: `${TIME_ZONE_CHANGE_RULE_ID}:${change.integration}:${change.from}->${change.to}`,
    // The headline and its values; what it means is drawn where a comparison is
    // made.
    note: `${change.integration.toUpperCase()} day moved from ${change.from} to ${change.to} on ${change.effectiveOn}`,
  });
  // A refused write is reported rather than swallowed: this is the only record
  // that the unit changed.
  if (!result.ok) {
    return { filed: false, error: result.error };
  }
  return { filed: result.created };
}

/**
 * Every filed change for one provider, keyed by property. One query for the
 * whole portfolio. The changes are read, not `signal_runs`, because only the
 * annotation is dated to the day the two day-definitions diverged.
 */
export async function timeZoneChangesFor(
  store: WorkspaceStore,
  integration: string,
): Promise<Map<string, TimeZoneChange[]>> {
  // The day is the UTC day of `at`; changes filed at one instant keep the
  // order they were filed in.
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; effectiveOn: string; ref: string }>(
      `SELECT asset_id AS asset, (at AT TIME ZONE 'UTC')::date AS "effectiveOn", ref
         FROM noticeos.annotations
        WHERE kind = 'config' AND ref LIKE $1
        ORDER BY at ASC, annotation_number ASC`,
      [`${TIME_ZONE_CHANGE_RULE_ID}:${integration}:%`],
    ),
  );
  const changes = new Map<string, TimeZoneChange[]>();
  for (const row of rows) {
    // ref shape: reporting-time-zone-changed:<integration>:<from>-><to>
    const [, refIntegration, transition] = row.ref.split(':');
    const [from, to] = (transition ?? '').split('->');
    if (!refIntegration || !from || !to) continue;
    const list = changes.get(row.asset) ?? [];
    list.push({
      asset: row.asset,
      integration: refIntegration,
      from,
      to,
      effectiveOn: row.effectiveOn,
    });
    changes.set(row.asset, list);
  }
  return changes;
}

/**
 * The zone a provider used when it bucketed this day, which is not the zone it
 * uses now: converting every row with the current zone would move the older
 * side of a comparison by the offset.
 */
export function reportingTimeZoneOn(
  changes: readonly Pick<TimeZoneChange, 'effectiveOn' | 'from' | 'to'>[],
  date: string,
  current: string,
  providerToday: string,
): string {
  // A change the OS has not filed yet is in effect from at latest the
  // provider's own today; the nightly lanes will date it properly.
  if (date >= providerToday) return current;

  let latestBefore: Pick<TimeZoneChange, 'effectiveOn' | 'from' | 'to'> | null =
    null;
  let earliest: Pick<TimeZoneChange, 'effectiveOn' | 'from' | 'to'> | null =
    null;
  for (const change of changes) {
    if (
      change.effectiveOn <= date &&
      (latestBefore === null || change.effectiveOn > latestBefore.effectiveOn)
    ) {
      latestBefore = change;
    }
    if (earliest === null || change.effectiveOn < earliest.effectiveOn) {
      earliest = change;
    }
  }
  // The newest change already in force on that day names the zone it moved to.
  if (latestBefore !== null) return latestBefore.to;
  // Before every filed change, the zone is the one the first change moved away
  // from, not today's.
  if (earliest !== null) return earliest.from;
  return current;
}

/**
 * Does a comparison window span a change, and which one? A window that starts
 * on the change day is entirely in the new definition; one that starts before
 * it and ends on or after it is not.
 */
export function spansTimeZoneChange(
  changes: readonly { effectiveOn: string; from: string; to: string }[],
  window: { start: string; end: string },
): { effectiveOn: string; from: string; to: string } | null {
  return (
    changes.find(
      (change) => window.start < change.effectiveOn && window.end >= change.effectiveOn,
    ) ?? null
  );
}

/**
 * The days the boundary move distorted on its own: moving a day boundary by N
 * hours takes N hours off one day and gives them to its neighbour, so both are
 * wrong by the move alone. Their values stay as the provider reported them;
 * what they carry is a marker.
 */
export function distortedDays(change: { effectiveOn: string }): string[] {
  const day = new Date(`${change.effectiveOn}T00:00:00.000Z`);
  const previous = new Date(day.getTime() - 86_400_000);
  return [previous.toISOString().slice(0, 10), change.effectiveOn];
}
