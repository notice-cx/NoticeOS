// Central count alerts compare complete aligned periods with a future-count
// prediction. Historical Poisson primitives remain available for old callers.
// Every verdict preserves the exact decision inputs for storage and replay.

import { COUNT_HISTORY_PERIODS, forecastLowerTail, type CountForecast } from './count-forecast.js';
import { poissonLowerTail } from './poisson.js';
import type { FlagKind, FlagSeverity, PulseEnvelope } from './schema.js';

export interface RuleConfig {
  /** Sensitivity budget allocated across candidate windows and tails. Default 0.01. */
  alpha: number;
  /** The longest window, in whole days, a quiet metric is pooled over. Default 14. */
  maxWindowDays: number;
}

/** docs/02 / config/constants.json `flag_defaults`. */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  alpha: 0.01,
  maxWindowDays: 14,
};

/** The most `maxWindowDays` may be. Past four weeks a drop is no longer news,
 * and its eight aligned historical windows reach back
 * more than seven months. */
export const MAX_WINDOW_DAYS_LIMIT = 28;

/**
 * Whether a run of zeros where `expected` events were due is improbable enough
 * to fire. It decides how long a window must be before a drop in it can show.
 */
export function zeroCanFire(
  expected: number,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): boolean {
  return expected > 0 && poissonLowerTail(0, expected) < config.alpha;
}

/**
 * The shortest whole-day window, at most `maxWindowDays`, in which a metric
 * averaging `baselinePerDay` falling to zero would fire; undefined when not
 * even the longest one would. 1 is the one-day test. At alpha 0.01: 4.61 a day
 * or more is judged on one day, 3 on two, 1.5 on four, 1 on five, 0.5 on ten.
 */
export function windowDaysFor(
  baselinePerDay: number,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): number | undefined {
  for (let days = 1; days <= config.maxWindowDays; days++) {
    if (zeroCanFire(baselinePerDay * days, config)) return days;
  }
  return undefined;
}

/** The daily average a metric must exceed to be judged at all: `zeroCanFire`
 * solved for the longest window. */
export function quietestJudgedPerDay(config: RuleConfig = DEFAULT_RULE_CONFIG): number {
  return Math.log(1 / config.alpha) / config.maxWindowDays;
}

export interface FiredFlag {
  severity: FlagSeverity;
  kind: FlagKind;
  metric: string;
  message: string;
}

export type RuleOutcome = 'fired' | 'ok' | 'not-applicable';

export interface RuleVerdict {
  ruleId: string;
  /** 'fired' → persist a flag; 'ok' → in-regime but not anomalous; 'not-applicable' → out of this rule's regime. */
  outcome: RuleOutcome;
  /** The exact inputs the rule saw — persisted verbatim as `rule_inputs` for auditability. */
  inputs: Record<string, unknown>;
  /** Present iff outcome === 'fired'. */
  flag?: FiredFlag;
}

/** Probability formatted for a flag message, e.g. 0.0020294 -> "0.0020". */
function fmtProb(p: number): string {
  return p.toPrecision(2);
}

/**
 * One-day drop detector. Models today's count as Poisson(baseline) and fires
 * when the lower-tail probability of seeing a count this low is < alpha.
 * Applies only when a zero day alone could fire; a quieter metric is judged
 * over several days (see flowLowVolumeAnomaly).
 */
export function flowPoissonAnomaly(
  metric: string,
  observed: number,
  baselinePerDay: number,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): RuleVerdict {
  const ruleId = 'flow-poisson-low';
  const inputs: Record<string, unknown> = {
    metric,
    observed,
    baselinePerDay,
    alpha: config.alpha,
    windowHours: 24,
  };
  if (!zeroCanFire(baselinePerDay, config)) {
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const lambda = baselinePerDay; // one-day window, weight 1
  const pLowerTail = poissonLowerTail(observed, lambda);
  inputs.lambda = lambda;
  inputs.pLowerTail = pLowerTail;
  if (pLowerTail < config.alpha) {
    return {
      ruleId,
      outcome: 'fired',
      inputs,
      flag: {
        severity: 'warn',
        kind: 'anomaly',
        metric,
        message: `${observed} in last24h (avg7d ${baselinePerDay.toFixed(1)}, P(<=${observed})~=${fmtProb(pLowerTail)})`,
      },
    };
  }
  return { ruleId, outcome: 'ok', inputs };
}

/**
 * Multi-day drop detector. Compares the count over the last `windowDays` days
 * with `baselinePerDay * windowDays`. The caller assembles `windowObserved` by
 * summing the recent daily counts; when it is undefined (no history yet) the
 * rule stays quiet rather than guess. A window too short for even a run of
 * zeros to fire is not judged: no count in it could raise an alert.
 */
export function flowLowVolumeAnomaly(
  metric: string,
  windowObserved: number | undefined,
  baselinePerDay: number,
  windowDays: number,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): RuleVerdict {
  const ruleId = 'flow-lowvol-window';
  const windowHours = windowDays * 24;
  const inputs: Record<string, unknown> = {
    metric,
    windowObserved: windowObserved ?? null,
    baselinePerDay,
    alpha: config.alpha,
    windowHours,
    maxWindowDays: config.maxWindowDays,
  };
  if (windowDays <= 1) {
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const lambda = baselinePerDay * windowDays;
  inputs.lambda = lambda;
  inputs.windowDays = windowDays;
  if (!zeroCanFire(lambda, config)) {
    inputs.reason = 'too-few-expected';
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  if (windowObserved === undefined) {
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const pLowerTail = poissonLowerTail(windowObserved, lambda);
  inputs.pLowerTail = pLowerTail;
  if (pLowerTail < config.alpha) {
    return {
      ruleId,
      outcome: 'fired',
      inputs,
      flag: {
        severity: 'warn',
        kind: 'anomaly',
        metric,
        message: `${windowObserved} in last${windowHours}h (baseline ${lambda.toFixed(1)}, P(<=${windowObserved})~=${fmtProb(pLowerTail)})`,
      },
    };
  }
  return { ruleId, outcome: 'ok', inputs };
}

/** Current central count decision; old functions remain available for replay
 * comparisons and historical evidence. Both filters share the same inputs. */
export function flowPredictiveAnomaly(
  metric: string,
  observed: number | undefined,
  baseline: MetricBaseline,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): RuleVerdict {
  const forecast = baseline.forecast!;
  const ruleId = baseline.windowHours <= 24 ? 'flow-poisson-low' : 'flow-lowvol-window';
  const inputs: Record<string, unknown> = {
    metric, observed: observed ?? null, windowObserved: observed ?? null,
    windowHours: baseline.windowHours, windowDays: baseline.windowHours / 24,
    baselinePerDay: baseline.perDay, alpha: config.alpha,
    prediction: forecast, pooledGroups: baseline.pooledGroups,
  };
  if (observed === undefined || !Number.isSafeInteger(observed) || observed < 0 || !baseline.eligible) {
    inputs.reason = observed === undefined ? 'missing-observation' : 'insufficient-predictive-evidence';
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const score = forecastLowerTail(observed, forecast);
  inputs.predictiveScore = score;
  if (observed < forecast.lower && score < forecast.alpha) {
    return { ruleId, outcome: 'fired', inputs, flag: {
      severity: 'warn', kind: 'anomaly', metric,
      message: `${observed} in last${baseline.windowHours}h (prediction ${forecast.lower}–${forecast.upper}; ${forecast.comparisonCounts.length} comparable periods)`,
    } };
  }
  return { ruleId, outcome: 'ok', inputs };
}

export interface EvaluateOptions {
  config?: RuleConfig;
  /**
   * Central history-derived baseline per metric. The current implementation
   * uses eight aligned historical periods, keeping a
   * cyclical property from comparing a weekend with a weekday average.
   */
  baselineByMetric?: Record<string, MetricBaseline>;
  /** When true, a metric with no complete historical baseline stays quiet
   * instead of falling back to the asset-supplied avg7d. */
  requireHistoricalBaseline?: boolean;
  /**
   * Caller-assembled multi-day window count per metric: the sum of the recent
   * daily `last24h` values over the metric's window, which is the one its
   * central baseline was measured over, or `windowDaysFor` its avg7d. Enables
   * the multi-day rule; metrics absent from this map are 'not-applicable' there.
   */
  windowObservedByMetric?: Record<string, number>;
}

/**
 * One metric's historical ruler, and the dates it was read from.
 *
 * A provider reporting-timezone change does not thin this cohort:
 * `comparisonDates` index stored pulse rows, which an asset reports out of its
 * own database, and a reporting timezone redistributes hours only inside that
 * provider's series. This holds only while the inputs stay asset-reported; a
 * rule fed a provider-bucketed daily series must exclude the distorted days
 * (`assembleSeasonalInputs` in `workers/ingest/src/db.ts`, docs/02).
 */
export interface MetricBaseline {
  perDay: number;
  source: 'same-weekday-4w' | 'same-weekday-8-periods';
  forecast?: CountForecast;
  eligible?: boolean;
  pooledGroups?: number;
  observed?: number;
  candidates?: MetricBaseline[];
  sampleSize: number;
  comparisonDates: string[];
  /** The window the baseline was measured over and the metric is judged on;
   * 24 is the one-day test. */
  windowHours: number;
}

/**
 * Evaluate a whole pulse envelope: for each metric pick its window — the one
 * its central baseline was measured over, or else the shortest one its avg7d
 * needs — run the one-day rule or the multi-day rule on it, and return every
 * verdict (fired and not). Callers persist the ones whose outcome is 'fired',
 * carrying `rule_id` + `rule_inputs` onto each flag row.
 */
export function evaluatePulse(
  envelope: PulseEnvelope,
  options: EvaluateOptions = {},
): RuleVerdict[] {
  const config = options.config ?? DEFAULT_RULE_CONFIG;
  const verdicts: RuleVerdict[] = [];
  for (const [metric, series] of Object.entries(envelope.metrics)) {
    let historical = options.baselineByMetric?.[metric];
    if (options.requireHistoricalBaseline && !historical) {
      verdicts.push({
        ruleId: 'flow-seasonal-baseline',
        outcome: 'not-applicable',
        inputs: {
          metric,
          observed: series.last24h,
          reason: 'insufficient-same-weekday-history',
          requiredWeeks: COUNT_HISTORY_PERIODS,
        },
      });
      continue;
    }
    const baselinePerDay = historical?.perDay ?? series.avg7d;
    const windowDays = historical
      ? historical.windowHours / 24
      : (windowDaysFor(baselinePerDay, config) ?? config.maxWindowDays);
    let verdict: RuleVerdict;
    if (historical?.candidates?.length) {
      const candidates = historical.candidates.map((baseline) => ({
        baseline,
        verdict: flowPredictiveAnomaly(metric, baseline.observed, baseline, config),
      }));
      const selected = candidates.find((candidate) => candidate.verdict.outcome === 'fired')
        ?? candidates.find((candidate) => candidate.verdict.outcome === 'ok')
        ?? candidates[candidates.length - 1]!;
      historical = selected.baseline;
      verdict = selected.verdict;
    } else {
      verdict = historical?.forecast
      ? flowPredictiveAnomaly(metric, windowDays <= 1 ? series.last24h : options.windowObservedByMetric?.[metric], historical, config)
      : windowDays <= 1
        ? flowPoissonAnomaly(metric, series.last24h, baselinePerDay, config)
        : flowLowVolumeAnomaly(
            metric,
            options.windowObservedByMetric?.[metric],
            baselinePerDay,
            windowDays,
            config,
          );
    }
    if (historical) {
      Object.assign(verdict.inputs, {
        baselineSource: historical.source,
        baselineSampleSize: historical.sampleSize,
        baselineComparisonDates: historical.comparisonDates,
        baselineWindowHours: historical.windowHours,
      });
      if (verdict.flag && verdict.ruleId === 'flow-poisson-low') {
        verdict.flag.message = verdict.flag.message.replace(
          'avg7d',
          'same-weekday baseline',
        );
      }
    }
    verdicts.push(verdict);
  }
  return verdicts;
}

/** Convenience: just the flags that fired, ready to persist. */
export function firedFlags(verdicts: RuleVerdict[]): RuleVerdict[] {
  return verdicts.filter((v) => v.outcome === 'fired');
}
