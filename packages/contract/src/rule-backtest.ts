/**
 * Cross-Worker contract for the alert-rule BACKTEST — "how often would this rule
 * have fired in the last 30 days with these knobs?" (bead `ro-u072`).
 *
 * WHY IT IS A CONTRACT AND NOT A TOWER FUNCTION. The answer has to be produced
 * by `evaluatePulse` (rules.ts) over the STORED pulses, against the same
 * seasonal baselines the nightly lane uses — docs/15 principle 1 asks the rule
 * edit to show what it would have done, and a preview computed from a different
 * ruler than the live lane's would be a fake number in the one place the
 * operator is being asked to trust one. Those baselines are assembled inside the
 * ingest Worker, which owns the `pulses` read, so the backtest runs there and
 * the Tower asks for it over the private INGEST Service Binding.
 *
 * READ-ONLY, always. Replaying a rule writes no flag, dispositions nothing, and
 * touches no config. The knobs are CANDIDATES the caller is considering; saving
 * them is a separate operator action through the D18 write lane.
 */

import type { RuleConfig } from './rules.js';
import type { FlagSeverity } from './schema.js';

/** The window docs/15 principle 1 names: "would have fired 3 times in the last
 * 30 days". Fixed rather than a caller parameter, so two surfaces can never
 * quote two different N for the same rule. */
export const RULE_BACKTEST_WINDOW_DAYS = 30;

/**
 * The rule families a pulse replay can honestly serve.
 *
 * These two are the whole output of `evaluatePulse`, they are the only rules the
 * `flag_defaults` knobs steer, and they read NOTHING but a stored pulse envelope
 * plus earlier stored envelopes — which is exactly what makes replaying them a
 * measurement rather than a guess. Every other rule id in the store is fed by
 * something a replay does not have: `ingest-freshness` is computed from arrival
 * times against a wall clock that has since moved on, `asset-declared` flags are
 * exploded out of an envelope the asset itself authored (no rule, no threshold),
 * and a watch-window verdict is a pre-registered outcome check, not a threshold.
 * Those get NO PREVIEW and say so, rather than a number produced by a different
 * computation wearing the same sentence.
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
 * One replay request.
 *
 * `metric` scopes the answer to the metric the operator is actually looking at,
 * because a rule fires per metric and "this rule is noisy" is nearly always a
 * sentence about one of them. Omit it for the whole asset.
 *
 * `through` is the last day of the window, inclusive (`YYYY-MM-DD`); absent, the
 * runtime's own UTC today — the same day grain the `pulses` table is keyed on.
 */
export interface RuleBacktestInput {
  asset: string;
  ruleId: string;
  config: RuleConfig;
  metric?: string | null;
  through?: string;
}

/**
 * What one replayed day means. Four states, because "it did not fire" hides two
 * completely different facts and a strip that draws them alike would claim
 * evidence nobody has.
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
  /** Did this rule ACTUALLY fire on this day — a stored `flags` row, not a
   * replay? Carried per day rather than only as a total so the candidate can be
   * read against reality where it differs, which is the question "3 instead of
   * 9" cannot answer on its own. */
  stored: boolean;
}

/**
 * The answer.
 *
 * `wouldFire` and `firedInStore` are both counts of DAYS, deliberately: they sit
 * side by side and a comparison between a count of days and a count of firings
 * would be a comparison between two different questions.
 *
 * `config` is echoed because the preview is a statement about exact values — a
 * strip that arrived after the operator typed again must be able to say which
 * numbers it is a picture of.
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
 * reports — one validation vocabulary whichever door the call arrived at. */
export interface RuleBacktestIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * A refusal is a RESULT, not a throw: "no preview for this rule" and "no such
 * asset" are ordinary answers a panel renders in place of a strip. Only an
 * infrastructure failure (a D1 error) crosses the binding as an exception.
 */
export type RuleBacktestResult =
  | { ok: true; backtest: RuleBacktest }
  | { ok: false; error: 'unsupported_rule'; ruleId: string }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'validation'; issues: RuleBacktestIssue[] };
