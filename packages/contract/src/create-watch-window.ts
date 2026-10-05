/** Cross-Worker contract for registering a pre-registered outcome check (docs/03).
 *
 * Same posture as the annotation write: the ingest Worker owns `watch_windows`
 * and the operator bearer guarding its HTTP lane, and the Control Tower is
 * served unauthenticated on the trusted LAN — so the Tower reaches this write
 * through the private INGEST Service Binding, where the binding itself is the
 * capability. Plain data crosses, never a credential.
 *
 * Every field is re-validated inside ingest. These types describe the shape a
 * caller INTENDS, not a shape ingest is willing to trust — which matters more
 * here than anywhere else in the OS, because the honesty of a watch window is
 * exactly the set of rules a convenient UI would be tempted to relax.
 */
import type { AnnotationIssue } from './create-annotation.js';

/**
 * The same `{path, code, message}` vocabulary every operator write reports.
 * Aliased rather than re-declared: two identical interfaces are two things to
 * keep in step.
 */
export type WatchWindowIssue = AnnotationIssue;

/** What the window is watching. Authority: `WATCH_REF_KINDS`, workers/ingest/src/watch-windows.ts. */
export type WatchRefKind = 'annotation' | 'decision' | 'manual';

/** The provider whose `signal_observations` series is measured. Authority:
 * `WATCH_INTEGRATIONS`, workers/ingest/src/watch-windows.ts. */
export type WatchMetricIntegration = 'ga4' | 'gsc' | 'bing-webmaster';

/** A registered predicate. `direction` is literal on the metric's OWN value, so
 * an improvement in average GSC `position` is `down`. */
export interface WatchThresholdInput {
  direction: 'up' | 'down';
  min_delta_pct: number;
}

/** One search query, as the operator typed it.
 *
 * GSC's retained `query` archive is one provider-final calendar day at query
 * grain, which is what makes this scope answerable. */
export interface WatchQueryScope {
  query: string;
}

/** One page, named the way a freeze entry names it.
 *
 * The retained `page` archive is the same provider-final daily shape at URL
 * grain. A value beginning with `/` is a route and matches the page on any host
 * the property covers — which is what a domain property mixes anyway, and what
 * a register entry means when it says `/water-intake-calculator`. An absolute
 * URL keeps its host, for the case where two hosts under one property are
 * genuinely different pages. */
export interface WatchPageScope {
  page: string;
}

/**
 * What a scoped window compares.
 *
 * Exactly one selector, never both: a window that narrowed twice would be
 * answering a question neither the archive nor the operator asked. Other scopes
 * stay out of this union until an equally durable daily source exists — an
 * open-ended object would let a caller register a question the evaluator cannot
 * answer.
 */
export type WatchScopeInput = WatchQueryScope | WatchPageScope;

/** Field-size boundary for a registered query and its private history read. */
export { WATCH_QUERY_MAX_CHARS, WATCH_CALIBRATION_DAYS } from './watch-series.mjs';

/** Field-size boundary for a registered page. Same ceiling as a query: both are
 * selectors, not payloads. */
export const WATCH_PAGE_MAX_CHARS = 2000;

/** A bead id ('mp-f0g.35'), not a title. */
export const WATCH_READBACK_BEAD_MAX = 128;

/**
 * The untruncated slice of the annotation ledger consulted for calibration.
 * `complete` means the store query covered every row inside these bounds; it
 * does not claim an operator recorded every real-world change.
 */
export interface WatchRecordedChangeCalendar {
  firstDay: string;
  lastDay: string;
  days: string[];
  complete: boolean;
}

/**
 * Dense provider-final history for one query-scoped GSC series.
 *
 * `values[0]` belongs to `firstDay`; a null is a day on which the retained
 * archive did not carry this query, never a measured zero. `archiveFirstDay`
 * and `archiveLastDay` describe the retained daily archive itself, while
 * `observedDays` counts the days on which this exact query supplied the metric.
 * Keeping both is what lets a UI say "Google was collected, but this query was
 * suppressed/absent" without collapsing the two facts.
 */
export interface WatchQueryHistory {
  integration: 'gsc';
  metric: string;
  query: string;
  firstDay: string;
  values: (number | null)[];
  archiveFirstDay: string | null;
  archiveLastDay: string | null;
  archiveDays: number;
  observedDays: number;
  recordedChanges: WatchRecordedChangeCalendar;
}

/** Private Tower→ingest RPC input for the bounded query-history read. */
export interface WatchQueryHistoryInput {
  asset: string;
  metric: string;
  query: string;
  first_day: string;
  last_day: string;
}

/**
 * One measurable series, named once for the whole OS.
 *
 * A metric name alone does not identify a series — `clicks` is a different
 * number depending on the provider — so the integration always travels with it,
 * exactly as the schema stores it. `improvesWhen` is what stops a UI from
 * asking the operator which direction is good: for average search position, it
 * is `down`, and a composer that defaulted `ship` to `up` would pre-register a
 * predicate that fires on the property getting worse.
 */
export interface WatchSeries {
  integration: WatchMetricIntegration;
  metric: string;
  /** Operator words, provider first. The Tower renders exactly this string. */
  label: string;
  improvesWhen: 'up' | 'down';
  /**
   * How a day's values combine across a window — and therefore whether the
   * series can be bet on property-wide at all.
   *
   * A `sum` is scope-independent: clicks are clicks whether they arrived on one
   * page or forty, so a property total answers the same question a page total
   * does, one level up. A `mean` is an average over whatever the property
   * happened to appear for, so it moves whenever the query mix moves — a change
   * that earns impressions on searches you rank badly for drags the property
   * average down while winning. Registering a `mean` property-wide measures the
   * mix as much as the change, which is why `watchScopeRequired` refuses it.
   */
  aggregation: 'sum' | 'mean';
}

/**
 * Whether this series may only be registered inside a scope.
 *
 * The rule in one line: bet property-wide on sums, bet scoped on averages.
 * Authority for the aggregations themselves is ingest's `WATCH_METRICS`, which
 * an ingest test pins against `WATCH_SERIES` field by field.
 */
export function watchScopeRequired(series: WatchSeries): boolean {
  return series.aggregation === 'mean';
}

/**
 * Every series a watch window may name, in the order a chooser should show them.
 *
 * This is the same vocabulary as ingest's `WATCH_METRICS` (and db/0012's CHECK
 * constraint) with operator labels attached; an ingest test asserts the two
 * cover each other exactly, so adding a metric on one side fails the suite
 * rather than silently leaving a chooser one option short.
 */
export { WATCH_SERIES } from './watch-series.mjs';

/**
 * How much of a window must carry observations before the evaluator will read a
 * verdict out of it. Authority: `MIN_WINDOW_COVERAGE`,
 * workers/ingest/src/watch-windows.ts — an ingest test asserts the two agree, so
 * changing one fails the suite rather than silently letting two surfaces
 * disagree about what "measurable" means.
 *
 * It lives in the contract because it is not only the evaluator's business: a
 * threshold CALIBRATED from history has to skip the same thin stretches the
 * evaluator would refuse to judge, or the noise floor it reports is measured
 * over comparisons that would never be made (bead `ro-5e8.2`).
 */
export const WATCH_MIN_WINDOW_COVERAGE = 0.8;

/** The registration a caller is asking for. Field names are the store's and the
 * HTTP route's, so one shape is documented, posted, and RPC'd. */
export interface CreateWatchWindowInput {
  asset: string;
  ref_kind: WatchRefKind;
  /** The thing being watched: an annotation id, a decision key, or free text. */
  ref: string;
  metric_integration: WatchMetricIntegration;
  metric: string;
  /** ISO-8601. Absent means "now" by ingest's clock. */
  registered_at?: string | null;
  /** The PRE-change comparison window, inclusive `YYYY-MM-DD` dates. */
  baseline_start: string;
  baseline_end: string;
  /** Whole days after `registered_at`; the largest is the final check. */
  check_offsets: number[];
  thresholds?: { ship?: WatchThresholdInput; kill?: WatchThresholdInput } | null;
  /** Optional query or page grain, evaluated from the retained daily GSC archive. */
  scope?: WatchScopeInput | null;
  note?: string | null;
  /**
   * The bead that owns the reading — a spoke's freeze register names one per
   * entry, and the verdict is posted there when the window closes.
   *
   * A documented pointer, never checked against the register: a bet must not
   * fail to register because the beads mirror is stale.
   */
  readback_bead?: string | null;
}

/** One `watch_windows` row as the store holds it (db/0012, snake_case). */
export interface WatchWindowRow {
  id: string;
  asset: string;
  ref_kind: string;
  ref: string;
  metric_integration: string;
  metric: string;
  scope_json: string | null;
  registered_at: string;
  baseline_start: string;
  baseline_end: string;
  check_offsets_json: string;
  thresholds_json: string | null;
  readings_json: string;
  status: string;
  outcome: string | null;
  last_checked_at: string | null;
  closed_at: string | null;
  note: string | null;
  outcome_note: string | null;
  created_at: string;
  /** The bead owed this window's reading, or null when nothing claimed it. */
  readback_bead: string | null;
  /** When the verdict was posted to that bead. Null while a closed window's
   * answer has not reached it yet — which is exactly the runner's work queue. */
  readback_posted_at: string | null;
}

/**
 * The outcome of one registration attempt.
 *
 * A rejected field and an unknown asset are RESULTS, not thrown errors — both
 * are ordinary answers a caller renders. Only an infrastructure failure throws.
 * There is no idempotent case: unlike an annotation, a second registration of
 * the same question is a second question, and collapsing them would silently
 * discard the offsets or thresholds the operator just chose.
 */
export type CreateWatchWindowResult =
  /** `created: false` is a re-registration of a bet the store already holds —
   * the same asset, ref, series and scope. Registering is idempotent because a
   * spoke syncs its whole freeze register every ship, and a producer punished
   * for re-sending would learn to send less. */
  | { ok: true; created: boolean; watchWindow: WatchWindowRow }
  | { ok: false; error: 'validation'; issues: WatchWindowIssue[] }
  | { ok: false; error: 'unknown_asset'; asset: string };
