import { describe, expect, it } from "vitest";
import type { JobSchedule } from "@shared/scheduled-jobs";
import type { ScheduledLane, SystemBand } from "@shared/wall";
import { backupStatus } from "@/lib/backups";
import { systemFlow } from "@/lib/system-flow";
import { systemHealthRow } from "@/lib/viz-adapters";
import { withSystemIssues } from "@/lib/wall-system-state";

const DAILY: JobSchedule = { enabled: true, cron: "0 4 * * *" };
const GOOD = "2026-10-01T04:00:00.000Z";
const FIRST = "2026-10-02T04:00:00.000Z";
const SECOND = "2026-10-03T04:00:00.000Z";
const lane = (patch: Partial<ScheduledLane> = {}): ScheduledLane => ({
  job: "backup", outcome: "ran", startedAt: GOOD, lastRanAt: GOOD, failedRuns: 0, failingSince: null, ...patch,
});
const status = (now: string, patch: Partial<ScheduledLane> = {}, schedule = DAILY) =>
  backupStatus([lane(patch)], Date.parse(now), schedule);
const system = (backup: ScheduledLane, schedule: JobSchedule, now: string): SystemBand => ({
  assetId: "os.example", hasPulse: true, spendTodayUsd: 0, dailyCapUsd: 1,
  ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 }, backupSchedule: schedule,
  scheduledLanes: [backup, { job: "beads-snapshot", outcome: "ran", startedAt: now, lastRanAt: now, failedRuns: 0, failingSince: null }],
});

describe("missed scheduled backups", () => {
  it.each(["skipped", "missing"])("shows one then two misses for %s firings while unrelated jobs keep running", (kind) => {
    for (const [now, state, cellState, nodeState, count] of [
      [FIRST, "missed", "overdue", "warn", 0],
      [SECOND, "failing", "failing", "error", 1],
    ] as const) {
      const backup = lane(kind === "skipped" ? { outcome: "skipped", startedAt: now } : {});
      const band = system(backup, DAILY, now);
      const nowMs = Date.parse(now);
      expect(backupStatus(band.scheduledLanes, nowMs, band.backupSchedule)).toMatchObject({ state, failingSince: FIRST });
      expect(systemHealthRow(band, nowMs).cells.find((cell) => cell.column === "backups")).toMatchObject({ state: cellState, since: FIRST });
      expect(systemFlow({ credentials: new Map(), items: [], system: band, nowMs }).nodes.find((node) => node.id === "backups"))
        .toMatchObject({ state: nodeState, since: FIRST });
      const issues = withSystemIssues([], band, nowMs);
      expect(issues).toHaveLength(count);
      if (count) expect(issues[0]).toMatchObject({ key: "system-backups-failing", since: FIRST });
      expect(withSystemIssues(issues, band, nowMs)).toEqual(issues);
    }
  });

  it("counts opportunities strictly after the good copy and through the current clock", () => {
    expect(status("2026-10-02T03:59:59.999Z").state).toBe("working");
    expect(status(FIRST)).toMatchObject({ state: "missed", missedRuns: 1, failingSince: FIRST });
    expect(status(SECOND)).toMatchObject({ state: "failing", missedRuns: 2 });
    expect(status(SECOND, { lastRanAt: SECOND })).toMatchObject({ state: "working", missedRuns: 0, failingSince: null });
  });

  it("uses weekly overrides in their saved timezone, not elapsed days", () => {
    const weekly = { enabled: true, cron: "0 4 * * 0", timezone: "America/New_York" };
    const good = { lastRanAt: "2026-10-03T12:00:00.000Z" };
    expect(status("2026-10-04T07:59:59.999Z", good, weekly).state).toBe("working");
    expect(status("2026-10-04T08:00:00.000Z", good, weekly)).toMatchObject({ state: "missed", failingSince: "2026-10-04T08:00:00.000Z" });
    expect(status("2026-10-11T07:59:59.999Z", good, weekly).state).toBe("missed");
    expect(status("2026-10-11T08:00:00.000Z", good, weekly).state).toBe("failing");
  });

  it.each([
    ["2026-03-07T09:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-09T08:00:00.000Z"],
    ["2026-10-31T08:00:00.000Z", "2026-11-01T09:00:00.000Z", "2026-11-02T09:00:00.000Z"],
  ])("follows daylight saving transitions after %s", (good, first, second) => {
    const schedule = { ...DAILY, timezone: "America/New_York" };
    expect(status(first, { lastRanAt: good }, schedule)).toMatchObject({ state: "missed", failingSince: first });
    expect(status(second, { lastRanAt: good }, schedule).state).toBe("failing");
  });

  it("counts comma-separated retry ticks independently", () => {
    const schedule = { enabled: true, cron: "10,30,50 * * * *" };
    const good = { lastRanAt: "2026-10-01T04:10:00.000Z" };
    expect(status("2026-10-01T04:30:00.000Z", good, schedule).state).toBe("missed");
    expect(status("2026-10-01T04:50:00.000Z", good, schedule).state).toBe("failing");
  });

  it.each(["ran", "failed", "skipped"] as const)("clears missed state after a successful manual copy despite the last scheduled outcome being %s", (outcome) => {
    const band = system(lane({ outcome, startedAt: SECOND, lastRanAt: "2026-10-03T10:00:00.000Z" }), DAILY, "2026-10-03T12:00:00.000Z");
    expect(backupStatus(band.scheduledLanes, Date.parse("2026-10-03T12:00:00.000Z"), DAILY)).toMatchObject({ state: "working", missedRuns: 0, failingSince: null });
    expect(withSystemIssues([], band, Date.parse("2026-10-03T12:00:00.000Z"))).toEqual([]);
  });

  it("shows disabled schedules as off on every surface, despite old failures", () => {
    const schedule = { ...DAILY, enabled: false };
    const backup = lane({ failedRuns: 12, failingSince: FIRST });
    const band = system(backup, schedule, SECOND);
    const nowMs = Date.parse(SECOND);
    expect(backupStatus(band.scheduledLanes, nowMs, schedule)).toMatchObject({ state: "off", missedRuns: 0, failingSince: null });
    expect(backupStatus([], nowMs, schedule).state).toBe("off");
    expect(systemHealthRow(band, nowMs).cells.find((cell) => cell.column === "backups")).toMatchObject({ state: "not-using", label: "Off" });
    const flow = systemFlow({ credentials: new Map(), items: [], system: band, nowMs });
    expect(flow.nodes.find((node) => node.id === "backups")).toMatchObject({ state: "absent", caption: "Off" });
    expect(flow.edges.find((edge) => edge.to === "backups")?.state).toBe("idle");
    expect(withSystemIssues([], band, nowMs)).toEqual([]);
    expect(withSystemIssues([], { ...band, scheduledLanes: [backup] }, nowMs)).toEqual([]);
  });

  it("judges a manual-only good copy without inventing a scheduled firing", () => {
    const nowMs = Date.parse(SECOND);
    expect(backupStatus([], nowMs, DAILY, GOOD)).toMatchObject({ state: "failing", lastGoodAt: GOOD, failingSince: FIRST });
    expect(backupStatus([], nowMs, DAILY, SECOND)).toMatchObject({ state: "working", lastGoodAt: SECOND, missedRuns: 0 });
    expect(backupStatus([], nowMs, { ...DAILY, enabled: false }, GOOD).state).toBe("off");
  });

  it("does not infer missed history without a good copy or an effective schedule", () => {
    const nowMs = Date.parse(SECOND);
    expect(backupStatus([], nowMs, DAILY).state).toBe("none");
    expect(status(SECOND, { outcome: "skipped", lastRanAt: null })).toMatchObject({ state: "none", missedRuns: 0 });
    expect(backupStatus([lane()], nowMs)).toMatchObject({ state: "working", missedRuns: 0 });
    expect(status(SECOND, { lastRanAt: null, failedRuns: 2, failingSince: FIRST })).toMatchObject({ state: "failing", missedRuns: 2, failingSince: FIRST });
  });

  it("does not double count failures that already represent due opportunities", () => {
    expect(status(FIRST, { failedRuns: 1, failingSince: FIRST })).toMatchObject({ state: "missed", missedRuns: 1 });
    expect(status(SECOND, { failedRuns: 1, failingSince: SECOND })).toMatchObject({ state: "failing", missedRuns: 2, failingSince: FIRST });
  });

  it("chooses the worst derived backup and bounds inference for old frequent schedules", () => {
    const backup = lane({ lastRanAt: "2000-01-01T00:00:00.000Z" });
    expect(backupStatus([lane({ job: "store-backup", lastRanAt: SECOND }), backup], Date.parse(SECOND), { enabled: true, cron: "* * * * *" }))
      .toMatchObject({ state: "failing", missedRuns: 2, lastGoodAt: backup.lastRanAt, failingSince: "2000-01-01T00:01:00.000Z" });
  });
});
