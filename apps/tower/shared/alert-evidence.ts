// Read-only alert interpretation. No evaluator runs and no thresholds change.
import { PulseEnvelope } from "@noticeos/contract";
import { AMBER_MULTIPLIER, CADENCE_HOURS } from "./wall";
import { evidenceInstant, signalClassOf, type Liveness, type SignalVerification, type VerificationReason } from "./signal-liveness";

export interface AlertEvidenceInput {
  asset: string;
  ruleId: string;
  kind: string;
  severity: string;
  metric: string | null;
  firedAt: string;
  pulseId?: number | null;
  resolvedAt?: string | null;
  ruleInputs: Record<string, unknown> | null;
}

export interface AlertPulseEvidence {
  id: number;
  asset: string;
  date: string;
  receivedAt: string;
  envelope: string;
}

export interface AlertWatchEvidence {
  outcome: string | null;
  readbackBead: string | null;
}

export interface AlertEvidenceResult {
  liveness: Liveness;
  verification: SignalVerification;
}

const HYGIENE_RULES = new Set([
  "hygiene-html-depth", "hygiene-robots-ai", "hygiene-sitemap",
  "hygiene-home-unreachable", "hygiene-page-directives", "hygiene-page-structure",
]);

export function deriveAlertEvidence(
  flag: AlertEvidenceInput,
  nowMs: number,
  pulse: AlertPulseEvidence | null = null,
  watch: AlertWatchEvidence | null = null,
): AlertEvidenceResult {
  const inputs = flag.ruleInputs;
  const firedAt = evidenceInstant(flag.firedAt, nowMs);
  const result = (
    state: SignalVerification["state"], source: string | null, reason: VerificationReason,
    lastConfirmedAt: string | null = null, lastEvaluatedAt: string | null = null,
  ): AlertEvidenceResult => ({
    liveness: state === "confirmed" ? { state: "live" }
      : state === "source-ended" ? { state: "stale", reason }
      : state === "unverified" ? { state: "last-known", reason }
      : { state: "historical" },
    verification: { state, source, reason, lastConfirmedAt, lastEvaluatedAt },
  });
  if (flag.resolvedAt) {
    return result("recorded-closed", null, "recorded-closed");
  }
  const signalClass = signalClassOf(flag);
  if (signalClass === "historical") {
    return result("not-applicable", null, "recorded-event");
  }
  if (signalClass === "decision-owed") {
    return {
      ...result("not-applicable", "Outcome check", "decision-owed"),
      liveness: { state: "awaiting-decision", verdict: watch?.outcome ?? null, decisionHome: watch?.readbackBead ?? null },
    };
  }
  const fresh = (at: string | null, cadence: number) => at !== null
    && nowMs - Date.parse(at) <= cadence * AMBER_MULTIPLIER * 3_600_000;
  const afterOnset = (at: string | null) => at !== null && firedAt !== null && Date.parse(at) >= Date.parse(firedAt);

  if (signalClass === "self-declared" || flag.ruleId === "flow-poisson-low" || flag.ruleId === "flow-lowvol-window") {
    const source = signalClass === "self-declared" ? "Nightly report" : "Central metric rule";
    let parsed: ReturnType<typeof PulseEnvelope.safeParse> | null = null;
    try { parsed = pulse ? PulseEnvelope.safeParse(JSON.parse(pulse.envelope)) : null; } catch { /* unreadable remains unknown */ }
    const receivedAt = evidenceInstant(pulse?.receivedAt, nowMs);
    const generatedAt = parsed?.success ? evidenceInstant(parsed.data.generatedAt, nowMs) : null;
    const valid = pulse && parsed?.success && parsed.data.asset === pulse.asset && pulse.asset === flag.asset
      && generatedAt && receivedAt && pulse.date === generatedAt.slice(0, 10)
      && Date.parse(generatedAt) <= Date.parse(receivedAt);
    if (!valid || !flag.metric || !parsed?.success) return result("unverified", source, "report-unreadable");
    const current = fresh(receivedAt, CADENCE_HOURS.pulse) && fresh(generatedAt, CADENCE_HOURS.pulse);
    if (signalClass === "self-declared") {
      const metricFlags = (parsed.data.flags ?? []).filter((entry) => entry.metric === flag.metric && entry.kind !== "milestone");
      const declared = metricFlags.some((entry) => entry.kind === flag.kind && entry.severity === flag.severity);
      if (declared && firedAt && (pulse.id === flag.pulseId || afterOnset(generatedAt))) {
        return result(current ? "confirmed" : "unverified", source,
          current ? "report-still-flags" : "report-too-old",
          receivedAt, receivedAt);
      }
      if (metricFlags.length === 0 && flag.metric in parsed.data.metrics && current && afterOnset(generatedAt) && generatedAt !== firedAt && pulse.id !== flag.pulseId) {
        return result("source-ended", source, "report-no-longer-flags", null, receivedAt);
      }
      return result("unverified", source, "report-inconclusive");
    }
    // The linked source pulse proves this stored central firing was evaluated.
    // A different pulse must not be re-evaluated here or treated as recovery.
    if (pulse.id !== flag.pulseId || !(flag.metric in parsed.data.metrics) || !firedAt) {
      return result("unverified", source, "no-linked-evaluation");
    }
    return result(current ? "confirmed" : "unverified", source,
      current ? "linked-report-confirms" : "linked-evaluation-too-old",
      receivedAt, receivedAt);
  }

  let source: string | null = null;
  let cadence: number | null = null;
  let observed: unknown;
  let evaluated: unknown;
  if (HYGIENE_RULES.has(flag.ruleId)) {
    source = "Site checks"; cadence = CADENCE_HOURS.hygiene;
    observed = inputs?.lastObservedAt; evaluated = inputs?.evaluatedAt;
  } else if (flag.ruleId === "asset-pull-failed" || flag.ruleId === "os-egress-down") {
    source = flag.ruleId === "os-egress-down" ? "OS connectivity check" : "Nightly collection check";
    cadence = flag.ruleId === "os-egress-down" ? CADENCE_HOURS.signals : CADENCE_HOURS.pulse;
    observed = inputs?.lastFailedAt; evaluated = inputs?.evaluatedAt;
  } else if (flag.ruleId === "ga4-quota-pressure") {
    source = "Provider quota";
    cadence = inputs?.lane === "google-signals" ? CADENCE_HOURS.signals
      : inputs?.lane === "signal-dumps" ? CADENCE_HOURS.pulse : null;
    observed = inputs?.lastObservedAt; evaluated = observed;
  } else if (flag.ruleId === "ingest-freshness") {
    source = "Report freshness check"; cadence = CADENCE_HOURS.pulse;
    observed = inputs?.evaluatedAt; evaluated = observed;
  }
  const confirmedAt = evidenceInstant(observed, nowMs);
  const evaluatedAt = evidenceInstant(evaluated, nowMs);
  if (source === null || cadence === null) {
    return result("unverified", source, "no-verifier");
  }
  const ordered = afterOnset(confirmedAt) && afterOnset(evaluatedAt)
    && Date.parse(evaluatedAt!) >= Date.parse(confirmedAt!);
  if (!ordered) return result("unverified", source, "no-check-after-onset");
  const current = fresh(confirmedAt, cadence) && fresh(evaluatedAt, cadence);
  return result(current ? "confirmed" : "unverified", source,
    current ? "source-confirms" : "confirmation-stale",
    confirmedAt, evaluatedAt);
}
