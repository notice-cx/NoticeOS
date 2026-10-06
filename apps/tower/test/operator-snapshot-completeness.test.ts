// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLatestBeadsSnapshot } from "../worker/beads-snapshot";
import { beadsNeedsYou } from "../worker/task-source";
import { buildWorkPayload } from "../worker/work-payload";
import { operatorLabel, operatorState } from "../src/lib/operator-posture";
import { type TestStore, createTestStore } from "./postgres-store";
import { seedSnapshot, workProject } from "./panel-fixtures";

const CAPTURED = "2026-09-05T12:00:00.000Z";
const NOW = new Date("2026-09-05T12:00:30.000Z");
const waiting = [
  { id: "mp-g1", title: "Approve the launch", status: "open", priority: 3, issueType: "gate" },
  { id: "mp-h1", title: "Choose the next page", status: "open", priority: 1, issueType: "task" },
  { id: "mp-h2", title: "Choose a later project", status: "open", priority: 3, issueType: "task" },
];

let ctx: TestStore;
beforeEach(async () => { ctx = await createTestStore(); });
afterEach(() => ctx.close());

describe("partial operator snapshots from the task poller", () => {
  it.each([
    ["only gates answered", [waiting[0]!], 1],
    ["only human tasks answered", waiting.slice(1), 1],
    ["one empty answer and one failed answer", [], 0],
    ["both answers failed", undefined, 0],
  ] as const)("keeps %s incomplete through the stored reader and dashboard", async (_name, rows, urgent) => {
    // Exact totals are omitted by the poller when either read failed. Known
    // rows are retained; successful ordinary work reads remain useful.
    await seedSnapshot(ctx, CAPTURED, [workProject({ waiting: rows })]);
    const snapshot = await loadLatestBeadsSnapshot(ctx.call);
    expect(snapshot!.projects[0]).toMatchObject({
      ok: true, error: null, counts: { waiting: null }, waitingUrgent: null,
    });
    expect(snapshot!.projects[0]!.waiting.map((row) => row.id)).toEqual((rows ?? []).map((row) => row.id));
    const posture = beadsNeedsYou(snapshot);
    expect(posture).toMatchObject({
      waiting: rows?.length ?? 0, urgent, measuredProjects: 0, urgentMeasuredProjects: 0, projectCount: 1,
    });
    expect(operatorState(posture, NOW.getTime())).toMatchObject({ complete: false, urgentComplete: false, needsAttention: true });
    expect(operatorLabel(posture, NOW.getTime())).toBe(rows?.length ? `Urgency unknown · ${rows.length}+ need you` : "Inbox unknown");
    const work = await buildWorkPayload(ctx.call, { now: NOW });
    expect(work.projects[0]!.counts.waiting).toBeNull();
    expect(work.projects[0]!.waiting.map((row) => row.id)).toEqual((rows ?? []).map((row) => row.id));
    expect(work.projects[0]!.counts.open).toBe(12);
  });

  it("adds a known partial head to complete projects without pretending it is the full total", async () => {
    await seedSnapshot(ctx, CAPTURED, [
      workProject({ waiting }),
      workProject({ asset: "nosh.example", counts: { waiting: 10 }, waitingUrgent: 4 }),
      workProject({ asset: "fees.example", ok: false, waiting }),
    ]);
    const posture = beadsNeedsYou(await loadLatestBeadsSnapshot(ctx.call));
    expect(posture).toMatchObject({ waiting: 13, urgent: 6, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 3 });
    expect(operatorLabel(posture, NOW.getTime())).toBe("6+ urgent · 13+ need you");
  });

  it("returns to a complete zero only after a newer complete empty snapshot", async () => {
    await seedSnapshot(ctx, "2026-09-05T11:59:00.000Z", [workProject({ waiting })]);
    await seedSnapshot(ctx, CAPTURED, [workProject({ counts: { waiting: 0 }, waitingUrgent: 0, waiting: [] })]);
    const posture = beadsNeedsYou(await loadLatestBeadsSnapshot(ctx.call));
    expect(operatorState(posture, NOW.getTime())).toMatchObject({ complete: true, urgentComplete: true, needsAttention: false });
    expect(operatorLabel(posture, NOW.getTime())).toBe("0 need you");
  });
});
