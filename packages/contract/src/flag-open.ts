// What "open" means for an alert, in one place, shared by the Tower and the
// ingest's alert rollup. A helper that asks about time takes the caller's
// placeholder for `now` (`$2::timestamptz`, say) rather than the store's own
// `now()`: every payload builder already takes the clock as an argument, and
// a test that cannot move time cannot prove that a snooze expires.

function prefix(alias: string): string {
  return alias ? `${alias}.` : '';
}

/**
 * An alert that still needs the operator: nobody resolved it, and either
 * nobody dispositioned it or the only disposition that expires has expired.
 * An expired snooze returns the same row.
 *
 * The `snooze_until IS NOT NULL` arm is load-bearing: without it a `snooze`
 * row with no date would make the whole expression NULL and vanish from both
 * lists. `tune` is also open, written out so it cannot change by accident:
 * tuning the detector is not resolving the firing, and any future disposition
 * is closed by default.
 */
export function openFlagsSql(alias: string, now: string): string {
  const p = prefix(alias);
  return `${p}resolved_at IS NULL
            AND (${p}disposition IS NULL
                 OR ${p}disposition = 'tune'
                 OR (${p}disposition = 'snooze'
                     AND ${p}snooze_until IS NOT NULL
                     AND ${p}snooze_until <= ${now}))`;
}

// Every alert is in exactly one of three states, all written here so no
// reader can invent a fourth:
//
//   open     needs the operator now                  openFlagsSql
//   snoozed  parked, and comes back on its date      snoozedFlagsSql
//   settled  finished: nothing brings it back        settledFlagsSql
//
// A snooze is not settled: the store hands the same row back on its date.

/** Parked — dispositioned `snooze` with time still on the clock. `now` is the
 * caller's placeholder for its clock. */
export function snoozedFlagsSql(alias: string, now: string): string {
  const p = prefix(alias);
  return `${p}resolved_at IS NULL
            AND ${p}disposition = 'snooze'
            AND ${p}snooze_until IS NOT NULL
            AND ${p}snooze_until > ${now}`;
}

/**
 * Settled — resolved, or given a decision that does not expire. Takes no
 * `now`: it is the one state a passing date can never enter or leave. A
 * `snooze` with no date is settled, so that a row is never in none of the
 * three states; the writer refuses to store one anyway.
 */
export function settledFlagsSql(alias = ''): string {
  const p = prefix(alias);
  return `(${p}resolved_at IS NOT NULL
            OR (${p}disposition IS NOT NULL
                AND ${p}disposition <> 'tune'
                AND (${p}disposition <> 'snooze' OR ${p}snooze_until IS NULL)))`;
}

/**
 * When an alert settled: its resolution, else its disposition, else its
 * firing. Written as CASE, not COALESCE: behind row security Postgres keeps a
 * COALESCE condition until after the workspace policy has run, so a COALESCE
 * bound can never seek the index. The index (`flags_asset_settled`) is on
 * exactly this expression, so readers compose it rather than write it.
 */
export function settledAtSql(alias = ''): string {
  const p = prefix(alias);
  return `(CASE WHEN ${p}resolved_at IS NOT NULL THEN ${p}resolved_at WHEN ${p}disposition_at IS NOT NULL THEN ${p}disposition_at ELSE ${p}fired_at END)`;
}
