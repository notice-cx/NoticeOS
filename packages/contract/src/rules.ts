// Volume-aware anomaly rules (docs/02): at healthy volume a drop is judged by
// its Poisson tail probability; below that volume a single zero-day is routine
// noise, so the rule widens to a multi-day window, or stays quiet.
//
// Every rule is pure and returns a full RuleVerdict, fired or not, so the
// caller can persist the exact inputs a rule saw as `rule_inputs`.

import { poissonLowerTail } from './poisson.js';
import type { FlagKind, FlagSeverity, PulseEnvelope } from './schema.js';

export interface RuleConfig {
  /** Tail-probability threshold below which a drop fires. docs/02 default 0.01. */
  alpha: number;
  /** Baseline (per-day) at/above which the single-day Poisson rule applies. Default 3. */
  minBaselinePerDay: number;
  /** Window (hours) the low-volume rule aggregates over. Default 72. */
  lowVolumeWindowHours: number;
}

/** docs/02 / config/constants.json `flag_defaults`. */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  alpha: 0.01,
  minBaselinePerDay: 3,
  lowVolumeWindowHours: 72,
};

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
 * Normal-volume drop detector. Models today's count as Poisson(avg7d) and fires
 * when the lower-tail probability of seeing a count this low is < alpha. Applies
 * only when the baseline clears `minBaselinePerDay` — below that, a zero-day is
 * routine noise and this rule stands down (see flowLowVolumeAnomaly).
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
    minBaselinePerDay: config.minBaselinePerDay,
    windowHours: 24,
  };
  if (baselinePerDay < config.minBaselinePerDay) {
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
 * Low-volume drop detector. Below `minBaselinePerDay` a single-day Poisson test
 * is too noisy, so this compares a multi-day window (default 72h) against
 * `baselinePerDay * windowDays` (docs/02: "last72h vs 3x daily baseline"). The
 * caller assembles `windowObserved` by summing the recent daily counts; when it
 * is undefined (no history yet) the rule stays quiet rather than guess — which
 * is the whole point of being volume-aware.
 */
export function flowLowVolumeAnomaly(
  metric: string,
  windowObserved: number | undefined,
  baselinePerDay: number,
  config: RuleConfig = DEFAULT_RULE_CONFIG,
): RuleVerdict {
  const ruleId = 'flow-lowvol-window';
  const windowDays = config.lowVolumeWindowHours / 24;
  const inputs: Record<string, unknown> = {
    metric,
    windowObserved: windowObserved ?? null,
    baselinePerDay,
    alpha: config.alpha,
    windowHours: config.lowVolumeWindowHours,
  };
  if (baselinePerDay >= config.minBaselinePerDay) {
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const lambda = baselinePerDay * windowDays; // 3x daily baseline
  inputs.lambda = lambda;
  inputs.windowDays = windowDays;
  // No window data to compare, or no baseline established yet -> stay quiet.
  if (windowObserved === undefined || lambda <= 0) {
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
        message: `${windowObserved} in last${config.lowVolumeWindowHours}h (baseline ${lambda.toFixed(1)}, P(<=${windowObserved})~=${fmtProb(pLowerTail)})`,
      },
    };
  }
  return { ruleId, outcome: 'ok', inputs };
}

/**
 * Percentage-drop tripwire, gated on a minimum absolute count (docs/02:
 * "percentage-drop rules gate on minimum absolute counts" — so a 1->0 day on a
 * tiny metric never reads as a "100% drop"). Available as a per-asset-configured
 * alternative to the Poisson rule; it is NOT wired into the default evaluator,
 * because at the volume where it is meaningful the Poisson tail already
 * subsumes it and running both would double-fire the same metric.
 */
export function percentageDropAnomaly(
  metric: string,
  observed: number,
  baselinePerDay: number,
  opts: { minDropFraction?: number; minAbsoluteCount?: number } = {},
): RuleVerdict {
  const ruleId = 'flow-pct-drop';
  const minDropFraction = opts.minDropFraction ?? 0.5;
  const minAbsoluteCount = opts.minAbsoluteCount ?? 5;
  const inputs: Record<string, unknown> = {
    metric,
    observed,
    baselinePerDay,
    minDropFraction,
    minAbsoluteCount,
  };
  if (baselinePerDay < minAbsoluteCount) {
    return { ruleId, outcome: 'not-applicable', inputs };
  }
  const dropFraction = (baselinePerDay - observed) / baselinePerDay;
  inputs.dropFraction = dropFraction;
  if (dropFraction >= minDropFraction) {
    return {
      ruleId,
      outcome: 'fired',
      inputs,
      flag: {
        severity: 'warn',
        kind: 'anomaly',
        metric,
        message: `${observed} in last24h is ${Math.round(dropFraction * 100)}% below avg7d ${baselinePerDay.toFixed(1)}`,
      },
    };
  }
  return { ruleId, outcome: 'ok', inputs };
}

export interface EvaluateOptions {
  config?: RuleConfig;
  /**
   * Central history-derived baseline per metric. The current implementation
   * uses four matching weekdays (or four aligned multi-day windows), keeping a
   * cyclical property from comparing a weekend with a weekday average.
   */
  baselineByMetric?: Record<string, MetricBaseline>;
  /** When true, a metric with no complete historical baseline stays quiet
   * instead of falling back to the asset-supplied avg7d. */
  requireHistoricalBaseline?: boolean;
  /**
   * Caller-assembled multi-day window count per metric (sum of the recent daily
   * `last24h` values over `lowVolumeWindowHours`). Enables the low-volume rule;
   * metrics absent from this map fall through to 'not-applicable' there.
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
  source: 'same-weekday-4w';
  sampleSize: number;
  comparisonDates: string[];
  windowHours: number;
}

/**
 * Evaluate a whole pulse envelope: for each metric pick the regime by baseline
 * — Poisson single-day at/above `minBaselinePerDay`, the multi-day window below
 * it — and return every verdict (fired and not). Callers persist the ones whose
 * outcome is 'fired', carrying `rule_id` + `rule_inputs` onto each flag row.
 */
export function evaluatePulse(
  envelope: PulseEnvelope,
  options: EvaluateOptions = {},
): RuleVerdict[] {
  const config = options.config ?? DEFAULT_RULE_CONFIG;
  const verdicts: RuleVerdict[] = [];
  for (const [metric, series] of Object.entries(envelope.metrics)) {
    const historical = options.baselineByMetric?.[metric];
    if (options.requireHistoricalBaseline && !historical) {
      verdicts.push({
        ruleId: 'flow-seasonal-baseline',
        outcome: 'not-applicable',
        inputs: {
          metric,
          observed: series.last24h,
          reason: 'insufficient-same-weekday-history',
          requiredWeeks: 4,
        },
      });
      continue;
    }
    const baselinePerDay = historical?.perDay ?? series.avg7d;
    const verdict =
      baselinePerDay >= config.minBaselinePerDay
        ? flowPoissonAnomaly(metric, series.last24h, baselinePerDay, config)
        : flowLowVolumeAnomaly(
            metric,
            options.windowObservedByMetric?.[metric],
            baselinePerDay,
            config,
          );
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
