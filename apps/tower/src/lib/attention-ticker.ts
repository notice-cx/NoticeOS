import { isAmber } from "@shared/freshness";
import { isRetired } from "@shared/asset-setup";
import type { AssetCard, WallAttentionTasks } from "@shared/wall";
import { WORK_POLL_CADENCE_HOURS } from "@shared/work";
import { compareIssues, type WallIssue } from "./wall-issues";
import { issueDestination } from "./portfolio-issues";
import { taskPath } from "./task-path";
export { portfolioIssues } from "./portfolio-issues";

export interface AttentionTickerItem {
  id: string;
  severity: "error" | "warn";
  assetName: string;
  title: string;
  href: string;
  conditions: string[];
  since: string | null;
  kind: "problem" | "task";
}
export type AttentionTaskStatus = "ready" | "stale" | "partial" | "unavailable";

export function attentionTickerItems({ issues, tasks, assets, nowMs }: {
  issues: readonly WallIssue[];
  tasks?: WallAttentionTasks | null;
  assets: readonly AssetCard[];
  nowMs: number;
}): { items: AttentionTickerItem[]; taskStatus: AttentionTaskStatus } {
  const seen = new Set<string>();
  const representedTasks = new Set(issues.flatMap(issue => issue.task ? [issue.task] : []));
  const items: AttentionTickerItem[] = [...issues].sort(compareIssues).flatMap(issue => {
    if (seen.has(issue.key)) return [];
    seen.add(issue.key);
    return [{ id: `problem:${issue.key}`, severity: issue.severity, assetName: issue.site, title: issue.line,
      href: issueDestination(issue, assets), conditions: [...issue.conditions], since: issue.since, kind: "problem" as const }];
  });
  const names = new Map(assets.map(asset => [asset.id, asset.displayName]));
  const retired = new Set(assets.filter(asset => isRetired(asset.status)).map(asset => asset.id));
  const dated = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
  const rows = [...(tasks?.items ?? [])].sort((a, b) => Number(b.ask !== null) - Number(a.ask !== null)
    || a.priority - b.priority || dated(a.updatedAt) - dated(b.updatedAt) || a.id.localeCompare(b.id));
  const taskIds = new Set<string>();
  for (const task of rows) {
    if (retired.has(task.asset) || representedTasks.has(task.id) || taskIds.has(task.id) || (task.ask === null && task.priority > 1)) continue;
    taskIds.add(task.id);
    const verb = task.ask === "approve" ? "Approve" : task.ask === "choose" ? "Choose" : "Answer";
    items.push({ id: `task:${task.id}`, severity: task.priority === 0 ? "error" : "warn", assetName: names.get(task.asset) ?? task.asset,
      title: task.ask ? `${verb}: ${task.title}` : task.title, href: taskPath(task.id, task.asset), conditions: task.ask ? ["human-gates"] : [],
      since: task.updatedAt, kind: "task" });
  }
  items.sort((a, b) => a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1);
  const taskStatus: AttentionTaskStatus = !tasks?.capturedAt || !Number.isFinite(Date.parse(tasks.capturedAt)) ? "unavailable"
    : isAmber(nowMs, tasks.capturedAt, WORK_POLL_CADENCE_HOURS) ? "stale"
    : tasks.measuredProjects < tasks.projectCount ? "partial" : "ready";
  return { items, taskStatus };
}
