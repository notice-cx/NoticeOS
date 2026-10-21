// @vitest-environment node
// Next up's two lists, derived from the newest task snapshot alone: the
// operator's decisions merged across projects without reordering any
// project's own inbox, and the held work, urgent first, then longest held.

import { describe, expect, it } from "vitest";
import type { TaskChoice, TaskChoices } from "@noticeos/contract/task-choices";
import type { WorkspaceStore } from "@noticeos/postgres";
import { loadLatestBeadsSnapshot, type BeadsSnapshot, type SnapshotProject } from "../worker/beads-snapshot";
import { WALL_NEXT_DECISIONS, WALL_NEXT_WORKING, wallNextUpOf } from "../worker/wall-payload";
import { wallDecisionAsk } from "../shared/wall";
import type { WorkEvent, WorkItem } from "../shared/work";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `Task ${id}`,
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: null,
    closedAt: null,
    parent: null,
    deferUntil: null,
    ...over,
  };
}

function project(asset: string, over: Partial<SnapshotProject> = {}): SnapshotProject {
  return {
    asset,
    prefix: asset.slice(0, 2),
    ok: true,
    error: null,
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    priorities: null,
    epics: null,
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    deferred: [],
    waiting: [],
    waitingUrgent: 0,
    panelReview: undefined,
    handoffs: undefined,
    ...over,
  };
}

const snapshot = (...projects: SnapshotProject[]): BeadsSnapshot => ({ capturedAt: hoursAgo(0), projects });

describe("wallNextUpOf — the decisions", () => {
  it("is null with no snapshot, so the TV says tasks are unknown rather than none", () => {
    expect(wallNextUpOf(null, NOW)).toBeNull();
  });

  it("merges the projects by their heads: a gate first, then priority, then the oldest, each project's own order kept", () => {
    const next = wallNextUpOf(snapshot(
      project("meadow.example", {
        waiting: [
          item("md-gate", { issueType: "gate", createdAt: daysAgo(1) }),
          // Newer than ro-old but listed first by its own project, so it stays ahead of md-old.
          item("md-new", { createdAt: daysAgo(2) }),
          item("md-old", { createdAt: daysAgo(20) }),
        ],
      }),
      project("root-os", {
        waiting: [
          item("ro-p1", { priority: 1, createdAt: daysAgo(3) }),
          item("ro-old", { createdAt: daysAgo(9) }),
        ],
      }),
    ), NOW)!;

    expect(next.decisions.map((decision) => decision.id)).toEqual(["md-gate", "ro-p1", "ro-old", "md-new", "md-old"]);
    expect(next.decisions[0]).toEqual({
      id: "md-gate",
      title: "Task md-gate",
      asset: "meadow.example",
      ask: "approve",
      ageDays: 1,
      releases: null,
    });
    expect(next.oldestAgeDays).toBe(20);
    expect(next.capturedAt).toBe(hoursAgo(0));
  });

  it(`lists at most ${WALL_NEXT_DECISIONS}, and reads the oldest across every row the snapshot listed`, () => {
    const waiting = Array.from({ length: 8 }, (_, index) => item(`md-${index}`, { createdAt: daysAgo(index + 1) }));
    const next = wallNextUpOf(snapshot(project("meadow.example", { waiting })), NOW)!;
    expect(next.decisions).toHaveLength(WALL_NEXT_DECISIONS);
    expect(next.decisions.map((decision) => decision.id)).toEqual(["md-0", "md-1", "md-2", "md-3", "md-4"]);
    expect(next.oldestAgeDays).toBe(8);
  });

  it("leaves out a project the poller could not read", () => {
    const next = wallNextUpOf(snapshot(
      project("meadow.example", { ok: false, error: "no repo", waiting: [item("md-1")] }),
      project("root-os", { waiting: [item("ro-1")] }),
    ), NOW)!;
    expect(next.decisions.map((decision) => decision.id)).toEqual(["ro-1"]);
  });

  it("gives null ages, never zero, when the snapshot carries no filing dates", () => {
    const next = wallNextUpOf(snapshot(project("meadow.example", { waiting: [item("md-1"), item("md-2", { createdAt: "not a date" })] })), NOW)!;
    expect(next.decisions.map((decision) => decision.ageDays)).toEqual([null, null]);
    expect(next.oldestAgeDays).toBeNull();
    // Nothing in the snapshot says what waits on what.
    expect(next.decisions.map((decision) => decision.releases)).toEqual([null, null]);
  });

  it("names each ask with the board's verb: a gate is approved, open choices are chosen, the rest answered", () => {
    const choices: TaskChoices = { question: "Which page stays?", options: [{ key: "a", label: "Keep it" }, { key: "b", label: "Drop it" }] };
    const choice: TaskChoice = { option: "a", label: "Keep it", by: "Dana", at: daysAgo(1) };
    const next = wallNextUpOf(snapshot(project("meadow.example", {
      waiting: [
        item("md-gate", { issueType: "gate" }),
        item("md-pick", { choices, choice: null }),
        item("md-picked", { choices, choice }),
        item("md-ask"),
      ],
    })), NOW)!;
    expect(next.decisions.map((decision) => [decision.id, decision.ask])).toEqual([
      ["md-gate", "approve"],
      ["md-pick", "choose"],
      ["md-picked", "answer"],
      ["md-ask", "answer"],
    ]);
    expect(wallDecisionAsk({ issueType: "task" })).toBe("answer");
  });
});

describe("a task's card and change class, as the Tower reads the stored row", () => {
  it("reads each when it is there and readable, and leaves out a card it cannot read", async () => {
    const card = { valuePerMonth: 1100, likelihood: 0.7, reviewMinutes: 10, daysToSignal: 14, measurability: "holdout" };
    const store = {
      read: async (run: (tx: { query: () => Promise<unknown[]> }) => Promise<unknown>) => run({ query: async () => [{
        captured_at: hoursAgo(0),
        payload: JSON.stringify({ projects: [{ asset: "meadow.example", prefix: "md", ok: true, error: null, counts: {}, inProgress: [], recentlyClosed: [],
          ready: [
            { id: "md-1", title: "Carded", card, changeClass: "copy" },
            { id: "md-2", title: "Hand-edited", card: { ...card, likelihood: 2 }, changeClass: "redesign" },
            { id: "md-3", title: "Older row" },
          ] }] }),
      }] }),
    } as unknown as WorkspaceStore;
    const ready = (await loadLatestBeadsSnapshot(store))!.projects[0]!.ready;
    expect([ready[0]!.card, ready[0]!.changeClass]).toEqual([card, "copy"]);
    expect(ready.slice(1).map((item) => ["card" in item, "changeClass" in item])).toEqual([[false, false], [false, false]]);
  });
});

describe("wallNextUpOf — the work held now", () => {
  const claimed = (taskId: string, at: string, by = "claude"): WorkEvent => ({ kind: "claimed", taskId, title: taskId, by, model: null, at, evidence: null });

  it(`puts urgent work first, then the longest held, at most ${WALL_NEXT_WORKING}`, () => {
    const next = wallNextUpOf(snapshot(
      project("meadow.example", {
        inProgress: [
          item("md-short", { status: "in_progress", assignee: "codex" }),
          item("md-long", { status: "in_progress", assignee: "claude" }),
          item("md-unknown", { status: "in_progress", assignee: null }),
        ],
        recentWork: [claimed("md-short", hoursAgo(2), "codex"), claimed("md-long", hoursAgo(30)), claimed("md-long", hoursAgo(40))],
      }),
      project("root-os", {
        inProgress: [item("ro-urgent", { status: "in_progress", priority: 0, assignee: "claude" })],
        recentWork: [claimed("ro-urgent", hoursAgo(1))],
      }),
    ), NOW)!;

    expect(next.working).toHaveLength(WALL_NEXT_WORKING);
    expect(next.working.map((row) => row.id)).toEqual(["ro-urgent", "md-long", "md-short"]);
    expect(next.working[0]).toEqual({ id: "ro-urgent", title: "Task ro-urgent", asset: "root-os", who: "claude", sinceHours: 1, urgent: true });
    // The newest claim is the one held: 30 hours, not 40.
    expect(next.working[1]?.sinceHours).toBe(30);
  });

  it("gives a null hold time when no claim was recorded, and the claimer when nobody is assigned", () => {
    const next = wallNextUpOf(snapshot(project("meadow.example", {
      inProgress: [item("md-1", { status: "in_progress" }), item("md-2", { status: "in_progress" })],
      recentWork: [claimed("md-2", hoursAgo(5), "codex")],
    })), NOW)!;
    expect(next.working.map((row) => [row.id, row.who, row.sinceHours])).toEqual([
      ["md-2", "codex", 5],
      ["md-1", null, null],
    ]);
  });
});
