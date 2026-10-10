/**
 * Replay one alert rule over the stored pulses: how often would it have fired
 * in the last 30 days with these settings? It lives here because the baseline
 * does: the nightly lane judges a pulse against four matching weekdays from the
 * `pulses` table (`seasonalInputsFrom`), and a preview computed against a flat
 * `avg7d` would look the same and mean something else. Read-only: the settings
 * that arrive are candidates. One wide read spans the whole horizon and
 * `seasonalInputsFrom`, which only looks strictly before the day it judges, is
 * called once per day over it.
 */

import {
  evaluatePulse,
  isBacktestableRule,
  RULE_BACKTEST_WINDOW_DAYS,
  type PulseEnvelope,
  type RuleBacktest,
  type RuleBacktestDay,
  type RuleBacktestInput,
  type RuleBacktestIssue,
  type RuleBacktestResult,
  type RuleConfig,
  type RuleVerdict,
} from '@noticeos/contract';
import { assetKnown } from './asset-registry.js';
import {
  parsePulseHistory,
  readReportHistory,
  pulseDay,
  seasonalHistorySpanDays,
  seasonalInputsFrom,
  shiftDate,
} from './db.js';

/** The rule id `evaluatePulse` returns when `requireHistoricalBaseline` stands a
 * metric down for want of a complete same-weekday cohort. */
const SEASONAL_BASELINE_RULE_ID = 'flow-seasonal-baseline';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** The asset-id shape the store uses (`example.com`, `home-os`). */
const ASSET_PATTERN = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/**
 * Bounds the replay refuses outright: the Tower's own field bounds, restated
 * because this runtime is the authority and a candidate over the binding was
 * never typed into that field. `alpha` at 0 silences every rule, at 1 fires on
 * every reading, and a non-positive window has no days in it.
 */
function configIssues(config: unknown): RuleBacktestIssue[] {
  const issues: RuleBacktestIssue[] = [];
  const c = config as Partial<RuleConfig> | null | undefined;
  if (!c || typeof c !== 'object') {
    return [{ path: 'config', code: 'required', message: 'config must be an object' }];
  }
  const number = (path: string, value: unknown, min: number, max: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, code: 'type', message: `${path} must be a finite number` });
      return;
    }
    if (value <= min || value > max) {
      issues.push({
        path,
        code: 'range',
        message: `${path} must be greater than ${min} and at most ${max}`,
      });
    }
  };
  number('config.alpha', c.alpha, 0, 1);
  number('config.minBaselinePerDay', c.minBaselinePerDay, 0, 100_000);
  number('config.lowVolumeWindowHours', c.lowVolumeWindowHours, 0, 24 * 90);
  return issues;
}

function inputIssues(input: RuleBacktestInput): RuleBacktestIssue[] {
  const issues: RuleBacktestIssue[] = [];
  if (typeof input?.asset !== 'string' || !ASSET_PATTERN.test(input.asset)) {
    issues.push({ path: 'asset', code: 'format', message: 'asset must be a store asset id' });
  }
  if (input?.metric != null && (typeof input.metric !== 'string' || input.metric.length > 120)) {
    issues.push({ path: 'metric', code: 'format', message: 'metric must be a metric name' });
  }
  if (input?.through !== undefined && !DATE_PATTERN.test(String(input.through))) {
    issues.push({ path: 'through', code: 'format', message: 'through must be YYYY-MM-DD' });
  }
  return [...issues, ...configIssues(input?.config)];
}

/**
 * Refusals come back as results a panel renders in place of a strip; only a
 * store failure throws.
 */
export async function backtestRule(
  env: IngestEnv,
  input: RuleBacktestInput,
): Promise<RuleBacktestResult> {
  const issues = inputIssues(input);
  if (issues.length > 0) return { ok: false, error: 'validation', issues };
  if (!isBacktestableRule(input.ruleId)) {
    return { ok: false, error: 'unsupported_rule', ruleId: String(input.ruleId) };
  }
  const ruleId = input.ruleId;

  if (!(await assetKnown(env.STORE, input.asset))) return { ok: false, error: 'unknown_asset', asset: input.asset };

  const config = input.config;
  const metric = input.metric ?? null;
  const lastDay = input.through ?? pulseDay(new Date().toISOString());
  const firstDay = shiftDate(lastDay, -(RULE_BACKTEST_WINDOW_DAYS - 1));
  // The oldest day in the window still needs its own four weeks behind it.
  const readFrom = shiftDate(firstDay, -seasonalHistorySpanDays(config));

  // The nightly lane's own read (`readReportHistory`), through the window's
  // last day.
  const rows = await readReportHistory(env, input.asset, readFrom, shiftDate(lastDay, 1));
  const history = parsePulseHistory(rows);

  const storedDays = await storedFiringDays(
    env,
    input.asset,
    ruleId,
    metric,
    firstDay,
    lastDay,
  );

  const days: RuleBacktestDay[] = [];
  for (let offset = RULE_BACKTEST_WINDOW_DAYS - 1; offset >= 0; offset--) {
    const date = shiftDate(lastDay, -offset);
    days.push(replayDay(date, history, config, ruleId, metric, storedDays.has(date)));
  }

  return {
    ok: true,
    backtest: {
      asset: input.asset,
      ruleId,
      metric,
      config,
      windowDays: RULE_BACKTEST_WINDOW_DAYS,
      firstDay,
      lastDay,
      days,
      wouldFire: days.filter((day) => day.state === 'fired').length,
      judged: days.filter((day) => day.state === 'fired' || day.state === 'quiet').length,
      reported: days.filter((day) => day.state !== 'no-report').length,
      firedInStore: storedDays.size,
    },
  };
}

/**
 * One day, judged with exactly the options the nightly lane passes, including
 * `requireHistoricalBaseline: true`, or it would promise alerts on days the
 * real detector stays silent through.
 */
function replayDay(
  date: string,
  history: ReadonlyMap<string, PulseEnvelope>,
  config: RuleConfig,
  ruleId: string,
  metric: string | null,
  stored: boolean,
): RuleBacktestDay {
  const envelope = history.get(date);
  if (!envelope) return { date, state: 'no-report', firings: [], stored };

  const seasonal = seasonalInputsFrom(history, envelope, config);
  const verdicts = evaluatePulse(envelope, {
    config,
    baselineByMetric: seasonal.baselineByMetric,
    windowObservedByMetric: seasonal.windowObservedByMetric,
    requireHistoricalBaseline: true,
  }).filter((verdict) => metric === null || verdictMetric(verdict) === metric);

  const firings = verdicts
    .filter((verdict) => verdict.outcome === 'fired' && verdict.ruleId === ruleId)
    .map((verdict) => ({
      metric: String(verdict.inputs.metric ?? ''),
      severity: verdict.flag!.severity,
    }));
  if (firings.length > 0) return { date, state: 'fired', firings, stored };

  // "It ran and stayed silent" and "it never ran" are different facts.
  // `flow-seasonal-baseline` is the lane standing a metric down for want of a
  // cohort; `not-applicable` is the metric sitting in the other volume regime.
  const ran = verdicts.some(
    (verdict) => verdict.ruleId === ruleId && verdict.outcome === 'ok',
  );
  if (ran) return { date, state: 'quiet', firings: [], stored };

  const noBaseline = verdicts.some(
    (verdict) => verdict.ruleId === SEASONAL_BASELINE_RULE_ID,
  );
  return {
    date,
    state: 'unjudged',
    firings: [],
    reason: noBaseline ? 'no-baseline' : 'out-of-regime',
    stored,
  };
}

function verdictMetric(verdict: RuleVerdict): string | null {
  const value = verdict.inputs.metric;
  return typeof value === 'string' ? value : null;
}

/**
 * The days this rule actually fired on, from the stored alerts. Distinct days,
 * the same unit as `wouldFire`; a dispositioned alert still fired.
 */
async function storedFiringDays(
  env: IngestEnv,
  asset: string,
  ruleId: string,
  metric: string | null,
  firstDay: string,
  lastDay: string,
): Promise<Set<string>> {
  // The UTC day each alert fired on, never one a same-day report retry replaced.
  const rows = await env.STORE.read((tx) =>
    tx.query<{ day: string }>(
      `SELECT DISTINCT ((fired_at AT TIME ZONE 'UTC')::date)::text AS day
         FROM noticeos.current_flags
        WHERE asset_id = $1 AND rule_id = $2
          AND (fired_at AT TIME ZONE 'UTC')::date BETWEEN $3::date AND $4::date
          AND ($5::text IS NULL OR metric = $5)`,
      [asset, ruleId, firstDay, lastDay, metric],
    ),
  );
  return new Set(rows.map((row) => row.day));
}
