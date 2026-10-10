/**
 * Cross-Worker contract for the alert-rule backtest: "how often would this
 * rule have fired in the last 30 days with these knobs?" The answer is
 * produced by `evaluatePulse` over the stored pulses, against the same
 * seasonal baselines the nightly lane uses; those are assembled inside the
 * ingest Worker, so the backtest runs there and the Tower asks over the
 * private ingest Service Binding. Read-only: replaying a rule writes no flag
 * and touches no config.
 */

import type { RuleConfig } from './rules.js';
import type { FlagSeverity } from './schema.js';

/** Fixed rather than a caller parameter, so two surfaces can never quote two
 * different windows for the same rule. */
export const RULE_BACKTEST_WINDOW_DAYS = 30;

/**
 * The rule families a pulse replay can serve: the whole output of
 * `evaluatePulse`, the only rules the `flag_defaults` knobs steer, reading
 * nothing but stored pulse envelopes. Every other rule id is fed by something
 * a replay does not have (arrival times against a wall clock, an envelope the
 * asset authored, a pre-registered outcome check) and gets no preview.
 */
export const BACKTESTABLE_RULE_IDS = [
  'flow-poisson-low',
  'flow-lowvol-window',
] as const;
export type BacktestableRuleId = (typeof BACKTESTABLE_RULE_IDS)[number];

export function isBacktestableRule(ruleId: string): ruleId is BacktestableRuleId {
  return (BACKTESTABLE_RULE_IDS as readonly string[]).includes(ruleId);
}

/**
 * One replay request. `metric` scopes the answer to one metric; omit it for
 * the whole asset. `through` is the last day of the window, inclusive
 * (`YYYY-MM-DD`); absent, the runtime's own UTC today, the `pulses` grain.
 */
export interface RuleBacktestInput {
  asset: string;
  ruleId: string;
  config: RuleConfig;
  metric?: string | null;
  through?: string;
}

/**
 * What one replayed day means. Four states, because "it did not fire" hides
 * two different facts.
 *
 * - `fired`      — the rule fires with these knobs.
 * - `quiet`      — the rule RAN and stayed silent. The only honest "no".
 * - `unjudged`   — the rule could not run: no complete same-weekday cohort yet,
 *                  or the metric sat outside this rule's volume regime that day.
 * - `no-report`  — the asset filed no pulse for that day. Nothing to replay.
 */
export type RuleBacktestDayState = 'fired' | 'quiet' | 'unjudged' | 'no-report';

/** Why a day could not be judged. Absent on every other state. */
export type RuleBacktestUnjudgedReason = 'no-baseline' | 'out-of-regime';

export interface RuleBacktestDay {
  /** `YYYY-MM-DD`, UTC — the `pulses` grain. */
  date: string;
  state: RuleBacktestDayState;
  /** The metrics that would have fired, with the severity the rule would carry.
   * Empty unless `state` is `fired`. */
  firings: { metric: string; severity: FlagSeverity }[];
  reason?: RuleBacktestUnjudgedReason;
  /** Did this rule actually fire on this day — a stored `flags` row, not a
   * replay? Per day, so the candidate can be read against reality where it
   * differs. */
  stored: boolean;
}

/**
 * The answer. `wouldFire` and `firedInStore` are both counts of days, so they
 * compare. `config` is echoed so a strip that arrived after the operator typed
 * again can say which numbers it is a picture of.
 */
export interface RuleBacktest {
  asset: string;
  ruleId: BacktestableRuleId;
  metric: string | null;
  config: RuleConfig;
  windowDays: number;
  firstDay: string;
  lastDay: string;
  /** Exactly `windowDays` entries, oldest first — the strip's slots. */
  days: RuleBacktestDay[];
  /** Days this rule would fire on with `config`. THE number. */
  wouldFire: number;
  /** Days the replay could actually judge (`fired` + `quiet`). */
  judged: number;
  /** Days the asset filed a pulse for at all. */
  reported: number;
  /** Days in the same window that carry a REAL stored flag from this rule —
   * what actually happened, beside what would have. */
  firedInStore: number;
}

/** One rejected field, in the `{path, code, message}` shape every ingest lane
 * reports. */
export interface RuleBacktestIssue {
  path: string;
  code: string;
  message: string;
}

/** A refusal is a result, not a throw; only an infrastructure failure crosses
 * the binding as an exception. */
export type RuleBacktestResult =
  | { ok: true; backtest: RuleBacktest }
  | { ok: false; error: 'unsupported_rule'; ruleId: string }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'validation'; issues: RuleBacktestIssue[] };
