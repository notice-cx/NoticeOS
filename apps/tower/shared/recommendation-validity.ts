import type { AssetDecision, ExecutiveInsight, HandoffBead, SearchPageTrends, SearchQueryTrends } from "./asset-detail";
import type { AnnotationTimeline } from "./annotations";
import { evidenceInstant } from "./signal-liveness";
import { isAmber } from "./freshness";
import { WORK_POLL_CADENCE_HOURS } from "./work";

/** Read-model facts, not a manifest of the inputs used by the saved analyzer. */
export interface RecommendationSourceReport {
  source: string;
  reportDate: string;
  /** Attempt finish time; only success/unchanged proves a stored report. */
  collectedAt: string;
  status: "success" | "unchanged" | "error";
}

export interface RecommendationSourceEvidence {
  available: boolean;
  truncated: boolean;
  reports: RecommendationSourceReport[];
  /** Earliest attempt included by the existing archive evidence lookback. */
  since?: string;
}

export interface RecommendationBasis {
  source: string;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface RecommendationSubject {
  kind: "finding" | "query" | "page";
  key: string;
  sources: RecommendationBasis[];
  /** Only supplied when inspecting an explicitly older analysis. */
  generatedAt?: string | null;
}

export interface RecommendationContext {
  generatedAt: string | null;
  sources: RecommendationSourceEvidence | null;
  handoffs: readonly HandoffBead[] | null;
  taskSnapshotAt: string | null;
  decisions: readonly AssetDecision[];
  annotations: AnnotationTimeline | null;
}

/** One named source as the check found it. Every field is evidence the
 * surface draws (a table row), never a sentence: `window` null means the
 * analyzed window is unknown or invalid, `latest` null means no readable
 * attempt. */
export interface RecommendationSourceCheck {
  source: string;
  window: { start: string; end: string } | null;
  latest: { reportDate: string; collectedAt: string; status: RecommendationSourceReport["status"] } | null;
  /** A stored report past the analyzed window, collected after the analysis. */
  newer: boolean;
  /** The latest attempt failed after the analysis was saved. It refutes nothing. */
  failedSinceAnalysis: boolean;
}

/** One task filed from this subject, and the releases that name it. */
export interface RecommendationTaskCheck {
  beadId: string;
  status: HandoffBead["status"];
  closedAt: string | null;
  /** Closed after the analysis, inside a task snapshot that covers the closure. */
  closedSinceAnalysis: boolean;
  /** Deploys recorded after the analysis whose ref is exactly this task. */
  releases: string[];
}

export interface RecommendationValidity {
  state: "unverified" | "newer-evidence" | "linked-work" | "dismissed" | "replaced";
  label: string;
  generatedAt: string | null;
  evidenceThrough: string | null;
  sources: RecommendationSourceCheck[];
  /** How much of the attempt archive the check could read. */
  sourceList: { available: boolean; truncated: boolean; since: string | null };
  tasks: { capturedAt: string | null; outdated: boolean; linked: RecommendationTaskCheck[] };
  /** False when older changes exist that the timeline did not carry. */
  timelineComplete: boolean;
  /** The operator's recorded display decision: preference, not validity. */
  decision: { status: AssetDecision["status"]; at: string } | null;
  /** A newer published analysis, when this is an explicitly older one. */
  newerAnalysisAt: string | null;
}

/** The one instruction a copied brief ends on. Absence of a contradiction
 * never proves the advice still applies, so there is no "current" state. */
export const RECOMMENDATION_RECHECK = "Recheck the latest reports, linked work and the site before acting.";

/** Calendar dates and instants have different contracts; reuse strict instant
 * validation without accepting Date.parse's rollover of impossible dates. */
export function recommendationDate(value: unknown, nowMs: number): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && evidenceInstant(`${value}T00:00:00Z`, nowMs) ? value : null;
}

export function findingBasis(insight: ExecutiveInsight): RecommendationSubject {
  return { kind: "finding", key: insight.key, sources: insight.sources.map((source) => ({
    source, windowStart: insight.windowStart, windowEnd: insight.windowEnd,
  })) };
}

export function queryBasis(key: string, trends: SearchQueryTrends, present: { google: boolean; bing: boolean; dataforseo: boolean; trackedPanel: boolean }): RecommendationSubject {
  const sources: RecommendationBasis[] = [];
  for (const provider of ["google", "bing"] as const) {
    const trend = trends[provider];
    if (present[provider] && trend) sources.push({ source: trend.source, windowStart: trend.currentStart, windowEnd: trend.currentEnd });
  }
  if (present.dataforseo && trends.dataforseo) sources.push({ source: trends.dataforseo.source, windowStart: trends.dataforseo.observedAt, windowEnd: trends.dataforseo.observedAt });
  // The folded row does not preserve the tracked panel's own report date.
  if (present.trackedPanel) sources.push({ source: "dataforseo/serp-panel", windowStart: null, windowEnd: null });
  return { kind: "query", key, sources };
}

export function pageBasis(key: string, pages: SearchPageTrends, leadingQuery: boolean, trackedPanel: boolean): RecommendationSubject {
  const sources: RecommendationBasis[] = [{ source: pages.source, windowStart: pages.currentStart, windowEnd: pages.currentEnd }];
  // The page/query join filters into the page window but does not preserve its
  // own coverage horizon. Do not borrow the page report's end date.
  if (leadingQuery) sources.push({ source: "gsc/page-query", windowStart: null, windowEnd: null });
  if (trackedPanel) sources.push({ source: "dataforseo/serp-panel", windowStart: null, windowEnd: null });
  return { kind: "page", key, sources };
}

/** This is an applicability review, never reanalysis. Absence of a known
 * contradiction cannot prove current validity; there is deliberately no
 * "current" state. No collection/alert thresholds are introduced here. */
export function recommendationValidity(
  subject: RecommendationSubject,
  context: RecommendationContext | null,
  nowMs: number,
): RecommendationValidity {
  const generatedAt = evidenceInstant(subject.generatedAt ?? context?.generatedAt, nowMs);
  const analysisDay = generatedAt?.slice(0, 10) ?? null;
  const sources: RecommendationSourceCheck[] = subject.sources.map((basis) => {
    const start = recommendationDate(basis.windowStart, nowMs);
    const end = recommendationDate(basis.windowEnd, nowMs);
    const window = start !== null && end !== null && start <= end && analysisDay !== null && end <= analysisDay
      ? { start, end } : null;
    const report = context?.sources?.reports.find((row) => row.source === basis.source);
    const collectedAt = evidenceInstant(report?.collectedAt, nowMs);
    const reportDate = recommendationDate(report?.reportDate, nowMs);
    const latest = context?.sources?.available && report && collectedAt && reportDate && reportDate <= collectedAt.slice(0, 10)
      ? { reportDate, collectedAt, status: report.status } : null;
    const since = latest !== null && generatedAt !== null && latest.collectedAt > generatedAt;
    return {
      source: basis.source,
      window,
      latest,
      newer: since && window !== null && latest.status !== "error"
        && latest.reportDate > window.end && latest.reportDate > analysisDay!,
      failedSinceAnalysis: since && latest.status === "error",
    };
  });

  const capturedAt = evidenceInstant(context?.taskSnapshotAt, nowMs);
  const linked: RecommendationTaskCheck[] = (context?.handoffs ?? [])
    .filter((task) => task.kind === subject.kind && task.key === subject.key)
    .map((task) => {
      const closedAt = evidenceInstant(task.closedAt, nowMs);
      return {
        beadId: task.beadId,
        status: task.status,
        closedAt,
        closedSinceAnalysis: task.status === "closed" && generatedAt !== null && closedAt !== null
          && capturedAt !== null && closedAt <= capturedAt && closedAt > generatedAt,
        releases: (context?.annotations?.items ?? []).flatMap((change) => {
          const at = evidenceInstant(change.at, nowMs);
          return change.kind === "deploy" && change.ref === task.beadId && at && generatedAt && at > generatedAt ? [at] : [];
        }),
      };
    });

  const decision = context?.decisions.find((row) => row.kind === subject.kind && row.key === subject.key);
  const decisionAt = evidenceInstant(decision?.updatedAt, nowMs);
  const latestAnalysis = evidenceInstant(context?.generatedAt, nowMs);
  const replaced = generatedAt !== null && latestAnalysis !== null && latestAnalysis > generatedAt;
  const dismissed = decision?.status === "dismissed" && decisionAt !== null;
  const linkedWork = linked.some((task) => task.closedSinceAnalysis || task.releases.length > 0);
  const newerEvidence = sources.some((check) => check.newer);
  const state = replaced ? "replaced" : dismissed ? "dismissed" : linkedWork ? "linked-work" : newerEvidence ? "newer-evidence" : "unverified";
  const labels: Record<RecommendationValidity["state"], string> = {
    unverified: "Not rechecked", "newer-evidence": "Newer source reports", "linked-work": "Review after linked work",
    dismissed: "Recorded dismissal", replaced: "Newer analysis available",
  };
  const ends = sources.flatMap((check) => (check.window ? [check.window.end] : []));
  return {
    state, label: labels[state], generatedAt,
    evidenceThrough: ends.length === sources.length && ends.length > 0 ? [...ends].sort()[0]! : null,
    sources,
    sourceList: {
      available: context?.sources?.available === true,
      truncated: context?.sources?.truncated === true,
      since: context?.sources?.since ?? null,
    },
    tasks: {
      capturedAt,
      outdated: capturedAt !== null && isAmber(nowMs, capturedAt, WORK_POLL_CADENCE_HOURS),
      linked,
    },
    timelineComplete: Boolean(context?.annotations) && context!.annotations!.olderCount === 0,
    decision: decision && decisionAt ? { status: decision.status, at: decisionAt } : null,
    newerAnalysisAt: replaced ? latestAnalysis : null,
  };
}

/** The state most of a list's rows share — the list's own, said once in its
 * header, so a row wears a chip only where its state differs (doc 14, one
 * status per subject). Ties go to the first row's state; empty is null. */
export function sharedValidity(all: readonly RecommendationValidity[]): RecommendationValidity | null {
  const counts = new Map<RecommendationValidity["state"], number>();
  for (const validity of all) counts.set(validity.state, (counts.get(validity.state) ?? 0) + 1);
  let best: RecommendationValidity | null = null;
  for (const validity of all) {
    if (!best || counts.get(validity.state)! > counts.get(best.state)!) best = validity;
  }
  return best;
}

/** The applicability facts as the lines a copied brief carries: the same
 * fields the evidence popover draws, one short line each, then the recheck. */
export function recommendationHandoffCaveat(validity?: RecommendationValidity): string {
  if (!validity) return `Applicability: unknown; analysis date unavailable. ${RECOMMENDATION_RECHECK}`;
  const lines = [
    `Applicability: ${validity.label}.`,
    `Analysis saved ${validity.generatedAt ?? "date unknown"}.`,
    ...validity.sources.map((check) => `${check.source}: ${sourceFacts(check)}.`),
    validity.sources.length === 0 ? "Source reports: not named." : null,
    validity.sourceList.truncated ? "Source report list: partial." : null,
    validity.sourceList.since ? `Source reports checked since ${validity.sourceList.since}.` : null,
    `Task snapshot: ${validity.tasks.capturedAt ?? "date unknown"}${validity.tasks.outdated ? " (outdated)" : ""}.`,
    ...validity.tasks.linked.flatMap((task) => [
      `Task ${task.beadId}: ${task.status}${task.closedAt ? ` ${task.closedAt}` : ""}${task.closedSinceAnalysis ? ", after the analysis" : ""}.`,
      ...task.releases.map((at) => `Deploy ${at} references ${task.beadId}.`),
    ]),
    validity.timelineComplete ? null : "Change timeline: incomplete.",
    validity.decision ? `Display decision: ${validity.decision.status} ${validity.decision.at}.` : null,
    validity.newerAnalysisAt ? `Newer analysis: ${validity.newerAnalysisAt}.` : null,
    RECOMMENDATION_RECHECK,
  ];
  return lines.filter((line): line is string => line !== null).join(" ");
}

function sourceFacts(check: RecommendationSourceCheck): string {
  const window = check.window ? `analyzed ${check.window.start}–${check.window.end}` : "analyzed window unknown";
  if (!check.latest) return `${window}; latest report unavailable`;
  const verb = check.latest.status === "error" ? "failed" : check.latest.status;
  return `${window}; latest report ${check.latest.reportDate} ${verb} at ${check.latest.collectedAt}`;
}

/** A source family as a person reads it: the product, then the report. */
export function recommendationSourceName(source: string): { product: string; report: string } {
  const [family = source, ...rest] = source.split("/");
  const products: Record<string, string> = {
    gsc: "Search Console", "bing-webmaster": "Bing", ga4: "Analytics",
    clarity: "Clarity", posthog: "PostHog", dataforseo: "DataForSEO",
  };
  const report = rest.join(" ").replace(/[-_]+/g, " ").trim();
  return { product: products[family] ?? family, report: report ? report.charAt(0).toUpperCase() + report.slice(1) : "" };
}
