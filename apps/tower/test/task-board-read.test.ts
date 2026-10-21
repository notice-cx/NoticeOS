// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LiveTask, LiveTasksPayload } from "@shared/tasks";
import { emptyWorkHistory, sumWorkWeeks, workWeeks, type WorkCloses, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import type { TaskProject } from "@shared/tasks";
import { askVerb, catalogScope, inboxAsk, readTaskBoard, taskCatalogProjects, type ProjectTaskRead, type TaskBoardFilters } from "@/lib/task-board-read";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "md-1w2",
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
    asset: "meadow.example",
    prefix: "md",
    name: "Meadow Board",
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
    ready: [item(), item({ id: "md-88x", title: "Rewrite the FAQ", priority: 0 })],
    inProgress: [
      item({ id: "md-33j", title: "Ship the sitemap fix", status: "in_progress", assignee: "agent-x" }),
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
  asset = "meadow.example",
): LiveTasksPayload {
  return {
    project: asset,
    prefix: "md",
    repo: "../meadow.example",
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
    const reads = new Map([['meadow.example', success(board([liveTask()]))]]);
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
    const reads = new Map([["meadow.example", success(board([liveTask({ labels: ["review"], description: "Full context" })]))]]);
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
    const snapshot = payload({ projects: [project(), project({ asset: "northwind.example", name: "Northwind", prefix: "nw", ready: [item({ id: "nw-saved" })], inProgress: [] })] });
    const reads = new Map<string, ProjectTaskRead>([
      ["meadow.example", success(board([liveTask({ id: "md-live" })]))],
      ["northwind.example", { data: undefined, isError: true, error: new Error("Unavailable") }],
    ]);
    const view = read({ snapshot, reads });
    expect(view.rows.map(row => row.id)).toEqual(["md-live", "nw-saved"]);
    expect(view.byId.get("meadow.example")?.actionable).toBe(true);
    expect(view.byId.get("northwind.example")).toMatchObject({ source: "snapshot", actionable: false, laneError: "Unavailable" });
    expect(view.complete).toBe(false);
    expect(view.shownAt).toBe(snapshot.capturedAt);
    expect(view.counts.closed).toBeNull();
    reads.set("northwind.example", success(board([liveTask({ id: "nw-current" })], null, "northwind.example")));
    const recovered = read({ snapshot, reads });
    expect(recovered.complete).toBe(true);
    expect(recovered.rows.map(row => row.id)).toEqual(["md-live", "nw-current"]);
    expect(recovered.shownAt).toBe("2026-08-01T11:59:30.000Z");
  });

  it("keeps a project's last read on screen, without actions, when a later refresh fails", () => {
    const snapshot = payload({ projects: [project(), project({ asset: "northwind.example", name: "Northwind", prefix: "nw", ready: [item({ id: "nw-saved" })], inProgress: [] })] });
    const reads = new Map<string, ProjectTaskRead>([
      ["meadow.example", success(board([liveTask({ id: "md-live" })]))],
      ["northwind.example", { data: board([liveTask({ id: "nw-cached" })], null, "northwind.example"), isError: true, error: new Error("Unavailable") }],
    ]);
    const view = read({ snapshot, reads });
    expect(view.rows.map(row => row.id)).toEqual(["md-live", "nw-cached"]);
    expect(view.byId.get("meadow.example")?.actionable).toBe(true);
    expect(view.byId.get("northwind.example")).toMatchObject({ source: "live", actionable: false, laneError: "Unavailable" });
    expect(view.broken.map(project => project.asset)).toEqual(["northwind.example"]);
    expect(view.shownAt).toBe("2026-08-01T11:59:30.000Z");
  });

  it("keeps complete reported snapshot counts distinct from its limited rows", () => {
    const snapshot = payload({ projects: [project({ counts: { ...project().counts, closedRecent: 60 }, recentlyClosed: [item({ id: "md-closed", status: "closed" })] })] });
    const view = read({ snapshot, capabilities: { live: false, reason: null }, filters: { ...filters, status: "closed" } });
    expect(view.counts.closed).toBe(60);
    expect(view.rows).toHaveLength(1);
    expect(view.statusCounts.get("closed")).toBe(1);
    expect(view.complete).toBe(false);
    expect(view.projects[0]?.actionable).toBe(false);
  });

  it("does not turn an unavailable project into an empty actionable queue", () => {
    const view = read({ snapshot: payload({ projects: [project({ ok: false, error: "Snapshot failed" })] }), reads: new Map([["meadow.example", { isError: true, error: new Error("Live failed") }]]) });
    expect(view.projects[0]).toMatchObject({ source: "unavailable", actionable: false, tasks: [], readAt: null });
    expect(view.broken).toHaveLength(1);
    expect(view.counts.closed).toBeNull();
    expect(view.totals.urgent).toBeNull();
    expect(view.countsComplete).toBe(false);
    expect(view.counts).toEqual({ waiting: null, urgent: null, open: null, inProgress: null, blocked: null, closed: null });
    expect(view.shownAt).toBeNull();
  });

  it("rejects a local payload for another project instead of granting its actions", () => {
    const view = read({ reads: new Map([["meadow.example", success(board([liveTask({ id: "nw-wrong" })], null, "northwind.example"))]]) });
    expect(view.projects[0]).toMatchObject({ source: "snapshot", actionable: false });
    expect(view.broken[0]?.laneError).toContain("different project");
    expect(view.rows.some(row => row.id === "nw-wrong")).toBe(false);
  });

  it("keeps scoped reads, filters, full counts, readiness and human gates together", () => {
    const tasks = [liveTask({ id: "md-ask", ready: true, labels: ["human"], priority: 0 }), liveTask({ id: "md-gate", issueType: "gate", awaitType: "human" }), liveTask({ id: "md-timer", issueType: "gate", awaitType: "timer" }), liveTask({ id: "md-epic", issueType: "epic" }), liveTask({ id: "md-working", status: "in_progress", assignee: "agent" })];
    const view = read({ scope: "meadow.example", snapshot: payload({ projects: [project(), project({ asset: "northwind.example" })] }), reads: new Map([["meadow.example", success(board(tasks))]]), filters: { ...filters, project: "northwind.example", label: "human" } });
    expect(view.spokes).toHaveLength(1);
    // The ask is listed once: in the inbox, not again in the table below it.
    expect(view.rows.map(row => row.id)).toEqual([]);
    expect(view.allTasks).toHaveLength(3);
    expect(view.totals.waiting).toBe(2);
    expect(view.inbox.map(row => row.task.id)).toEqual(["md-ask"]);
    expect(view.statusCounts.get("in-progress")).toBe(1);
    expect(view.assigneeCounts.get("agent")).toBe(1);
  });
});

// The one rule the board's Your decisions and a task's own page both read:
// what the operator's inbox asks of a task.
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

  it("keeps answered questions and epic containers out of the inbox even with stale human labels", () => {
    const choice = { option: "a" as const, label: "Build it", by: "Owner", at: "2026-10-17T12:00:00Z" };
    expect(inboxAsk(liveTask({ labels: ["human"], ready: true, choice }))).toBeNull();
    expect(inboxAsk(liveTask({ issueType: "epic", labels: ["human"], ready: true }))).toBeNull();
  });

  it("shows one approval for gated work while keeping the parent accessible in All tasks", () => {
    const tasks = [
      liveTask({ id: "md-parent", labels: ["human"], ready: true, dependencies: [{ id: "md-gate", type: "blocks", title: "Approve read", status: "open" }] }),
      liveTask({ id: "md-gate", issueType: "gate", awaitType: "human", title: "Approve one read" }),
    ];
    const view = read({ reads: new Map([["meadow.example", success(board(tasks))]]) });
    expect(view.projects[0]!.waiting.map(task => task.id)).toEqual(["md-gate"]);
    expect(view.rows.map(task => task.id)).toContain("md-parent");
    expect(view.totals.waiting).toBe(1);
  });

  it("ranks decisions by the work they release without promising work with another blocker", () => {
    const tasks = [
      liveTask({ id: "md-urgent", labels: ["human"], ready: true, priority: 0 }),
      liveTask({ id: "md-choice", issueType: "decision", labels: ["human"], ready: true, priority: 3 }),
      liveTask({ id: "md-build", title: "Build the approved sender", priority: 1,
        dependencies: [
          { id: "md-choice", type: "waits-for", title: "Choose sender", status: null },
          { id: "md-finished", type: "blocks", title: null, status: null },
        ] }),
      liveTask({ id: "md-finished", status: "closed" }),
      liveTask({ id: "md-still-blocked", priority: 0, dependencies: [
        { id: "md-choice", type: "blocks", title: "Choose sender", status: "open" },
        { id: "md-other", type: "conditional-blocks", title: "Another decision", status: "open" },
      ] }),
      liveTask({ id: "md-approval", issueType: "gate", awaitType: "human", priority: 2 }),
    ];
    const view = read({ reads: new Map([["meadow.example", success(board(tasks))]]) });
    expect(view.inbox.map(row => row.task.id)).toEqual(["md-urgent", "md-choice", "md-approval"]);
    expect(view.inbox[1]!.task.decisionImpact).toEqual({ priority: 1,
      proceeds: [{ id: "md-build", title: "Build the approved sender" }] });
  });

  it("ranks an approval by its dependent work and keeps a separate parent choice unresolved", () => {
    const tasks = [
      liveTask({ id: "md-approval", issueType: "gate", awaitType: "human", priority: 0 }),
      liveTask({ id: "md-later", priority: 3, dependencies: [{ id: "md-approval", type: "blocks", title: null, status: null }] }),
      liveTask({ id: "md-choice", labels: ["human"], ready: true, priority: 1 }),
    ];
    const view = read({ reads: new Map([["meadow.example", success(board(tasks))]]) });
    expect(view.inbox.map(row => row.task.id)).toEqual(["md-choice", "md-approval"]);
    expect(view.inbox[1]!.task.decisionImpact?.priority).toBe(3);
  });

  it("asks for a choice while a ready human ask carries options nobody has picked, and for nothing once one is", () => {
    const choices = { question: "Which?", options: [{ key: "a", label: "One", recommended: true }, { key: "b", label: "Two" }] } as const;
    const choice = { option: "a", label: "One", by: "Dana", at: "2026-09-04T11:00:00.000Z" } as const;
    expect(inboxAsk(liveTask({ labels: ["human"], ready: true, choices }))).toBe("choose");
    expect(askVerb(item({ choices, choice: null }))).toBe("choose");
    // A pick takes the human label off, so the ask is gone; a row still
    // listed as waiting with its pick recorded is answered, never picked twice.
    expect(inboxAsk(liveTask({ labels: [], ready: true, choices, choice }))).toBeNull();
    expect(askVerb(item({ choices, choice }))).toBe("answer");
    expect(askVerb(item({ issueType: "gate", choices }))).toBe("approve");
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

  it("excludes archived prefixes from live catalogs even when their logical key differs", () => {
    const archived = { ...snapshot, projects: [], archivedProjects: [{ asset: "lightbrief.example", prefix: "lb" }] };
    expect(taskCatalogProjects(catalog, archived)).toEqual([]);
    const unknown = { projectId: "other", logicalKey: "unknown", displayName: "Unknown", prefix: "uk" };
    expect(taskCatalogProjects([...catalog, unknown], archived).map(row => row.asset)).toEqual(["unknown"]);
    expect(taskCatalogProjects(catalog, snapshot).map(row => row.asset)).toEqual(["lb"]);
  });

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

describe("the board's week against the week before", () => {
  const NOW = new Date("2026-08-01T12:00:00.000Z");
  // 2026-07-19 .. 2026-08-01 is 14 days: Sunday 07-19, then Monday 07-20 .. Saturday 08-01.
  const days = (values: readonly number[]) => values.map((v, i) => ({ t: new Date(Date.parse("2026-07-19T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10), v }));
  const history = (closed: number) => ({
    ...emptyWorkHistory(),
    closed: days(Array.from({ length: 14 }, () => closed)),
    blocked: days(Array.from({ length: 14 }, (_, i) => (i === 13 ? 4 : i >= 6 ? 2 : 0))),
  });
  /** `perDay` done closes at 10:00 on each of the 14 days, read from 07-17. */
  const closesOf = (perDay: number, extra: WorkCloses["items"] = []): WorkCloses => ({
    since: "2026-07-17",
    items: [...days(Array.from({ length: 14 }, () => perDay)).flatMap((day) => Array.from({ length: day.v }, () => ({ at: `${day.t}T10:00:00.000Z` }))), ...extra],
  });
  const weekly = (asset: string, prefix: string, closed: number, closes: WorkCloses | null = closesOf(closed)) => {
    const series = history(closed);
    return project({ asset, prefix, name: asset, history: series, weeks: workWeeks(series, closes ?? undefined, NOW, "UTC") });
  };
  const snapshot = payload({ projects: [weekly("meadow.example", "md", 1), weekly("northwind.example", "nw", 2)] });

  it("reads the projects' weeks through the one derivation the work payload serves, live read or not", () => {
    const sampled = readTaskBoard({ capabilities: { live: false, reason: "read_only_deployment" }, snapshot, reads: new Map(), filters });
    expect(sampled.weeks).toEqual(sumWorkWeeks(snapshot.projects.map((row) => row.weeks)));
    // Monday 07-27 to Saturday 08-01 is six days at 1 + 2 a day.
    expect(sampled.weeks?.done).toMatchObject({ now: 18, before: 18, lastWeek: 21, move: { by: 0, verdict: "neutral" } });
    expect(sampled.weeks?.blocked).toMatchObject({ now: 8, before: 4, move: { by: 4, verdict: "bad" } });
    const live = readTaskBoard({ capabilities: { live: true, reason: null }, snapshot, filters, reads: new Map([
      ["meadow.example", success(board([liveTask()]))],
      ["northwind.example", success({ ...board([liveTask({ id: "nw-1" })], null, "northwind.example"), prefix: "nw" })],
    ]) });
    expect(live.weeks).toEqual(sampled.weeks);
  });

  it("gives a site's Tasks tab its own project's week", () => {
    const scoped = readTaskBoard({ capabilities: { live: false, reason: "read_only_deployment" }, snapshot, scope: "northwind.example", reads: new Map(), filters });
    expect(scoped.weeks).toEqual(snapshot.projects[1]!.weeks);
  });

  it("includes non-shipping resolutions in both weeks' completed counts", () => {
    const split = payload({ projects: [weekly("meadow.example", "md", 1, closesOf(1, [
      { at: "2026-07-29T10:00:00.000Z", resolution: "wont-do" },
      // Sunday, last week: included in last week's done.
      { at: "2026-07-26T10:00:00.000Z", resolution: "duplicate" },
    ]))] });
    const view = readTaskBoard({ capabilities: { live: false, reason: "read_only_deployment" }, snapshot: split, reads: new Map(), filters });
    expect(view.weeks?.done).toMatchObject({ now: 7, notDone: 1, lastWeek: 8 });
  });

  it("keeps done from the projects with a reading as a lower bound when one project has none", () => {
    const missing = payload({ projects: [weekly("meadow.example", "md", 1), weekly("northwind.example", "nw", 2, null)] });
    const view = readTaskBoard({ capabilities: { live: false, reason: "read_only_deployment" }, snapshot: missing, reads: new Map(), filters });
    expect(view.weeks?.done.now).toBeNull();
    expect(view.doneRead).toBe(6);
  });
});

describe("the snapshot's links between tasks", () => {
  const sampled = { capabilities: { live: false, reason: "read_only_deployment" as const }, reads: new Map(), filters };
  const gate = item({ id: "md-gate", title: "Approve the price change", issueType: "gate", dependencies: [] });
  const blocked = [
    item({ id: "md-a", title: "Raise the price", dependencies: [{ id: "md-gate", type: "blocks", status: "open" }] }),
    item({ id: "md-b", title: "Announce the price", priority: 1, dependencies: [{ id: "md-gate", type: "waits-for" }, { id: "md-gone", type: "blocks", status: "closed" }] }),
    // Something else the snapshot does not list still holds it.
    item({ id: "md-c", title: "Reprint the menu", dependencies: [{ id: "md-gate", type: "blocks" }, { id: "md-elsewhere", type: "blocks" }] }),
  ];

  it("works out what a decision releases from the rows the snapshot lists, as the live read does", () => {
    const view = readTaskBoard({ ...sampled, snapshot: payload({ projects: [project({ waiting: [gate], blocked })] }) });
    expect(view.inbox.map((row) => row.task.id)).toEqual(["md-gate"]);
    expect(view.inbox[0]!.task.decisionImpact).toEqual({ priority: 1,
      proceeds: [{ id: "md-a", title: "Raise the price" }, { id: "md-b", title: "Announce the price" }] });
    // The blocked sample is on the board, each link titled from the row the snapshot holds for it.
    const held = view.allTasks.find((task) => task.id === "md-a")!;
    expect([held.ready, held.dependencies]).toEqual([false, [{ id: "md-gate", type: "blocks", title: "Approve the price change", status: "open" }]]);
    expect(view.allTasks.find((task) => task.id === "md-c")!.dependencies![1]).toEqual({ id: "md-elsewhere", type: "blocks", title: null, status: null });
  });

  it("works out nothing for a snapshot an older poller wrote, which recorded no links", () => {
    const view = readTaskBoard({ ...sampled, snapshot: payload({ projects: [project({ waiting: [item({ id: "md-gate", issueType: "gate" })] })] }) });
    expect(view.inbox[0]!.task.decisionImpact).toBeUndefined();
    expect(Object.hasOwn(view.inbox[0]!.task, "dependencies")).toBe(false);
  });
});


describe("work count parity", () => {
  const dependency = (id: string, type = "blocks", status: string | null = null) => ({ id, type, status, title: null });
  const tasks = [
    liveTask({ id: "md-open", ready: true }),
    liveTask({ id: "md-held", priority: 0, dependencies: [dependency("md-gate")] }),
    liveTask({ id: "md-wait", dependencies: [dependency("outside-open", "waits-for", "open")] }),
    liveTask({ id: "md-conditional", dependencies: [dependency("outside-unknown", "conditional-blocks")] }),
    liveTask({ id: "md-stored", status: "blocked", priority: 1 }),
    liveTask({ id: "md-working", status: "in_progress", priority: 1, dependencies: [dependency("md-gate")] }),
    liveTask({ id: "md-done", status: "closed", priority: 0 }),
    liveTask({ id: "md-parked", status: "deferred", priority: 0, dependencies: [dependency("md-gate")] }),
    liveTask({ id: "md-released", ready: true, dependencies: [dependency("md-closed-timer"), dependency("md-closed-epic"),
      dependency("md-done", "blocks", "open"), dependency("outside-related", "related"), dependency("outside-parent", "parent-child")] }),
    liveTask({ id: "md-human", ready: true, labels: ["human"] }),
    liveTask({ id: "md-gate", issueType: "gate", awaitType: "human", priority: 0 }),
    liveTask({ id: "md-closed-gate", issueType: "gate", awaitType: "human", status: "closed", priority: 0 }),
    liveTask({ id: "md-timer", issueType: "gate", awaitType: "timer", priority: 0 }),
    liveTask({ id: "md-closed-timer", issueType: "gate", awaitType: "timer", status: "closed" }),
    liveTask({ id: "md-closed-epic", issueType: "epic", status: "closed" }),
    liveTask({ id: "md-epic", issueType: "epic", priority: 0 }),
  ];
  const get = (id: string): WorkItem => {
    const task = tasks.find(task => task.id === id)!;
    return { ...task, dependencies: task.dependencies.map(edge => ({ ...edge,
      status: tasks.find(other => other.id === edge.id)?.status ?? edge.status ?? undefined })) };
  };
  const saved = project({
    counts: { open: 7, highPriority: 3, ready: 3, inProgress: 1, blocked: 4, closedRecent: 1, deferred: 1, waiting: 2 },
    ready: [get("md-open"), get("md-released"), get("md-human")],
    blocked: [get("md-held"), get("md-wait"), get("md-conditional"), get("md-stored")],
    inProgress: [get("md-working")], deferred: [get("md-parked")],
    recentlyClosed: [get("md-done"), get("md-closed-gate")], waiting: [get("md-gate"), get("md-human")],
  });
  const options = (live: boolean, status = "all") => ({ snapshot: payload({ projects: [saved] }),
    capabilities: { live, reason: null }, reads: new Map([[saved.asset, success(board(tasks))]]), filters: { ...filters, status } });

  it("counts the same work, approvals and aggregate backlog with or without daily history", () => {
    const live = read(options(true));
    const snapshot = read(options(false));
    expect(live.projects[0]!.stats).toEqual({ open: 7, urgent: 3, inProgress: 1, blocked: 4, closed: 1 });
    expect(live.projects[0]!.stats).toEqual(snapshot.projects[0]!.stats);
    expect(live.projects[0]!.totals).toEqual({ waiting: 2, tasks: 9 });
    expect(live.projects[0]!.totals).toEqual(snapshot.projects[0]!.totals);
    expect(live.totals).toEqual(snapshot.totals);
    expect(live.totals.live).toBe(8);
    expect(live.counts).toEqual(snapshot.counts);
    expect(live.weeks).toBeNull();
    expect(snapshot.weeks).toBeNull();
    expect(live.inbox.map(row => row.task.id).sort()).toEqual(["md-gate", "md-human"]);
    expect(snapshot.inbox.map(row => row.task.id).sort()).toEqual(["md-gate", "md-human"]);
    expect(live.allTasks.some(task => task.id === "md-closed-gate")).toBe(true);
    expect(live.rows.some(task => task.issueType === "gate")).toBe(false);
    expect(snapshot.rows.some(task => task.issueType === "gate")).toBe(false);
    expect(live.statusCounts).toEqual(snapshot.statusCounts);
    expect(live.projectCounts.get(saved.asset)).toBe(10);
  });

  it.each([
    ["open", ["md-human", "md-open", "md-released"]],
    ["blocked", ["md-conditional", "md-held", "md-stored", "md-wait"]],
    ["in-progress", ["md-working"]], ["closed", ["md-done"]], ["parked", ["md-parked"]],
  ])("uses the same %s work classification for status filters in both reads", (status, ids) => {
    for (const live of [true, false]) {
      const view = read(options(live, status));
      const workIds = [...view.rows, ...view.inbox.map(row => row.task)].filter(task => task.issueType !== "gate").map(task => task.id).sort();
      expect(workIds).toEqual(ids);
      expect(view.statusCounts.get(status)).toBe(ids.length);
      if (status === "blocked") expect(view.rows.find(task => task.id === "md-held")?.status).toBe("open");
    }
  });

  it("sums mixed project sources without adding their blocked subset twice", () => {
    const other = project({ asset: "northwind.example", prefix: "nw", ready: [], inProgress: [],
      counts: { ...saved.counts, open: 12, blocked: 10, inProgress: 2, highPriority: null, closedRecent: 5, waiting: 0 } });
    const view = read({ ...options(true), snapshot: payload({ projects: [saved, other] }) });
    expect(view.projects.map(project => project.source)).toEqual(["live", "snapshot"]);
    expect(view.totals).toMatchObject({ open: 19, blocked: 14, inProgress: 3, closed: 6, live: 22, urgent: 3, blindUrgent: 1 });
    expect(view.counts.closed).toBeNull();
    expect(view.weeks).toBeNull();
  });

  it("uses saved blocked membership when an older sample has no dependency links", () => {
    const held = item({ id: "md-held" });
    const view = read({ snapshot: payload({ projects: [project({ blocked: [held], ready: [], inProgress: [],
      counts: { ...project().counts, open: 40, blocked: 35, inProgress: 7, closedRecent: 12 } })] }),
      capabilities: { live: false, reason: null }, filters: { ...filters, status: "blocked" } });
    expect(view.rows.map(task => task.id)).toEqual(["md-held"]);
    expect(view.statusCounts.get("blocked")).toBe(1);
    expect(view.totals).toMatchObject({ open: 40, blocked: 35, inProgress: 7, closed: 12, live: 47 });
    expect(view.projects[0]!.totals.tasks).toBe(59);
  });
});


it.each([
  { ready: true, status: null, blocked: 0 },
  { ready: false, status: null, blocked: 1 },
  { ready: true, status: "open", blocked: 1 },
])("uses readiness for an unlisted blocker only when its status is unknown: %j", ({ ready, status, blocked }) => {
  const live = liveTask({ ready, dependencies: [{ id: "outside-window", type: "blocks", title: null, status }] });
  const saved = item({ dependencies: [{ id: "outside-window", type: "blocks", ...(status === null ? {} : { status }) }] });
  const snapshot = payload({ projects: [project({ ready: ready ? [saved] : [], blocked: ready ? [] : [saved], inProgress: [],
    counts: { ...project().counts, open: 1, blocked, ready: Number(ready), inProgress: 0, highPriority: 0 } })] });
  for (const enabled of [true, false]) {
    const view = read({ snapshot, capabilities: { live: enabled, reason: null },
      reads: new Map([["meadow.example", success(board([live]))]]) });
    expect(view.projects[0]!.stats).toMatchObject({ open: 1, blocked });
    expect(view.statusCounts.get(blocked ? "blocked" : "open")).toBe(1);
    expect(view.allTasks[0]!.ready).toBe(ready);
  }
});

it.each([true, false])("keeps an assignee used only by approvals available to inbox filters (live=%s)", enabled => {
  const approval = liveTask({ id: "md-approval", issueType: "gate", awaitType: "human", assignee: "owner" });
  const snapshot = payload({ projects: [project({ ready: [], inProgress: [], waiting: [approval],
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 1 } })] });
  const options = { snapshot, capabilities: { live: enabled, reason: null },
    reads: new Map([["meadow.example", success(board([approval]))]]) };
  const view = read(options);
  expect(view.assigneeCounts.get("owner")).toBe(1);
  expect(view.statusCounts.size).toBe(0);
  expect(view.totals.live).toBe(0);
  expect(view.inbox.map(row => row.task.id)).toEqual(["md-approval"]);
  expect(read({ ...options, filters: { ...filters, assignee: "owner" } }).inbox.map(row => row.task.id)).toEqual(["md-approval"]);
});
