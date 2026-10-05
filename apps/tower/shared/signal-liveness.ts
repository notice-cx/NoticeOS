// What makes an open flag CURRENT — derived, never assumed (bead `ro-wlq5`).
//
// THE PROBLEM THIS EXISTS TO FIX. A `flags` row records that a rule fired at a
// moment. Confirmation timestamps exist for some rules in `rule_inputs`, but
// an unresolved row alone does not prove a recent evaluation. The asset
// page then rendered open rows under the heading "Current signals", which is a
// claim the data cannot support: it showed "Revert decision needed" from nine
// days ago and "4300 signups" from fifty-six beside each other, both styled as
// live, both offering a Resolve button. The operator stopped trusting the
// surface, correctly.
//
// WHAT IS ACTUALLY BROKEN IS NARROWER THAN IT LOOKS. Most rules already resolve
// themselves: the central flow rules resolve the prior open event on each new
// reading, and hygiene, egress and the GA4 quota lane each clear their own flag
// when the condition ends. Those are already frontends to their source of
// truth, and this module must not second-guess them.
//
// So a rule declares what confirms it, and the read model asks that source
// rather than trusting the row.

/**
 * Where a flag's continued truth comes from.
 *
 * - `central-rule` — a lane re-evaluates on a schedule and resolves the flag
 *   when the condition ends. Currentness still requires recent source evidence.
 * - `self-declared` — the asset reported the flag in its own pulse envelope.
 *   The OS never derived it, so the OS never un-derives it. Its truth lives in
 *   the asset's LATEST pulse.
 * - `decision-owed` — a one-shot verdict. The evaluation is finished; what is
 *   outstanding is a human decision, and its truth lives wherever that decision
 *   is recorded (a bead, a `decisions` row).
 * - `historical` — an event that happened. Never still-true, never
 *   no-longer-true, never actionable.
 */
export type SignalClass =
  | "central-rule"
  | "self-declared"
  | "decision-owed"
  | "historical";

/**
 * Rules whose class is not the default. Everything absent is `central-rule`.
 *
 * WHY THE DEFAULT IS "SHOW IT". An alert system's dangerous failure is hiding a
 * real alert, not showing a stale one, so an unregistered rule keeps today's
 * behaviour and stays visible. A rule earns quieter treatment by declaring
 * itself — never by being forgotten.
 */
export const SIGNAL_CLASSES: Readonly<Record<string, SignalClass>> =
  Object.freeze({
    // The asset's own envelope reports these; see `pulseDeclares`.
    "asset-declared": "self-declared",
    // A closed watch window's verdict. The window is finished — status
    // 'closed', outcome recorded — and what remains is the operator's call.
    "watch-window-closed": "decision-owed",
  });

/**
 * A milestone is historical WHATEVER rule emitted it, so this is read off the
 * row rather than the register. The store already agrees: `flags` constrains
 * `kind = 'milestone'` to `severity = 'info'` — it was never an alert.
 */
export function signalClassOf(flag: {
  ruleId: string;
  kind: string;
}): SignalClass {
  if (flag.kind === "milestone") return "historical";
  return SIGNAL_CLASSES[flag.ruleId] ?? "central-rule";
}

/**
 * WHY a verification reads the way it does, as a code (bead `ro-ujb9.96.6.7`).
 *
 * The read model used to ship a sentence per case — "The last confirming check
 * is older than this source's freshness window; the condition remains
 * unresolved." — and the desk printed it word for word under a tooltip. A code
 * crosses the wire instead, and `AlertVerification` owns the one short label
 * each code renders as, so the payload stays data and the screen stays a
 * glance.
 */
export type VerificationReason =
  /** Closed in the store; nothing at the source said it recovered. */
  | "recorded-closed"
  /** A milestone — something that happened, not a condition. */
  | "recorded-event"
  /** A finished evaluation waiting on a person. */
  | "decision-owed"
  /** No readable, dated nightly report exists to check against. */
  | "report-unreadable"
  /** The latest report still carries this flag. */
  | "report-still-flags"
  /** The newest report carrying this flag is past its freshness window. */
  | "report-too-old"
  /** A newer report no longer carries it (source evidence, not a closure). */
  | "report-no-longer-flags"
  /** The latest report is old or does not speak to this flag. */
  | "report-inconclusive"
  /** A central rule firing with no current linked evaluation. */
  | "no-linked-evaluation"
  /** The current linked report produced this central rule firing. */
  | "linked-report-confirms"
  /** The linked evaluation is past its freshness window. */
  | "linked-evaluation-too-old"
  /** The rule declares no source that can confirm it. */
  | "no-verifier"
  /** No valid confirmation timestamp after the first detection. */
  | "no-check-after-onset"
  /** The source confirmed the condition inside its freshness window. */
  | "source-confirms"
  /** The last confirming check is past the source's freshness window. */
  | "confirmation-stale"
  /** A grouped row whose members disagree or cannot be read. */
  | "mixed-states"
  /** A grouped row summarised by its oldest member's evidence. */
  | "oldest-across-assets";

/** What a surface is entitled to say about a flag right now. */
export type Liveness =
  | {
      /** Re-confirmed by whatever owns it; safe to present as current. */
      state: "live";
    }
  | {
      /** Unresolved, but no recent source evidence can confirm it. Remains
       * visible and actionable; absence of evidence is never recovery. */
      state: "last-known";
      reason: VerificationReason;
    }
  | {
      /** The evaluation finished and delivered a verdict; a person owes a
       * decision. Not a signal — a task, and it says so. */
      state: "awaiting-decision";
      /** What the finished evaluation concluded, in the store's own words. */
      verdict: string | null;
      /** Where the decision is recorded, or null when nothing owns it yet —
       * which the surface must SAY rather than quietly imply. */
      decisionHome: string | null;
    }
  | {
      /** Its source of truth no longer carries it. Not current, and the reason
       * is stated rather than the row silently disappearing. */
      state: "stale";
      reason: VerificationReason;
    }
  | {
      /** An event. Belongs on the timeline, never in a current list. */
      state: "historical";
    };

/** Only these belong under a heading that claims to be current. */
export function isCurrent(liveness: Liveness): boolean {
  return liveness.state === "live" || liveness.state === "awaiting-decision";
}

/** Evidence freshness is separate from the operator's open/closed lifecycle. */
export interface SignalVerification {
  state: "confirmed" | "unverified" | "source-ended" | "recorded-closed" | "not-applicable";
  lastConfirmedAt: string | null;
  lastEvaluatedAt: string | null;
  /** Human-readable source name; null when the rule has no known verifier. */
  source: string | null;
  reason: VerificationReason;
}

/** Date-only, impossible and future instants are not evaluator timestamps. */
export function evidenceInstant(value: unknown, nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > nowMs) return null;
  const calendar = value.slice(0, 10);
  if (new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) return null;
  return new Date(ms).toISOString();
}

/** Unverified warnings still require attention. Only evidence can end them. */
export function isAttentionEligible(liveness: Liveness): boolean {
  return isCurrent(liveness) || liveness.state === "last-known";
}

/** A group cannot borrow its representative's freshness for every member. */
export function summarizeVerification(
  members: readonly (SignalVerification | undefined)[],
  nowMs = Date.now(),
): SignalVerification {
  const first = members[0];
  if (!first || members.some((member) => {
    if (!member || member.state !== first.state) return true;
    const confirmed = evidenceInstant(member.lastConfirmedAt, nowMs);
    const evaluated = evidenceInstant(member.lastEvaluatedAt, nowMs);
    return (member.lastConfirmedAt !== null && confirmed === null)
      || (member.lastEvaluatedAt !== null && evaluated === null)
      || (member.state === "confirmed" && (confirmed === null || evaluated === null))
      || (confirmed !== null && evaluated !== null && Date.parse(confirmed) > Date.parse(evaluated));
  })) {
    return {
      state: "unverified", lastConfirmedAt: null, lastEvaluatedAt: null,
      source: null, reason: "mixed-states",
    };
  }
  const oldest = (key: "lastConfirmedAt" | "lastEvaluatedAt") => {
    const values = members.map((member) => evidenceInstant(member?.[key], nowMs));
    if (values.some((value) => value === null)) return null;
    return (values as string[]).reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b);
  };
  return {
    state: first.state,
    lastConfirmedAt: oldest("lastConfirmedAt"),
    lastEvaluatedAt: oldest("lastEvaluatedAt"),
    source: members.every((member) => member?.source === first.source) ? first.source : null,
    reason: members.length === 1 ? first.reason : "oldest-across-assets",
  };
}
