// Opening a pre-registered outcome check from the Tower: what the composer
// prefills from, and what it refuses on. Every refusal here mirrors a 422 the
// ingest route already issues (workers/ingest/src/routes/watch-windows.ts);
// the route stays the authority, and this only tells the operator earlier.
// `WATCH_SERIES` (@noticeos/contract) names the measurable series once.

import {
  WATCH_MIN_WINDOW_COVERAGE,
  WATCH_SERIES,
  watchScopeRequired,
  type WatchQueryHistory,
  type WatchQueryScope,
  type WatchRecordedChangeCalendar,
  type WatchScopeInput,
  type WatchSeries,
} from "@noticeos/contract/create-watch-window";

export type {
  WatchQueryHistory,
  WatchRecordedChangeCalendar,
} from "@noticeos/contract";

/** The baseline the composer proposes: four whole weeks. Long enough to
 * survive one bad week, short enough that the final check is not a season
 * away. */
export const WATCH_BASELINE_DAYS = 28;

/** How long until the verdict, offered as whole windows rather than a free
 * number: the final check must be at least the baseline's length or its post
 * window reaches back over the change, so these are the honest choices for a
 * 28-day baseline and the composer re-checks the constraint after any edit. */
export const WATCH_VERDICT_DAYS = [28, 56, 90] as const;

/**
 * The predicate to fall back on when this asset's own archives cannot supply
 * one: symmetric, "call it a win at +10%, a loss at −10%". A last resort, used
 * when a series has no usable history, and the composer says which of the two
 * it is showing.
 */
export const WATCH_DEFAULT_DELTA_PCT = 10;

// ---------------------------------------------------------------------------
// Per-asset threshold calibration
// ---------------------------------------------------------------------------

/** How far back the calibration reads. Long enough that a 28-day window has
 * many historical comparisons to be measured over, short enough that an asset's
 * behaviour a season ago does not outvote what it does now. */
export { WATCH_CALIBRATION_DAYS } from "@noticeos/contract/create-watch-window";

/** The share of a window that must carry observations before the calibration
 * will count it — the evaluator's rule, re-exported rather than restated. */
export { WATCH_MIN_WINDOW_COVERAGE };

/**
 * One asset's own daily values for one measurable series, as the calibration
 * reads them. Dense by calendar day, `null` where the asset has no
 * observation: the evaluator's per-day figure divides by the days it observed
 * and its coverage rule counts the holes.
 */
export interface WatchSeriesHistory {
  integration: string;
  metric: string;
  /** The calendar day `values[0]` belongs to. */
  firstDay: string;
  values: (number | null)[];
  /** Present only when the full annotation-ledger range was queried. Older
   * payloads omit it and therefore cannot claim a change-filtered floor. */
  recordedChanges?: WatchRecordedChangeCalendar;
}

/**
 * What this asset's own numbers do outside pairs that cross recorded changes
 * — the floor a registered threshold has to clear to mean anything. An older
 * payload without the full annotation calendar remains measurable but is
 * labelled historical-only, never change-filtered.
 */
export interface WatchCalibration {
  /** The window length the floor was measured at: the baseline's own span,
   * never a fixed number, because a floor measured at another length describes
   * a different comparison. */
  windowDays: number;
  /** Adjacent window pairs the floor was measured over. They overlap, so this
   * is a count of comparisons, not of independent samples. */
  comparisons: number;
  /** Median absolute percent change across those historical pairs. */
  typicalPct: number;
  /** The 90th percentile: nine in ten historical pairs moved less than this. */
  floorPct: number;
  /** The smallest whole percent above the floor — what the composer prefills. */
  suggestedPct: number;
  /** The observed span the floor was read from, for the sentence that says
   * where the number came from. */
  firstDay: string;
  lastDay: string;
  /** Bounds of the annotation-ledger query used to remove confounded pairs. */
  changeCalendarFirstDay: string | null;
  changeCalendarLastDay: string | null;
  /** Distinct calendar days carrying at least one recorded change. */
  recordedChangeDays: number;
  /** Candidate pairs rejected because one of those days fell inside them. */
  excludedComparisons: number;
  /** True only when the calendar covers this history from first through last. */
  changeCalendarComplete: boolean;
}

/**
 * Derive the noise floor for one series at one window length, using the
 * evaluator's own arithmetic (workers/ingest/src/watch-windows.ts): mean daily
 * value over the post window against mean daily value over the baseline, as a
 * percent of the baseline, made over every adjacent pair of `windowDays`-long
 * windows the history holds. Every pair crossing a day in the supplied
 * annotation calendar is excluded before the percentiles are taken; without a
 * complete calendar the result records that it is historical-only.
 *
 * Three rules are the evaluator's, not this function's: a window under
 * `WATCH_MIN_WINDOW_COVERAGE` is skipped, a zero baseline is skipped, and the
 * per-day figure is the mean over observed days. `null` when the history
 * cannot support even one comparison.
 */
export function watchCalibration(
  history: WatchSeriesHistory | null | undefined,
  windowDays: number,
): WatchCalibration | null {
  if (!history || !Number.isFinite(windowDays) || windowDays < 2) return null;
  const { values } = history;
  const needed = windowDays * 2;
  if (values.length < needed) return null;

  const historyLastDay = shiftDay(history.firstDay, values.length - 1);
  const calendar = history.recordedChanges;
  const changeCalendarComplete = Boolean(
    calendar?.complete &&
      calendar.firstDay <= history.firstDay &&
      calendar.lastDay >= historyLastDay,
  );
  const changeOffsets = new Set(
    (calendar?.days ?? []).flatMap((day) => {
      const offset = Math.round(
        (Date.parse(`${day}T00:00:00.000Z`) -
          Date.parse(`${history.firstDay}T00:00:00.000Z`)) /
          86_400_000,
      );
      return Number.isInteger(offset) && offset >= 0 && offset < values.length
        ? [offset]
        : [];
    }),
  );
  const changeOffsetList = [...changeOffsets];

  const deltas: number[] = [];
  let excludedComparisons = 0;
  for (let end = values.length; end >= needed; end -= 1) {
    const start = end - needed;
    if (changeOffsetList.some((offset) => offset >= start && offset < end)) {
      excludedComparisons += 1;
      continue;
    }
    const baseline = values.slice(end - needed, end - windowDays);
    const post = values.slice(end - windowDays, end);
    const before = windowPerDay(baseline);
    const after = windowPerDay(post);
    if (before === null || after === null || before === 0) continue;
    deltas.push(Math.abs(((after - before) / before) * 100));
  }
  if (deltas.length === 0) return null;

  deltas.sort((a, b) => a - b);
  const floorPct = percentile(deltas, 0.9);
  return {
    windowDays,
    comparisons: deltas.length,
    typicalPct: round1(percentile(deltas, 0.5)),
    floorPct: round1(floorPct),
    // Strictly above the floor: a threshold equal to it fires on the historical
    // pair that produced it. `Math.floor(x) + 1` clears an exact integer floor
    // too, which `Math.ceil` would not.
    suggestedPct: Math.max(1, Math.floor(floorPct) + 1),
    firstDay: shiftDay(history.firstDay, firstObserved(values)),
    lastDay: shiftDay(history.firstDay, lastObserved(values)),
    changeCalendarFirstDay: calendar?.firstDay ?? null,
    changeCalendarLastDay: calendar?.lastDay ?? null,
    recordedChangeDays: changeOffsets.size,
    excludedComparisons,
    changeCalendarComplete,
  };
}

/**
 * What the composer's threshold stands on — a code and its evidence, never a
 * sentence. A calibration beside a query scope is admissible only with the
 * query history that proves its grain, so a caller cannot relabel the site
 * calibration as a query floor.
 */
export type WatchCalibrationBasis =
  /** Measured on this asset's own series. */
  | { kind: "asset"; calibration: WatchCalibration }
  /** Measured on the one query's own daily Google history. */
  | { kind: "query"; calibration: WatchCalibration; history: WatchQueryHistory }
  /** Nothing to measure from: the threshold is `WATCH_DEFAULT_DELTA_PCT`. */
  | { kind: "none"; gap: WatchCalibrationGap };

export type WatchCalibrationGap =
  /** The asset's series cannot support two coverage-valid windows. */
  | "short-history"
  /** The query archive exists, but too few of its days carry this query. */
  | "query-sparse"
  /** No retained daily Google query span at all. */
  | "no-query-archive";

export function watchCalibrationBasis(
  calibration: WatchCalibration | null,
  scope: WatchQueryScope | null = null,
  queryHistory: WatchQueryHistory | null = null,
): WatchCalibrationBasis {
  if (scope) {
    if (calibration && queryHistory) {
      return { kind: "query", calibration, history: queryHistory };
    }
    const archive = Boolean(queryHistory?.archiveFirstDay && queryHistory.archiveLastDay);
    return { kind: "none", gap: archive ? "query-sparse" : "no-query-archive" };
  }
  return calibration
    ? { kind: "asset", calibration }
    : { kind: "none", gap: "short-history" };
}

/** The days a registration made today would be read on — the interim checks
 * and, last, the verdict — as calendar days, so the composer can show the plan
 * as dates rather than as "read again 7 · 14 · 28 days from today". */
export function watchCheckDates(today: string, verdictDays: number): string[] {
  return watchCheckOffsets(verdictDays).map((offset) => shiftDay(today, offset));
}

/** The evaluator's window figure: mean over the days actually observed, or null
 * when the window is too full of holes to judge. */
function windowPerDay(window: (number | null)[]): number | null {
  const observed = window.filter((value): value is number => value !== null);
  if (window.length === 0) return null;
  if (observed.length / window.length < WATCH_MIN_WINDOW_COVERAGE) return null;
  if (observed.length === 0) return null;
  return observed.reduce((sum, value) => sum + value, 0) / observed.length;
}

/** Nearest-rank on a sorted ascending array. No interpolation: the samples are
 * overlapping windows rather than independent draws, and a value between two
 * observed moves would be a precision this estimate has not earned. */
function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

function firstObserved(values: (number | null)[]): number {
  return values.findIndex((value) => value !== null);
}

function lastObserved(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== null) return i;
  }
  return 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A metric name alone does not identify a series, so the provider travels with
 * it — exactly as the schema stores it. One lookup for every surface: the
 * chooser, the pending list, and the closed verdict all print this string. */
export function watchSeriesLabel(
  integration: string,
  metric: string,
): string {
  const known = WATCH_SERIES.find(
    (series) => series.integration === integration && series.metric === metric,
  );
  if (known) return known.label;
  // A row the store holds and this build does not know about still has to
  // render as something an operator can read.
  const provider =
    integration === "ga4" ? "Analytics" : integration === "gsc" ? "Google" : "Bing";
  return `${provider} ${metric.replace(/_/g, " ")}`;
}

/**
 * The one query or page a stored window measures, or null for the whole site.
 * Read defensively: `watch_windows.scope_json` predates the registration
 * boundary that now validates it, so anything but one non-empty selector is
 * treated as no scope to show rather than thrown.
 */
export function storedWatchScope(json: string | null): WatchScopeInput | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) return null;
    const [key, selected] = entries[0]!;
    if (typeof selected !== "string" || selected.trim().length === 0) return null;
    if (key === "query") return { query: selected.trim() };
    if (key === "page") return { page: selected.trim() };
    return null;
  } catch {
    return null;
  }
}

/** How a scoped window's selector reads beside its series: the query in
 * quotes, a page as its path or URL. */
export function watchScopeText(scope: WatchScopeInput): string {
  return "query" in scope ? `“${scope.query}”` : scope.page;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The evaluator's figures from a closed window's note. Older notes begin with
 * the store's own words for the series, its scope and the check (`gsc/clicks
 * for query “x” at +28d: `), which the row already shows as its title; that
 * exact prefix is removed on the read side, because the store is never
 * rewritten. Any other note is returned as stored.
 */
export function watchVerdictFigures(
  note: string | null,
  integration: string,
  metric: string,
): string | null {
  if (note === null) return null;
  const series = `${escapeRegExp(integration)}/${escapeRegExp(metric)}`;
  const legacy = new RegExp(`^${series}(?: for (?:query “.*?”|page .+?))?(?: at \\+\\d+d)?: `);
  const figures = note.replace(legacy, "");
  return figures.length > 0 ? figures : note;
}

/**
 * The baseline for a change that happened on `changeDay`: the whole
 * `WATCH_BASELINE_DAYS` ending the day BEFORE it.
 *
 * The day of the change is excluded on purpose. A change ships at some hour, so
 * its own day is part before and part after — including it puts a slice of the
 * thing being measured inside the window it is measured against.
 */
export function watchBaselineFor(changeDay: string): {
  start: string;
  end: string;
} {
  const end = shiftDay(changeDay, -1);
  return { start: shiftDay(end, -(WATCH_BASELINE_DAYS - 1)), end };
}

/**
 * The checks a verdict horizon implies: the final one, plus reads at a quarter
 * and a half of the way there.
 *
 * The interim reads are not verdicts and the evaluator says so — an offset
 * shorter than the baseline necessarily reaches back over the change, and each
 * reading records how far. They exist so a window that is going badly is
 * visible before its final date, not so it can be closed early.
 */
export function watchCheckOffsets(verdictDays: number): number[] {
  const interims = [Math.round(verdictDays / 4), Math.round(verdictDays / 2)];
  const offsets = new Set<number>();
  for (const day of interims) {
    if (day >= 1 && day < verdictDays) offsets.add(day);
  }
  offsets.add(verdictDays);
  return [...offsets].sort((a, b) => a - b);
}

/** Whole days from `start` to `end` inclusive — the same span the ingest route
 * measures a baseline in, so the two agree about what "28 days" is. */
export function watchDaySpan(start: string, end: string): number {
  return Math.round((dayMs(end) - dayMs(start)) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Opening the composer from somewhere other than the timeline
// ---------------------------------------------------------------------------

/** What a surface (a query row, a finding card) knows about the check it is
 * asking to open. */
export interface WatchSeed {
  /** What the operator was looking at, in their words — the composer's note,
   * and its `ref` when there is no timeline event to point at. */
  subject: string;
  /** The series that row or card is about, so the operator is not re-choosing a
   * metric the surface already knows. */
  series: WatchSeries;
  /** The exact query this row asks about. GSC series retain this scope; changing
   * the composer to a provider without a query-grain archive visibly widens it
   * to the asset instead of silently carrying or dropping the selector. */
  query: string | null;
  /**
   * The task somebody filed from this row or card, when one exists. It becomes
   * the window's `ref`; the task's closure never implies a verdict — closed
   * means shipped, not proven. `null` when nothing was filed or the register
   * could not be asked, which leaves the ref as the operator's own words.
   */
  beadId: string | null;
}

/** The exact query selector a GSC series keeps from a seeded query, or null. */
export function watchScopeFor(
  seed: WatchSeed | null,
  series: WatchSeries,
): WatchQueryScope | null {
  if (!seed?.query || series.integration !== "gsc") return null;
  return { query: seed.query };
}

/**
 * What a seeded query's check will actually judge, as a state the composer
 * draws before the operator registers. `query`: only that query's daily Google
 * row is compared. `widened`: the chosen provider keeps no query-grain series,
 * so the check is asset-wide. `null` when nothing was narrowed.
 */
export type WatchScopeState =
  | { kind: "query"; query: string }
  | { kind: "widened"; query: string };

export function watchScopeState(
  seed: WatchSeed | null,
  series: WatchSeries,
): WatchScopeState | null {
  if (!seed?.query) return null;
  return series.integration === "gsc"
    ? { kind: "query", query: seed.query }
    : { kind: "widened", query: seed.query };
}

/**
 * The series a finding is about, read off its own sources. A finding names its
 * provider, not a metric, so the metric is that provider's headline outcome.
 * A finding sourced only from providers the evaluator cannot read returns
 * null, and the composer falls back to the asset's own default lane.
 */
export function watchSeriesForSources(
  sources: readonly string[],
): WatchSeries | null {
  const headline: Record<string, string> = {
    gsc: "clicks",
    "bing-webmaster": "clicks",
    ga4: "sessions",
  };
  for (const source of sources) {
    const integration = source.split("/")[0] ?? "";
    const metric = headline[integration];
    if (!metric) continue;
    const series = WATCH_SERIES.find(
      (option) => option.integration === integration && option.metric === metric,
    );
    if (series) return series;
  }
  return null;
}

/** What the operator has chosen so far. Not the request body: `asset` is the
 * page's, and the body is derived once, by `watchDraftBody`. */
export interface WatchDraft {
  refKind: "annotation" | "decision" | "manual";
  ref: string;
  series: WatchSeries;
  baselineStart: string;
  baselineEnd: string;
  verdictDays: number;
  minDeltaPct: number;
  note: string;
  scope: WatchQueryScope | null;
}

/** One reason a draft cannot be registered, in the operator's words. `field`
 * names the control to point at; the sentence is what the route would have
 * said, said earlier. */
export interface WatchDraftIssue {
  field: "ref" | "baseline" | "verdict" | "threshold" | "series";
  message: string;
}

/**
 * Every refusal the ingest route would issue, checked while the form is still
 * open. `today` is the calendar day the registration would carry.
 *
 * The order matters: the operator fixes one thing at a time, and the composer
 * shows the first issue rather than a wall of them.
 */
export function watchDraftIssues(
  draft: WatchDraft,
  today: string,
): WatchDraftIssue[] {
  const issues: WatchDraftIssue[] = [];
  if (watchScopeRequired(draft.series) && draft.scope === null) {
    // The route's rule: an average is taken over whatever the asset appeared
    // for, so asset-wide it reads the query mix as much as the change.
    issues.push({
      field: "series",
      message: `${draft.series.label} needs one query — watch it from Search`,
    });
  }
  if (draft.ref.trim().length === 0) {
    issues.push({ field: "ref", message: "Name what changed — a watch is a check on something." });
  }
  if (!isDay(draft.baselineStart) || !isDay(draft.baselineEnd)) {
    issues.push({ field: "baseline", message: "The baseline needs two calendar dates." });
    return issues;
  }
  if (draft.baselineStart > draft.baselineEnd) {
    issues.push({ field: "baseline", message: "The baseline starts after it ends." });
    return issues;
  }
  if (draft.baselineEnd > today) {
    // A baseline running past the registration measures the change against
    // itself. The date pickers stop at today; this catches a typed date.
    issues.push({
      field: "baseline",
      message: `Baseline must end by ${today}`,
    });
  }
  const span = watchDaySpan(draft.baselineStart, draft.baselineEnd);
  if (draft.verdictDays < span) {
    // A post window shorter than the baseline reaches back over the change.
    // The composer disables the shorter horizons; this catches the rest.
    issues.push({
      field: "verdict",
      message: `Verdict must be at least ${span} days out`,
    });
  }
  if (!(draft.minDeltaPct > 0)) {
    issues.push({
      field: "threshold",
      message: "Pick a percentage above 0",
    });
  }
  return issues;
}

/**
 * The request body, derived from the draft in one place. `registered_at` is
 * deliberately absent: the route allows backdating, but a window whose final
 * check has already passed would collect a verdict from numbers already seen,
 * so the baseline may be old and the checks always start now. `scope` is
 * present only when a seeded query and a query-grain GSC series make the
 * selector answerable.
 */
export function watchDraftBody(draft: WatchDraft): {
  ref_kind: string;
  ref: string;
  metric_integration: string;
  metric: string;
  baseline_start: string;
  baseline_end: string;
  check_offsets: number[];
  thresholds: {
    ship: { direction: "up" | "down"; min_delta_pct: number };
    kill: { direction: "up" | "down"; min_delta_pct: number };
  };
  scope?: WatchQueryScope;
  note: string | null;
} {
  const improve = draft.series.improvesWhen;
  return {
    ref_kind: draft.refKind,
    ref: draft.ref.trim(),
    metric_integration: draft.series.integration,
    metric: draft.series.metric,
    baseline_start: draft.baselineStart,
    baseline_end: draft.baselineEnd,
    check_offsets: watchCheckOffsets(draft.verdictDays),
    // Direction is literal on the metric's own value: an improvement in
    // average search position is a decrease.
    thresholds: {
      ship: { direction: improve, min_delta_pct: draft.minDeltaPct },
      kill: {
        direction: improve === "up" ? "down" : "up",
        min_delta_pct: draft.minDeltaPct,
      },
    },
    ...(draft.scope ? { scope: draft.scope } : {}),
    note: draft.note.trim().length > 0 ? draft.note.trim() : null,
  };
}

/** `YYYY-MM-DD` for an instant, in UTC — the grain `signal_observations` and
 * every baseline date are recorded in. */
export function watchDayOf(iso: string): string {
  return iso.slice(0, 10);
}

function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(dayMs(value));
}

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Calendar-day arithmetic in UTC, so the viewer's timezone cannot move a
 * baseline edge by a day. */
function shiftDay(day: string, delta: number): string {
  return new Date(dayMs(day) + delta * 86_400_000).toISOString().slice(0, 10);
}
