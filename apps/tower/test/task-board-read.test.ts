import { describe, expect, it } from "vitest";
import type { LiveTask, LiveTasksPayload } from "@shared/tasks";
import { emptyWorkHistory, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import type { TaskProject } from "@shared/tasks";
import { askVerb, catalogScope, inboxAsk, readTaskBoard, taskCatalogProjects, type ProjectTaskRead, type TaskBoardFilters } from "@/lib/task-board-read";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "mp-1w2",
    title: "Fix the recipe schema",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-08-01T11:55:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
    ...overrides,
  };
}

function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    asset: "meals.example",
    prefix: "mp",
    name: "Meal Planner",
    ok: true,
    error: null,
    counts: {
      open: 3,
      highPriority: 1,
      ready: 2,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
      deferred: 0,
      waiting: 0,
    },
    priorities: [1, 0, 3, 0, 0],
    epics: null,
    deferred: [],
    waiting: [],
    ready: [item(), item({ id: "mp-88x", title: "Rewrite the FAQ", priority: 0 })],
    inProgress: [
      item({ id: "mp-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" }),
    ],
    recentlyClosed: [],
    history: emptyWorkHistory(),
    ...overrides,
  };
}

function payload(overrides: Partial<WorkPayload> = {}): WorkPayload {
  return {
    generatedAt: "2026-08-01T12:00:00.000Z",
    capturedAt: "2026-08-01T11:59:00.000Z",
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects: [project()],
    historyDays: 0,
    ...overrides,
  };
}

function liveTask(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    ...item(),
    description: "",
    acceptance: "",
    labels: [],
    ready: false,
    dependencies: [],
    comments: 0,
    metadata: null,
    createdAt: null,
    startedAt: null,
    closeReason: null,
    awaitType: null,
    ...overrides,
  };
}

function board(
  tasks: LiveTask[],
  epics: LiveTasksPayload["epics"] = null,
  asset = "meals.example",
): LiveTasksPayload {
  return {
    project: asset,
    prefix: "mp",
    repo: "../meals.example",
    readAt: "2026-08-01T11:59:30.000Z",
    tasks,
    epics,
  };
}


const filters: TaskBoardFilters = { project: "all", status: "all", priority: "all", label: "", assignee: "all" };
function read(options: Partial<Parameters<typeof readTaskBoard>[0]> = {}) {
  return readTaskBoard({ snapshot: payload(), capabilities: { live: true, reason: null }, reads: new Map(), filters, ...options });
}
function success(data: LiveTasksPayload): ProjectTaskRead { return { data, isError: false, error: null }; }

describe("task board read", () => {
  it('retains live rows, filtering and read provenance when writes are unavailable', () => {
    const reads = new Map([['meals.example', success(board([liveTask()]))]]);
    const ordinary = read({ reads });
    const viewer = read({ reads, capabilities: { live: true, writable: false, reason: null } });
    expect(viewer.rows).toEqual(ordinary.rows); expect(viewer.totals).toEqual(ordinary.totals);
    expect(viewer.shownAt).toBe(ordinary.shownAt); expect(viewer.live).toBe(true);
    expect(viewer.projects[0]!.source).toBe('live'); expect(viewer.projects[0]!.actionable).toBe(false);
    expect(ordinary.projects[0]!.actionable).toBe(true);
  });
  it("moves from a saved sample to complete local rows and back when capability is removed", () => {
    const pending = read();
    expect(pending.projects[0]).toMatchObject({ source: "snapshot", actionable: false });
    expect(pending.totals.open).toBe(3);
    expect(pending.counts.closed).toBeNull();
    expect(pending.closedHistoryState).toBe("loading");
    const reads = new Map([["meals.example", success(board([liveTask({ labels: ["review"], description: "Full context" })]))]]);
    const live = read({ reads });
    expect(live.complete).toBe(true);
    expect(live.projects[0]).toMatchObject({ source: "live", actionable: true });
    expect(live.rows[0]).toMatchObject({ labels: ["review"], description: "Full context" });
    expect(live.totals.open).toBe(1);
    const revoked = read({ reads, capabilities: { live: false, reason: "read_only_deployment" } });
    expect(revoked.projects[0]).toMatchObject({ source: "snapshot", actionable: false });
    expect(revoked.totals.open).toBe(3);
    expect(revoked.closedHistoryState).toBe("sample");
    expect(revoked.rows.every(row => row.labels.length === 0)).toBe(true);
  });

  it("keeps one failing project sampled and uses the oldest displayed source for the age", () => {
    const snapshot = payload({ projects: [project(), project({ asset: "nosh.example", name: "Nosh", prefix: "nom", ready: [item({ id: "nom-saved" })], inProgress: [] })] });
    const reads = new Map<string, ProjectTaskRead>([
      ["meals.example", success(board([liveTask({ id: "mp-live" })]))],
      ["nosh.example", { data: board([liveTask({ id: "nom-cached" })], null, "nosh.example"), isError: true, error: new Error("Unavailable") }],
    ]);
    const view = read({ snapshot, reads });
    expect(view.rows.map(row => row.id)).toEqual(["mp-live", "nom-saved"]);
    expect(view.byId.get("meals.example")?.actionable).toBe(true);
    expect(view.byId.get("nosh.example")).toMatchObject({ source: "snapshot", actionable: false, laneError: "Unavailable" });
    expect(view.complete).toBe(false);
    expect(view.shownAt).toBe(snapshot.capturedAt);
    expect(view.counts.closed).toBeNull();
    reads.set("nosh.example", success(board([liveTask({ id: "nom-current" })], null, "nosh.example")));
    const recovered = read({ snapshot, reads });
    expect(recovered.complete).toBe(true);
    expect(recovered.rows.map(row => row.id)).toEqual(["mp-live", "nom-current"]);
    expect(recovered.shownAt).toBe("2026-08-01T11:59:30.000Z");
  });

  it("keeps complete reported snapshot counts distinct from its limited rows", () => {
    const snapshot = payload({ projects: [project({ counts: { ...project().counts, closedRecent: 60 }, recentlyClosed: [item({ id: "mp-closed", status: "closed" })] })] });
    const view = read({ snapshot, capabilities: { live: false, reason: null }, filters: { ...filters, status: "closed" } });
    expect(view.counts.closed).toBe(60);
    expect(view.rows).toHaveLength(1);
    expect(view.statusCounts.get("closed")).toBe(1);
    expect(view.complete).toBe(false);
    expect(view.projects[0]?.actionable).toBe(false);
  });

  it("does not turn an unavailable project into an empty actionable queue", () => {
    const view = read({ snapshot: payload({ projects: [project({ ok: false, error: "Snapshot failed" })] }), reads: new Map([["meals.example", { isError: true, error: new Error("Live failed") }]]) });
    expect(view.projects[0]).toMatchObject({ source: "unavailable", actionable: false, tasks: [], readAt: null });
    expect(view.broken).toHaveLength(1);
    expect(view.counts.closed).toBeNull();
    expect(view.totals.urgent).toBeNull();
    expect(view.countsComplete).toBe(false);
    expect(view.counts).toEqual({ waiting: null, urgent: null, open: null, inProgress: null, blocked: null, closed: null });
    expect(view.shownAt).toBeNull();
  });

  it("rejects a local payload for another project instead of granting its actions", () => {
    const view = read({ reads: new Map([["meals.example", success(board([liveTask({ id: "nom-wrong" })], null, "nosh.example"))]]) });
    expect(view.projects[0]).toMatchObject({ source: "snapshot", actionable: false });
    expect(view.broken[0]?.laneError).toContain("different project");
    expect(view.rows.some(row => row.id === "nom-wrong")).toBe(false);
  });

  it("keeps scoped reads, filters, full counts, readiness and human gates together", () => {
    const tasks = [liveTask({ id: "mp-ask", ready: true, labels: ["human"], priority: 0 }), liveTask({ id: "mp-gate", issueType: "gate", awaitType: "human" }), liveTask({ id: "mp-timer", issueType: "gate", awaitType: "timer" }), liveTask({ id: "mp-epic", issueType: "epic" }), liveTask({ id: "mp-working", status: "in_progress", assignee: "agent" })];
    const view = read({ scope: "meals.example", snapshot: payload({ projects: [project(), project({ asset: "nosh.example" })] }), reads: new Map([["meals.example", success(board(tasks))]]), filters: { ...filters, project: "nosh.example", label: "human" } });
    expect(view.spokes).toHaveLength(1);
    // The ask matches, and it is listed once: in the inbox, not again in the
    // table below it (bead ro-ujb9.96.7.11).
    expect(view.rows.map(row => row.id)).toEqual([]);
    expect(view.allTasks).toHaveLength(3);
    expect(view.totals.waiting).toBe(2);
    expect(view.inbox.map(row => row.task.id)).toEqual(["mp-ask"]);
    expect(view.statusCounts.get("in-progress")).toBe(1);
    expect(view.assigneeCounts.get("agent")).toBe(1);
  });
});

// The one rule the board's Waiting on you and a task's own page both read
// (bead ro-ujb9.243): what the operator's inbox asks of a task.
describe("what the inbox asks of a task", () => {
  it("approves a human gate, answers a ready human ask, and asks nothing of anything else", () => {
    expect(inboxAsk(liveTask({ issueType: "gate", awaitType: "human" }))).toBe("approve");
    expect(inboxAsk(liveTask({ labels: ["human"], ready: true }))).toBe("answer");
    // A gate that resolves itself, an ask still blocked, plain work, finished
    // or parked work: none of them waits on the operator.
    expect(inboxAsk(liveTask({ issueType: "gate", awaitType: "timer" }))).toBeNull();
    expect(inboxAsk(liveTask({ labels: ["human"], ready: false }))).toBeNull();
    expect(inboxAsk(liveTask({ ready: true }))).toBeNull();
    expect(inboxAsk(liveTask({ issueType: "gate", awaitType: "human", status: "closed" }))).toBeNull();
    expect(inboxAsk(liveTask({ labels: ["human"], ready: true, status: "deferred" }))).toBeNull();
    // A photographed row in the waiting list carries no labels: its verb is
    // read from what it is.
    expect(askVerb(item({ issueType: "gate" }))).toBe("approve");
    expect(askVerb(item())).toBe("answer");
  });
});

describe("a hosted catalog joined to the snapshot by prefix", () => {
  // The catalog keys a project by logical key (`lb`); the snapshot keys the
  // same project by site id. An asset's Tasks tab scopes by the site id.
  const catalog: TaskProject[] = [
    { projectId: "56c5558d-5eab-4817-8059-153c1774ca5b", logicalKey: "lb", displayName: "Light Brief", prefix: "lb" },
  ];
  const snapshot = payload({
    projects: [project({ asset: "lightbrief.example", prefix: "lb", name: "Light Brief", counts: { ...project().counts, open: 3 } })],
  });
  const filters: TaskBoardFilters = { project: "all", status: "all", priority: "all", label: "", assignee: "all" };

  it("keeps the logical key as the read address and takes the snapshot's counts", () => {
    const roster = taskCatalogProjects(catalog, snapshot);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.asset).toBe("lb");
    expect(roster[0]?.ok).toBe(true);
    expect(roster[0]?.counts.open).toBe(3);
  });

  it("resolves a site id to the catalog key and leaves other scopes alone", () => {
    expect(catalogScope(catalog, snapshot, "lightbrief.example")).toBe("lb");
    expect(catalogScope(catalog, snapshot, "lb")).toBe("lb");
    expect(catalogScope(catalog, snapshot, null)).toBeNull();
    expect(catalogScope(catalog, undefined, "lightbrief.example")).toBe("lightbrief.example");
  });

  it("a site-scoped board shows the project rather than an empty state", () => {
    const roster = taskCatalogProjects(catalog, snapshot);
    const scope = catalogScope(catalog, snapshot, "lightbrief.example");
    const board = readTaskBoard({ capabilities: { live: true, reason: null }, snapshot, scope, reads: new Map(), roster, filters });
    expect(board.spokes).toHaveLength(1);
    expect(board.spokes[0]?.asset).toBe("lb");
  });
});
