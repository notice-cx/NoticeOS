// Watch windows — pre-registered outcome checks, and the daily job that reads
// them out.
//
// docs/03's whole subject is how not to lie to yourself about whether a change
// worked. Its first defense is that the comparison is chosen BEFORE the numbers
// exist. A watch window is that pre-registration made machine-checkable: the
// metric, the pre-change baseline window, the days it will be re-read, and the
// ship/kill predicate, all written down at registration time. This module owns
// the vocabulary those registrations are validated against, the arithmetic, and
// the daily sweep that records interim readings and closes due windows.
//
// Three honesty rules are load-bearing here and are pinned by tests:
//   1. No thresholds → the window can only close 'inconclusive', with the
//      numbers shown. The OS never invents a verdict it was not given.
//   2. A scope reads only the retained daily GSC archive at that grain — the
//      query report for a query, the page report for a page. An unsupported or
//      malformed scope closes 'unmeasurable'; it never falls back to the site's
//      number.
//   3. Thin coverage closes 'unmeasurable', never 'inconclusive'. "We could not
//      measure this" and "we measured it and it did nothing" are different
//      facts and the ledger needs to keep them apart.
//   4. A comparison never spans two provider resources (ro-ujb9.70). When the
//      baseline and post days were read from different `property_ref`s — the
//      asset was repointed at another GA4 property or Search Console site — the
//      window closes 'unmeasurable'. Rotating the credential that reads the same
//      resource is not a switch and evaluates normally.

import {
  WATCH_QUERY_MAX_CHARS,
  type WatchQueryHistory,
  type WatchQueryHistoryInput,
  type WatchScopeInput,
} from '@noticeos/contract';
import type { Transaction, WorkspaceStore } from '@noticeos/postgres';
import { readPanelManifest, readPanelObject } from './panel-source.js';
import { appendReadings, markChecked, markClosed, readOpenWindows } from './watch-window-store.js';

export const WATCH_REF_KINDS = ['annotation', 'decision', 'manual'] as const;
export type WatchRefKind = (typeof WATCH_REF_KINDS)[number];

export const WATCH_INTEGRATIONS = ['ga4', 'gsc', 'bing-webmaster'] as const;
export type WatchIntegration = (typeof WATCH_INTEGRATIONS)[number];

export const WATCH_OUTCOMES = [
  'ship_confirmed',
  'kill_confirmed',
  'inconclusive',
  'unmeasurable',
] as const;
export type WatchOutcome = (typeof WATCH_OUTCOMES)[number];

/**
 * The metrics a watch may name, and how a window of daily values collapses to
 * one number. Counts sum; rates are already per-day figures and are averaged —
 * summing a CTR would be arithmetic nonsense. This is the
 * `signal_observations` vocabulary the collectors actually write (docs/02); the
 * migration's CHECK constraint carries the same pairs.
 */
export const WATCH_METRICS: Record<WatchIntegration, Record<string, 'sum' | 'mean'>> = {
  ga4: { sessions: 'sum', active_users: 'sum', page_views: 'sum', event_count: 'sum' },
  gsc: { clicks: 'sum', impressions: 'sum', ctr: 'mean', position: 'mean' },
  'bing-webmaster': { clicks: 'sum', impressions: 'sum' },
};

/** rule id stamped on the flag a closing watch window files. */
export const WATCH_CLOSED_RULE_ID = 'watch-window-closed';

/**
 * How much of each window must actually have observations before a verdict is
 * allowed. Provider lag routinely costs the newest day or two of a 28-day GSC
 * window, which should not void a check; a window that is mostly holes should.
 */
export const MIN_WINDOW_COVERAGE = 0.8;

export interface WatchThreshold {
  /** Literal on the metric's own value. Improving average `position` is 'down'. */
  direction: 'up' | 'down';
  min_delta_pct: number;
}

export interface WatchThresholds {
  ship?: WatchThreshold;
  kill?: WatchThreshold;
}

export interface WatchWindowAggregate {
  start: string;
  end: string;
  /** Dates in the window that actually carry an observation. */
  days: number;
  /** Days the window spans, observed or not. */
  span_days: number;
  /** The window's sum — reported only for count metrics; a summed CTR is not a
   * number that means anything, so rate metrics carry null here. */
  total: number | null;
  /** The comparison figure for BOTH aggregations: mean daily value over the
   * observed days. Two windows of unequal (but adequate) coverage therefore
   * still compare like for like. */
  per_day: number;
  /** The provider resources (`signal_runs.property_ref`) the counted days were
   * read from, sorted. One entry is one measurement series; more than one means
   * the window spans a property switch. Absent on a scoped archive read, and on
   * readings stored before this field existed. */
  properties?: string[];
}

export interface WatchReading {
  offset_days: number;
  check_date: string;
  checked_at: string;
  final: boolean;
  baseline: WatchWindowAggregate | null;
  post: WatchWindowAggregate | null;
  delta_pct: number | null;
  /** Days of the post window that fall on or before the registration date —
   * non-zero on an interim check whose offset is shorter than the baseline. */
  pre_change_days: number;
}

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
  note: string | null;
}

export interface WatchWindowEvaluation {
  /** Open windows examined this run. */
  scanned: number;
  /** Windows that had at least one due, not-yet-evaluated offset. */
  evaluated: number;
  /** Interim readings appended. */
  readings: number;
  closed: { id: string; asset: string; outcome: WatchOutcome; note: string }[];
  /** Windows whose own evaluation threw. One bad row never costs the others. */
  failed: { id: string; error: string }[];
  /** Ids still open after this run with their final check date already behind
   * them: the bets the sweep was due to answer and did not. `failed` cannot see
   * this on its own — a window skipped without throwing looks like a clean run. */
  overdue: string[];
}

/** What one sweep says about itself in the log. */
export interface WatchSweepEvent {
  event: 'watch_windows_complete';
  scanned: number;
  evaluated: number;
  readings: number;
  closed: { id: string; asset: string; outcome: WatchOutcome }[];
  overdue: string[];
  errors: { id: string; error: string }[];
}

const DAY_MS = 86_400_000;
const SCOPED_ARCHIVE_READ_CONCURRENCY = 12;

interface ArchiveManifest {
  reportDate: string;
  objectKey: string;
}

interface ScopedArchive {
  asset: string;
  reportDate: string;
  rows: unknown[];
}

/** Keyed by object key, so one day read for a query costs nothing to re-read
 * for a page — and a sweep with several windows on one property reads each
 * archived day once. */
type ScopedArchiveCache = Map<string, Promise<ScopedArchive>>;

/**
 * What a scoped window compares, resolved from the stored scope.
 *
 * `kind` doubles as the GSC report name to read, which is not a coincidence:
 * a selector the archive has no report for is a selector this module refuses to
 * invent an answer for.
 */
export interface WatchScopeSelector {
  kind: 'query' | 'page';
  /** The operator's own words — the query as typed, the route as named. */
  value: string;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function addDays(date: string, days: number): string {
  return isoDay(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS);
}

/** Inclusive day count between two 'YYYY-MM-DD' dates. */
export function daySpan(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS) + 1;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Collapse one integration/metric series over a date range.
 *
 * `signal_observations` is append-only and a provider revision appends a NEW
 * row for the same (date, metric), so the latest run's value wins per date —
 * exactly the ordering `recordSignalSuccess` writes in.
 *
 * Each counted day also carries the provider resource its winning value was
 * measured on, so `decide` can refuse a comparison that spans two of them. The
 * aggregate itself is unchanged by that: it reports what was read, and the
 * verdict says whether it may be compared.
 *
 * Read on Postgres (bead ro-ujb9.76.5.3): every series of this site, provider
 * and metric, whatever its property or zone, as the D1 read took every run.
 */
export async function aggregateMetric(
  store: WorkspaceStore,
  asset: string,
  integration: string,
  metric: string,
  start: string,
  end: string,
): Promise<WatchWindowAggregate> {
  const rows = await store.read((tx) =>
    tx.query<{ date: string; value: number; property: string }>(
      `SELECT o.observed_date AS date, o.value, r.property_ref AS property
         FROM noticeos.measurement_series s
         JOIN noticeos.signal_observations o ON o.workspace_id = s.workspace_id AND o.series_id = s.series_id
         JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
        WHERE s.asset_id = $1 AND s.integration = $2 AND s.metric = $3
          AND o.observed_date >= $4::date AND o.observed_date <= $5::date
        ORDER BY o.observed_date, r.finished_at, o.observation_id`,
      [asset, integration, metric, start, end],
    ),
  );

  const latest = new Map<string, { value: number; property: string }>();
  for (const row of rows) {
    latest.set(row.date, { value: row.value, property: row.property });
  }

  const values = [...latest.values()].map((day) => day.value);
  const total = values.reduce((sum, value) => sum + value, 0);
  const aggregation = WATCH_METRICS[integration as WatchIntegration]?.[metric] ?? 'sum';
  const days = values.length;
  return {
    start,
    end,
    days,
    span_days: daySpan(start, end),
    total: aggregation === 'sum' ? round(total, 4) : null,
    per_day: days === 0 ? 0 : round(total / days, 4),
    properties: [...new Set([...latest.values()].map((day) => day.property))].sort(),
  };
}

/** Parse the only scope the evaluator can currently answer.
 *
 * Registrations now validate this exact shape. The defensive parser remains
 * because older rows and hand-edited local stores can predate that boundary;
 * those rows close unmeasurable rather than throwing or widening themselves.
 */
export function parseWatchScope(raw: string | null): WatchScopeInput | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    // Exactly one selector. A row carrying both narrowed twice and answers a
    // question neither the archive nor the operator asked.
    if (keys.length !== 1) return null;
    const key = keys[0];
    if (key !== 'query' && key !== 'page') return null;
    const selected = record[key];
    if (typeof selected !== 'string' || selected.trim().length === 0) return null;
    return key === 'query' ? { query: selected.trim() } : { page: selected.trim() };
  } catch {
    return null;
  }
}

/** The selector a stored scope names; null is a property-wide window. */
export function watchScopeSelector(scope: WatchScopeInput | null): WatchScopeSelector | null {
  if (scope === null) return null;
  return 'query' in scope
    ? { kind: 'query', value: scope.query }
    : { kind: 'page', value: scope.page };
}

/** How a scoped window reads in a verdict note. */
export function watchScopeLabel(selector: WatchScopeSelector): string {
  return selector.kind === 'query' ? `query “${selector.value}”` : `page ${selector.value}`;
}

function normalizeQuery(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function loadScopedArchive(
  env: IngestEnv,
  manifest: ArchiveManifest,
  report: 'query' | 'page',
  cache: ScopedArchiveCache,
): Promise<ScopedArchive> {
  const cached = cache.get(manifest.objectKey);
  if (cached) return cached;

  const loading = (async (): Promise<ScopedArchive> => {
    const text = await readPanelObject(env, manifest.objectKey);
    if (text === null) {
      throw new Error(`watch_archive_missing: ${manifest.objectKey}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`watch_archive_invalid_json: ${manifest.objectKey}`);
    }
    const envelope = asRecord(parsed);
    if (
      !envelope ||
      typeof envelope.asset !== 'string' ||
      envelope.integration !== 'gsc' ||
      envelope.report !== report ||
      envelope.reportDate !== manifest.reportDate ||
      !Array.isArray(envelope.pages)
    ) {
      throw new Error(`watch_archive_invalid_envelope: ${manifest.objectKey}`);
    }
    const rows: unknown[] = [];
    for (const page of envelope.pages) {
      const response = asRecord(asRecord(page)?.response);
      if (!response) continue;
      if (response.rows === undefined) continue;
      if (!Array.isArray(response.rows)) {
        throw new Error(`watch_archive_invalid_rows: ${manifest.objectKey}`);
      }
      rows.push(...response.rows);
    }
    return {
      asset: envelope.asset,
      reportDate: manifest.reportDate,
      rows,
    };
  })();
  cache.set(manifest.objectKey, loading);
  return loading;
}

function scopedMetricValue(
  archive: ScopedArchive,
  asset: string,
  selector: WatchScopeSelector,
  metric: string,
): number | null {
  if (archive.asset && archive.asset !== asset) {
    throw new Error(`watch_archive_wrong_asset: expected ${asset}, got ${archive.asset}`);
  }
  const matches = selector.kind === 'query' ? queryMatcher(selector.value) : pageMatcher(selector.value);
  for (const value of archive.rows) {
    const row = asRecord(value);
    const keys = row?.keys;
    if (!row || !Array.isArray(keys) || typeof keys[0] !== 'string') continue;
    if (!matches(keys[0])) continue;
    const metricValue = row[metric];
    return typeof metricValue === 'number' && Number.isFinite(metricValue)
      ? metricValue
      : null;
  }
  // GSC suppresses anonymized/low-volume queries, and a page with no
  // impressions that day simply has no row. Absence is unknown, not 0.
  return null;
}

function queryMatcher(query: string): (key: string) => boolean {
  const wanted = normalizeQuery(query);
  return (key) => normalizeQuery(key) === wanted;
}

/**
 * Match a page the way an operator names one.
 *
 * GSC keys a page row with the absolute URL it crawled. A freeze entry names a
 * route (`/water-intake-calculator`), so a scope beginning with `/` compares
 * paths alone and matches across the hosts one domain property mixes — apex vs
 * www, http vs https. A scope given as an absolute URL keeps its host, for the
 * case where two hosts under one property really are different pages.
 */
function pageMatcher(page: string): (key: string) => boolean {
  const wanted = normalizePageRef(page);
  return (key) => {
    const got = normalizePageRef(key);
    if (wanted.path !== got.path) return false;
    return wanted.host === null || wanted.host === got.host;
  };
}

/** `{host, path}` for either an absolute URL or a bare route. A host of null
 * means "any host in this property"; a key too malformed to parse is compared
 * as the literal string it is, so bad archive data can never match everything. */
function normalizePageRef(value: string): { host: string | null; path: string } {
  const trimmed = value.trim().split('#')[0]!;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return { host: url.host.toLowerCase().replace(/^www\./, ''), path: trimPath(`${url.pathname}${url.search}`) };
    } catch {
      return { host: null, path: trimmed };
    }
  }
  return { host: null, path: trimPath(trimmed) };
}

/** One trailing slash is a formatting choice, not a different page; the root is
 * the exception, where `/` IS the path. */
function trimPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

async function readScopedMetricDays(
  env: IngestEnv,
  asset: string,
  metric: string,
  selector: WatchScopeSelector,
  start: string,
  end: string,
  cache: ScopedArchiveCache,
): Promise<{ manifests: ArchiveManifest[]; daily: Map<string, number> }> {
  const manifests = await readPanelManifest(env, asset, {
    from: start,
    to: end,
    integration: 'gsc',
    report: selector.kind,
  });

  const daily = new Map<string, number>();
  for (let index = 0; index < manifests.length; index += SCOPED_ARCHIVE_READ_CONCURRENCY) {
    const batch = manifests.slice(index, index + SCOPED_ARCHIVE_READ_CONCURRENCY);
    const values = await Promise.all(
      batch.map(async (manifest) => {
        const archive = await loadScopedArchive(env, manifest, selector.kind, cache);
        return {
          date: manifest.reportDate,
          value: scopedMetricValue(archive, asset, selector, metric),
        };
      }),
    );
    for (const observation of values) {
      if (observation.value !== null) daily.set(observation.date, observation.value);
    }
  }
  return { manifests, daily };
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Read the exact dense daily query series the evaluator uses, for the Tower's
 * on-demand threshold calibration. This is deliberately an R2 read rather than
 * a second projection in D1: the provider-final archive remains canonical.
 */
export async function readWatchQueryHistory(
  env: IngestEnv,
  input: WatchQueryHistoryInput,
  cache: ScopedArchiveCache = new Map(),
): Promise<WatchQueryHistory> {
  const asset = input.asset.trim();
  const metric = input.metric.trim();
  const query = input.query.trim();
  if (!asset || asset.length > 255) throw new Error('watch_query_history_invalid_asset');
  if (!query || query.length > WATCH_QUERY_MAX_CHARS) {
    throw new Error('watch_query_history_invalid_query');
  }
  if (!(metric in WATCH_METRICS.gsc)) throw new Error('watch_query_history_invalid_metric');
  if (!validDay(input.first_day) || !validDay(input.last_day) || input.first_day > input.last_day) {
    throw new Error('watch_query_history_invalid_range');
  }
  const span = daySpan(input.first_day, input.last_day);
  if (span > 366) throw new Error('watch_query_history_range_too_wide');

  const [{ manifests, daily }, changeRead] = await Promise.all([
    readScopedMetricDays(
      env,
      asset,
      metric,
      { kind: 'query', value: query },
      input.first_day,
      input.last_day,
      cache,
    ),
    readChangeDays(env, asset, input.first_day, input.last_day),
  ]);
  const values = Array.from({ length: span }, (_, offset) =>
    daily.get(addDays(input.first_day, offset)) ?? null,
  );
  return {
    integration: 'gsc',
    metric,
    query,
    firstDay: input.first_day,
    values,
    archiveFirstDay: manifests[0]?.reportDate ?? null,
    archiveLastDay: manifests.at(-1)?.reportDate ?? null,
    archiveDays: manifests.length,
    observedDays: daily.size,
    recordedChanges: {
      firstDay: input.first_day,
      lastDay: input.last_day,
      days: changeRead,
      complete: true,
    },
  };
}

/**
 * The UTC days in [firstDay, lastDay] on which the site recorded a change, in
 * order. D1 cut the day from its stored text; `at` is an instant now, and its
 * UTC day is the same ten characters every writer's `toISOString()` began
 * with. The bound is on the instant, so the site's (site, time) index seeks it.
 */
async function readChangeDays(env: IngestEnv, asset: string, firstDay: string, lastDay: string): Promise<string[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ day: string }>(
      `SELECT DISTINCT (at AT TIME ZONE 'UTC')::date AS day
         FROM noticeos.annotations
        WHERE asset_id = $1 AND at >= $2::date AND at < $3::date + 1
        ORDER BY day ASC`,
      [asset, firstDay, lastDay],
    ),
  );
  return rows.map((row) => row.day);
}

/** Collapse one query's provider-final daily GSC rows over a date range.
 *
 * The manifest resolver selects the newest successful revision per day. Raw
 * objects remain the canonical store; this reader adds no second table and no
 * migration. Missing query rows stay missing so the normal 80% coverage rule
 * decides whether a verdict is supportable.
 */
export async function aggregateScopedMetric(
  env: IngestEnv,
  asset: string,
  metric: string,
  selector: WatchScopeSelector,
  start: string,
  end: string,
  cache: ScopedArchiveCache = new Map(),
): Promise<WatchWindowAggregate> {
  const { daily } = await readScopedMetricDays(
    env,
    asset,
    metric,
    selector,
    start,
    end,
    cache,
  );

  const values = [...daily.values()];
  const total = values.reduce((sum, value) => sum + value, 0);
  const aggregation = WATCH_METRICS.gsc[metric] ?? 'sum';
  const days = values.length;
  return {
    start,
    end,
    days,
    span_days: daySpan(start, end),
    total: aggregation === 'sum' ? round(total, 4) : null,
    per_day: days === 0 ? 0 : round(total / days, 4),
  };
}

export function parseThresholds(raw: string | null): WatchThresholds | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as WatchThresholds;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseOffsets(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function parseReadings(raw: string): WatchReading[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as WatchReading[]) : [];
  } catch {
    return [];
  }
}

function matchesThreshold(threshold: WatchThreshold | undefined, deltaPct: number): boolean {
  if (!threshold) return false;
  const magnitude = Math.abs(threshold.min_delta_pct);
  return threshold.direction === 'up' ? deltaPct >= magnitude : deltaPct <= -magnitude;
}

function coverageOk(aggregate: WatchWindowAggregate): boolean {
  return aggregate.span_days > 0 && aggregate.days / aggregate.span_days >= MIN_WINDOW_COVERAGE;
}

interface Verdict {
  outcome: WatchOutcome;
  note: string;
}

const quoted = (properties: readonly string[]): string =>
  properties.map((property) => `"${property}"`).join(' and ');

/**
 * Why a baseline/post pair spans more than one provider resource, as the
 * properties themselves, or null when it does not. A scoped archive read
 * carries no `properties` and is not judged here.
 *
 * Figures from different properties are not one series and not like for like,
 * so the window closes unmeasurable and claims no comparison; the note is
 * which properties, in one line (bead `ro-ujb9.96.6.28`).
 */
function propertySplit(baseline: WatchWindowAggregate, post: WatchWindowAggregate): string | null {
  const before = baseline.properties;
  const after = post.properties;
  if (!before || !after) return null;
  if (before.length > 1) return `baseline spans properties ${quoted(before)}`;
  if (after.length > 1) return `post window spans properties ${quoted(after)}`;
  if (before[0] !== after[0]) return `baseline on ${quoted(before)}, post window on ${quoted(after)}`;
  return null;
}

/**
 * Decide a due FINAL check. Every branch that cannot support a claim says so
 * rather than defaulting to a comfortable one.
 *
 * The note is the evaluator's figures and nothing else (bead
 * `ro-ujb9.96.6.30`): the series, its scope and the offset are the window's
 * own columns, which a site's Activity tab already draws as the row's title,
 * so a `gsc/clicks at +28d:` prefix repeated them in the store's vocabulary.
 * The flag's statistics line still names them (`closeWindow`), because a
 * flag is read without its row.
 */
function decide(reading: WatchReading, thresholds: WatchThresholds | null): Verdict {
  const { baseline, post, delta_pct: deltaPct } = reading;
  if (!baseline || baseline.days === 0) {
    return { outcome: 'unmeasurable', note: 'no observations in the baseline window' };
  }
  if (!post || post.days === 0) {
    return { outcome: 'unmeasurable', note: 'no observations in the post window' };
  }
  const split = propertySplit(baseline, post);
  if (split !== null) {
    return { outcome: 'unmeasurable', note: split };
  }
  if (!coverageOk(baseline) || !coverageOk(post)) {
    return {
      outcome: 'unmeasurable',
      note:
        `thin coverage — baseline ${baseline.days}/${baseline.span_days} days, ` +
        `post ${post.days}/${post.span_days} days (need ${Math.round(MIN_WINDOW_COVERAGE * 100)}%)`,
    };
  }
  if (deltaPct === null) {
    return {
      outcome: 'unmeasurable',
      note: `baseline is 0/day, so a percent change is undefined (post ${post.per_day}/day)`,
    };
  }

  const numbers = `${post.per_day}/day vs baseline ${baseline.per_day}/day (${deltaPct >= 0 ? '+' : ''}${deltaPct}%)`;
  if (!thresholds || (!thresholds.ship && !thresholds.kill)) {
    return {
      outcome: 'inconclusive',
      note: `${numbers}; no ship/kill threshold was registered, so no verdict is claimed`,
    };
  }
  const ship = matchesThreshold(thresholds.ship, deltaPct);
  const kill = matchesThreshold(thresholds.kill, deltaPct);
  if (ship && kill) {
    return {
      outcome: 'inconclusive',
      // Both registered predicates match, so neither is trusted.
      note: `${numbers}; ship and kill thresholds both match`,
    };
  }
  if (ship) return { outcome: 'ship_confirmed', note: numbers };
  if (kill) return { outcome: 'kill_confirmed', note: numbers };
  return { outcome: 'inconclusive', note: `${numbers}; neither threshold was met` };
}

/** kill_confirmed is the only outcome that wants attention; the rest are record. */
function severityFor(outcome: WatchOutcome): 'info' | 'warn' {
  return outcome === 'kill_confirmed' ? 'warn' : 'info';
}

/** A confirmed win is the one outcome the opportunity kind describes. */
function kindFor(outcome: WatchOutcome): 'anomaly' | 'opportunity' {
  return outcome === 'ship_confirmed' ? 'opportunity' : 'anomaly';
}

/**
 * The daily watch sweep (03:30 UTC, after the nightly pulls have landed).
 *
 * For each open window it evaluates every offset that has come due and has not
 * been read yet, appending an interim reading for each and closing the window
 * on its final offset. Closing files a flag through the existing flags
 * machinery, so the result appears on the asset's alert surfaces with no new
 * UI. Windows are failure-isolated: one bad row never costs the others.
 */
export async function runWatchWindows(
  env: IngestEnv,
  nowMs: number = Date.now(),
): Promise<WatchWindowEvaluation> {
  const now = new Date(nowMs).toISOString();
  const today = isoDay(nowMs);

  const open = await env.STORE.read((tx) => readOpenWindows(tx));

  const result: WatchWindowEvaluation = {
    scanned: open.length,
    evaluated: 0,
    readings: 0,
    closed: [],
    failed: [],
    overdue: [],
  };
  const archiveCache: ScopedArchiveCache = new Map();

  for (const window of open) {
    try {
      await evaluateWindow(env, window, now, today, result, archiveCache);
    } catch (error) {
      result.failed.push({
        id: window.id,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
  }

  const answered = new Set(result.closed.map((closed) => closed.id));
  result.overdue = open
    .filter((window) => !answered.has(window.id) && pastFinalCheck(window, today))
    .map((window) => window.id);

  // Every other nightly lane ends with a completion event; this one used to end
  // with nothing, and `failed` was thrown away by the dispatch table on top of
  // that. A window that threw every night therefore failed forever in silence —
  // the only symptom was a property card advertising a bet whose check date had
  // quietly slipped into the past (ro-5tqk). `overdue` is here because `errors`
  // is not enough: the sweep can also fail by not throwing.
  console.log(JSON.stringify(watchSweepEvent(result)));

  return result;
}

/**
 * The completion event, built apart from the printing so the suite can pin its
 * shape: inside workerd a test cannot see the lane's own console.
 */
export function watchSweepEvent(result: WatchWindowEvaluation): WatchSweepEvent {
  return {
    event: 'watch_windows_complete',
    scanned: result.scanned,
    evaluated: result.evaluated,
    readings: result.readings,
    closed: result.closed.map(({ id, asset, outcome }) => ({ id, asset, outcome })),
    overdue: result.overdue,
    errors: result.failed,
  };
}

/**
 * True when the window's last scheduled check has already come due.
 *
 * Deliberately total: a row too malformed to date is unanswerable rather than
 * overdue, because the line that reports a failure must never be the line that
 * throws.
 */
function pastFinalCheck(window: WatchWindowRow, today: string): boolean {
  const offsets = parseOffsets(window.check_offsets_json);
  const final = offsets[offsets.length - 1];
  if (final === undefined) return false;
  const registered = Date.parse(`${window.registered_at.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(registered)) return false;
  return isoDay(registered + final * DAY_MS) <= today;
}

async function evaluateWindow(
  env: IngestEnv,
  window: WatchWindowRow,
  now: string,
  today: string,
  result: WatchWindowEvaluation,
  archiveCache: ScopedArchiveCache,
): Promise<void> {
  const registeredDate = window.registered_at.slice(0, 10);
  const offsets = parseOffsets(window.check_offsets_json);
  if (offsets.length === 0) return;
  const readings = parseReadings(window.readings_json);
  /** The readings this run takes, appended to the window's own. */
  const fresh: WatchReading[] = [];
  const alreadyRead = new Set(readings.map((reading) => reading.offset_days));
  const due = offsets.filter(
    (offset) => !alreadyRead.has(offset) && addDays(registeredDate, offset) <= today,
  );
  if (due.length === 0) return;
  result.evaluated += 1;

  const finalOffset = offsets[offsets.length - 1]!;
  const series = `${window.metric_integration}/${window.metric}`;

  const scope = parseWatchScope(window.scope_json);
  const selector = watchScopeSelector(scope);
  if (window.scope_json !== null && (selector === null || window.metric_integration !== 'gsc')) {
    const unsupported: Verdict = {
      outcome: 'unmeasurable',
      note: 'stored scope unsupported · no site-wide fallback',
    };
    await closeWindow(env, window, readings, fresh, now, unsupported, series);
    result.closed.push({ id: window.id, asset: window.asset, ...unsupported });
    return;
  }

  const baselineDays = daySpan(window.baseline_start, window.baseline_end);
  const aggregate = (start: string, end: string): Promise<WatchWindowAggregate> =>
    selector
      ? aggregateScopedMetric(
          env,
          window.asset,
          window.metric,
          selector,
          start,
          end,
          archiveCache,
        )
      : aggregateMetric(
          env.STORE,
          window.asset,
          window.metric_integration,
          window.metric,
          start,
          end,
        );
  const label = selector ? `${series} for ${watchScopeLabel(selector)}` : series;
  const baseline = await aggregate(window.baseline_start, window.baseline_end);
  let verdict: Verdict | null = null;
  let subject = label;

  for (const offset of due) {
    const checkDate = addDays(registeredDate, offset);
    // The post window matches the baseline's length and ends on the check date,
    // so the two are the same size by construction. On an interim offset
    // shorter than the baseline it necessarily reaches back past the change;
    // `pre_change_days` records exactly how far, which is why an interim
    // reading is a reading and never a verdict.
    const postStart = addDays(checkDate, -(baselineDays - 1));
    const post = await aggregate(postStart, checkDate);
    const deltaPct =
      baseline.days === 0 || post.days === 0 || baseline.per_day === 0
        ? null
        : round(((post.per_day - baseline.per_day) / baseline.per_day) * 100, 2);
    const reading: WatchReading = {
      offset_days: offset,
      check_date: checkDate,
      checked_at: now,
      final: offset === finalOffset,
      baseline,
      post,
      delta_pct: deltaPct,
      pre_change_days: postStart > registeredDate ? 0 : daySpan(postStart, registeredDate),
    };
    readings.push(reading);
    fresh.push(reading);
    if (reading.final) {
      verdict = decide(reading, parseThresholds(window.thresholds_json));
      subject = `${label} at +${offset}d`;
    } else {
      result.readings += 1;
    }
  }

  if (verdict) {
    await closeWindow(env, window, readings, fresh, now, verdict, subject);
    result.closed.push({
      id: window.id,
      asset: window.asset,
      outcome: verdict.outcome,
      note: verdict.note,
    });
    return;
  }
  // The interim readings and the check's stamp are one transaction, which
  // holds the window's row: a sweep that finds it closed by another adds
  // nothing to it.
  await env.STORE.write(async (tx) => {
    if (await markChecked(tx, window.id, now)) await appendReadings(tx, window.id, fresh);
  });
}

/**
 * Close the window with its verdict and file the verdict as a flag. The flag
 * is how the outcome reaches the operator: `rule_id = watch-window-closed`
 * rides the existing alert surfaces, carries the numbers in its message, and
 * keeps the full baseline/post arithmetic in `rule_inputs` for audit (docs/02:
 * every fired flag records rule + inputs).
 *
 * ONE TRANSACTION, AS THE D1 BATCH WAS (bead ro-ujb9.76.5.7): the close, the
 * readings it took, and the flag. Any of them failing leaves none of them, so
 * the window stays open and the next sweep reads it again; a closed window
 * always has its flag, and a window has one. The close goes first and holds
 * the window's row: a sweep that finds it closed by another files nothing.
 */
async function closeWindow(
  env: IngestEnv,
  window: WatchWindowRow,
  readings: WatchReading[],
  /** The readings this run took, which the close appends. */
  fresh: readonly WatchReading[],
  now: string,
  verdict: Verdict,
  /** The series, scope and offset the verdict is about, in the store's words:
   * `gsc/clicks at +28d`. Only the flag's statistics line carries it. */
  subject: string,
): Promise<void> {
  const finalReading = readings[readings.length - 1] ?? null;
  const inputs = {
    rule: WATCH_CLOSED_RULE_ID,
    watchWindowId: window.id,
    refKind: window.ref_kind,
    ref: window.ref,
    integration: window.metric_integration,
    metric: window.metric,
    outcome: verdict.outcome,
    registeredAt: window.registered_at,
    baselineWindow: { start: window.baseline_start, end: window.baseline_end },
    thresholds: parseThresholds(window.thresholds_json),
    scoped: window.scope_json !== null,
    scope: parseWatchScope(window.scope_json),
    reading: finalReading,
    evaluatedAt: now,
  };

  await env.STORE.write(async (tx) => {
    if (!(await markClosed(tx, window.id, verdict, now))) return;
    await appendReadings(tx, window.id, fresh);
    await fileWindowFlag(tx, window, {
      firedAt: now,
      severity: severityFor(verdict.outcome),
      kind: kindFor(verdict.outcome),
      message: `watch window ${verdict.outcome} — ${subject}: ${verdict.note}`,
      ruleInputs: JSON.stringify(inputs),
    });
  });
}

/** The window's flag, in the transaction that closes it. */
async function fileWindowFlag(
  tx: Transaction,
  window: Pick<WatchWindowRow, 'id' | 'asset' | 'metric'>,
  flag: { firedAt: string; severity: string; kind: string; message: string; ruleInputs: string },
): Promise<void> {
  await tx.execute(
    `INSERT INTO noticeos.flags
       (workspace_id, asset_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
     VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      tx.workspaceId,
      window.asset,
      flag.firedAt,
      flag.severity,
      flag.kind,
      window.metric,
      flag.message,
      WATCH_CLOSED_RULE_ID,
      flag.ruleInputs,
    ],
  );
}
