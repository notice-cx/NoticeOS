// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LiveTask, LiveTasksPayload } from "@shared/tasks";
import { emptyWorkHistory, type WorkItem, type WorkPayload, type WorkProject, type WorkWeeks } from "@shared/work";
import { liveRows, readTaskBoard, type ProjectTaskRead, type TaskBoardFilters } from "@/lib/task-board-read";
import { boardInOut, boardWorkRows, epicDrawsGraph, epicGraphs, epicTaskGroups, inOutDrawn, netFlow, queueItem, stripTotals, weekLine } from "@/lib/task-board-viz";

// The board's reads as the kit's shapes. Built through `readTaskBoard`, so the
// projects these functions see are the ones the board itself renders.

const NOW = Date.parse("2026-08-10T15:00:00.000Z");
const READ_AT = "2026-08-10T14:59:30.000Z";
const CLOSED_SINCE = "2026-08-03";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "md-1", title: "Fix the recipe schema", status: "open", priority: 2, issueType: "task", assignee: null,
    updatedAt: "2026-08-09T12:00:00.000Z", closedAt: null, parent: null, deferUntil: null, ...overrides,
  };
}

function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    asset: "meadow.example", prefix: "md", name: "Meadow Board", ok: true, error: null,
    counts: { open: 5, highPriority: 1, ready: 3, inProgress: 2, blocked: 2, closedRecent: 4, deferred: 0, waiting: 0 },
    priorities: null, epics: null, deferred: [], waiting: [], ready: [item()], inProgress: [], recentlyClosed: [],
    history: emptyWorkHistory(), ...overrides,
  };
}

function payload(projects: WorkProject[]): WorkPayload {
  return { generatedAt: READ_AT, capturedAt: READ_AT, pollCadenceHours: 1 / 60, owner: "config/beads.json", projects, historyDays: 0 };
}

function live(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    ...item(), description: "", acceptance: "", labels: [], ready: true, dependencies: [], comments: 0, metadata: null,
    createdAt: "2026-06-01T10:00:00.000Z", startedAt: null, closeReason: null, awaitType: null, ...overrides,
  };
}

const blocks = (...ids: string[]) => ids.map((id) => ({ id, type: "blocks", title: null, status: null }));

function board(tasks: LiveTask[], asset = "meadow.example", epics: LiveTasksPayload["epics"] = null): LiveTasksPayload {
  return { project: asset, prefix: asset === "meadow.example" ? "md" : "nw", repo: `../${asset}`, readAt: READ_AT, closedSince: CLOSED_SINCE, tasks, epics };
}

const filters: TaskBoardFilters = { project: "all", status: "all", priority: "all", label: "", assignee: "all" };
const ok = (data: LiveTasksPayload): ProjectTaskRead => ({ data, isError: false, error: null });

function read(snapshot: WorkPayload, reads: Record<string, ProjectTaskRead> = {}, liveCapability = true) {
  return readTaskBoard({ snapshot, capabilities: { live: liveCapability, reason: null }, reads: new Map(Object.entries(reads)), filters });
}

describe("work by project", () => {
  it("splits each project's open work the way the answer's figures count it, from either read", () => {
    const snapshot = payload([project(), project({ asset: "northwind.example", prefix: "nw", name: "Northwind" })]);
    const board_ = read(snapshot, {
      "meadow.example": ok(board([live({ id: "md-1" }), live({ id: "md-2", status: "blocked" }), live({ id: "md-3", status: "in_progress" })])),
    });
    const [meadow, northwind] = boardWorkRows(board_.projects, (row) => `/tasks?project=${row.asset}`);
    // Both sources use inclusive open counts and disjoint chart segments.
    expect(meadow).toMatchObject({ id: "meadow.example", ready: 1, blocked: 1, inProgress: 1, done: 0, to: "/tasks?project=meadow.example" });
    expect(northwind).toMatchObject({ ready: 3, blocked: 2, inProgress: 2, done: 4, urgent: 1 });
  });

  it("draws equal disjoint segments from equivalent live work and authoritative saved counts", () => {
    const tasks = [live({ id: "md-open" }), live({ id: "md-held", ready: false, dependencies: blocks("md-gate") }),
      live({ id: "md-stored", status: "blocked" }), live({ id: "md-working", status: "in_progress", dependencies: blocks("md-gate") }),
      live({ id: "md-done", status: "closed" }), live({ id: "md-gate", issueType: "gate", awaitType: "human", priority: 0 }),
      live({ id: "md-approved", issueType: "gate", awaitType: "human", status: "closed" })];
    const snapshot = payload([project({ counts: { ...project().counts, open: 3, blocked: 2, inProgress: 1, closedRecent: 1, highPriority: 0 } })]);
    const liveBoard = read(snapshot, { "meadow.example": ok(board(tasks)) });
    const savedBoard = read(snapshot, {}, false);
    const [row] = boardWorkRows(liveBoard.projects);
    expect(boardWorkRows(liveBoard.projects)).toEqual(boardWorkRows(savedBoard.projects));
    expect(row).toMatchObject({ ready: 1, blocked: 2, inProgress: 1, done: 1, urgent: 0, doneLastWeek: null });
    expect(row!.ready + row!.blocked + row!.inProgress).toBe(liveBoard.totals.live);
    expect(row!.ready).toBe(liveBoard.statusCounts.get("open"));
    expect(row!.blocked).toBe(liveBoard.statusCounts.get("blocked"));
  });

  it("leaves out a project neither read reached rather than drawing it empty", () => {
    const board_ = read(payload([project(), project({ asset: "northwind.example", prefix: "nw", ok: false, error: "no repo" })]), {}, false);
    expect(boardWorkRows(board_.projects).map((row) => row.id)).toEqual(["meadow.example"]);
  });

  it("takes each project's done from its calendar week, with last week's beside it, as the Wall does", () => {
    const board_ = read(payload([project(), project({ asset: "northwind.example", prefix: "nw", name: "Northwind" })]), {}, false);
    const done = { now: 3, notDone: 0, before: 2, lastWeek: 8, move: null };
    const [meadow, northwind] = boardWorkRows(board_.projects, undefined, new Map([["meadow.example", { done } as unknown as WorkWeeks]]));
    expect(meadow).toMatchObject({ done: 3, doneLastWeek: 8 });
    // Without a week reading: the read's closes, and no outline.
    expect(northwind).toMatchObject({ done: 4, doneLastWeek: null });
  });
});

describe("the week's closes in words", () => {
  const week = (by: number | null) => ({ now: 5, notDone: 0, before: 5 - (by ?? 0), lastWeek: 9,
    move: by === null ? null : { by, direction: by > 0 ? "up" as const : by < 0 ? "down" as const : "flat" as const, verdict: "neutral" as const } });

  it("says more, fewer or as many against last week by today, and nothing without a comparison", () => {
    expect(weekLine(week(3))).toBe("3 more done this week than last week by today");
    expect(weekLine(week(-1))).toBe("1 fewer done this week than last week by today");
    expect(weekLine(week(0))).toBe("As many done this week as last week by today");
    expect(weekLine(week(null))).toBeNull();
    expect(weekLine(null)).toBeNull();
  });
});

describe("in and out", () => {
  const closedOn = (id: string, at: string, createdAt = "2026-06-01T10:00:00.000Z") => live({ id, status: "closed", closedAt: at, createdAt });

  it("counts closings and filings inside the live window and leaves earlier filings unmeasured", () => {
    const history = { ...emptyWorkHistory(), closed: [{ t: "2026-07-30", v: 3 }, { t: "2026-08-03", v: 9 }, { t: "2026-08-04", v: 99 }] };
    const board_ = read(payload([project({ history })]), {
      "meadow.example": ok(board([
        closedOn("md-a", "2026-08-04T09:00:00.000Z", "2026-08-04T08:00:00.000Z"),
        closedOn("md-b", "2026-08-09T09:00:00.000Z"),
        live({ id: "md-c", createdAt: "2026-08-09T10:00:00.000Z" }),
        live({ id: "md-d", createdAt: "2026-08-03T10:00:00.000Z" }),
        // An approval is an ask, not work: in neither series.
        live({ id: "md-g", issueType: "gate", awaitType: "human", status: "closed", closedAt: "2026-08-09T11:00:00.000Z", createdAt: "2026-08-09T09:00:00.000Z" }),
      ])),
    });
    const flow = boardInOut(board_.projects, board_.spokes, NOW);
    const day = (points: { t: string; v: number | null }[] | null, t: string) => points?.find((point) => point.t === t)?.v;
    expect(flow.closed).toHaveLength(14);
    expect(flow.today).toBe("2026-08-10");
    // Inside the window the live read counts, history or not.
    expect(day(flow.closed, "2026-08-04")).toBe(1);
    expect(day(flow.closed, "2026-08-09")).toBe(1);
    expect(day(flow.closed, "2026-08-08")).toBe(0);
    // The boundary day and before come from the daily history; a day it
    // does not hold is unmeasured, never zero.
    expect(day(flow.closed, "2026-08-03")).toBe(9);
    expect(day(flow.closed, "2026-07-30")).toBe(3);
    expect(day(flow.closed, "2026-07-31")).toBeNull();
    expect(day(flow.filed, "2026-08-04")).toBe(1);
    expect(day(flow.filed, "2026-08-09")).toBe(1);
    expect(day(flow.filed, "2026-08-03")).toBeNull();
    expect(inOutDrawn(flow)).toBe(true);
    expect(netFlow(flow)).toEqual({ closed: 2, filed: 2, days: 7 });
  });

  it("counts no filings from a partial live read, and sums history only over days every project measured", () => {
    const meadow = project({ history: { ...emptyWorkHistory(), closed: [{ t: "2026-08-08", v: 2 }, { t: "2026-08-09", v: 1 }] } });
    const northwind = project({ asset: "northwind.example", prefix: "nw", name: "Northwind", history: { ...emptyWorkHistory(), closed: [{ t: "2026-08-09", v: 4 }] } });
    const board_ = read(payload([meadow, northwind]), {
      "meadow.example": ok(board([closedOn("md-a", "2026-08-08T09:00:00.000Z")])),
      "northwind.example": { isError: true, error: new Error("unreadable"), data: undefined },
    });
    const flow = boardInOut(board_.projects, board_.spokes, NOW);
    expect(flow.filed).toBeNull();
    expect(flow.closed.find((point) => point.t === "2026-08-09")?.v).toBe(5);
    expect(flow.closed.find((point) => point.t === "2026-08-08")?.v).toBeNull();
    expect(netFlow(flow)).toBeNull();
  });

  it("draws nothing when no day was measured", () => {
    const board_ = read(payload([project()]), {}, false);
    expect(inOutDrawn(boardInOut(board_.projects, board_.spokes, NOW))).toBe(false);
  });

  it("averages only settled days, and only once there are three", () => {
    const points = [{ t: "2026-08-07", v: 2 }, { t: "2026-08-08", v: null }, { t: "2026-08-09", v: 4 }, { t: "2026-08-10", v: 9 }];
    expect(stripTotals(points, "2026-08-10")).toEqual({ total: 15, days: 3, average: null });
    expect(stripTotals([{ t: "2026-08-06", v: 3 }, ...points], "2026-08-10").average).toBe(3);
  });
});

describe("one epic's dependencies", () => {
  const epic = [{ id: "md-e", title: "Recipe overhaul", status: "open", priority: 1, total: 6, closed: 1, eligibleForClose: false }];
  const tasks = [
    live({ id: "md-e", issueType: "epic", title: "Recipe overhaul" }),
    live({ id: "md-e.1", title: "Draft", parent: "md-e", status: "closed", closedAt: "2026-08-08T10:00:00.000Z" }),
    live({ id: "md-e.2", title: "Build", parent: "md-e", status: "in_progress", assignee: "agent-x", dependencies: blocks("md-e.1") }),
    live({ id: "md-e.3", title: "Load test", parent: "md-e", status: "blocked", updatedAt: "2026-08-05T10:00:00.000Z" }),
    live({ id: "md-e.4", title: "Launch", parent: "md-e", ready: false, dependencies: [...blocks("md-e.2", "md-e.3", "md-g"), { id: "md-x", type: "related", title: null, status: null }] }),
    live({ id: "md-e.5", title: "Write the email", parent: "md-e" }),
    live({ id: "md-g", title: "Approve the launch", issueType: "gate", awaitType: "human", ready: false }),
    live({ id: "md-x", title: "Unrelated" }),
  ];
  const snapshot = payload([project({
    epics: [{ id: "md-e", title: "Recipe overhaul", status: "open", priority: 1, total: 9, closed: 3, counts: { open: 3, inProgress: 1, blocked: 1, deferred: 0 }, priorities: [0, 1, 3, 0, 0] }],
  })]);
  const graphsOf = (snap: WorkPayload, reads: Record<string, ProjectTaskRead>, capability = true) => {
    const board_ = read(snap, reads, capability);
    return epicGraphs({ projects: board_.projects, snapshots: snap.projects, nowMs: NOW, href: (task) => `/tasks/${task.id}` });
  };

  it("draws the unfinished children, what holds them and what released them, each in its state", () => {
    const [graph] = graphsOf(snapshot, { "meadow.example": ok(board(tasks, "meadow.example", epic)) });
    expect(graph).toBeDefined();
    expect(graph!.title).toBe("Recipe overhaul");
    expect(graph!.progress).toEqual({ closed: 3, total: 9 });
    const node = (id: string) => graph!.nodes.find((candidate) => candidate.id === id);
    expect(graph!.nodes.map((candidate) => candidate.id).sort()).toEqual(["md-e.1", "md-e.2", "md-e.3", "md-e.4", "md-e.5", "md-g"]);
    expect(node("md-e.1")).toMatchObject({ state: "ok", stateLabel: "Done", caption: "closed 2d ago", href: "/tasks/md-e.1" });
    expect(node("md-e.2")).toMatchObject({ state: "active", stateLabel: "In progress", caption: "agent-x" });
    expect(node("md-e.3")).toMatchObject({ state: "warn", stateLabel: "Blocked", since: "2026-08-05T10:00:00.000Z" });
    expect(node("md-e.4")).toMatchObject({ state: "idle", stateLabel: "Waiting", caption: "waits on 3" });
    expect(node("md-e.5")).toMatchObject({ state: "idle", stateLabel: "Ready" });
    // The approval sits beside the step it holds, not at the start.
    expect(node("md-g")).toMatchObject({ state: "warn", stateLabel: "Needs attention", caption: "your approval", column: 1 });
    // `related` is not a dependency the queue waits on.
    expect(graph!.edges).toEqual(expect.arrayContaining([
      { from: "md-e.1", to: "md-e.2", state: "idle" },
      { from: "md-e.2", to: "md-e.4", state: "flowing" },
      { from: "md-e.3", to: "md-e.4", state: "broken" },
      { from: "md-g", to: "md-e.4", state: "idle", label: "needs attention" },
    ]));
    expect(graph!.edges).toHaveLength(4);
    expect(graph).toMatchObject({ stuck: 1, asks: 1, hidden: 0 });
  });

  it("names a task waiting on a pick between its options as waiting on your choice", () => {
    const choices = { question: "Which subject line?", options: [{ key: "a", label: "Short", recommended: true }, { key: "b", label: "Long" }] } as const;
    const withChoice = tasks.map((task) => (task.id === "md-e.5" ? live({ id: "md-e.5", title: "Write the email", parent: "md-e", labels: ["human"], ready: true, choices }) : task));
    const [graph] = graphsOf(snapshot, { "meadow.example": ok(board(withChoice, "meadow.example", epic)) });
    expect(graph!.nodes.find((node) => node.id === "md-e.5")).toMatchObject({ state: "warn", stateLabel: "Needs attention", caption: "your choice" });
  });

  it("draws no graph from the saved snapshot, which carries no edges, nor for an epic without one", () => {
    expect(graphsOf(snapshot, {}, false)).toEqual([]);
    const flat = tasks.map((task) => ({ ...task, dependencies: [] }));
    expect(graphsOf(snapshot, { "meadow.example": ok(board(flat, "meadow.example", epic)) })).toEqual([]);
  });

  it("groups an epic's tasks by the graph's own state words, and says whether the board draws its graph", () => {
    const rows = liveRows(board(tasks, "meadow.example", epic), { containers: true });
    const groups = epicTaskGroups(rows.filter((row) => row.parent === "md-e"), rows);
    expect(groups.map((group) => [group.word, group.tasks.map((task) => task.id)])).toEqual([
      ["In progress", ["md-e.2"]],
      ["Ready", ["md-e.5"]],
      ["Waiting", ["md-e.4"]],
      ["Blocked", ["md-e.3"]],
      ["Done", ["md-e.1"]],
    ]);
    expect(epicDrawsGraph(liveRows(board(tasks)), "md-e")).toBe(true);
    expect(epicDrawsGraph(liveRows(board(tasks.map((task) => ({ ...task, dependencies: [] })))), "md-e")).toBe(false);
  });

  it("leads with the epic most stuck", () => {
    const other = [
      live({ id: "md-f", issueType: "epic", title: "Smaller" }),
      live({ id: "md-f.1", title: "One", parent: "md-f" }),
      live({ id: "md-f.2", title: "Two", parent: "md-f", dependencies: blocks("md-f.1") }),
    ];
    const both = [...other, ...tasks];
    const epics = [...epic, { id: "md-f", title: "Smaller", status: "open", priority: 2, total: 2, closed: 0, eligibleForClose: false }];
    expect(graphsOf(snapshot, { "meadow.example": ok(board(both, "meadow.example", epics)) }).map((graph) => graph.id)).toEqual(["md-e", "md-f"]);
  });
});

it("ages a queue item by its last touch, and says which kind of ask it is", () => {
  const board_ = read(payload([project()]), {
    "meadow.example": ok(board([live({ id: "md-g", issueType: "gate", awaitType: "human", updatedAt: "2026-08-07T15:00:00.000Z" })])),
  });
  expect(queueItem(board_.inbox[0]!, NOW)).toMatchObject({ id: "md-g", project: "Meadow Board", kind: "approval", ageDays: 3 });
});
