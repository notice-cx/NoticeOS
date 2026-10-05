// System posture and its specific Needs you rows (ro-trai.49). The header
// carries time and obligations; these concerns remain in the action list.

import type { ConnectionReads } from "@shared/connection-status";
import type { MaterialCondition } from "@shared/materiality";
import { osReportMissing, type AssetCard, type SystemBand } from "@shared/wall";
import { scheduledLanePosture } from "@/components/ScheduledLanes";
import { compareIssues, failingSources, type WallIssue, type WallIssueCondition } from "@/lib/wall-issues";
import { SCHEDULED_JOBS, jobRunName } from "@shared/scheduled-jobs";

export type WallSystemStateKind =
  | "os-report-missing"
  | "job-failed"
  | "jobs-silent"
  | "sources-failing"
  | "reports-stale"
  | "over-pace"
  | "healthy";

export interface WallSystemState {
  kind: WallSystemStateKind;
  /** Attention tone; null is healthy, drawn in muted ink. */
  severity: "error" | "warn" | null;
  /** What the strip says: at most four words. */
  label: string;
  /** The material conditions this state speaks for (`shared/materiality`). */
  conditions: MaterialCondition[];
}

/**
 * How many SOURCE KINDS are failing right now — the rows Needs you lists for
 * them (`failingSources`, bead `ro-trai.17`). One provider failing on two
 * sites is "1 source failing" beside one Needs you row naming both sites; the
 * nightly report's slot counts as "reports stale" instead.
 */
export function failingSourceCount(
  assets: readonly AssetCard[],
  reads: ConnectionReads,
  nowMs: number,
): number {
  return failingSources(assets, reads, nowMs).size;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The one state, worst first. */
export function wallSystemState(system: SystemBand, sourcesFailing: number, nowMs: number): WallSystemState {
  // Owed and missing, never merely absent (bead ro-ujb9.132): an installation
  // with no OS row has no OS report to miss, and Home's System tile reads the
  // same rule.
  if (osReportMissing(system)) {
    return { kind: "os-report-missing", severity: "error", label: "OS report missing", conditions: ["os-runner-health"] };
  }
  const scheduler = scheduledLanePosture(system.scheduledLanes, nowMs);
  if (scheduler === "failed") {
    return { kind: "job-failed", severity: "error", label: "A scheduled job failed", conditions: ["scheduled-lane-health"] };
  }
  if (scheduler === "silent") {
    return { kind: "jobs-silent", severity: "error", label: "Scheduled jobs silent", conditions: ["scheduled-lane-health"] };
  }
  if (sourcesFailing > 0) {
    // A failing source is an error wherever it is counted (`sourcesSummary`).
    return {
      kind: "sources-failing",
      severity: "error",
      label: `${plural(sourcesFailing, "source", "sources")} failing`,
      conditions: ["signal-freshness"],
    };
  }
  if (system.ingest.stale > 0) {
    return {
      kind: "reports-stale",
      severity: "warn",
      label: `${plural(system.ingest.stale, "report", "reports")} stale`,
      conditions: ["signal-freshness"],
    };
  }
  if (system.dailyCapUsd > 0 && system.spendTodayUsd > system.dailyCapUsd) {
    return { kind: "over-pace", severity: "warn", label: "Over daily data pace", conditions: ["budget-guardrail"] };
  }
  return {
    kind: "healthy",
    severity: null,
    label: "System",
    conditions: ["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail"],
  };
}

/** Add OS, scheduler and spend problems to the same ordered action list.
 * Source and nightly-report problems already have their specific asset rows. */
export function withSystemIssues(issues: readonly WallIssue[], system: SystemBand | undefined, nowMs: number): WallIssue[] {
  if (!system) return [...issues];
  const merged = [...issues];
  const quiet = { ...system, scheduledLanes: [], ingest: { ...system.ingest, stale: 0 }, spendTodayUsd: 0 };
  const states = [
    wallSystemState(quiet, 0, nowMs),
    wallSystemState({ ...quiet, hasPulse: true, scheduledLanes: system.scheduledLanes }, 0, nowMs),
    wallSystemState({ ...quiet, hasPulse: true, spendTodayUsd: system.spendTodayUsd }, 0, nowMs),
  ];
  for (const state of states) {
    if (state.kind === "healthy") continue;
    const condition = state.conditions[0] as WallIssueCondition;
    const represented = merged.findIndex(issue => issue.conditions.includes(condition) || (
      state.kind === "os-report-missing" && system.assetId !== null && issue.assets.includes(system.assetId) &&
      (issue.mark === "Report late" || issue.mark === "No report yet")
    ));
    if (represented !== -1) {
      const issue = merged[represented]!;
      merged[represented] = { ...issue, severity: state.severity === "error" ? "error" : issue.severity, conditions: [...new Set([...issue.conditions, condition])] };
      continue;
    }
    const failed = state.kind === "job-failed" ? system.scheduledLanes.filter(lane => lane.outcome === "failed") : [];
    const line = failed.length === 1
      ? `${SCHEDULED_JOBS.find(job => jobRunName(job) === failed[0]!.job)?.label ?? failed[0]!.job} failed`
      : failed.length > 1 ? `${failed.length} scheduled jobs failed` : state.label;
    const latest = failed.length > 0 ? failed.reduce((time, lane) => lane.startedAt > time ? lane.startedAt : time, "") : null;
    merged.push({
      key: `system-${state.kind}`, severity: state.severity ?? "warn", assets: system.assetId ? [system.assetId] : [],
      site: "OS", line, mark: state.label, since: latest, conditions: [condition],
    });
  }
  return merged.sort(compareIssues);
}
