// WHAT "OPEN" MEANS, in one place — now shared by both Workers (`ro-c7qq`,
// moved here by `ro-78qo.36`).
//
// Six queries across four modules once decided for themselves that an open
// alert is `resolved_at IS NULL AND disposition IS NULL`. That was true while
// every disposition was permanent. Snooze is not: it is a disposition with an
// END, and the moment one of those copies had learned about it and the others
// had not, the Home card, `/alerts`, the asset hero and the Wall's rail would
// have been counting different portfolios. `apps/tower/worker/flag-scope.ts`
// collapsed them to one.
//
// IT MOVED INTO THE CONTRACT PACKAGE because the nightly alert rollup
// (`workers/ingest/src/alert-daily.ts`) runs in a separate build and cannot
// import the Tower's predicate. The rollup and current reads need the same
// definition of open. The rollup records alert history; it does not prove
// continuous condition history, so /alerts' Open KPI draws no series from it.
// The Tower's `flag-scope.ts` re-exports this: one predicate for every caller.
//
// The alerts live on Postgres (`noticeos.current_flags`, bead
// ro-ujb9.76.5.2). A helper that asks about time takes the caller's
// placeholder for `now` (`$2::timestamptz`, say): the caller binds its clock
// there as an ISO instant, and names the placeholder so the helper can sit
// anywhere in a statement.
//
// `now` is a bound parameter rather than the store's own `now()` on purpose:
// every payload builder already takes the clock as an argument, and a test
// that cannot move time cannot prove that a snooze expires.

function prefix(alias: string): string {
  return alias ? `${alias}.` : '';
}

/**
 * An alert that still needs the operator.
 *
 * Nobody resolved it, AND either nobody dispositioned it or the only
 * disposition that expires has expired. An expired snooze returns the SAME
 * condition — the row keeps its id, its evidence and its history; what it
 * loses is the silence.
 *
 * The `snooze_until IS NOT NULL` arm is not defensive noise: without it a
 * `snooze` row with no date would make the whole expression NULL, and a row
 * that is neither open nor closed disappears from both lists at once.
 *
 * `tune` IS ALSO OPEN, and says so out loud (bead `ro-van6`). Tuning the
 * detector is not resolving the firing: the drop that fired is still there and
 * still unanswered, and only what would produce it NEXT time has changed. A
 * disposition that silently closed the row would make "I made this rule
 * quieter" read as "I dealt with this", which is the one confusion the six
 * labels exist to prevent. The arm is written here rather than left to fall out
 * of `disposition IS NULL` precisely so it cannot change by accident: any future
 * disposition is closed by default, and staying open is a decision somebody had
 * to write down.
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

// --- the other two states (bead `ro-ujb9.194`) -------------------------------
//
// EVERY ALERT IS IN EXACTLY ONE OF THREE STATES, and all three are written here
// so no reader can invent a fourth:
//
//   open     needs the operator now                  openFlagsSql
//   snoozed  parked, and comes back on its date      snoozedFlagsSql
//   settled  finished: nothing brings it back        settledFlagsSql
//
// A snooze is NOT settled. Nobody decided anything about the condition; they
// put it off, and the store hands the same row back on its date. `/alerts`
// lists it under Open's Snoozed panel, never in History, and it is never
// counted in "Settled · 7d" or in a rule's settled alerts. The history read once
// took "settled" to mean "not open", which filed every live snooze as finished
// with the ✓ of a finished thing.

/**
 * Parked — dispositioned `snooze` with time still on the clock.
 *
 * `/alerts` renders these under "Snoozed", and so does a site's Alerts tab,
 * because a snooze the operator cannot find is a silent hide rather than a
 * decision. `now` is the caller's placeholder for its clock.
 */
export function snoozedFlagsSql(alias: string, now: string): string {
  const p = prefix(alias);
  return `${p}resolved_at IS NULL
            AND ${p}disposition = 'snooze'
            AND ${p}snooze_until IS NOT NULL
            AND ${p}snooze_until > ${now}`;
}

/**
 * Settled — resolved, or given a decision that does not expire.
 *
 * Resolve, Mark read and the rest settle an alert; `tune` does not (it is open,
 * above) and neither does a snooze with a date, which is either parked or open
 * again. So settled needs NO clock and takes no `now`: it is the one state a
 * passing date can never enter or leave.
 *
 * A `snooze` with no date is settled. Nothing reopens it — the open predicate's
 * `snooze_until IS NOT NULL` arm says so — and a row in none of the three states
 * would vanish from every list at once. The writer never stores one
 * (`worker/flag-actions.ts` refuses a snooze without a date).
 *
 * Written out rather than as `NOT open AND NOT snoozed` so it needs no `now`;
 * that the three states still cover every row exactly once is pinned in
 * `apps/tower/test/alert-history.test.ts`.
 */
export function settledFlagsSql(alias = ''): string {
  const p = prefix(alias);
  return `(${p}resolved_at IS NOT NULL
            OR (${p}disposition IS NOT NULL
                AND ${p}disposition <> 'tune'
                AND (${p}disposition <> 'snooze' OR ${p}snooze_until IS NULL)))`;
}

/**
 * WHEN AN ALERT SETTLED: its resolution, else its disposition, else its firing
 * — what the settled-alert lists sort on and the Wall's feed bounds its
 * resolutions by.
 *
 * Written as CASE, not the COALESCE D1 used (bead ro-ujb9.76.5.2): the alerts
 * are on Postgres behind row security, and Postgres keeps a COALESCE condition
 * until after the workspace policy has run — it cannot tell a COALESCE cannot
 * leak — so a COALESCE bound can never seek the index on this time. A CASE it
 * can. The index (`flags_asset_settled`, db/postgres/migrations/0001_baseline.sql)
 * is on exactly this expression, so readers compose it rather than write it.
 */
export function settledAtSql(alias = ''): string {
  const p = prefix(alias);
  return `(CASE WHEN ${p}resolved_at IS NOT NULL THEN ${p}resolved_at WHEN ${p}disposition_at IS NOT NULL THEN ${p}disposition_at ELSE ${p}fired_at END)`;
}
