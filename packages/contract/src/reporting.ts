/** Reporting obligation and coverage: who owes the OS a nightly report, and
 * what the store can say about each one (docs/06 §ingest freshness).
 *
 * Freshness is a property of the asset set, never of the `pulses` table: read
 * from the pulses side, "of the properties that reported, how many reported
 * recently" is cheerfully "all of them" when a property has never reported.
 * The ingest freshness cron and the Tower's coverage summary both read this,
 * so "expected" and "stale" mean one thing on both sides of the wire.
 */

const HOUR_MS = 3_600_000;

/** The nightly obligation: one report per expected property per day (docs/02). */
export const REPORT_CADENCE_HOURS = 24;

/** How many cadences a property may miss before "late" becomes "stale". Two,
 * so a single late night is not an error flag that resolves itself by
 * morning. Also the rule for every age badge on the Wall. */
export const REPORT_STALE_MULTIPLIER = 2;

/**
 * The staleness age for the nightly report lane, in hours. One number: the
 * ingest cron fires its `ingest-freshness` error past it, and the Tower
 * counts the property `stale` past it. Nothing recomputes it.
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
 * Does this site expect a nightly report? The one answer: a site expects one
 * once it has sent one, and until the operator declares it sends none
 * (`config/constants.json` `no_nightly_report`). A site that has never sent
 * one has no sender, so it raises no warning; the first report that arrives
 * switches the expectation on by itself.
 *
 * "Has sent one" is the newest accepted report ever (`MAX(pulses.received_at)`),
 * never a recent window. A declared site that sends a report anyway still
 * expects none: its report is shown (`showsNightlyReport`), and its silence
 * afterwards is never an alert. Nothing the site sends rewrites config.
 */
export function expectsNightlyReport(
  declaredNoReport: boolean,
  latestReceivedAt: string | null | undefined,
): boolean {
  return !declaredNoReport && Boolean(latestReceivedAt);
}

/**
 * Is a nightly report owed? What every count of the obligation asks: the site
 * expects one ({@link expectsNightlyReport}) and its lifecycle stage reports
 * ({@link expectsReports}).
 */
export function owesNightlyReport(
  status: string,
  declaredNoReport: boolean,
  latestReceivedAt: string | null | undefined,
): boolean {
  return expectsReports(status) && expectsNightlyReport(declaredNoReport, latestReceivedAt);
}

/**
 * Whether a site's nightly slot shows its report as arriving (an age) rather
 * than the neutral "No report". An expected report always shows its age; a
 * report nobody expects shows only while it is inside the stale age, because
 * past it nothing is late.
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
 * Classify one property. `latestReceivedAt` is the `received_at` of its
 * newest accepted report, or null when it has none. A timestamp that will not
 * parse counts as `stale`: a report did arrive, it cannot be aged. A site owes
 * nothing it does not expect ({@link owesNightlyReport}).
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
 * caller can hand a surface a denominator that omits its bad news. */
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
