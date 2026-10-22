import { describe, expect, it } from "vitest";
import type { TaskCard } from "@noticeos/contract/task-card";
import type { WorkProject } from "@shared/work";
import { emptyWorkHistory } from "@shared/work";
import type { BoardProject, BoardTask } from "@/lib/task-board-read";
import {
  allProjects,
  projectModel,
  sortProjects,
  sortSites,
  type ProjectRecord,
} from "@/routes/tasks/projects/project-model";

// The Projects tab's one derivation, from board rows built by hand: every
// state a project can be in, the three orders, the bar's segments, the kill
// date, the card sum and the work that hangs off no project.

const NOW = new Date("2026-10-21T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: "md-1",
    title: "A task",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: daysAgo(1),
    closedAt: null,
    createdAt: daysAgo(2),
    parent: "md-e",
    deferUntil: null,
    project: "meadow.example",
    labels: [],
    ready: false,
    awaitType: null,
    ...overrides,
  };
}

/** A human-labelled ready task: one the operator answers. */
function ask(overrides: Partial<BoardTask> = {}): BoardTask {
  return task({ labels: ["human"], ready: true, ...overrides });
}

function card(overrides: Partial<TaskCard> = {}): TaskCard {
  return { valuePerMonth: 400, likelihood: 0.5, reviewMinutes: 10, daysToSignal: 14, measurability: "cohort", ...overrides };
}

function board(tasks: BoardTask[], overrides: Partial<BoardProject> = {}): BoardProject {
  const epics = overrides.epicNames ?? new Map([["md-e", "Recipe overhaul"]]);
  return {
    asset: "meadow.example",
    prefix: "md",
    name: "Meadow",
    ok: true,
    error: null,
    source: "live",
    actionable: true,
    readAt: NOW.toISOString(),
    closedSince: null,
    laneError: null,
    stats: { open: 0, urgent: 0, inProgress: 0, blocked: 0, closed: 0 },
    epicNames: epics,
    tasks,
    waiting: tasks.filter((row) => row.labels.includes("human") && row.ready && row.status !== "closed"),
    totals: { waiting: 0, tasks: tasks.length },
    ...overrides,
  };
}

function one(tasks: BoardTask[], overrides: Partial<BoardProject> = {}, snapshots: WorkProject[] = []): ProjectRecord {
  const [site] = projectModel({ projects: [board(tasks, overrides)], snapshots, now: NOW });
  expect(site!.projects).toHaveLength(1);
  return site!.projects[0]!;
}

describe("a project's state", () => {
  it("needs you while one of its tasks waits on the operator, with the ask's verb and age", () => {
    const record = one([task({ id: "md-1", priority: 0, status: "blocked" }), ask({ id: "md-2", title: "Pick a schema", createdAt: daysAgo(9) })]);
    expect(record.state).toBe("needs-you");
    expect(record.ask?.task.id).toBe("md-2");
    expect(record.ask?.verb).toBe("answer");
    expect(record.agesDays).toBe(9);
  });

  it("approves a gate", () => {
    const gate = task({ id: "md-g", issueType: "gate", awaitType: "human", title: "Approve the launch" });
    const record = one([gate], { waiting: [gate] });
    expect(record.ask?.verb).toBe("approve");
  });

  it("is urgent with a P0 or P1 task open, and not for a parked one", () => {
    expect(one([task({ priority: 1, ready: true })]).state).toBe("urgent");
    expect(one([task({ priority: 0, status: "deferred" }), task({ id: "md-2", ready: true })]).state).toBe("ready");
  });

  it("is blocked when nothing open can move", () => {
    expect(one([task({ status: "blocked" }), task({ id: "md-2" }), task({ id: "md-3", status: "closed" })]).state).toBe("blocked");
  });

  it("is in progress, then ready, then parked, then done, then not started", () => {
    expect(one([task({ status: "in_progress", assignee: "claude-code" }), task({ id: "md-2", ready: true })]).state).toBe("in-progress");
    expect(one([task({ ready: true }), task({ id: "md-2", status: "blocked" })]).state).toBe("ready");
    expect(one([task({ status: "deferred" }), task({ id: "md-2", status: "closed" })]).state).toBe("parked");
    expect(one([task({ status: "closed" }), task({ id: "md-2", status: "closed" })]).state).toBe("done");
    expect(one([]).state).toBe("not-started");
  });

  it("names the next ready task by priority then age, else the one in progress and who holds it", () => {
    const record = one([
      task({ id: "md-1", ready: true, priority: 2, createdAt: daysAgo(3) }),
      task({ id: "md-2", ready: true, priority: 2, createdAt: daysAgo(8) }),
      task({ id: "md-3", ready: true, priority: 3, createdAt: daysAgo(20) }),
      task({ id: "md-4", status: "in_progress", assignee: "claude-code" }),
    ]);
    expect(record.next?.task.id).toBe("md-2");
    expect(record.next?.who).toBeNull();
    expect(record.working).toMatchObject({ who: "claude-code" });
    expect(one([task({ status: "in_progress", assignee: "Ada" })]).next).toMatchObject({ who: "Ada" });
  });

  it("takes its kind from its tasks when the epic records none, and marks a bug-heavy one", () => {
    const record = one([
      task({ id: "md-1", changeClass: "copy" }),
      task({ id: "md-2", changeClass: "feature", issueType: "bug" }),
      task({ id: "md-3", changeClass: "feature", issueType: "bug" }),
    ]);
    expect(record.kind).toBe("feature");
    expect(record.bugHeavy).toBe(true);
    expect(one([task()]).kind).toBeNull();
  });
});

describe("a project's bar", () => {
  it("has one segment per task: done, in progress, needs you, blocked, ready, waiting, parked", () => {
    const record = one([
      task({ id: "md-1", status: "deferred" }),
      task({ id: "md-2", ready: true }),
      task({ id: "md-3", status: "blocked" }),
      ask({ id: "md-4" }),
      task({ id: "md-5", status: "in_progress" }),
      task({ id: "md-6", status: "closed" }),
      task({ id: "md-7" }),
    ]);
    expect(record.segments.map((segment) => segment.state)).toEqual(["done", "in-progress", "needs-you", "blocked", "ready", "waiting", "parked"]);
    expect(record).toMatchObject({ total: 7, closed: 1, open: 6, counts: { open: 3, inProgress: 1, blocked: 1, deferred: 1 } });
  });

  it("counts the snapshot rollup's children the sample leaves out, and what nobody placed as unknown", () => {
    const snapshot = {
      asset: "meadow.example", prefix: "md", name: "Meadow", ok: true, error: null,
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
      history: emptyWorkHistory(), priorities: null,
      epics: [{ id: "md-e", title: "Recipe overhaul", status: "open", priority: 1, total: 9, closed: 5, counts: { open: 2, inProgress: 0, blocked: 2, deferred: 0 }, priorities: [0, 0, 4, 0, 0] }],
      ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [],
    } satisfies WorkProject;
    const record = one([task({ id: "md-2", ready: true })], { source: "snapshot", epicNames: new Map() }, [snapshot]);
    expect(record.segments.map((segment) => segment.state)).toEqual(["done", "done", "done", "done", "done", "blocked", "blocked", "ready", "unknown"]);
    expect(record).toMatchObject({ total: 9, closed: 5, status: "open" });
  });
});

describe("what a project's cards say it is worth", () => {
  it("takes the earliest kill date and sums the open tasks' cards, null when none carries one", () => {
    const record = one([
      task({ id: "md-1", card: card({ valuePerMonth: 300, kill: { state: "no lift", date: "2026-12-01" } }) }),
      task({ id: "md-2", card: card({ valuePerMonth: 200, kill: { state: "no lift", date: "2026-11-15" } }) }),
      task({ id: "md-3", status: "closed", card: card({ valuePerMonth: 5000 }) }),
    ]);
    expect(record.killDate).toBe("2026-11-15");
    expect(record.valuePerMonth).toBe(500);
    expect(one([task()])).toMatchObject({ killDate: null, valuePerMonth: null });
  });
});

describe("the work in no project", () => {
  it("counts an asset's open tasks with no parent, or a parent that is no project", () => {
    const [site] = projectModel({
      projects: [board([
        task({ id: "md-1" }),
        task({ id: "md-2", parent: null }),
        task({ id: "md-3", parent: "md-nope" }),
        task({ id: "md-4", parent: null, status: "closed" }),
      ])],
      snapshots: [],
      now: NOW,
    });
    expect(site).toMatchObject({ loose: 2, open: 3, complete: true });
  });
});

describe("the three orders", () => {
  const rows = [
    task({ id: "a-1", parent: "a" }),
    ask({ id: "b-1", parent: "b", createdAt: daysAgo(3) }),
    ask({ id: "c-1", parent: "c", createdAt: daysAgo(12) }),
    task({ id: "d-1", parent: "d", priority: 0, ready: true }),
    task({ id: "e-1", parent: "e", status: "closed" }),
    task({ id: "f-1", parent: "f", status: "in_progress" }),
    task({ id: "f-2", parent: "f", ready: true }),
    task({ id: "f-3", parent: "f", ready: true }),
  ];
  const names = new Map([["a", "Zebra"], ["b", "Bravo"], ["c", "Charlie"], ["d", "Delta"], ["e", "Echo"], ["f", "Alpha"]]);
  const sites = projectModel({ projects: [board(rows, { epicNames: names })], snapshots: [], now: NOW });
  const order = (records: readonly ProjectRecord[]) => records.map((record) => record.title);

  it("puts what needs attention first: the oldest question, urgent, held, moving, done", () => {
    // Zebra's one task waits on another task, so nothing in it can move.
    expect(order(allProjects(sites, "attention"))).toEqual(["Charlie", "Bravo", "Delta", "Zebra", "Alpha", "Echo"]);
  });

  it("puts the most open work first", () => {
    expect(order(sortProjects(sites[0]!.projects, "open")).slice(0, 1)).toEqual(["Alpha"]);
    expect(order(sortProjects(sites[0]!.projects, "open")).at(-1)).toBe("Echo");
  });

  it("orders A–Z", () => {
    expect(order(sortProjects(sites[0]!.projects, "az"))).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Zebra"]);
  });

  it("orders assets by their first project, their open work or their name", () => {
    const quiet = projectModel({ projects: [board([task({ id: "q-1", parent: "q", ready: true })], { asset: "acorn.example", name: "Acorn", epicNames: new Map([["q", "Quiet"]]) })], snapshots: [], now: NOW });
    const both = [...quiet, ...sites];
    expect(sortSites(both, "attention").map((site) => site.site.name)).toEqual(["Meadow", "Acorn"]);
    expect(sortSites(both, "open").map((site) => site.site.name)).toEqual(["Meadow", "Acorn"]);
    expect(sortSites(both, "az").map((site) => site.site.name)).toEqual(["Acorn", "Meadow"]);
  });
});

describe("an approval outside the project", () => {
  it("makes the project wait on you when it holds one of its tasks, without counting as one of its tasks", () => {
    const gate = task({ id: "md-g", parent: null, issueType: "gate", awaitType: "human", title: "Approve the launch" });
    const held = task({ id: "md-1", dependencies: [{ id: "md-g", type: "blocks", title: null, status: null }] });
    const record = one([gate, held], { waiting: [gate] });
    expect(record).toMatchObject({ state: "needs-you", total: 1, ask: { verb: "approve", task: { id: "md-g" } } });
  });
});
