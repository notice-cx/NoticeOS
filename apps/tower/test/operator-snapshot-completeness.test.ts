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
  { id: "md-g1", title: "Approve the launch", status: "open", priority: 3, issueType: "gate" },
  { id: "md-h1", title: "Choose the next page", status: "open", priority: 1, issueType: "task" },
  { id: "md-h2", title: "Choose a later project", status: "open", priority: 3, issueType: "task" },
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
    expect(operatorLabel(posture, NOW.getTime())).toBe(rows?.length ? `Urgency unknown · ${rows.length}+ need attention` : "Inbox unknown");
    const work = await buildWorkPayload(ctx.call, { now: NOW });
    expect(work.projects[0]!.counts.waiting).toBeNull();
    expect(work.projects[0]!.waiting.map((row) => row.id)).toEqual((rows ?? []).map((row) => row.id));
    expect(work.projects[0]!.counts.open).toBe(12);
  });

  it("adds a known partial head to complete projects without pretending it is the full total", async () => {
    await seedSnapshot(ctx, CAPTURED, [
      workProject({ waiting }),
      workProject({ asset: "northwind.example", counts: { waiting: 10 }, waitingUrgent: 4 }),
      workProject({ asset: "ferns.example", ok: false, waiting }),
    ]);
    const posture = beadsNeedsYou(await loadLatestBeadsSnapshot(ctx.call));
    expect(posture).toMatchObject({ waiting: 13, urgent: 6, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 3 });
    expect(operatorLabel(posture, NOW.getTime())).toBe("6+ urgent · 13+ need attention");
  });

  it("carries a waiting task's choices and a person's pick, and leaves out what it cannot read", async () => {
    const choices = { question: "Which page next?", options: [{ key: "a", label: "Recipes" }, { key: "b", label: "Plans", recommended: true }] };
    const choice = { option: "b", label: "Plans", by: "Dana", at: "2026-09-05T11:00:00.000Z" };
    await seedSnapshot(ctx, CAPTURED, [workProject({
      waiting: [{ ...waiting[1]!, choices }, { ...waiting[2]!, choices: "a or b", choice: "b" }],
      recentWork: [
        { kind: "chosen", taskId: "md-h0", title: "Choose the first page", by: "Dana", model: null, at: choice.at, evidence: null, option: "b", label: "Plans" },
        { kind: "chosen", taskId: "md-h9", title: "No option named", by: "Dana", model: null, at: choice.at, evidence: null },
      ],
      ready: [{ id: "md-h0", title: "Choose the first page", status: "open", priority: 1, issueType: "task", choices, choice }],
    })]);
    const project = (await loadLatestBeadsSnapshot(ctx.call))!.projects[0]!;
    expect([project.waiting[0]!.choices, "choice" in project.waiting[0]!]).toEqual([choices, false]);
    expect("choices" in project.waiting[1]! || "choice" in project.waiting[1]!).toBe(false);
    expect(project.ready[0]!.choice).toEqual(choice);
    expect(project.recentWork).toEqual([{ kind: "chosen", taskId: "md-h0", title: "Choose the first page", by: "Dana", model: null,
      at: choice.at, evidence: null, option: "b", label: "Plans" }]);
  });

  it("carries how a close that was not done ended, and reads one it cannot read as done", async () => {
    const closed = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, status: "closed", priority: 2, issueType: "task",
      closedAt: "2026-09-05T11:00:00.000Z", ...extra });
    await seedSnapshot(ctx, CAPTURED, [workProject({
      recentlyClosed: [closed("md-c1"), closed("md-c2", { resolution: "duplicate", duplicateOf: "md-c1" }), closed("md-c3", { resolution: "wont-do" }),
        closed("md-c4", { resolution: "fixed" })],
      recentWork: [
        { kind: "closed", taskId: "md-c3", title: "md-c3", by: "Dana", model: null, at: "2026-09-05T11:00:00.000Z", evidence: "Nobody asked", resolution: "wont-do" },
        { kind: "closed", taskId: "md-c1", title: "md-c1", by: "claude", model: null, at: "2026-09-05T11:00:00.000Z", evidence: "Landed", resolution: "done" },
      ],
    })]);
    const project = (await loadLatestBeadsSnapshot(ctx.call))!.projects[0]!;
    expect(project.recentlyClosed.map((row) => [row.id, row.resolution ?? null, row.duplicateOf ?? null])).toEqual([
      ["md-c1", null, null], ["md-c2", "duplicate", "md-c1"], ["md-c3", "wont-do", null], ["md-c4", null, null]]);
    expect(project.recentWork?.map((event) => [event.taskId, event.resolution ?? null])).toEqual([["md-c3", "wont-do"], ["md-c1", null]]);
  });

  it("carries each figure's week on the work payload, an unmeasured count as unknown rather than zero", async () => {
    // The closes the poller read from 08-21, so this week and last are whole.
    const closes = { since: "2026-08-21", items: [
      { at: "2026-08-25T10:00:00.000Z" },
      // Saturday 13:00 last week: after this moment of last week.
      { at: "2026-08-29T13:00:00.000Z" },
      { at: "2026-09-01T10:00:00.000Z" },
      { at: "2026-09-02T10:00:00.000Z", resolution: "wont-do" },
      // A resolution the reader does not know reads as done.
      { at: "2026-09-03T10:00:00.000Z", resolution: "fixed" },
      { at: "2026-09-04T10:00:00.000Z" },
    ] };
    await seedSnapshot(ctx, CAPTURED, [workProject({ waiting: [waiting[1]!], closes })]);
    // The one day the rollup holds: a poller that measured neither the inbox
    // nor urgency, on Saturday of the week that began on Monday 08-31.
    await ctx.call.write((tx) => tx.execute(
      `INSERT INTO noticeos.task_daily_counts (workspace_id, project, day, captured_at, waiting, urgent, open, in_progress, blocked, closed_ids)
       VALUES ($1::uuid, 'meadow.example', '2026-09-05'::date, $2::timestamptz, NULL, NULL, 12, 1, 0, '[]'::jsonb)`,
      [tx.workspaceId, CAPTURED],
    ));
    const weeks = (await buildWorkPayload(ctx.call, { now: NOW, timeZone: "UTC" })).projects[0]!.weeks;
    expect(weeks).toEqual({
      weekStart: "2026-08-31",
      daysIn: 6,
      // Done is counted from the closes, whatever days the history holds.
      done: { now: 3, notDone: 1, before: 1, lastWeek: 2, move: { by: 2, direction: "up", verdict: "good" } },
      waiting: { now: null, before: null, added: null, move: null },
      urgent: { now: null, before: null, added: null, move: null },
      inProgress: { now: 1, before: null, added: null, move: null },
      blocked: { now: 0, before: null, added: null, move: null },
    });
  });

  it("returns to a complete zero only after a newer complete empty snapshot", async () => {
    await seedSnapshot(ctx, "2026-09-05T11:59:00.000Z", [workProject({ waiting })]);
    await seedSnapshot(ctx, CAPTURED, [workProject({ counts: { waiting: 0 }, waitingUrgent: 0, waiting: [] })]);
    const posture = beadsNeedsYou(await loadLatestBeadsSnapshot(ctx.call));
    expect(operatorState(posture, NOW.getTime())).toMatchObject({ complete: true, urgentComplete: true, needsAttention: false });
    expect(operatorLabel(posture, NOW.getTime())).toBe("0 need attention");
  });
});
