/** Reporting obligation and coverage — who owes the OS a nightly report, and
 * what the store can honestly say about each one (docs/06 §ingest freshness,
 * docs/19 finding 5).
 *
 * Freshness is a property of the ASSET SET, never of the `pulses` table. Read
 * from the pulses side it answers a different question — "of the properties
 * that reported, how many reported recently" — whose answer is a cheerful "all
 * of them" on the morning a property has never reported at all. The obligation
 * lives on the asset row's lifecycle, so that is where the denominator comes
 * from, and a property with zero reports is a STATE, not a missing row.
 *
 * WHO EXPECTS A REPORT is one answer, `expectsNightlyReport`: a site that has
 * sent one and has not been declared as sending none (D29, amended 2026-09-23).
 * A site that has never sent one is not a failure — nobody set up a sender for
 * it — so it is `not-expected`, like a declared one; the first report that
 * arrives puts it in the denominator by itself, and from then on its silence
 * is the stale state.
 *
 * Both the ingest freshness cron and the Tower's coverage summary read this, so
 * "expected" cannot come to mean two things on the two sides of the wire — and
 * neither can "stale": the age they measure it at is `REPORT_MAX_AGE_HOURS`,
 * defined here once for both.
 */

const HOUR_MS = 3_600_000;

/** The nightly obligation: one report per expected property per day (docs/02). */
export const REPORT_CADENCE_HOURS = 24;

/** How many cadences a property may miss before "late" becomes "stale". Two, so
 * a single late night — a retried collector, a provider that published at noon —
 * is not an error flag that resolves itself by morning. It takes two consecutive
 * silent nights to earn the operator's attention. This is also doc 10 principle
 * 2's rule for every age badge on the Wall, so the report lane and the badge
 * beside it are the same rule rather than two numbers that happen to agree. */
export const REPORT_STALE_MULTIPLIER = 2;

/**
 * THE staleness age for the nightly report lane, in hours — 48.
 *
 * ONE number, because both surfaces speak about the same property in the same
 * payload: the ingest cron fires its `ingest-freshness` error past this age, and
 * the Tower counts the property `stale` past this age. They disagreed once
 * (36h vs 48h), which put a property at 40h in ATTENTION as an open error while
 * the SYSTEM card counted it fresh — two contradictory sentences about one
 * property, rendered side by side (ro-uwo.1). Anything that wants to call a
 * report late reads this; nothing recomputes it.
 */
export const REPORT_MAX_AGE_HOURS = REPORT_CADENCE_HOURS * REPORT_STALE_MULTIPLIER;

/** Lifecycle states that owe no report: not launched yet, or decommissioned.
 * Everything else — onboarding, baselining, live — owes the report it expects
 * ({@link owesNightlyReport}). */
export const NON_REPORTING_STATUSES = ['pre-launch', 'retired'] as const;

/** Does this `assets.status` carry a reporting obligation? */
export function expectsReports(status: string): boolean {
  return !(NON_REPORTING_STATUSES as readonly string[]).includes(status);
}

/**
 * DOES THIS SITE EXPECT A NIGHTLY REPORT? The one answer (D29, amended
 * 2026-09-23, bead `ro-ujb9.121`).
 *
 * A site expects one once it has SENT one, and until the operator declares it
 * sends none (`config/constants.json` `no_nightly_report`, read with
 * `noNightlyReportAssets`). The report is a push the site's own code makes, so
 * a site that has never sent one has no sender, and nobody chose one for it: a
 * new site raises no warning anywhere, and the first report that arrives
 * switches the expectation on by itself. From then on a sender that stops is
 * late, then stale, exactly as before.
 *
 * "Has sent one" is the newest accepted report ever (`MAX(pulses.received_at)`,
 * a table that is never truncated), never a recent window — a site that went
 * quiet a year ago still expects its report.
 *
 * A declared site that sends a report anyway still expects none: its report is
 * accepted and shown (`showsNightlyReport`), and its silence afterwards is the
 * state it declared, never an alert. The declaration is the operator's and
 * stays until they switch it off; nothing the site sends rewrites config.
 */
export function expectsNightlyReport(
  declaredNoReport: boolean,
  latestReceivedAt: string | null | undefined,
): boolean {
  return !declaredNoReport && Boolean(latestReceivedAt);
}

/**
 * IS A NIGHTLY REPORT OWED TODAY? What every count of the obligation asks —
 * the ingest freshness cron, the SYSTEM fraction, Needs you: the site expects
 * one ({@link expectsNightlyReport}) and its lifecycle stage reports
 * ({@link expectsReports}). One rule on both sides of the wire, so a site can
 * never be failing on one and exempt on the other.
 */
export function owesNightlyReport(
  status: string,
  declaredNoReport: boolean,
  latestReceivedAt: string | null | undefined,
): boolean {
  return expectsReports(status) && expectsNightlyReport(declaredNoReport, latestReceivedAt);
}

/**
 * Whether a site's nightly slot shows its report as ARRIVING — an age — rather
 * than the neutral "No report". An expected report always shows its age (a
 * late one is the stale state); a report nobody expects — a declared site that
 * sent one anyway — shows only while it is inside the stale age, because past
 * it nothing is late, there is just no report. A site that has never sent one
 * shows "No report".
 */
export function showsNightlyReport(
  declaredNoReport: boolean,
  latestReceivedAt: string | null | undefined,
  nowMs: number,
  maxAgeHours: number = REPORT_MAX_AGE_HOURS,
): boolean {
  if (expectsNightlyReport(declaredNoReport, latestReceivedAt)) return true;
  if (!latestReceivedAt) return false;
  const receivedMs = Date.parse(latestReceivedAt);
  return Number.isFinite(receivedMs) && nowMs - receivedMs <= maxAgeHours * HOUR_MS;
}

/** The rule id of the flag the ingest freshness cron fires for a report that
 * is owed and missing (`workers/ingest/src/db.ts` `FRESHNESS_RULE_ID`). */
export const REPORT_FRESHNESS_RULE_ID = 'ingest-freshness';

/**
 * An open freshness flag the declaration has released: the asset no longer owes
 * the report the flag is about. The next freshness run resolves it; until then
 * every reader leaves it out, so a Save on the Settings switch clears the Wall
 * at once rather than an hour later.
 */
export function releasedFreshnessFlag(
  flag: { ruleId: string; asset: string },
  declared: ReadonlySet<string>,
): boolean {
  return flag.ruleId === REPORT_FRESHNESS_RULE_ID && declared.has(flag.asset);
}

/** What the store knows about a property's current reporting obligation. */
export type ReportingState = 'fresh' | 'stale' | 'not-expected';

/**
 * Classify one property. `latestReceivedAt` is the `received_at` of its newest
 * accepted report, or null when it has none — ever.
 *
 * A row whose timestamp will not parse counts as `stale`: a report did arrive,
 * we simply cannot age it, and unreadable is a defect on the healthy side of
 * nothing-at-all.
 *
 * A site owes nothing it does not expect ({@link owesNightlyReport}): one that
 * has never sent a report, one the operator declared as sending none and a
 * pre-launch or retired one are all `not-expected`, outside the denominator.
 */
export function reportingState(
  status: string,
  latestReceivedAt: string | null | undefined,
  nowMs: number,
  maxAgeHours: number,
  declaredNoReport = false,
): ReportingState {
  if (!latestReceivedAt || !owesNightlyReport(status, declaredNoReport, latestReceivedAt)) return 'not-expected';
  const receivedMs = Date.parse(latestReceivedAt);
  if (!Number.isFinite(receivedMs)) return 'stale';
  return nowMs - receivedMs > maxAgeHours * HOUR_MS ? 'stale' : 'fresh';
}

/** A portfolio's reporting posture, counted over the FULL expected set. */
export interface ReportingCoverage {
  fresh: number;
  stale: number;
  /** Pre-launch, retired, never sent a report, or declared as sending none:
   * outside the denominator, still counted so the surfaces can say why the
   * portfolio is bigger than the expected set. */
  notExpected: number;
  /** The denominator every freshness claim is measured against:
   * `fresh + stale`. */
  expected: number;
}

export function emptyReportingCoverage(): ReportingCoverage {
  return { fresh: 0, stale: 0, notExpected: 0, expected: 0 };
}

/** Tally states into a coverage. The expected total is derived here, so no
 * caller can hand a surface a denominator that omits its own bad news. */
export function summarizeReporting(states: Iterable<ReportingState>): ReportingCoverage {
  const coverage = emptyReportingCoverage();
  for (const state of states) {
    if (state === 'fresh') coverage.fresh += 1;
    else if (state === 'stale') coverage.stale += 1;
    else coverage.notExpected += 1;
  }
  coverage.expected = coverage.fresh + coverage.stale;
  return coverage;
}

/**
 * "All fresh" is a claim about the whole expected set, so it is true only when
 * every expected property reported recently — and never over an empty set,
 * where it would be a reassurance about nothing.
 */
export function isAllFresh(coverage: ReportingCoverage): boolean {
  return coverage.expected > 0 && coverage.fresh === coverage.expected;
}

/** The worst state among expected reporters; null when none owes a report. */
export function worstReportingState(
  coverage: ReportingCoverage,
): Exclude<ReportingState, 'not-expected'> | null {
  if (coverage.stale > 0) return 'stale';
  if (coverage.expected > 0) return 'fresh';
  return null;
}
