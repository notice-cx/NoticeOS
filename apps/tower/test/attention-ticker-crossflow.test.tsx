import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { WorkspaceStore } from "@noticeos/postgres";
import { NO_READS } from "@shared/connection-status";
import type { WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import { IncidentList } from "@/components/viz/IncidentList";
import { portfolioIssues, issueDestination } from "@/lib/portfolio-issues";
import { incidentsFromIssues } from "@/lib/viz-adapters";
import { loadLatestBeadsSnapshot } from "../worker/beads-snapshot";
import { wallAttentionTasksOf } from "../worker/wall-payload";
import { WALL_FIXTURE_NOW, wallFixturePayload } from "../e2e/wall-fixture";
import { render } from "./render";

const nowMs = Date.parse(WALL_FIXTURE_NOW);

describe("stored attention reaches the Wall beside Home's canonical problems", () => {
  it.each(["os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail", "rollback-failure"] as const)("renders the observed %s condition as an actual ticker row", condition => {
    const payload = wallFixturePayload("four");
    payload.attention = [];
    payload.system = { ...payload.system, assetId: "os", hasPulse: true, scheduledLanes: [], spendTodayUsd: 0 };
    if (condition === "os-runner-health") payload.system.hasPulse = false;
    if (condition === "scheduled-lane-health") payload.system.scheduledLanes = [{ job: "signals", outcome: "failed", startedAt: WALL_FIXTURE_NOW, lastRanAt: null, failedRuns: 1, failingSince: WALL_FIXTURE_NOW }];
    if (condition === "budget-guardrail") { payload.system.dailyCapUsd = 1; payload.system.spendTodayUsd = 2; }
    if (condition === "signal-freshness") {
      payload.assets[0] = { ...payload.assets[0]!, status: "live", noNightlyReport: false, pulseReceivedAt: new Date(nowMs - 72 * 3_600_000).toISOString() };
    }
    if (condition === "rollback-failure") payload.attention = [{ id: 91, asset: payload.assets[0]!.id, assetDisplayName: payload.assets[0]!.displayName, severity: "error", kind: "anomaly", message: "Rollback failed", firedAt: WALL_FIXTURE_NOW, metric: "clicks", ruleId: "watch-window-closed", ruleInputs: { outcome: "kill_confirmed", deltaPercent: -31 }, correlatedChanges: [], occurrences: 1, firstFiredAt: WALL_FIXTURE_NOW }];
    const issues = portfolioIssues({ assets: payload.assets, attention: payload.attention, system: payload.system, connections: NO_READS, nowMs });
    const source = issues.find(issue => issue.conditions.includes(condition));
    expect(source).toBeDefined();
    const layout: WallLayout = { version: 1, rows: [{ id: "attention", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1 }] }] };
    const wall = render(<MemoryRouter><WallCanvas layout={layout} data={payload} nowMs={nowMs} connections={NO_READS} /></MemoryRouter>);
    const row = wall.container.querySelector(`[data-attention-copy="original"] [data-attention-item="problem:${source!.key}"]`)!;
    expect(row.getAttribute("data-material-condition")?.split(" ")).toContain(condition);
    expect(row).toHaveTextContent(source!.line);
    expect(row.querySelector('[role="img"]')).not.toBeNull();
    if (condition === "rollback-failure") expect(row.getAttribute("data-material-condition")?.split(" ")).toContain("open-flags");
  });

  it.each([undefined, []])("retains all Home problems and stored decisions when the TV hides their asset and filter is %j", async assets => {
    const payload = wallFixturePayload("four");
    const hidden = payload.assets[0]!;
    payload.dashboard.sites = { [hidden.id]: { tv: false } };
    const raw = { projects: [{ asset: hidden.id, prefix: "ex", ok: true, counts: {}, ready: [], inProgress: [], recentlyClosed: [], attentionTasks: { complete: true, items: [
      { id: "ex-decision", title: "Approve the repair", priority: 3, status: "open", issueType: "gate", decision: true },
      { id: "ex-urgent", title: "Repair the unavailable page", priority: 0, status: "blocked", issueType: "task", decision: false },
    ] } }] };
    const store = { read: async (run: (transaction: { query: () => Promise<unknown[]> }) => Promise<unknown>) => run({ query: async () => [{ captured_at: WALL_FIXTURE_NOW, payload: JSON.stringify(raw) }] }) } as unknown as WorkspaceStore;
    payload.attentionTasks = wallAttentionTasksOf(await loadLatestBeadsSnapshot(store));
    const issues = portfolioIssues({ assets: payload.assets, attention: payload.attention, system: payload.system, connections: NO_READS, nowMs });
    expect(issues.some(issue => issue.assets.includes(hidden.id))).toBe(true);
    const layout: WallLayout = { version: 1, rows: [{ id: "attention", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1, ...(assets ? { settings: { assets } } : {}) }] }] };
    const home = render(<MemoryRouter><IncidentList items={incidentsFromIssues(issues, { to: issue => issueDestination(issue, payload.assets) })} nowMs={nowMs} /></MemoryRouter>);
    const wall = render(<MemoryRouter><WallCanvas layout={layout} data={payload} nowMs={nowMs} connections={NO_READS} /></MemoryRouter>);
    const original = wall.container.querySelector('[data-attention-copy="original"]')!;
    for (const issue of issues) {
      expect(home.container).toHaveTextContent(issue.line);
      const item = original.querySelector(`[data-attention-item="problem:${issue.key}"]`)!;
      expect(item).toHaveTextContent(issue.line);
      expect(item.querySelector(`[aria-label="${issue.severity === "error" ? "Error" : "Warning"}"]`)).not.toBeNull();
      for (const condition of issue.conditions) expect(item.getAttribute("data-material-condition")?.split(" ")).toContain(condition);
    }
    expect(original.querySelectorAll('[data-attention-item^="problem:"]')).toHaveLength(issues.length);
    expect(original.querySelector('[data-attention-item="task:ex-decision"]')).toHaveAttribute("data-material-condition", "human-gates");
    expect(original.querySelector('[data-attention-item="task:ex-decision"] a')).toHaveAttribute("href", `/tasks/ex-decision?project=${encodeURIComponent(hidden.id)}`);
    expect(original.querySelector('[data-attention-item="task:ex-urgent"]')).not.toHaveAttribute("data-material-condition");
    expect(wall.container.querySelector("[data-wall-attention-ticker]")).toHaveAttribute("data-attention-status", "ready");
  });
});
