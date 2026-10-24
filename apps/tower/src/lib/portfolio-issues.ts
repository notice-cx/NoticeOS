import { sitePath } from "@shared/first-run";
import type { AssetCard, SystemBand } from "@shared/wall";
import { wallIssues, type WallIssue, type WallIssueInputs } from "./wall-issues";
import { withSystemIssues } from "./wall-system-state";
import { taskPath } from "./task-path";

/** Portfolio problems keep their scope when a surface hides ordinary asset rows. */
export function portfolioIssues({ system, ...inputs }: WallIssueInputs & { system?: SystemBand }): WallIssue[] {
  return withSystemIssues(wallIssues(inputs), system, inputs.nowMs);
}

export function issueDestination(issue: WallIssue, assets: readonly AssetCard[]): string {
  if (issue.task) return taskPath(issue.task, issue.assets.length === 1 ? issue.assets[0] : undefined);
  const asset = issue.assets.length === 1 ? assets.find(candidate => candidate.id === issue.assets[0]) : undefined;
  if (asset) return issue.key.startsWith("source-") ? `/assets/${encodeURIComponent(asset.id)}/sources` : sitePath(asset);
  return issue.key.startsWith("system-") || issue.key.startsWith("source-") ? "/health" : "/alerts";
}
