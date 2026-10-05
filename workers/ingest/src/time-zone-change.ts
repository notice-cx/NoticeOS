// A provider's reporting timezone changing is an EVENT, not a setting (ro-tzq).
//
// WHAT HAPPENED ON 2026-08-31. The operator moved one asset's GA4 property
// from Pacific to Eastern time, so its analytics would agree
// with Mediavine Journey, which reports in ET. GA4 buckets each event into a day
// using the property's reporting timezone at PROCESSING time and never
// reprocesses history — so from that moment the property's daily series carried
// two units at once: PT-days before, ET-days after.
//
// Nothing in the OS noticed. The timezone lived in a config secret that no
// property had ever set, so the collector was using its own default and would
// have gone on using it indefinitely, computing "today" three hours away from
// the property's own answer.
//
// SO THE OS READS IT FROM THE PROVIDER AND WATCHES IT. GA4 returns
// `metadata.timeZone` on every report the collector already requests. Comparing
// this run's answer to the last one costs one indexed query and turns a silent
// unit change into a dated timeline event that every comparison can see.
//
// WHY AN ANNOTATION AND NOT ONLY A FLAG. A flag says "look at this now"; this
// needs to still be legible in six weeks, when a watch window closes over a
// baseline that predates it. Annotations are the OS's record of what changed and
// when, watch windows already correlate against them, and the property page's
// timeline already renders them. The flag rides alongside so it is also seen
// today.

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
 * The timezone the previous successful run of THIS provider resource recorded,
 * or null when there is no previous run — a first collection establishes the
 * baseline and can never be a change.
 *
 * Scoped to `propertyRef` (ro-ujb9.70). Repointing an asset at a different GA4
 * property is a different measurement series, not a moved day boundary: the old
 * property's zone is not the new property's history, so a switch between
 * properties in different zones must never be filed as "reporting timezone
 * changed". The new property's first run is its own first collection.
 *
 * Rows written before `db/0027` were backfilled with the collector's default
 * rather than left null, so "no previous timezone" genuinely means "no previous
 * run" and not "we used to not record this".
 *
 * Read on Postgres (bead ro-ujb9.76.5.3). Two runs that finished in the same
 * instant are taken in the order they were written, the first one first, as
 * D1's index returned them.
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
 * Record a change the collector just observed.
 *
 * IDEMPOTENT BY THE ANNOTATION'S OWN IDENTITY. The lanes run several times a
 * night and each one sees the same difference until the older runs age out of
 * the "previous" lookup, so this would file repeatedly. Annotations are keyed on
 * `(asset, at, kind, ref)` (db/README), and `ref` here is the change itself —
 * property, direction and day — so the second filing is a duplicate rather than
 * a second event.
 */
export async function recordTimeZoneChange(
  env: IngestEnv,
  change: TimeZoneChange,
): Promise<{ filed: boolean; error?: string }> {
  const result = await writeAnnotation(env, {
    asset: change.asset,
    // Dated to the provider day the definitions diverged, not to the moment the
    // OS noticed. A comparison asking "does my window span this change" needs
    // the day the data changed shape, and the OS may notice hours later.
    at: `${change.effectiveOn}T00:00:00.000Z`,
    kind: 'config',
    ref: `${TIME_ZONE_CHANGE_RULE_ID}:${change.integration}:${change.from}->${change.to}`,
    // The headline and its values (bead `ro-ujb9.96.6.29`). What it means —
    // days before are bucketed by the old midnight and after it by the new one,
    // the provider never reprocesses history, and the transition day is short
    // or long by the offset — is drawn where a comparison is made: a delta
    // whose window spans the day says "reporting timezone changed", and the
    // chart marks the day (the Tower's signal trends read this annotation).
    note: `${change.integration.toUpperCase()} day moved from ${change.from} to ${change.to} on ${change.effectiveOn}`,
  });
  // A refused write is reported rather than swallowed: this is the only record
  // that the unit changed, and losing it silently would leave every later
  // comparison unable to know.
  if (!result.ok) {
    return { filed: false, error: result.error };
  }
  return { filed: result.created };
}

/**
 * Every filed change for one provider, keyed by property.
 *
 * One query for the whole portfolio: an on-demand read that hit the database
 * once per property would pay for a portfolio-sized fan-out on the operator's
 * hot path. The changes are read, not `signal_runs`, because only the
 * annotation is DATED to the day the two day-definitions diverged; a run row
 * says what timezone that run used, which cannot say when the boundary moved.
 */
export async function timeZoneChangesFor(
  store: WorkspaceStore,
  integration: string,
): Promise<Map<string, TimeZoneChange[]>> {
  // On Postgres (bead ro-ujb9.76.5.7). The day is the UTC day of `at`, the ten
  // characters D1 cut from its text; changes filed at one instant keep the
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
 * uses now.
 *
 * GA4 buckets at processing time and never reprocesses history, so a report
 * pulled today carries rows stamped with whatever clock was in force on each
 * row's own date. Converting them all with the current zone would move the
 * older side of a comparison by the offset and make a pace chip lie.
 */
export function reportingTimeZoneOn(
  changes: readonly Pick<TimeZoneChange, 'effectiveOn' | 'from' | 'to'>[],
  date: string,
  current: string,
  providerToday: string,
): string {
  // A change the OS has not filed yet is in effect from at latest the
  // provider's own today: the provider is answering with `current` right now.
  // The nightly lanes will date it properly and the next read picks that up.
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
  // from — not today's, which is several moves later.
  if (earliest !== null) return earliest.from;
  return current;
}

/**
 * Does a comparison window span a change, and which one?
 *
 * The question every pace chip, delta and baseline has to ask before subtracting
 * one window from another. A window that starts on the change day is entirely in
 * the new definition and is fine; one that starts before it and ends on or after
 * it is not.
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
 * The days the boundary move distorted on its own.
 *
 * Moving a day boundary by N hours does not just relabel days — it takes N hours
 * off one and gives them to its neighbour. Both are wrong by the move alone, and
 * neither is evidence about the property. Their VALUES stay exactly as the
 * provider reported them (operator decision, 2026-08-31): the numbers are what
 * GA4 said, and rewriting them would destroy the only record of what was
 * measured. What they carry instead is a marker, so no chart, rule or reader
 * treats them as ordinary days.
 */
export function distortedDays(change: { effectiveOn: string }): string[] {
  const day = new Date(`${change.effectiveOn}T00:00:00.000Z`);
  const previous = new Date(day.getTime() - 86_400_000);
  return [previous.toISOString().slice(0, 10), change.effectiveOn];
}
