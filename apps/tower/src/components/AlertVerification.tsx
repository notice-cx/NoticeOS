import type { ReactNode } from "react";
import { Archive, CircleCheck, CircleDashed, CircleDot, CircleOff, type LucideIcon } from "lucide-react";
import { evidenceInstant, type SignalVerification, type VerificationReason } from "@shared/signal-liveness";
import { formatAge } from "@shared/freshness";
import type { IntegrationEvidence } from "@shared/integrations";
import { InfoTooltip } from "@/components/InfoTooltip";
import { formatTimestamp } from "@/lib/format";

export interface AlertVerificationProps {
  verification?: SignalVerification;
  firstDetectedAt: string;
  nowMs: number;
  /** False inside another control and on the passive Wall. */
  interactive?: boolean;
}

/** Recency is decided by the source-aware read model, not a second UI cutoff. */
function usableVerificationState(verification: SignalVerification | undefined, nowMs: number): SignalVerification["state"] {
  if (verification?.state === "confirmed" || verification?.state === "source-ended") {
    const confirmed = evidenceInstant(verification.lastConfirmedAt, nowMs);
    const evaluated = evidenceInstant(verification.lastEvaluatedAt, nowMs);
    if (evaluated === null
      || (verification.state === "confirmed" && confirmed === null)
      || (verification.lastConfirmedAt !== null && confirmed === null)
      || (confirmed !== null && Date.parse(confirmed) > Date.parse(evaluated))) return "unverified";
  }
  return verification?.state ?? "unverified";
}

export function alertVerificationLabel(verification: SignalVerification | undefined, nowMs: number): string {
  const state = usableVerificationState(verification, nowMs);
  if (state === "unverified") return "Last known";
  switch (verification?.state) {
    case "confirmed": {
      const confirmed = evidenceInstant(verification.lastConfirmedAt, nowMs);
      return confirmed === null ? "Last known" : `Confirmed ${formatAge(nowMs - Date.parse(confirmed))} ago`;
    }
    case "source-ended": return "No longer reported";
    case "recorded-closed": return "Recorded closed";
    case "not-applicable": return "Not a live condition";
    default: return "Last known";
  }
}

/**
 * THE STATE IS A GLYPH BEFORE IT IS A WORD (bead `ro-ujb9.96.6.7`). A solid
 * tick is a source that confirmed the condition; a dashed ring is one nobody
 * has confirmed lately — so "is this still true?" reads down a column of rows
 * before a label is read. Neutral ink throughout: verification qualifies the
 * evidence and never competes with the row's severity ring.
 */
const STATE_GLYPH: Record<SignalVerification["state"], LucideIcon> = {
  confirmed: CircleCheck,
  unverified: CircleDashed,
  "source-ended": CircleOff,
  "recorded-closed": Archive,
  "not-applicable": CircleDot,
};

/**
 * What each read-model reason code renders as — a label, never a sentence.
 * The read model ships the code (`shared/signal-liveness.ts`); this is the one
 * place it becomes words, so no surface prints a paragraph about evidence.
 */
export const VERIFICATION_REASON_LABEL: Record<VerificationReason, string> = {
  "recorded-closed": "Closed in the store; recovery not checked",
  "recorded-event": "A recorded event",
  "decision-owed": "Waiting on your decision",
  "report-unreadable": "No readable dated report",
  "report-still-flags": "Latest report still flags it",
  "report-too-old": "Last flagging report is too old",
  "report-no-longer-flags": "Newer report no longer flags it",
  "report-inconclusive": "Latest report does not settle it",
  "no-linked-evaluation": "No current evaluation linked",
  "linked-report-confirms": "Current report produced it",
  "linked-evaluation-too-old": "Linked evaluation is too old",
  "no-verifier": "No source check for this rule",
  "no-check-after-onset": "No valid check since first seen",
  "source-confirms": "Source confirmed it recently",
  "confirmation-stale": "Last check is past its freshness window",
  "mixed-states": "Sites differ; open each one",
  "oldest-across-assets": "Oldest check across these sites",
};

/**
 * The verification as EVIDENCE ROWS — first seen, last confirmed and by what,
 * last checked, and why it reads as it does — for the one "Why this fired"
 * panel an opened alert row carries (bead `ro-ujb9.96.6.7`).
 *
 * An opened row used to print the verification twice, once in its caption and
 * once as a tooltip trigger under it. The caption keeps the glanceable label;
 * the timestamps behind it join the rule's numbers in the evidence panel, so
 * everything the operator can check sits in one place, one press away.
 */
export function verificationEvidence(
  verification: SignalVerification | undefined,
  firstDetectedAt: string,
  nowMs: number,
): IntegrationEvidence[] {
  const rows: IntegrationEvidence[] = [];
  const first = evidenceInstant(firstDetectedAt, nowMs);
  if (first) rows.push({ polarity: "supporting", source: "First seen", detail: "", at: first });
  const confirmed = evidenceInstant(verification?.lastConfirmedAt, nowMs);
  if (confirmed) {
    rows.push({ polarity: "supporting", source: "Last confirmed", detail: verification?.source?.trim() ?? "", at: confirmed });
  }
  const checked = evidenceInstant(verification?.lastEvaluatedAt, nowMs);
  if (checked && checked !== confirmed) {
    rows.push({ polarity: "supporting", source: "Last checked", detail: confirmed ? "" : verification?.source?.trim() ?? "", at: checked });
  }
  // A usable confirmation is fully said by "Last confirmed" above; every other
  // state gets one row naming it and why — "Last known · Last check is past its
  // freshness window" — so the panel never says the same state twice.
  if (usableVerificationState(verification, nowMs) !== "confirmed") {
    rows.push({
      polarity: "supporting",
      source: alertVerificationLabel(verification, nowMs),
      detail: verificationWhy(verification, nowMs),
      at: null,
    });
  }
  return rows;
}

/** The reason label for a verification, after the timestamps are checked. */
function verificationWhy(verification: SignalVerification | undefined, nowMs: number): string {
  const state = usableVerificationState(verification, nowMs);
  const noUsableEvidence = state === "unverified" &&
    (verification?.state === "confirmed" || verification?.state === "source-ended");
  if (!verification) return "No check recorded";
  if (noUsableEvidence) return "Check timestamps unreadable";
  return VERIFICATION_REASON_LABEL[verification.reason] ?? "No check recorded";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="m-0 tabular-nums">{children}</dd>
  </>;
}

function Instant({ value, nowMs }: { value: string | null | undefined; nowMs: number }) {
  const at = evidenceInstant(value, nowMs);
  return at === null ? <>—</> : <time dateTime={at} title={at}>{formatTimestamp(at)}</time>;
}

/** First detection, successful evaluation and confirmation are separate facts.
 * This evidence qualifier is always neutral; it does not change flag severity. */
export function AlertVerification({ verification, firstDetectedAt, nowMs, interactive = true }: AlertVerificationProps) {
  const label = alertVerificationLabel(verification, nowMs);
  const state = usableVerificationState(verification, nowMs);
  // A confirmed or ended state whose timestamps do not hold up reads as last
  // known — and its "why" is the timestamps, not the reason the store gave.
  const why = verificationWhy(verification, nowMs);
  const Glyph = STATE_GLYPH[state];
  const face = <span className="inline-flex items-center gap-1">
    <Glyph className="size-3 shrink-0" aria-hidden />
    {label}
  </span>;
  return <span className={interactive ? "text-xs tabular-nums text-muted-foreground" : "tabular-nums text-muted-foreground"} data-alert-verification={state}>
    {interactive ? <InfoTooltip label="Alert verification details" trigger={face}>
      <span className="font-medium">{label}</span>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <Fact label="First seen"><Instant value={firstDetectedAt} nowMs={nowMs} /></Fact>
        <Fact label="Last confirmed"><Instant value={verification?.lastConfirmedAt} nowMs={nowMs} /></Fact>
        <Fact label="Last checked"><Instant value={verification?.lastEvaluatedAt} nowMs={nowMs} /></Fact>
        <Fact label="Checked by">{verification?.source?.trim() || "—"}</Fact>
        <Fact label="Why">{why}</Fact>
      </dl>
    </InfoTooltip> : face}
  </span>;
}
