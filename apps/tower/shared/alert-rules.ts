// The FALSE-POSITIVE RATE contract — per rule, how often the operator answered
// an alert by making the rule quieter (docs/15 flow E, bead `ro-ayxy`).
//
// WHAT THE NUMBER IS. Over SETTLED flags (`@noticeos/contract`'s
// `settledFlagsSql`), grouped by `rule_id`, the share carrying
// `disposition='tune'`: "of the N alerts this rule produced that are now
// finished with, the operator answered M of them by changing the rule". `tune`
// is the only disposition that says the ALERT was the problem — ack and resolve
// are statements about the event, and a snooze is a statement about timing.
//
// WHY IT IS A SEPARATE CONTRACT FROM `shared/settings.ts`. The settings payload
// is a PURE builder over config, deliberately: nothing on that page is evidence,
// so an empty or down database must not be able to blank the page an operator
// opens to fix things. These counts are the opposite — they are evidence, they
// need the store, and they are read by a second surface that never loads
// `/settings` at all (the Tune panel on an alert row). So they travel on their
// own read, and the two payloads keep their own failure modes.
//
// ONE LIMIT STILL TRAVELS WITH THE NUMBER, stated on the surface rather than
// buried here, and it makes `tuned` a LOWER bound: a decision on a rule in
// `RECURRING_CONDITION_RULES` is recorded on every open firing of the same
// condition at once (`worker/flag-actions.ts`), so these are counts of ALERTS,
// not of separate decisions.
//
// THE SECOND LIMIT IS FIXED as of bead `ro-bkcl`. `flags.disposition` still
// holds ONE decision, but a decision landing on a tuned row now carries the
// tune into the note behind `shared/tune.ts`'s mark, and the numerator asks
// "was this ever tuned" (`worker/flag-scope.ts`'s `everTunedSql`) rather than
// "does it say tune now". The operator who tunes the rule AND clears the alert
// is no longer the one whose tune is forgotten.
//
// The third count comes from one `noticeos.flag_tunes` row per decision.

/** How far back the counts look, in days. One quarter: long enough that a rule
 * firing weekly has something to average, short enough that a threshold changed
 * two quarters ago is not still being judged on the alerts it produced before
 * the change. */
export const ALERT_RULE_WINDOW_DAYS = 90;

/**
 * One rule's record over the window, in counts of FLAG ROWS.
 *
 * `settled` is the denominator the rate is read against, and it is not `fired`:
 * an alert nobody has finished with has not been answered by anything yet, and
 * putting it in the denominator would read every fresh firing as evidence the
 * rule is fine.
 */
export interface AlertRuleStat {
  /** `flags.rule_id` — the identity, and the only field the store guarantees. */
  ruleId: string;
  /** Rows that fired inside the window, whatever became of them. */
  fired: number;
  /** Of those, the ones that are settled at the moment of the read. */
  settled: number;
  /**
   * Of the settled, the ones the operator ever tuned. The numerator.
   *
   * "Ever", not "still says tune": a tuned alert that was later marked read or
   * parked keeps its tune in the note (bead `ro-bkcl`), and counting only the
   * live disposition dropped exactly the alerts the most diligent operator had
   * dealt with twice. It follows that this and {@link acknowledged} OVERLAP —
   * one alert, two true facts — so the four counts do not partition `settled`
   * and nothing may sum them.
   */
  tuned: number;
  /**
   * Tuned and NOT YET SETTLED — a tune keeps the row in the queue by design
   * (`flag-open.ts`), and a tuned row the operator then snoozed is parked, not
   * settled — so these are answers the operator has already given that the rate
   * above cannot count yet.
   *
   * Carried rather than folded in, because folding it in would be a second
   * arithmetic for one fact; shown beside the rate, it stops a rule the operator
   * tuned three times this week from reading as 0%.
   */
  tunedOpen: number;
  /** Of the settled, the ones marked read (`disposition='ack'`). */
  acknowledged: number;
  /** Of the settled, the ones closed with no disposition at all — resolved and
   * unlabelled. The remainder (incident, hypothesis) is
   * `settled - tuned - acknowledged - resolved` and is deliberately not a
   * fourth field nobody reads. */
  resolved: number;
  /**
   * HOW MANY TIMES this rule was tuned in the window — a count of DECISIONS,
   * where every other field here is a count of ALERTS (bead `ro-6d1t`).
   *
   * Its window is `tuned_at` rather than `fired_at`: "tuned five times this
   * quarter" is a question about the operator's quarter, and a rule tuned in
   * March that has been quiet since would otherwise read as never tuned.
   */
  tunes: number;
}

/** `GET /api/alerts/rules` — every rule that fired in the window, noisiest
 * first. A rule that has never fired is ABSENT rather than a row of zeros: the
 * store has nothing to say about it, and a zero here would read as "this rule
 * has never been a problem". */
export interface AlertRuleStatsPayload {
  generatedAt: string;
  /** {@link ALERT_RULE_WINDOW_DAYS}, so the caption states its own scope. */
  windowDays: number;
  /** The oldest `fired_at` this read considered (ISO). */
  since: string;
  rules: AlertRuleStat[];
}

/**
 * The share of this rule's settled alerts the operator answered by tuning, 0–1.
 *
 * `null` when nothing has settled — which is a different fact from zero, and the
 * surface says so instead of drawing an empty bar that reads as "this rule has
 * never been wrong".
 */
export function tuneShare(stat: AlertRuleStat): number | null {
  if (stat.settled <= 0) return null;
  return stat.tuned / stat.settled;
}

// --- WHEN THE OS PROPOSES QUIETENING A RULE ITSELF (bead `ro-bgny`) --------
//
// docs/15 flow E has promised since it was written that "rules above ~40% FP
// get auto-proposed for tuning (Learn eating its own telemetry)". The rate has
// been measured and rendered since `ro-ayxy` and nothing acted on it: the
// operator read the figure and remembered the threshold, which is the manual
// half of a loop the doc describes as automatic.
//
// THE PROPOSAL MAY NEVER APPLY ITSELF. Guardrail thresholds are operator-only
// and forever-forbidden on the autonomy ladder (AGENTS.md HARD INVARIANTS) —
// an agent that can edit the ruler eventually will. So what crossing the line
// produces is a SENTENCE with two answers, on the surfaces where the tuning
// already happens, and never a saved value.
//
// IT IS BUILT ON A FLOOR, ON PURPOSE. One decision still covers every open
// firing of a repeating condition, so the measured share understates how often
// the operator actually answered by tuning. A threshold on a floor UNDER-fires,
// which is the direction a proposal that cannot apply itself should err in: the
// cost of a proposal that arrives a quarter late is a rule the operator tunes
// by hand once more, and the cost of one that arrives early is the OS nagging
// about a rule it has no evidence against.

/**
 * The share of settled alerts answered by tuning at which the OS says
 * something. Declared ONCE, here, beside the arithmetic it is compared against
 * — docs/15 flow E's "~40%" is prose about this constant, not a second copy.
 */
export const TUNE_PROPOSAL_SHARE = 0.4;

/**
 * How many settled alerts a rule needs before the share means anything.
 *
 * Five, and the reason is the smallest number at which the threshold is not an
 * accident: with two settled alerts one tune is 50% and the OS would propose
 * quietening a rule on the strength of a single click. At five, crossing 40%
 * takes two independent decisions the operator made on two different alerts.
 * It is stated on the surface rather than kept here, because a proposal that
 * did not say what evidence it waits for is a threshold nobody can argue with.
 */
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

/**
 * Does this rule cross the line — and is there enough of it to act on?
 *
 * `null` for every other case, including the two that look like a rate and are
 * not: a rule with nothing settled has no share at all, and a rule with three
 * settled alerts has one the OS is not entitled to an opinion about.
 */
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

/**
 * One rule's row out of the payload — `null` when the read has not answered
 * yet, failed, or holds nothing for this rule.
 *
 * Both surfaces look their rule up through this, so "the read said nothing about
 * this rule" and "the read never arrived" cannot be told apart differently on
 * the settings page and on the alert row: neither licenses a number.
 */
export function findRuleStat(
  payload: AlertRuleStatsPayload | null | undefined,
  ruleId: string,
): AlertRuleStat | null {
  return payload?.rules.find((rule) => rule.ruleId === ruleId) ?? null;
}

/**
 * The rule ids in the operator's words.
 *
 * These are LABELS, not descriptions: the sentence explaining what each rule
 * looks for is `shared/alert-language.ts`'s job, once, on the alert itself. A
 * rule this map has never heard of renders its own id — a new rule shipping from
 * the ingest lane degrades to the identity the store holds, never to a blank.
 */
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
