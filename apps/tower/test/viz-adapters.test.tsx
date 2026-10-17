import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AssetCard, SystemBand } from "@shared/wall";
import { render, screen } from "./render";
import { WorkFlow, workQueue, workScale } from "@/components/viz/WorkFlow";
import { drawnByHealthGrid, incidentsFromIssues, systemHealthRow, workFlowRows } from "@/lib/viz-adapters";
import type { WallIssue } from "@/lib/wall-issues";
import { backupLane, backupNight, pressedBackupLane } from "./backup-lanes";

const NOW = Date.parse("2026-10-14T16:00:00.000Z");

// The office installation on 2026-10-14: a good copy on 2026-10-02, then
// twelve failed nights.
const SYSTEM: SystemBand = {
  assetId: "os.example",
  hasPulse: true,
  spendTodayUsd: 0.5,
  dailyCapUsd: 1,
  ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 },
  scheduledLanes: [
    backupLane(NOW, 12, "2026-10-02T04:00:00.000Z"),
    { job: "signals", outcome: "ran", startedAt: "2026-10-14T15:00:00.000Z", lastRanAt: "2026-10-14T15:00:00.000Z", failedRuns: 0, failingSince: null },
  ],
};

const issue = (key: string, severity: "error" | "warn" = "error"): WallIssue => ({
  key, severity, assets: ["a.example"], site: "Acorn Atlas", line: key, mark: key, since: "2026-10-11T15:00:00.000Z", conditions: [],
});

describe("the system row", () => {
  const backups = (lanes: SystemBand["scheduledLanes"]) =>
    systemHealthRow({ ...SYSTEM, scheduledLanes: lanes }, NOW).cells.find((cell) => cell.column === "backups")!;

  it("dates a backup outage from its first failed night, with the last good copy's age, and leaves an unrun scheduler unknown", () => {
    const row = systemHealthRow(SYSTEM, NOW);
    const cell = (id: string) => row.cells.find((candidate) => candidate.column === id)!;
    expect(cell("backups")).toMatchObject({ state: "failing", since: "2026-10-03T04:00:00.000Z", detail: "last good copy 12d ago" });
    expect(cell("jobs").state).toBe("working");
    expect(cell("os-report").state).toBe("working");
    expect(systemHealthRow({ ...SYSTEM, scheduledLanes: [] }, NOW).cells.find((c) => c.column === "jobs")!.state).toBe("unknown");
    expect(systemHealthRow({ ...SYSTEM, spendTodayUsd: 2 }, NOW).cells.find((c) => c.column === "spend")!.state).toBe("overdue");
  });

  it("is amber after one failed night and failing after two", () => {
    expect(backups([backupLane(NOW, 1, backupNight(NOW, 1))])).toMatchObject({ state: "overdue", since: backupNight(NOW, 0), detail: "last good copy 1d ago" });
    expect(backups([backupLane(NOW, 2, backupNight(NOW, 2))])).toMatchObject({ state: "failing", since: backupNight(NOW, 1), detail: "last good copy 2d ago" });
  });

  it("is working again once a backup runs after the failures, scheduled or pressed", () => {
    expect(backups([backupLane(NOW, 0, backupNight(NOW, 0))])).toMatchObject({ state: "working", since: null, detail: "last good copy 12h ago" });
    expect(backups([pressedBackupLane(NOW, "2026-10-14T14:00:00.000Z")])).toMatchObject({ state: "working", since: null, detail: "last good copy 2h ago" });
  });

  it("reads no good copy yet when none was ever made", () => {
    expect(backups([backupLane(NOW, 3, null)])).toMatchObject({ state: "failing", since: backupNight(NOW, 2), detail: "no good copy yet" });
    expect(backups([])).toMatchObject({ state: "not-connected", detail: "no good copy yet" });
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
    expect(rows).toEqual([{ id: "a.example", name: "Acorn Atlas", to: undefined, done: 5, doneLastWeek: null, inProgress: 2, ready: 7, blocked: 3, urgent: 1 }]);
    expect(workQueue(rows[0]!)).toBe(12);
  });

  it("takes done from this calendar week, with last week's beside it, where the closes reach the week", () => {
    const card = work(10, 3);
    const done = { now: 2, notDone: 0, before: 1, lastWeek: 6, move: null };
    const rows = workFlowRows([{ ...card, work: { ...card.work!, weeks: { weekStart: "2026-10-05", daysIn: 7, done } as never } }]);
    expect(rows[0]).toMatchObject({ done: 2, doneLastWeek: 6 });
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
