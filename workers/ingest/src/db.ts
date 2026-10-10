// Central-store writes: pulse ingest (with flag explosion and central rule
// evaluation), the hourly ingest-freshness check, and the nightly asset-#0
// self-pulse.

import {
  DEFAULT_RULE_CONFIG,
  evaluatePulse,
  expectsNightlyReport,
  firedFlags,
  PulseEnvelope,
  REPORT_FRESHNESS_RULE_ID,
  REPORT_MAX_AGE_HOURS,
  reportingState,
  summarizeReporting,
  type MetricBaseline,
  type ReportingState,
  type RuleConfig,
} from '@noticeos/contract';
import { noNightlyReportAssets } from '@noticeos/contract/configuration';
import { javascriptInstant } from '@noticeos/postgres';
import constants from '../../../config/constants.json';
import { rollUpAlertDay } from './alert-daily.js';
import { holdCondition, raiseAlertUnlessOpen, resolveOpen } from './alert-store.js';
import { readCollectorConfigs } from './config-store.js';
import { cronRunSuccessValue, latestJobRuns } from './job-runs.js';
import { readOsAssetId } from './os-asset.js';

/** The contract's rule id, so the Tower releases exactly the flag this Worker fires. */
export const FRESHNESS_RULE_ID = REPORT_FRESHNESS_RULE_ID;
/** rule id stamped on flags exploded out of an asset's own envelope. */
export const ASSET_DECLARED_RULE_ID = 'asset-declared';
/** A full four same-weekday observations before flow alerts arm. */
export const SEASONAL_BASELINE_WEEKS = 4;

/**
 * The central flag-rule config. `stored` is the document the store holds, or
 * `undefined` for the copy compiled into this Worker; one coalescing chain
 * either way, so a stored document that has lost a key behaves as a file that
 * never had it.
 */
export function ruleConfigFromConstants(stored?: unknown): RuleConfig {
  const document = (stored ?? constants) as { flag_defaults?: Record<string, unknown> };
  const d = document.flag_defaults;
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    alpha: number(d?.alpha, DEFAULT_RULE_CONFIG.alpha),
    minBaselinePerDay: number(d?.min_baseline_per_day, DEFAULT_RULE_CONFIG.minBaselinePerDay),
    lowVolumeWindowHours: number(
      d?.low_volume_window_hours,
      DEFAULT_RULE_CONFIG.lowVolumeWindowHours,
    ),
  };
}

/**
 * The flag-rule config this write runs on, store-first. Read here rather than
 * at the cron seam because `writePulse` has two entry points that are not a
 * cron fire: `POST /api/pulse` and the nightly pull's own ingest. An explicit
 * `config` still wins, so every suite states its own thresholds.
 */
async function ruleConfigFor(env: Pick<IngestEnv, 'STORE'>, config?: RuleConfig): Promise<RuleConfig> {
  if (config !== undefined) return config;
  const { documents } = await readCollectorConfigs(env, ['config/constants.json']);
  return ruleConfigFromConstants(documents['config/constants.json']);
}

const iso = (ms: number): string => new Date(ms).toISOString();
/** The pulse day (UTC) for a generatedAt timestamp — the `(asset,date)` grain. */
export const pulseDay = (generatedAt: string): string =>
  new Date(generatedAt).toISOString().slice(0, 10);

export interface WritePulseResult {
  pulseId: number;
  date: string;
  envelopeFlags: number;
  centralFlags: number;
  resolvedAnomalies: number;
  resolvedFreshness: number;
}

/** The Zod parse error type for a pulse envelope, without importing zod here. */
type PulseParseError = Extract<
  ReturnType<typeof PulseEnvelope.safeParse>,
  { success: false }
>['error'];

/** Outcome of {@link ingestPulseEnvelope}: written, or rejected at validation. */
export type IngestOutcome =
  | { ok: true; result: WritePulseResult }
  | { ok: false; error: PulseParseError };

/**
 * The one shared pulse-ingest path: validate an untrusted envelope against the
 * contract, then write it. Both the authed route and the nightly pull adapter
 * run through this, so a pulled asset is held to the same contract and central
 * rules as a pushed one, and a mis-mapped pull body is a clean `ok:false`.
 */
export async function ingestPulseEnvelope(
  env: Pick<IngestEnv, 'STORE'>,
  body: unknown,
  config?: RuleConfig,
): Promise<IngestOutcome> {
  const parsed = PulseEnvelope.safeParse(body);
  if (!parsed.success) return { ok: false, error: parsed.error };
  const result = await writePulse(env, parsed.data, config);
  return { ok: true, result };
}

/**
 * Write one pulse. A same-day re-push is a new revision of that day's report
 * (the day keeps its first revision's number); the alerts the earlier revision
 * raised and nobody has touched are replaced (`replaced_by_pulse_id`), while an
 * acknowledged, parked or resolved alert stays and is not raised twice. A pulse
 * arriving also resolves any open ingest-freshness flag. The report, its alerts
 * and the resolutions are one transaction, and a second write of the same site
 * and day waits for the first.
 */
export async function writePulse(
  env: Pick<IngestEnv, 'STORE'>,
  envelope: PulseEnvelope,
  ruleConfig?: RuleConfig,
): Promise<WritePulseResult> {
  const config = await ruleConfigFor(env, ruleConfig);
  const receivedAt = iso(Date.now());
  const date = pulseDay(envelope.generatedAt);

  // Centrally evaluate against four matching weekdays (or four aligned
  // low-volume windows), never the asset-supplied flat avg7d. The cohort is
  // days strictly before this report's own.
  const seasonal = await assembleSeasonalInputs(env, envelope, config);
  const central = firedFlags(
    evaluatePulse(envelope, {
      config,
      baselineByMetric: seasonal.baselineByMetric,
      windowObservedByMetric: seasonal.windowObservedByMetric,
      requireHistoricalBaseline: true,
    }),
  );
  // Which metrics are still firing tonight: the close-then-reinsert pattern
  // below is unconditional, and a snooze has to tell "recovered" from "still
  // broken".
  const firingFlowMetrics = new Set(
    central
      .filter((v) => v.ruleId === 'flow-poisson-low' || v.ruleId === 'flow-lowvol-window')
      .map((v) => v.flag?.metric)
      .filter((metric): metric is string => typeof metric === 'string'),
  );

  return env.STORE.write(async (tx) => {
    await holdCondition(tx, envelope.asset, `report:${date}`);
    const [report] = await tx.query<{ pulse_id: bigint; day_number: number }>(
      `WITH revision AS (
         SELECT coalesce(max(revision), 0) + 1 AS next FROM noticeos.pulses
          WHERE asset_id = $2 AND pulse_date = $3::date
       ), written AS (
         INSERT INTO noticeos.pulses
           (workspace_id, asset_id, pulse_date, revision, generated_at, received_at, capabilities, envelope)
         SELECT $1::uuid, $2, $3::date, next, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::json FROM revision
         RETURNING pulse_id, pulse_number, revision
       )
       SELECT w.pulse_id,
              (CASE WHEN w.revision = 1 THEN w.pulse_number
                    ELSE (SELECT d.pulse_number FROM noticeos.pulses d
                           WHERE d.asset_id = $2 AND d.pulse_date = $3::date AND d.revision = 1) END)::int AS day_number
         FROM written w`,
      [
        tx.workspaceId,
        envelope.asset,
        date,
        envelope.generatedAt,
        receivedAt,
        JSON.stringify(envelope.capabilities),
        JSON.stringify(envelope),
      ],
    );
    if (!report) throw new Error('pulse insert returned no id');
    const pulseId = report.pulse_id;

    // Re-derive only flags the operator has not touched. Dispositioned/resolved
    // rows are event history and must survive a corrected same-day report.
    await tx.execute(
      `UPDATE noticeos.flags SET replaced_by_pulse_id = $1
        WHERE pulse_id IN (SELECT pulse_id FROM noticeos.pulses
                            WHERE asset_id = $2 AND pulse_date = $3::date AND pulse_id <> $1)
          AND disposition IS NULL AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL`,
      [pulseId, envelope.asset, date],
    );

    const insertFlag = (
      firedAt: string,
      severity: string,
      kind: string,
      metric: string | null,
      message: string | null,
      ruleId: string,
      ruleInputs: string,
      distinguishMessage: boolean,
    ) =>
      tx.execute(
        `INSERT INTO noticeos.flags
           (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs)
         SELECT $1::uuid, $2, $3::bigint, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb
          WHERE NOT EXISTS (
            -- This day's report already said it: an alert of any revision of
            -- the same site and day that was not replaced.
            SELECT 1 FROM noticeos.flags f
              JOIN noticeos.pulses p ON p.workspace_id = f.workspace_id AND p.pulse_id = f.pulse_id
             WHERE p.asset_id = $2 AND p.pulse_date = $12::date
               AND f.replaced_by_pulse_id IS NULL
               AND f.rule_id = $9
               AND COALESCE(f.metric, '') = COALESCE($7, '')
               AND ($11::boolean = false OR COALESCE(f.message, '') = COALESCE($8, ''))
          )
            AND NOT EXISTS (
            -- A condition the operator parked does not raise itself again
            -- tonight: this rule is keyed on the report, which is a new row
            -- every night, so without this arm a snooze would be defeated by
            -- the cron. The key is (asset, rule_id, metric), the same scope the
            -- Tower dispositions. The clock is receivedAt, never the
            -- asset-supplied generatedAt.
            SELECT 1 FROM noticeos.flags
             WHERE asset_id = $2
               AND rule_id = $9
               AND COALESCE(metric, '') = COALESCE($7, '')
               AND resolved_at IS NULL
               AND disposition = 'snooze'
               AND snooze_until IS NOT NULL
               AND snooze_until > $13::timestamptz
        )`,
        [
          tx.workspaceId,
          envelope.asset,
          pulseId,
          firedAt,
          severity,
          kind,
          metric,
          message,
          ruleId,
          ruleInputs,
          distinguishMessage,
          date,
          receivedAt,
        ],
      );

    // Explode the asset-declared (in-transit) flags. They carry no rule id of
    // their own, so we stamp `asset-declared` and preserve the raw flag as inputs.
    let insertedEnvelopeFlags = 0;
    for (const f of envelope.flags ?? []) {
      insertedEnvelopeFlags += await insertFlag(
        envelope.generatedAt,
        f.severity,
        f.kind,
        f.metric ?? null,
        f.msg ?? null,
        ASSET_DECLARED_RULE_ID,
        JSON.stringify({ source: 'envelope', ...f }),
        true,
      );
    }

    // Each fresh metric reading closes its previous flow alert before a
    // current one is inserted, so one recovered Saturday cannot leave the
    // property yellow forever.
    let resolvedAnomalies = 0;
    for (const metric of Object.keys(envelope.metrics)) {
      resolvedAnomalies += await tx.execute(
        // A snoozed flow alert is closed by its own recovery, and only by that:
        // ack and resolve are the operator saying "done", which a lane may not
        // undo; a snooze says "ask me later", and a metric that recovered has
        // answered. $4 makes it a recovery and not a reset: closing a snoozed
        // row for a condition that is still true would let the insert below
        // raise it again.
        `UPDATE noticeos.flags SET resolved_at = $1::timestamptz
          WHERE asset_id = $2 AND metric = $3
            AND rule_id IN ('flow-poisson-low','flow-lowvol-window')
            AND resolved_at IS NULL AND replaced_by_pulse_id IS NULL
            AND (disposition IS NULL OR ($4::boolean = false AND disposition = 'snooze'))`,
        [receivedAt, envelope.asset, metric, firingFlowMetrics.has(metric)],
      );
    }
    let insertedCentralFlags = 0;
    for (const v of central) {
      const flag = v.flag!;
      insertedCentralFlags += await insertFlag(
        receivedAt,
        flag.severity,
        flag.kind,
        flag.metric,
        flag.message,
        v.ruleId,
        JSON.stringify(v.inputs),
        false,
      );
    }

    // A fresh pulse resolves any open freshness flag for this asset.
    const resolvedFreshness = await resolveOpen(tx, envelope.asset, FRESHNESS_RULE_ID, receivedAt);

    return {
      pulseId: report.day_number,
      date,
      envelopeFlags: insertedEnvelopeFlags,
      centralFlags: insertedCentralFlags,
      resolvedAnomalies,
      resolvedFreshness,
    };
  });
}

/**
 * Build a seasonality-aware baseline from the four matching weekdays before
 * the current report. Normal-volume metrics compare day-to-day at a seven-day
 * offset; low-volume metrics compare the current multi-day window with four
 * equivalently aligned windows. Any missing cohort keeps that metric quiet.
 *
 * A day a reporting-timezone change distorted stays in this cohort: it is
 * built from an asset's own nightly self-report, which a provider property's
 * timezone does not touch, and the cohort requires all four weekdays, so
 * dropping one silences the metric for four weeks. A rule that reads a
 * provider-bucketed daily series must drop those days (`distortedDays()` in
 * `time-zone-change.ts`).
 */
async function assembleSeasonalInputs(
  env: Pick<IngestEnv, 'STORE'>,
  envelope: PulseEnvelope,
  config: RuleConfig,
): Promise<SeasonalInputs> {
  const currentDate = pulseDay(envelope.generatedAt);
  const earliestDate = shiftDate(currentDate, -seasonalHistorySpanDays(config));
  const priors = await readReportHistory(env, envelope.asset, earliestDate, currentDate);
  return seasonalInputsFrom(parsePulseHistory(priors), envelope, config);
}

/**
 * A site's reports from `from` up to, not including, `before`, oldest first:
 * each day's newest revision. Shared by the nightly rules and the rule
 * backtest, so a preview and the lane read one history.
 */
export async function readReportHistory(
  env: Pick<IngestEnv, 'STORE'>,
  asset: string,
  from: string,
  before: string,
): Promise<{ date: string; envelope: string }[]> {
  return env.STORE.read((tx) =>
    tx.query<{ date: string; envelope: string }>(
      `SELECT pulse_date AS date, envelope::text AS envelope
         FROM noticeos.current_pulses
        WHERE asset_id = $1 AND pulse_date >= $2::date AND pulse_date < $3::date
        ORDER BY pulse_date ASC`,
      [asset, from, before],
    ),
  );
}

/** What {@link seasonalInputsFrom} needs to see behind a pulse: the deepest
 * cohort it reads is the oldest matching weekday's multi-day window. */
export function seasonalHistorySpanDays(config: RuleConfig): number {
  const windowDays = Math.max(1, Math.round(config.lowVolumeWindowHours / 24));
  return SEASONAL_BASELINE_WEEKS * 7 + windowDays - 1;
}

/** Stored `pulses` rows → the date-keyed history the baseline reads. An
 * unreadable envelope is dropped, not defaulted: a missing cohort day keeps its
 * metric quiet by design. */
export function parsePulseHistory(
  rows: readonly { date: string; envelope: string }[],
): Map<string, PulseEnvelope> {
  const history = new Map<string, PulseEnvelope>();
  for (const row of rows) {
    try {
      history.set(row.date, JSON.parse(row.envelope) as PulseEnvelope);
    } catch {
      // An unreadable historical envelope cannot be a trustworthy baseline.
    }
  }
  return history;
}

export interface SeasonalInputs {
  baselineByMetric: Record<string, MetricBaseline>;
  windowObservedByMetric: Record<string, number>;
}

/**
 * The baseline math itself, over a history the caller already read. Split out
 * for the rule backtest, so there is one implementation and a preview is
 * computed against the same ruler as the nightly lane. It reads only dates
 * strictly before the envelope's own day, so a history that also contains
 * later days cannot leak the future into a baseline.
 */
export function seasonalInputsFrom(
  history: ReadonlyMap<string, PulseEnvelope>,
  envelope: PulseEnvelope,
  config: RuleConfig,
): SeasonalInputs {
  const windowDays = Math.max(1, Math.round(config.lowVolumeWindowHours / 24));
  const currentDate = pulseDay(envelope.generatedAt);

  const baselineByMetric: Record<string, MetricBaseline> = {};
  const windowObservedByMetric: Record<string, number> = {};
  const comparisonDates = Array.from(
    { length: SEASONAL_BASELINE_WEEKS },
    (_, index) => shiftDate(currentDate, -(index + 1) * 7),
  );

  for (const [metric, current] of Object.entries(envelope.metrics)) {
    const matchingValues = comparisonDates.map(
      (date) => history.get(date)?.metrics[metric]?.last24h,
    );
    if (matchingValues.some((value) => value === undefined)) continue;
    const sameWeekdayPerDay = mean(matchingValues as number[]);

    if (sameWeekdayPerDay >= config.minBaselinePerDay) {
      baselineByMetric[metric] = {
        perDay: sameWeekdayPerDay,
        source: 'same-weekday-4w',
        sampleSize: SEASONAL_BASELINE_WEEKS,
        comparisonDates,
        windowHours: 24,
      };
      continue;
    }

    const historicalWindowTotals: number[] = [];
    let complete = true;
    for (const endDate of comparisonDates) {
      let total = 0;
      for (let offset = 0; offset < windowDays; offset++) {
        const value =
          history.get(shiftDate(endDate, -offset))?.metrics[metric]?.last24h;
        if (value === undefined) {
          complete = false;
          break;
        }
        total += value;
      }
      if (!complete) break;
      historicalWindowTotals.push(total);
    }
    if (!complete) continue;

    let observedWindow = current.last24h;
    for (let offset = 1; offset < windowDays; offset++) {
      const value =
        history.get(shiftDate(currentDate, -offset))?.metrics[metric]?.last24h;
      if (value === undefined) {
        complete = false;
        break;
      }
      observedWindow += value;
    }
    if (!complete) continue;

    baselineByMetric[metric] = {
      perDay: mean(historicalWindowTotals) / windowDays,
      source: 'same-weekday-4w',
      sampleSize: SEASONAL_BASELINE_WEEKS,
      comparisonDates,
      windowHours: config.lowVolumeWindowHours,
    };
    windowObservedByMetric[metric] = observedWindow;
  }

  return { baselineByMetric, windowObservedByMetric };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** One `YYYY-MM-DD` day moved by whole days, on the UTC grain the `pulses`
 * table is keyed on. */
export function shiftDate(value: string, days: number): string {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export interface FreshnessResult {
  /** The full expected set — every asset carrying a reporting obligation. This
   * is the denominator; it does not shrink because a property stayed silent. */
  checked: number;
  fresh: number;
  stale: number;
  /** Pre-launch / retired / never sent a report / declared as sending none —
   * outside the obligation, and outside `checked`. */
  notExpected: number;
  fired: number;
  /** Open freshness flags this run resolved because their asset expects no
   * report (`expectsNightlyReport`). */
  released: number;
  /** Stale properties whose flag was withheld because the store evidences the
   * OS was dark for enough of the silence ({@link evidencedDarkSpans}). They
   * stay inside `stale`: what is withheld is the accusation, not the fact. */
  egressGated: number;
}

/** One row of the obligation query: an asset and its newest report, if any. */
interface ObligationRow {
  asset: string;
  status: string;
  last_received: string | null;
}

/** A stretch of wall-clock the store evidences the OS's own connection was
 * down. Bounded by readings, never by inference. */
interface DarkSpan {
  startMs: number;
  endMs: number;
}

/**
 * The OS's own dark spans from `sinceIso` on, read off `egress_checks`. A span
 * runs from the first down reading of a consecutive run to the last: the hours
 * between are credited because no up reading contradicts them, the hours after
 * are not, and an isolated down reading is a moment, not a night. The one
 * reading before `sinceIso` is read for its verdict, so an outage that
 * straddles a property's last report is one span, clipped to the window. No
 * extrapolation in either direction: a night on which nothing failed files no
 * reading, and must read as the OS being up. `EgressGate.finalize` probes once
 * on any run that owes an open flag its retraction, so the first run after
 * recovery writes the up reading that closes the span.
 */
async function evidencedDarkSpans(env: IngestEnv, sinceIso: string): Promise<DarkSpan[]> {
  // Readings a lane run took at one instant come in the order they were written.
  const rows = await env.STORE.read((tx) =>
    tx.query<{ observedAt: string; up: boolean }>(
      `SELECT observed_at AS "observedAt", up FROM noticeos.egress_checks
        WHERE observed_at >= $1::timestamptz
           OR observed_at = (SELECT max(observed_at) FROM noticeos.egress_checks WHERE observed_at < $1::timestamptz)
        ORDER BY observed_at, egress_check_id`,
      [sinceIso],
    ),
  );

  const spans: DarkSpan[] = [];
  let open: DarkSpan | null = null;
  for (const row of rows) {
    const atMs = Date.parse(row.observedAt);
    if (!Number.isFinite(atMs)) continue;
    if (!row.up) {
      if (open === null) open = { startMs: atMs, endMs: atMs };
      else open.endMs = atMs;
    } else if (open !== null) {
      spans.push(open);
      open = null;
    }
  }
  if (open !== null) spans.push(open);
  return spans;
}

/** How much of `[windowStartMs, windowEndMs]` the dark spans cover. They come
 * out of {@link evidencedDarkSpans} disjoint and ordered, so this is a sum. */
function darkOverlapMs(spans: DarkSpan[], windowStartMs: number, windowEndMs: number): number {
  let total = 0;
  for (const span of spans) {
    const start = Math.max(span.startMs, windowStartMs);
    const end = Math.min(span.endMs, windowEndMs);
    if (end > start) total += end - start;
  }
  return total;
}

/**
 * Hourly ingest-freshness check: start from the assets and LEFT JOIN their
 * latest pulse, so every asset is a row and the contract's `reportingState`
 * decides which owe a report. A stale property fires the `error` flag, except
 * that staleness does not count hours the OS itself was dark: the age is
 * reduced by the dark hours the store evidences ({@link evidencedDarkSpans})
 * before it is read against the threshold, and a flag that still fires carries
 * `osDarkHours`. The property is still counted `stale` either way, at the same
 * age the Tower counts it. It never double-fires while an open freshness flag
 * exists, and resolves on the next accepted pulse.
 *
 * A site that has never sent a report owes none (`expectsNightlyReport`): its
 * first report makes it expected. An asset that declared it sends no nightly
 * report owes none either, read store first from `config/constants.json`, the
 * same rule the Tower counts with. Any freshness flag still open for a site
 * that expects no report is resolved by this run. The age is the contract's
 * `REPORT_MAX_AGE_HOURS`, so this flag and the Tower's tally never disagree.
 */
export async function runFreshnessCheck(env: IngestEnv, nowMs: number = Date.now()): Promise<FreshnessResult> {
  const now = iso(nowMs);

  // Every site and its newest report's arrival: a report is its day's newest
  // revision, arriving when that revision did.
  const obligations = {
    results: (
      await env.STORE.read((tx) =>
        tx.query<{ asset: string; status: string; last_received: string | null }>(
          `SELECT a.asset_id AS asset, a.status,
                  (SELECT p.received_at FROM noticeos.current_pulses p
                    WHERE p.workspace_id = a.workspace_id AND p.asset_id = a.asset_id
                    ORDER BY p.received_at DESC LIMIT 1) AS last_received
             FROM noticeos.assets a
            ORDER BY a.asset_id COLLATE "C"`,
        ),
      )
    ).map((row): ObligationRow => ({
      ...row,
      last_received: row.last_received === null ? null : javascriptInstant(row.last_received),
    })),
  };

  // Store first, then the copy compiled into this Worker.
  const { documents } = await readCollectorConfigs(env, ['config/constants.json']);
  const declared = new Set(
    noNightlyReportAssets(documents['config/constants.json'] ?? constants) ?? [],
  );

  const states = new Map<string, ReportingState>();
  for (const row of obligations.results) {
    states.set(
      row.asset,
      reportingState(
        row.status,
        row.last_received,
        nowMs,
        REPORT_MAX_AGE_HOURS,
        declared.has(row.asset),
      ),
    );
  }
  const coverage = summarizeReporting(states.values());

  // The dark-hour evidence, loaded once per run and only when something is
  // stale, from the oldest silence in play.
  const staleSince = obligations.results
    .filter((row) => states.get(row.asset) === 'stale')
    .map((row) => Date.parse(row.last_received ?? ''))
    .filter((ms) => Number.isFinite(ms));
  const darkSpans =
    staleSince.length > 0 ? await evidencedDarkSpans(env, iso(Math.min(...staleSince))) : [];

  let egressGated = 0;
  const stale = obligations.results.flatMap((row) => {
    const state = states.get(row.asset);
    if (state !== 'stale') return [];

    const receivedMs = Date.parse(row.last_received!);
    const ageMs = nowMs - receivedMs;
    const ageHours = Math.round(ageMs / 3_600_000);
    // An unreadable `received_at` is `stale` too (`reportingState`) and gets no
    // credit: a defective timestamp must not buy an excuse.
    const darkMs = Number.isFinite(receivedMs)
      ? darkOverlapMs(darkSpans, receivedMs, nowMs)
      : 0;
    // NaN fails this comparison, so an unreadable timestamp still fires.
    if (ageMs - darkMs <= REPORT_MAX_AGE_HOURS * 3_600_000) {
      egressGated += 1;
      return [];
    }
    // Rounded, because this number is shown; it was already counted in full above.
    const osDarkHours = Math.round(darkMs / 3_600_000);
    const inputs = JSON.stringify({
      rule: FRESHNESS_RULE_ID,
      state,
      lastReceivedAt: row.last_received,
      thresholdHours: REPORT_MAX_AGE_HOURS,
      ageHours,
      ...(osDarkHours > 0 ? { osDarkHours } : {}),
      evaluatedAt: now,
    });
    // Values only: the Tower draws its headline and rows from the inputs, and
    // this line is what the Discord digest carries.
    const message =
      `no pulse in ${ageHours}h (> ${REPORT_MAX_AGE_HOURS}h threshold)` +
      (osDarkHours > 0 ? ` · OS offline ${osDarkHours}h` : '');

    // Insert only when no identical open freshness flag exists for the asset.
    return [{ asset: row.asset, message, inputs }];
  });

  // A freshness flag open for a site that expects no report is about a report
  // nobody owes: close it, the way a report arriving would.
  const releases = obligations.results.filter(
    (row) => !expectsNightlyReport(declared.has(row.asset), row.last_received),
  );

  // One transaction: each stale site's alert raised unless one is open, and
  // each released one closed.
  const { fired, released } =
    stale.length + releases.length === 0
      ? { fired: 0, released: 0 }
      : await env.STORE.write(async (tx) => {
          let raised = 0;
          for (const alert of stale) {
            await holdCondition(tx, alert.asset, FRESHNESS_RULE_ID);
            const flagId = await raiseAlertUnlessOpen(tx, {
              asset: alert.asset,
              firedAt: now,
              severity: 'error',
              kind: 'anomaly',
              metric: 'pulse',
              message: alert.message,
              ruleId: FRESHNESS_RULE_ID,
              ruleInputs: alert.inputs,
            });
            if (flagId !== null) raised += 1;
          }
          let closed = 0;
          for (const row of releases) closed += await resolveOpen(tx, row.asset, FRESHNESS_RULE_ID, now);
          return { fired: raised, released: closed };
        });
  return {
    checked: coverage.expected,
    fresh: coverage.fresh,
    stale: coverage.stale,
    notExpected: coverage.notExpected,
    fired,
    released,
    egressGated,
  };
}

/**
 * Nightly asset-#0 self-pulse: the OS reports what it can observe about itself
 * (pulses received, ledger rows, open flags by severity, cron-run success) in
 * the same envelope shape every asset emits, through the same pulse path. It
 * reports as the store's OS asset; a store with no OS row writes nothing.
 */
export async function runAssetZeroPulse(env: Pick<IngestEnv, 'STORE'>, nowMs: number = Date.now()): Promise<WritePulseResult | null> {
  const now = iso(nowMs);
  const dayAgo = iso(nowMs - 24 * 3_600_000);
  const weekAgo = iso(nowMs - 7 * 24 * 3_600_000);

  // A report is a day's newest revision; an alert reads as its newest reading,
  // and a replaced one is none.
  const reportsAndAlerts = env.STORE.read(async (tx) => {
    const [reports] = await tx.query<{ day: number; week: number; total: number }>(
      `SELECT count(*) FILTER (WHERE received_at >= $1::timestamptz)::int AS day,
              count(*) FILTER (WHERE received_at >= $2::timestamptz)::int AS week,
              count(*)::int AS total
         FROM noticeos.current_pulses`,
      [dayAgo, weekAgo],
    );
    const bySeverity = await tx.query<{ severity: string; n: number }>(
      `SELECT severity, count(*)::int AS n FROM noticeos.current_flags WHERE resolved_at IS NULL GROUP BY severity`,
    );
    return { reports: reports ?? { day: 0, week: 0, total: 0 }, bySeverity };
  });
  const [{ reports, bySeverity }, ledgerCounts, cronLatest] =
    await Promise.all([
      reportsAndAlerts,
      // Money entries booked: revenue and cost; a change entry names no money.
      env.STORE.read((tx) => tx.query<{ day: number; week: number; total: number }>(
        `SELECT count(*) FILTER (WHERE recorded_at >= $1::timestamptz)::int AS day,
                count(*) FILTER (WHERE recorded_at >= $2::timestamptz)::int AS week,
                count(*)::int AS total
           FROM noticeos.ledger_entries WHERE kind IN ('revenue', 'cost')`,
        [dayAgo, weekAgo],
      )),
      latestJobRuns(env),
    ]);
  const pulses24 = reports.day;
  const pulses7 = reports.week;
  const pulsesTotal = reports.total;
  const ledger24 = ledgerCounts[0]?.day ?? 0;
  const ledger7 = ledgerCounts[0]?.week ?? 0;
  const ledgerTotal = ledgerCounts[0]?.total ?? 0;

  const open: Record<string, number> = { error: 0, warn: 0, info: 0 };
  for (const r of bySeverity) open[r.severity] = r.n;

  // Flow metrics carry a real 7-day mean; gauges set avg7d == last24h so the
  // volume-aware drop rule can never fire on a point-in-time count.
  const flow = (last24h: number, week: number, total: number) => ({ last24h, avg7d: week / 7, total });
  const gauge = (n: number) => ({ last24h: n, avg7d: n, total: n });

  // Cron success is observed from the runner's job-run record. `null` is the
  // honest third state: an empty record is evidence of neither success nor
  // failure, so the metric and its capability are both omitted.
  const cronRunSuccess = cronRunSuccessValue(cronLatest, nowMs);

  // Tonight's alert shape, written down: open-alert counts are the one thing
  // /alerts states that nothing else keeps a history of.
  await rollUpAlertDay(env, nowMs);

  const osAsset = await readOsAssetId(env);
  if (osAsset === null) {
    console.warn(JSON.stringify({ event: 'asset_zero_pulse_skipped', reason: 'no asset has is_os = 1' }));
    return null;
  }
  const envelope: PulseEnvelope = {
    asset: osAsset,
    generatedAt: now,
    capabilities: [
      'pulsesReceived',
      'ledgerRows',
      'openFlagsError',
      'openFlagsWarn',
      'openFlagsInfo',
      ...(cronRunSuccess === null ? [] : ['cronRunSuccess']),
    ],
    metrics: {
      pulsesReceived: flow(pulses24, pulses7, pulsesTotal),
      ledgerRows: flow(ledger24, ledger7, ledgerTotal),
      openFlagsError: gauge(open.error ?? 0),
      openFlagsWarn: gauge(open.warn ?? 0),
      openFlagsInfo: gauge(open.info ?? 0),
      ...(cronRunSuccess === null ? {} : { cronRunSuccess: gauge(cronRunSuccess) }),
    },
  };

  return writePulse(env, envelope);
}
