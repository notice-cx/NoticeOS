/** Cross-Worker contract for registering a pre-registered outcome check
 * (docs/03). The ingest Worker owns `watch_windows`; the Tower reaches the
 * write through the private ingest Service Binding, and plain data crosses,
 * never a credential. Every field is re-validated inside ingest: these types
 * describe the shape a caller intends, not one ingest trusts.
 */
import type { ValidationIssue } from './validation-issue.js';

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

/** One search query, as the operator typed it. GSC's retained `query`
 * archive is one provider-final calendar day at query grain. */
export interface WatchQueryScope {
  query: string;
}

/** One page, named the way a freeze entry names it. A value beginning with
 * `/` is a route and matches the page on any host the property covers; an
 * absolute URL keeps its host, for two hosts under one property that are
 * genuinely different pages. */
export interface WatchPageScope {
  page: string;
}

/**
 * What a scoped window compares. Exactly one selector, never both; other
 * scopes stay out of this union until an equally durable daily source exists.
 */
export type WatchScopeInput = WatchQueryScope | WatchPageScope;

/** Field-size boundary for a registered query and its private history read. */
export { WATCH_QUERY_MAX_CHARS, WATCH_CALIBRATION_DAYS } from './watch-series.mjs';

/** Field-size boundary for a registered page. Same ceiling as a query: both are
 * selectors, not payloads. */
export const WATCH_PAGE_MAX_CHARS = 2000;

/** A task id, not a title. */
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
 * Dense provider-final history for one query-scoped GSC series. `values[0]`
 * belongs to `firstDay`; a null is a day on which the retained archive did
 * not carry this query, never a measured zero. `archiveFirstDay` and
 * `archiveLastDay` describe the retained archive itself; `observedDays` counts
 * the days on which this exact query supplied the metric.
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
 * One measurable series, named once for the whole OS. A metric name alone
 * does not identify a series (`clicks` differs by provider), so the
 * integration always travels with it. `improvesWhen` is what stops a UI from
 * asking the operator which direction is good: for average search position it
 * is `down`.
 */
export interface WatchSeries {
  integration: WatchMetricIntegration;
  metric: string;
  /** Operator words, provider first. The Tower renders exactly this string. */
  label: string;
  improvesWhen: 'up' | 'down';
  /**
   * How a day's values combine across a window. A `sum` is scope-independent.
   * A `mean` moves whenever the query mix moves, so registering one
   * property-wide measures the mix as much as the change; `watchScopeRequired`
   * refuses it.
   */
  aggregation: 'sum' | 'mean';
}

/**
 * Whether this series may only be registered inside a scope: bet
 * property-wide on sums, scoped on averages. Authority for the aggregations
 * is ingest's `WATCH_METRICS`, which an ingest test pins against
 * `WATCH_SERIES`.
 */
export function watchScopeRequired(series: WatchSeries): boolean {
  return series.aggregation === 'mean';
}

/**
 * Every series a watch window may name, in the order a chooser should show
 * them: the same vocabulary as ingest's `WATCH_METRICS` with operator labels
 * attached; an ingest test asserts the two cover each other exactly.
 */
export { WATCH_SERIES } from './watch-series.mjs';

/**
 * How much of a window must carry observations before the evaluator will read
 * a verdict out of it. Authority: `MIN_WINDOW_COVERAGE`,
 * workers/ingest/src/watch-windows.ts; an ingest test asserts the two agree.
 * In the contract because a threshold calibrated from history has to skip the
 * same thin stretches the evaluator would refuse to judge.
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
   * The task that owns the reading; the verdict is posted there when the
   * window closes. A documented pointer, never checked against the task hub:
   * a bet must not fail to register because the task mirror is stale.
   */
  readback_bead?: string | null;
}

/** One `watch_windows` row as the store holds it (snake_case). */
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
  /** The task owed this window's reading, or null when nothing claimed it. */
  readback_bead: string | null;
  /** When the verdict was posted to that task. Null while a closed window's
   * answer has not reached it yet, which is the runner's work queue. */
  readback_posted_at: string | null;
}

/**
 * The outcome of one registration attempt. A rejected field and an unknown
 * asset are results, not thrown errors; only an infrastructure failure throws.
 */
export type CreateWatchWindowResult =
  /** `created: false` is a re-registration of a bet the store already holds —
   * the same asset, ref, series and scope. Idempotent because a spoke syncs
   * its whole freeze register every ship. */
  | { ok: true; created: boolean; watchWindow: WatchWindowRow }
  | { ok: false; error: 'validation'; issues: ValidationIssue[] }
  | { ok: false; error: 'unknown_asset'; asset: string };
