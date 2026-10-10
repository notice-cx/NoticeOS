import { createContext, useContext, type ReactNode } from "react";
import { Check, Clock, EyeOff, History, ListChecks, RefreshCw, Rocket, X } from "lucide-react";
import type { AssetDetailPayload, ExecutiveSnapshot } from "@shared/asset-detail";
import { ageMs, formatAge } from "@shared/freshness";
import { formatCalendarDate, formatCalendarRange } from "@/lib/format";
import { InfoTooltip } from "@/components/InfoTooltip";
import { StateChip, type StatusSubject } from "@/components/StateChip";
import { evidenceInstant } from "@shared/signal-liveness";
import {
  recommendationValidity, recommendationDate, findingBasis, recommendationSourceName,
  type RecommendationContext, type RecommendationSourceCheck, type RecommendationSubject, type RecommendationValidity,
} from "@shared/recommendation-validity";

const EvidenceContext = createContext<{ context: RecommendationContext; nowMs: number } | null>(null);

/** All asset recommendation surfaces read one request-scoped snapshot; the
 * tabs that show recommendations mount it. Callers without it stay unverified. */
export function RecommendationEvidenceProvider({ data, nowMs, children }: {
  data: Pick<AssetDetailPayload, "executive" | "recommendationEvidence" | "handoffBeads" | "operator" | "decisions" | "annotations">;
  nowMs: number;
  children: ReactNode;
}) {
  const context: RecommendationContext = {
    generatedAt: data.executive?.generatedAt ?? null, sources: data.recommendationEvidence ?? null,
    handoffs: data.handoffBeads, taskSnapshotAt: data.operator.capturedAt,
    decisions: data.decisions, annotations: data.annotations,
  };
  return <EvidenceContext.Provider value={{ context, nowMs }}>{children}</EvidenceContext.Provider>;
}

export function useRecommendationValidity(subject: RecommendationSubject): RecommendationValidity {
  return useRecommendationAssessor()(subject);
}

export function useRecommendationAssessor() {
  const value = useContext(EvidenceContext);
  return (subject: RecommendationSubject) => recommendationValidity(subject, value?.context ?? null, value?.nowMs ?? Date.now());
}

/** A row's applicability. Passive (inside a closed row's summary, where a
 * nested button is not allowed) it is a state chip, drawn only when it differs
 * from the default "not rechecked" the list header already states. Expanded it
 * is the evidence popover. */
export function RecommendationReview({ validity, subject, passive = false }: {
  validity: RecommendationValidity;
  /** The recommendation this is the applicability of: `finding:<key>`,
   * `query:<key>`, `page:<path>`, or `analysis:saved` for the analysis as a
   * whole. */
  subject: StatusSubject;
  passive?: boolean;
}) {
  if (passive) {
    return validity.state === "unverified" ? null : (
      <span data-recommendation-validity={validity.state} className="block whitespace-normal font-normal normal-case tracking-normal">
        <ValidityChip validity={validity} subject={subject} />
      </span>
    );
  }
  return <span data-recommendation-validity={validity.state} className="block whitespace-normal text-xs font-normal normal-case tracking-normal text-muted-foreground tabular-nums">
    {/* A fixed name for what opens, not a date: a finding already prints its
        evidence window beside this, and one date said twice is one too many. */}
    <InfoTooltip label="About this recommendation's applicability" trigger="Source dates">
      <RecommendationFacts validity={validity} subject={subject} />
    </InfoTooltip>
  </span>;
}

const VALIDITY_GLYPH: Record<RecommendationValidity["state"], typeof RefreshCw> = {
  unverified: Clock,
  "newer-evidence": RefreshCw,
  "linked-work": ListChecks,
  dismissed: EyeOff,
  replaced: History,
};

/** The state as a neutral chip with its own glyph. Neutral on purpose: colour
 * is severity, and a stale recommendation is not an alert. */
export function ValidityChip({ validity, subject }: { validity: RecommendationValidity; subject: StatusSubject }) {
  const Glyph = VALIDITY_GLYPH[validity.state];
  return <StateChip tone="neutral" label={validity.label} glyph={<Glyph className="size-3" />} subject={subject}
    className="px-1.5 py-0 text-[11px] font-normal text-muted-foreground" />;
}

/** The applicability evidence, drawn: one row per named source (what was
 * analyzed, what arrived since), then linked tasks, the releases that name
 * them, and any recorded decision. Label-length cells only. */
export function RecommendationFacts({ validity, subject, heading }: { validity: RecommendationValidity; subject: StatusSubject; heading?: ReactNode }) {
  const { tasks } = validity;
  return <div className="grid gap-2" data-recommendation-facts>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium text-foreground">
        {heading ?? (validity.generatedAt ? `Saved ${formatCalendarDate(validity.generatedAt.slice(0, 10))}` : "Save date unknown")}
      </span>
      <ValidityChip validity={validity} subject={subject} />
    </div>
    {validity.sources.length > 0 ? (
      <table className="w-full text-left tabular-nums">
        <thead className="text-[10.5px] uppercase tracking-[0.04em] text-muted-foreground">
          <tr><th className="py-0.5 font-medium">Source</th><th className="py-0.5 font-medium">Analyzed</th><th className="py-0.5 text-right font-medium">Latest</th></tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {validity.sources.map((check) => <SourceRow key={check.source} check={check} />)}
        </tbody>
      </table>
    ) : <span>Sources not named</span>}
    {!validity.sourceList.available || validity.sourceList.truncated ? (
      <span data-fact="source-list">{validity.sourceList.available ? "Report list partial" : "Report list unavailable"}</span>
    ) : null}
    <div className="grid gap-1 border-t border-border/60 pt-2">
      <span className="flex items-center gap-1.5" data-fact="tasks">
        <ListChecks className="size-3.5 shrink-0" aria-hidden />
        {tasks.capturedAt ? `Tasks as of ${formatCalendarDate(tasks.capturedAt.slice(0, 10))}` : "Tasks not checked"}
        {tasks.outdated ? <StateChip tone="caution" label="Outdated" subject="tasks:snapshot" className="px-1.5 py-0 text-[10.5px]" /> : null}
      </span>
      {tasks.linked.map((task) => (
        <span key={task.beadId} className="flex flex-wrap items-center gap-x-1.5 pl-5" data-fact="task" data-task-status={task.status}>
          <span className="font-mono text-foreground">{task.beadId}</span>
          <span>{task.status === "closed" ? `closed${task.closedAt ? ` ${monthDay(task.closedAt.slice(0, 10))}` : ""}` : "open"}</span>
          {task.closedSinceAnalysis ? <span className="text-foreground">· since analysis</span> : null}
          {task.releases.map((at) => (
            <span key={at} className="flex items-center gap-1" data-fact="release">
              · <Rocket className="size-3" aria-hidden /> deploy {monthDay(at.slice(0, 10))}
            </span>
          ))}
        </span>
      ))}
      {validity.timelineComplete ? null : <span className="pl-5" data-fact="timeline">Change history partial</span>}
      {validity.decision ? (
        <span className="pl-5" data-fact="decision">
          {validity.decision.status === "dismissed" ? "Dismissed" : "Marked"} {monthDay(validity.decision.at.slice(0, 10))}
        </span>
      ) : null}
      {validity.newerAnalysisAt ? (
        <span className="pl-5" data-fact="newer-analysis">Newer analysis {monthDay(validity.newerAnalysisAt.slice(0, 10))}</span>
      ) : null}
    </div>
  </div>;
}

function SourceRow({ check }: { check: RecommendationSourceCheck }) {
  const name = recommendationSourceName(check.source);
  const latest = check.latest;
  return <tr data-fact="source" data-source={check.source}>
    <td className="py-1 pr-2">
      <span className="text-foreground">{name.product}</span>
      {name.report ? <span className="block text-[10.5px]">{name.report}</span> : null}
    </td>
    <td className="py-1 pr-2">{check.window ? monthDayRange(check.window.start, check.window.end) : "—"}</td>
    <td className="py-1 text-right">
      {latest === null ? <span title="No readable report">—</span> : (
        <span className="inline-flex items-center gap-1" data-latest={latest.status === "error" ? "failed" : check.newer ? "newer" : "stored"}>
          {monthDay(latest.reportDate)}
          {latest.status === "error"
            ? <><X className="size-3 text-error" aria-hidden /><span className="sr-only">failed</span></>
            : check.newer
              ? <><RefreshCw className="size-3 text-foreground" aria-hidden /><span className="sr-only">newer</span></>
              : <Check className="size-3" aria-hidden />}
        </span>
      )}
    </td>
  </tr>;
}

/** Within one popover the year is stated once, in its heading. */
function monthDay(day: string): string {
  return formatCalendarDate(day).replace(/, \d{4}$/, "");
}

function monthDayRange(start: string, end: string): string {
  return formatCalendarRange(start, end).replace(/, \d{4}$/, "");
}

type AnalysisSnapshot = Pick<ExecutiveSnapshot, "generatedAt" | "windowStart" | "windowEnd"> & Partial<Pick<ExecutiveSnapshot, "items">>;

/** The saved analysis's applicability as `AnalysisEvidence` states it, so a
 * list on the same screen can tell whether its own state is already said. */
export function useAnalysisValidity(snapshot: AnalysisSnapshot, nowMs = Date.now()): RecommendationValidity {
  const value = useContext(EvidenceContext);
  const clock = value?.nowMs ?? nowMs;
  const bases = [...new Map((snapshot.items ?? []).flatMap((item) => findingBasis(item).sources)
    .map((basis) => [`${basis.source}\u0000${basis.windowStart}\u0000${basis.windowEnd}`, basis])).values()];
  return recommendationValidity({ kind: "finding", key: "", generatedAt: snapshot.generatedAt,
    sources: bases,
  }, value?.context ?? { generatedAt: snapshot.generatedAt, sources: null, handoffs: null, taskSnapshotAt: null, decisions: [], annotations: null }, clock);
}

/** One evidence clock for the saved analysis reused by Overview, Search and
 * findings. A page refresh is never a refresh of the underlying analysis. */
export function AnalysisEvidence({ snapshot, nowMs = Date.now() }: {
  snapshot: AnalysisSnapshot;
  nowMs?: number;
}) {
  const value = useContext(EvidenceContext);
  const clock = value?.nowMs ?? nowMs;
  const knownDate = evidenceInstant(snapshot.generatedAt, clock) !== null;
  const validity = useAnalysisValidity(snapshot, nowMs);
  const start = recommendationDate(snapshot.windowStart, clock);
  const end = recommendationDate(snapshot.windowEnd, clock);
  return <span className="text-xs tabular-nums text-muted-foreground" data-analysis-evidence>
    <InfoTooltip label="About this saved analysis" trigger={
      // Only an exception rides the line: "· Not rechecked" beside the age
      // would read as a task. The state is still the first fact inside.
      <>{knownDate ? `Analysis ${formatAge(ageMs(clock, snapshot.generatedAt))} ago` : "Analysis date unknown"}{validity.state === "unverified" ? null : ` · ${validity.label}`}</>
    }>
      <RecommendationFacts validity={validity} subject="analysis:saved" heading={<>
        {knownDate ? `Saved ${formatCalendarDate(validity.generatedAt!.slice(0, 10))}` : "Save date unknown"}
        <span className="block font-normal text-muted-foreground">
          {start && end && start <= end ? `Evidence ${formatCalendarRange(start, end)}` : "Evidence dates unknown"}
        </span>
      </>} />
    </InfoTooltip>
  </span>;
}
