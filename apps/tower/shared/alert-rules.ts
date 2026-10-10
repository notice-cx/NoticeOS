// The false-positive rate contract — per rule, how often the operator
// answered an alert by making the rule quieter: over settled flags
// (`settledFlagsSql`), grouped by `rule_id`, the share the operator ever
// tuned. `tune` is the only disposition that says the alert was the problem.
// A separate contract from `shared/settings.ts` because these counts are
// evidence that needs the store, read by a second surface (the Tune panel on
// an alert row). `tuned` is a lower bound: a decision on a rule in
// `RECURRING_CONDITION_RULES` lands on every open firing of the condition at
// once (`worker/flag-actions.ts`), so these count alerts, not decisions. The
// numerator asks "was this ever tuned" (`worker/flag-scope.ts`'s
// `everTunedSql`), since a later decision keeps the tune in the note.

/** How far back the counts look, in days: long enough that a rule firing
 * weekly has something to average, short enough that an old threshold is not
 * still being judged. */
export const ALERT_RULE_WINDOW_DAYS = 90;

/** One rule's record over the window, in counts of flag rows. `settled` is
 * the denominator, not `fired`: an alert nobody has finished with has not been
 * answered yet. */
export interface AlertRuleStat {
  /** `flags.rule_id` — the identity, and the only field the store guarantees. */
  ruleId: string;
  /** Rows that fired inside the window, whatever became of them. */
  fired: number;
  /** Of those, the ones that are settled at the moment of the read. */
  settled: number;
  /** Of the settled, the ones the operator ever tuned. The numerator. "Ever",
   * not "still says tune", so this and {@link acknowledged} overlap and the
   * counts do not partition `settled`. */
  tuned: number;
  /** Tuned and not yet settled — a tune keeps the row in the queue
   * (`flag-open.ts`), so these are answers the rate above cannot count yet.
   * Shown beside the rate, never folded in. */
  tunedOpen: number;
  /** Of the settled, the ones marked read (`disposition='ack'`). */
  acknowledged: number;
  /** Of the settled, the ones closed with no disposition at all — resolved and
   * unlabelled. The remainder (incident, hypothesis) is
   * `settled - tuned - acknowledged - resolved` and is deliberately not a
   * fourth field nobody reads. */
  resolved: number;
  /** How many times this rule was tuned in the window — a count of decisions,
   * where every other field is a count of alerts. Its window is `tuned_at`
   * rather than `fired_at`. */
  tunes: number;
}

/** `GET /api/alerts/rules` — every rule that fired in the window, noisiest
 * first. A rule that has never fired is absent rather than a row of zeros. */
export interface AlertRuleStatsPayload {
  generatedAt: string;
  /** {@link ALERT_RULE_WINDOW_DAYS}, so the caption states its own scope. */
  windowDays: number;
  /** The oldest `fired_at` this read considered (ISO). */
  since: string;
  rules: AlertRuleStat[];
}

/** The share of this rule's settled alerts the operator answered by tuning,
 * 0–1. `null` when nothing has settled, which is a different fact from zero. */
export function tuneShare(stat: AlertRuleStat): number | null {
  if (stat.settled <= 0) return null;
  return stat.tuned / stat.settled;
}

// --- when the OS proposes quietening a rule itself ---------------------------
// The proposal never applies itself: guardrail thresholds are operator-only,
// so crossing the line produces a sentence with two answers, never a saved
// value. It is built on a floor on purpose: the measured share understates
// how often the operator answered by tuning, and a proposal that cannot apply
// itself should under-fire.

/** The share of settled alerts answered by tuning at which the OS says
 * something. */
export const TUNE_PROPOSAL_SHARE = 0.4;

/** How many settled alerts a rule needs before the share means anything:
 * at five, crossing 40% takes two independent decisions on two different
 * alerts. */
export const TUNE_PROPOSAL_MIN_SETTLED = 5;

/** What the OS proposes, and the counts it read to get there — carried rather
 * than re-derived, so the sentence beside the bar cannot state a different
 * share from the one that crossed the line. */
export interface TuneProposalFacts {
  ruleId: string;
  /** 0–1, {@link tuneShare}'s value at the moment it crossed. */
  share: number;
  tuned: number;
  settled: number;
}

/** Does this rule cross the line, and is there enough of it to act on?
 * `null` otherwise, including a rule with nothing settled and one with too few
 * settled alerts. */
export function tuneProposal(
  stat: AlertRuleStat | null | undefined,
): TuneProposalFacts | null {
  if (!stat) return null;
  if (stat.settled < TUNE_PROPOSAL_MIN_SETTLED) return null;
  const share = tuneShare(stat);
  if (share === null || share < TUNE_PROPOSAL_SHARE) return null;
  return {
    ruleId: stat.ruleId,
    share,
    tuned: stat.tuned,
    settled: stat.settled,
  };
}

/** One rule's row out of the payload — `null` when the read has not answered
 * yet, failed, or holds nothing for this rule. Neither licenses a number. */
export function findRuleStat(
  payload: AlertRuleStatsPayload | null | undefined,
  ruleId: string,
): AlertRuleStat | null {
  return payload?.rules.find((rule) => rule.ruleId === ruleId) ?? null;
}

/** The rule ids in the operator's words. Labels, not descriptions: what each
 * rule looks for is `shared/alert-language.ts`'s job. A rule this map has
 * never heard of renders its own id. */
export const RULE_LABELS: Record<string, string> = {
  "flow-poisson-low": "Drop at normal volume",
  "flow-lowvol-window": "Drop at low volume",
  "flow-pct-drop": "Drop against baseline",
  "flow-seasonal-baseline": "Drop against the season",
  "asset-declared": "The site's own threshold",
  "asset-pull-failed": "Pull failed",
  "ingest-freshness": "Nightly report overdue",
  "hygiene-home-unreachable": "Home page check",
  "hygiene-sitemap": "Sitemap check",
  "os-egress-down": "OS egress down",
  "watch-window-closed": "Watch window closed",
};

/** The operator's name for a rule, falling back to the id the store holds. */
export function ruleLabel(ruleId: string): string {
  return RULE_LABELS[ruleId] ?? ruleId;
}
