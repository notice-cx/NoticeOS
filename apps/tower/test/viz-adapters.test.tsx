import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AssetCard, SystemBand } from "@shared/wall";
import { render, screen } from "./render";
import { WorkFlow, workQueue, workScale } from "@/components/viz/WorkFlow";
import { drawnByHealthGrid, incidentsFromIssues, systemHealthRow, workFlowRows } from "@/lib/viz-adapters";
import type { WallIssue } from "@/lib/wall-issues";

const SYSTEM: SystemBand = {
  assetId: "os.example",
  hasPulse: true,
  spendTodayUsd: 0.5,
  dailyCapUsd: 1,
  ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 },
  scheduledLanes: [
    { job: "backup", outcome: "failed", startedAt: "2026-10-11T15:00:00.000Z" },
    { job: "signals", outcome: "ran", startedAt: "2026-10-11T16:00:00.000Z" },
  ],
};

const issue = (key: string, severity: "error" | "warn" = "error"): WallIssue => ({
  key, severity, assets: ["a.example"], site: "Acorn Atlas", line: key, mark: key, since: "2026-10-11T15:00:00.000Z", conditions: [],
});

describe("the system row", () => {
  it("dates a failed backup from its run and leaves an unrun scheduler unknown", () => {
    const row = systemHealthRow(SYSTEM);
    const cell = (id: string) => row.cells.find((candidate) => candidate.column === id)!;
    expect(cell("backups")).toMatchObject({ state: "failing", since: "2026-10-11T15:00:00.000Z" });
    expect(cell("jobs").state).toBe("working");
    expect(cell("os-report").state).toBe("working");
    expect(systemHealthRow({ ...SYSTEM, scheduledLanes: [] }).cells.find((c) => c.column === "jobs")!.state).toBe("unknown");
    expect(systemHealthRow({ ...SYSTEM, spendTodayUsd: 2 }).cells.find((c) => c.column === "spend")!.state).toBe("overdue");
  });
});

describe("problems beside a health grid", () => {
  it("leaves data-source, report and system problems to the grid so each appears once", () => {
    const issues = [issue("source-bing-webmaster"), issue("system-job-failed"), issue("report-a.example", "warn"), issue("alert-12", "warn")];
    expect(issues.filter(drawnByHealthGrid).map((item) => item.key)).toEqual(["source-bing-webmaster", "system-job-failed", "report-a.example"]);
    expect(incidentsFromIssues(issues, { besideGrid: true }).map((item) => item.key)).toEqual(["alert-12"]);
    expect(incidentsFromIssues(issues)).toHaveLength(4);
  });
});

describe("work as flow", () => {
  const work = (open: number, blocked: number) =>
    ({ id: "a.example", displayName: "Acorn Atlas", work: { open, blocked, inProgress: 2, closedRecent: 5, highPriority: 1, priorities: null, capturedAt: "2026-10-11T16:00:00.000Z" } }) as unknown as AssetCard;

  it("splits open work into ready and blocked, and leaves out a site with no snapshot", () => {
    const rows = workFlowRows([work(10, 3), { id: "b.example", displayName: "Summit", work: null } as unknown as AssetCard]);
    expect(rows).toEqual([{ id: "a.example", name: "Acorn Atlas", to: undefined, done: 5, inProgress: 2, ready: 7, blocked: 3, urgent: 1 }]);
    expect(workQueue(rows[0]!)).toBe(12);
  });

  it("draws both sides of every row on one scale", () => {
    expect(workScale([{ id: "a", name: "A", done: 58, inProgress: 4, ready: 167, blocked: 9, urgent: null }, { id: "b", name: "B", done: 90, inProgress: 0, ready: 1, blocked: 0, urgent: null }])).toBe(180);
    expect(workScale([])).toBe(1);
  });

  it("says each project's flow in words and names what waits on the operator", () => {
    render(
      <MemoryRouter>
        <WorkFlow rows={workFlowRows([work(10, 3)])} waiting={{ count: 4, urgent: 1 }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("row", { name: "Acorn Atlas: 5 done this week; 12 open, 2 in progress, 3 blocked, 1 high priority" })).toBeTruthy();
    expect(screen.getByText("1 urgent")).toBeTruthy();
  });
});
