// Central-store writes: pulse ingest (with flag explosion + central rule
// evaluation), the hourly ingest-freshness check, and the nightly asset-#0
// self-pulse. Reports and alerts live on Postgres (`noticeos.pulses`,
// `noticeos.flags`, read through `current_pulses` and `current_flags`; bead
// ro-ujb9.76.5.2).

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

/** rule id for the centrally-computed ingest-freshness flag (docs/06). The
 * contract's, so the Tower releases exactly the flag this Worker fires. */
export const FRESHNESS_RULE_ID = REPORT_FRESHNESS_RULE_ID;
/** rule id stamped on flags exploded out of an asset's own envelope. */
export const ASSET_DECLARED_RULE_ID = 'asset-declared';
/** A full four same-weekday observations before flow alerts arm. */
export const SEASONAL_BASELINE_WEEKS = 4;

/**
 * The central flag-rule config, sourced from config/constants.json (docs/02: no
 * re-hardcoding).
 *
 * `stored` is the document the store holds, or `undefined` for the copy compiled
 * into this Worker. One coalescing chain either way, so a stored document that
 * has lost a key behaves exactly as a file that never had it.
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
 * The flag-rule config this write runs on, store-first (bead `ro-syok.7`).
 *
 * READ HERE RATHER THAN AT THE CRON SEAM, and it is the one place in this Worker
 * that is right to. `config/constants.json`'s flag defaults are not a collector's
 * config: they are what `writePulse` evaluates, and it has TWO entry points that
 * are not a cron fire at all — `POST /api/pulse` from an asset, and the nightly
 * pull's own ingest. Threading it from `dispatch.ts` would leave the route on the
 * compiled copy, which is exactly the split this bead exists to close.
 *
 * An explicit `config` still wins, so every suite states its own thresholds and
 * nothing here reads the store on their behalf.
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
 * contract, then (on success) write it — upsert `(asset,date)`, explode the
 * in-transit flags, evaluate the central volume-aware rules, and resolve any
 * open freshness flag. Both the authed `POST /api/pulse` route and the nightly
 * pull adapter run through this so a pulled asset is held to the exact same
 * contract and central rules as a pushed one. Validation lives here (not just
 * in the route) so a mis-mapped pull body is caught as a clean `ok:false`
 * rather than a thrown D1 error mid-write.
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
 * Write one pulse, on Postgres (bead ro-ujb9.76.5.2). A same-day re-push is a
 * new REVISION of that day's report (`noticeos.pulses`; the application never
 * rewrites a report), and the day keeps one number, its first revision's.
 * The alerts the earlier revision raised and nobody has touched are REPLACED by
 * this one (`replaced_by_pulse_id`) where D1 deleted them, so they leave every
 * list, count and action; an alert the operator acknowledged, parked or that
 * was resolved stays, and is not raised twice. Both the asset-declared and
 * centrally-computed flags are then (re)written, and a pulse arriving also
 * auto-resolves any open ingest-freshness flag for the asset. The report, its
 * alerts and the resolutions are ONE transaction, and a second write of the
 * same site and day waits for the first.
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
  // days strictly before this report's own, so reading it before the write
  // reads what D1 read after its upsert.
  const seasonal = await assembleSeasonalInputs(env, envelope, config);
  const central = firedFlags(
    evaluatePulse(envelope, {
      config,
      baselineByMetric: seasonal.baselineByMetric,
      windowObservedByMetric: seasonal.windowObservedByMetric,
      requireHistoricalBaseline: true,
    }),
  );
  // Which metrics are STILL firing tonight. The close-then-reinsert pattern
  // below is unconditional, so "the row went away and came back" is how this
  // lane says both "recovered" and "still broken" — and a snooze has to tell
  // those two apart (`ro-c7qq`).
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
            -- THIS DAY'S REPORT ALREADY SAID IT: an alert of any revision of
            -- the same site and day that was not replaced, which is what D1's
            -- one row per day kept.
            SELECT 1 FROM noticeos.flags f
              JOIN noticeos.pulses p ON p.workspace_id = f.workspace_id AND p.pulse_id = f.pulse_id
             WHERE p.asset_id = $2 AND p.pulse_date = $12::date
               AND f.replaced_by_pulse_id IS NULL
               AND f.rule_id = $9
               AND COALESCE(f.metric, '') = COALESCE($7, '')
               AND ($11::boolean = false OR COALESCE(f.message, '') = COALESCE($8, ''))
          )
            AND NOT EXISTS (
            -- A CONDITION THE OPERATOR PARKED DOES NOT RAISE ITSELF AGAIN
            -- TONIGHT (ro-c7qq). Every other lane dedups per ASSET and
            -- unresolved, so a snoozed flag already suppresses their re-fire;
            -- this one is keyed on the report, and a report is a new row every
            -- night. Without this arm, snoozing one asset's month-old
            -- asset-declared condition would park its sixteen firings and put a
            -- seventeenth on the board by morning — a snooze the cron defeats.
            --
            -- The key is (asset, rule_id, metric): the same scope the Tower's
            -- applyFlagAction dispositions and groupConditionFirings counts, so
            -- what the snooze silences is exactly what the operator's row claimed
            -- to stand for. The clock is receivedAt — this runtime's, never the
            -- asset-supplied generatedAt a spoke could set to the year 2099.
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
        // A SNOOZED FLOW ALERT IS CLOSED BY ITS OWN RECOVERY, AND ONLY BY THAT
        // (`ro-c7qq`). `disposition IS NULL` alone was right while every
        // disposition was permanent: ack and resolve are the operator saying
        // "done with this", and a lane may not undo that. A snooze says "ask
        // me later" — so a metric that recovered while the row was quiet has
        // answered the question, and leaving it parked would hand back a
        // month-old false alarm on its date. It also keeps ro-wlq5's invariant
        // true: these rules close their own flags, so an open one is current.
        //
        // $4 is what makes it a RECOVERY and not a reset. This statement runs
        // for every metric before the night's flags are inserted, so closing a
        // snoozed row unconditionally would clear the snooze on a condition
        // that is still true and let the insert below raise it again — the
        // snooze defeated by the very cron it was set against.
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
 * Build a seasonality-aware baseline from the four matching weekdays before the
 * current report. Normal-volume metrics compare day-to-day at a seven-day
 * offset. Low-volume metrics compare the current multi-day window with four
 * equivalently aligned windows. Any missing cohort keeps that metric quiet.
 *
 * A DAY A REPORTING-TIMEZONE CHANGE DISTORTED STAYS IN THIS COHORT
 * *(decided 2026-09-04, bead `ro-kukv.8`)*. The question was raised because the
 * charts now MARK such a day (`distortedByTimeZoneChange`), and a mark on one
 * surface invites the same exclusion everywhere. It does not belong here: this
 * cohort is built from stored `pulses` rows — an asset's own nightly
 * self-report, which is an asset's Prometheus counters read straight out of
 * its database or its own envelope — and a reporting timezone is a
 * setting on a PROVIDER's property (GA4). Moving GA4's day boundary moves hours
 * between days in the GA4 series and touches nothing these rules read, so
 * excluding Aug 31 here would drop a day that is not distorted. It would also
 * cost more than it saved: the cohort requires all four matching weekdays to be
 * present, so removing one silences that metric for four weeks. A phantom bias
 * is not worth a month of real blindness.
 *
 * THE BOUNDARY, so this stays true rather than lucky: the moment a rule reads a
 * PROVIDER-bucketed daily series (the `signal_values` GA4/GSC rows the Tower
 * charts), the exclusion becomes live and that rule must drop the distorted
 * days from its own cohort. `distortedDays()` in `time-zone-change.ts` is the
 * function to ask; it exists for exactly that caller.
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
 * A site's reports from `from` up to, not including, `before` ('YYYY-MM-DD'),
 * oldest first: each day's newest revision (`noticeos.current_pulses`), the
 * one report D1 kept per day. Shared by the nightly rules and the rule
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
 * unreadable envelope is DROPPED, not defaulted: it cannot be a trustworthy
 * baseline, and a missing cohort day keeps its metric quiet by design. */
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
 * The baseline math itself, over a history the caller already read.
 *
 * SPLIT OUT of {@link assembleSeasonalInputs} for the rule backtest (bead
 * `ro-u072`), which replays thirty days in a row and would otherwise issue
 * thirty near-identical `pulses` reads — or, far worse, carry a second copy of
 * this arithmetic. A preview computed against a different ruler than the
 * nightly lane's is exactly the fake number the backtest exists to avoid, so
 * there is ONE implementation and both callers stand on it.
 *
 * It reads only dates STRICTLY BEFORE the envelope's own day (the four matching
 * weekdays and the windows ending on them), so handing it a history that also
 * contains later days — as the backtest's single wide read does — cannot leak
 * the future into a baseline.
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
 * table is keyed on. Exported for the rule backtest, which walks the same grain
 * backwards to build its window (bead `ro-u072`). */
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
   * report (`expectsNightlyReport`): it declares that it sends none (bead
   * `ro-ujb9.96.8`), or it has never sent one and the flag was fired under the
   * rule before D29's amendment. The report they are about is not owed, so
   * they close rather than linger red. */
  released: number;
  /** Stale properties whose flag was WITHHELD because the store evidences the OS
   * was dark for enough of the silence (see {@link evidencedDarkSpans}). They
   * stay inside `stale`: the report really is late, and what is withheld is the
   * accusation, not the fact. */
  egressGated: number;
}

/** One row of the obligation query: an asset and its newest report, if any. */
interface ObligationRow {
  asset: string;
  status: string;
  last_received: string | null;
}

/** A stretch of wall-clock the store EVIDENCES the OS's own connection was down,
 * in ms. Bounded by readings, never by inference. */
interface DarkSpan {
  startMs: number;
  endMs: number;
}

/**
 * The OS's own dark spans from `sinceIso` on, read off `egress_checks` (db/0023).
 *
 * A span runs from the FIRST down reading of a consecutive run of them to the
 * LAST, and stops there. Both endpoints are readings that failed every beacon,
 * so the OS was demonstrably dark at each; the hours between them are credited
 * because no up reading contradicts them, and the hours AFTER the last down
 * reading are not, because nothing yet says the connection was still out. An
 * isolated down reading is therefore a moment, not a night — a single failed
 * probe never excuses a property's silence.
 *
 * The one reading BEFORE `sinceIso` is read along with the rest, and only for
 * its verdict: it is what says whether the OS was already dark when the window
 * opened. Without it an outage that straddles a property's last report — the OS
 * out at 22:00, the report in at 23:00, the OS still out through the night —
 * would come back as two unrelated moments, and the property would be accused of
 * the silence its own dark uplink caused. How far back that reading sits does not
 * matter, because the overlap is clipped to the window either way.
 *
 * This does not extrapolate past the evidence in either direction, which is what
 * makes it safe against the gate's laziness: a night on which nothing failed
 * files no reading at all (src/egress.ts probes only after a fetch came back
 * empty-handed), and such a night must read as the OS being up, because that is
 * what it was. The run cannot creep either: `EgressGate.finalize` probes once at
 * the end of any run that owes an open `os-egress-down` flag its retraction, so
 * the first lane run after recovery always writes the up reading that closes the
 * span.
 */
async function evidencedDarkSpans(env: IngestEnv, sinceIso: string): Promise<DarkSpan[]> {
  // On Postgres (`noticeos.egress_checks`, bead ro-ujb9.76.5.1). Readings a
  // lane run took at one instant come in the order they were written, as D1's
  // index returned them.
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
 * Hourly ingest-freshness check (docs/06, the 2026-07 audit's finding 5): start from the
 * ASSETS and LEFT JOIN their latest pulse, so every asset is a row in the
 * result and the contract's `reportingState` decides which of them owe a
 * report.
 *
 * One failure fires the `error` flag:
 *
 *   - STALE — reported before, nothing in `REPORT_MAX_AGE_HOURS`. A wired
 *     lane broke. Except: staleness does not count hours the OS itself was dark
 *     (ro-6le). The 2026-08-08 uplink outage is why — the egress gate stops the
 *     pull lane from blaming a property it could not reach that night, but 48h
 *     of the same outage used to bring this rule around to accuse those very
 *     properties of having gone quiet: the same wrong sentence through a second
 *     door. So the age is reduced by the dark hours the store EVIDENCES inside
 *     it (see {@link evidencedDarkSpans}) before it is read against the
 *     threshold, and a flag that still fires carries `osDarkHours` so the read
 *     side can say so. The property is still counted `stale` either way — the
 *     Tower counts it stale at the same age off the same store (ro-uwo.1), and
 *     a coverage tally that quietly disagreed with it would be the older bug.
 *     Push and pull are treated alike: when this house's uplink is out, a
 * *     property cannot reach the OS to push any more than the OS can reach it to
 *     pull.
 *
 * It never double-fires while an open freshness flag exists, and it resolves
 * on the next accepted pulse (writePulse).
 *
 * A SITE THAT HAS NEVER SENT A REPORT OWES NONE (D29, amended 2026-09-23, bead
 * `ro-ujb9.121`, `expectsNightlyReport` in the contract). The report is a push
 * from the site's own code, so a site without one is not a broken lane, just a
 * site nobody set a sender up for; it used to earn a "never reported" error 48
 * hours after it was added. Its first report makes it expected, and only then
 * can it go stale.
 *
 * AN ASSET THAT DECLARED IT SENDS NO NIGHTLY REPORT OWES NONE EITHER (bead
 * `ro-ujb9.96.8`). The declaration is read store first from
 * `config/constants.json` — the same document and the same rule the Tower
 * counts with — so it is `not-expected` here exactly as it is on the SYSTEM
 * card. Any freshness flag still open for a site that expects no report — one
 * fired before a declaration, or a "never reported" one fired before the
 * amendment — is resolved by this run.
 *
 * The age this reads late at is the contract's `REPORT_MAX_AGE_HOURS`, never a
 * number of this worker's own: the Tower counts the same property stale at the
 * same age, so an open error flag here and a "fresh" tally there can never
 * describe one property in one payload (ro-uwo.1).
 */
export async function runFreshnessCheck(env: IngestEnv, nowMs: number = Date.now()): Promise<FreshnessResult> {
  const now = iso(nowMs);

  // Every site and its newest report's arrival, on Postgres: a report is its
  // day's newest revision, arriving when that revision did, as D1's one row
  // per day was stamped by its latest write. Ordered by id, as D1's GROUP BY
  // returned them.
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

  // Store first, then the copy compiled into this Worker — the fallback rule
  // `readCollectorConfigs` writes once for every lane.
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

  // The dark-hour evidence, loaded ONCE per run and only when something is
  // actually stale — an hour with nothing late spends no query on it — from the
  // oldest silence in play, since that is the earliest window any of these
  // properties can be measured over.
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
    // Hours the OS spent dark inside this property's own silence. An
    // unreadable `received_at` is `stale` too (see `reportingState`) and gets
    // no credit: with no window start there is nothing to overlap, and a
    // defective timestamp must not buy an excuse.
    const darkMs = Number.isFinite(receivedMs)
      ? darkOverlapMs(darkSpans, receivedMs, nowMs)
      : 0;
    // NaN fails this comparison, so an unreadable timestamp still fires —
    // exactly as it did before any of this existed.
    if (ageMs - darkMs <= REPORT_MAX_AGE_HOURS * 3_600_000) {
      egressGated += 1;
      return [];
    }
    // Rounded, because this number is shown: a dark span too short to print as
    // an hour is not worth a clause, and it was already counted where it
    // counts (above, in full).
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
    // The store's own record, values only (bead `ro-ujb9.96.6.26`): the
    // Tower's headline and its "OS offline, not counted" row are drawn from
    // the inputs above, and this line is what the Discord digest carries.
    const message =
      `no pulse in ${ageHours}h (> ${REPORT_MAX_AGE_HOURS}h threshold)` +
      (osDarkHours > 0 ? ` · OS offline ${osDarkHours}h` : '');

    // Insert only when no identical open freshness flag exists for the asset.
    return [{ asset: row.asset, message, inputs }];
  });

  // A freshness flag open for a site that expects no report — opened before it
  // declared it sends none, or a "never reported" one from before D29's
  // amendment — is about a report nobody owes: close it, the way a report
  // arriving would, rather than leave it red until somebody resolves it by hand.
  const releases = obligations.results.filter(
    (row) => !expectsNightlyReport(declared.has(row.asset), row.last_received),
  );

  // One transaction, as D1's one batch: each stale site's alert raised unless
  // one is open, and each released one closed.
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
 * Nightly asset-#0 self-pulse (docs/06): the OS reports what Phase 0 can observe
 * about itself — pulses received, ledger rows ingested, open flags by severity,
 * and cron-run success — in the very same envelope shape every asset emits, and
 * writes it through the same pulse path (so the OS is held to its own contract).
 *
 * It reports AS the store's OS asset (`readOsAssetId`). A store with no OS row
 * writes nothing and answers null: a self-report with no self is not a report.
 */
export async function runAssetZeroPulse(env: Pick<IngestEnv, 'STORE'>, nowMs: number = Date.now()): Promise<WritePulseResult | null> {
  const now = iso(nowMs);
  const dayAgo = iso(nowMs - 24 * 3_600_000);
  const weekAgo = iso(nowMs - 7 * 24 * 3_600_000);

  // Reports and open alerts on Postgres (bead ro-ujb9.76.5.2): a report is a
  // day's newest revision, received in the window as D1's one row per day was
  // stamped by its latest arrival; an alert reads as its newest reading, and a
  // replaced one is none.
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
      // Money entries booked: revenue and cost (a change entry names no money, D36).
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

  // flow metrics carry a real 7-day mean; gauges set avg7d == last24h so the
  // volume-aware drop rule can never spuriously fire on a point-in-time count.
  const flow = (last24h: number, week: number, total: number) => ({ last24h, avg7d: week / 7, total });
  const gauge = (n: number) => ({ last24h: n, avg7d: n, total: n });

  // Cron success is now OBSERVED, from the runner's job-run record (db/0022,
  // ro-uwo.4) — it was a hard-coded 1 until 2026-08-04, which meant a lane that
  // never fired still scored full marks (the 2026-07 audit's finding 6). `null` is the third
  // state and the honest one: an empty record is not evidence of success and not
  // evidence of failure, so the metric and its capability are BOTH omitted
  // rather than filled in. docs/02 defines `capabilities` as what the asset can
  // actually observe, which is the same sentence read from the other side.
  const cronRunSuccess = cronRunSuccessValue(cronLatest, nowMs);

  // TONIGHT'S ALERT SHAPE, WRITTEN DOWN (db/0033, bead `ro-78qo.36`). This lane
  // already counts what the store holds tonight, and open-alert counts are the
  // one thing /alerts states that nothing keeps a history of.
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
