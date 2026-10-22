import type { LiveTask, LiveTasksPayload, TaskProject } from "../../shared/tasks";
import { emptyWorkHistory, type WorkPayload, type WorkProject } from "../../shared/work";

const NOW = "2026-10-21T12:00:00Z";
export function syntheticTask(id: string, dependencies: string[] = [], overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    id, title: `Synthetic task ${id}`, status: "open", issueType: "task", priority: 2, assignee: null,
    updatedAt: NOW, closedAt: null, parent: null, deferUntil: null, description: "", acceptance: "",
    labels: [], ready: false, dependencies: dependencies.map(id => ({ id, type: "blocks", title: null, status: null })),
    comments: 0, metadata: null, createdAt: NOW, startedAt: null, closeReason: null, awaitType: null, ...overrides,
  };
}

export const projects: TaskProject[] = [
  { projectId: "synthetic-alpha", logicalKey: "alpha", displayName: "Example project Alpha", prefix: "ex" },
  { projectId: "synthetic-beta", logicalKey: "beta", displayName: "Example project Beta", prefix: "ex" },
];

export function blockerFixture(empty = false) {
  const alpha = [
    syntheticTask("ex-a", [], { title: "Finish the shared schema", status: "in_progress", assignee: "builder" }),
    syntheticTask("ex-b", ["ex-a"]), syntheticTask("ex-c", ["ex-a"]), syntheticTask("ex-d", ["ex-b", "ex-c"]),
    syntheticTask("ex-gate", [], { title: "Approve the review", issueType: "gate", awaitType: "human" }),
    syntheticTask("ex-held", ["ex-a", "ex-gate"]),
    syntheticTask("ex-human", ["ex-a"], { labels: ["human"] }),
    syntheticTask("ex-parked", ["ex-a"], { status: "deferred" }),
  ];
  const beta = [syntheticTask("ex-a", [], { title: "Finish the independent schema" }), syntheticTask("ex-child", ["ex-a"])];
  const live = new Map<string, LiveTasksPayload>(projects.map((project, index) => [project.logicalKey, {
    project: project.logicalKey, prefix: project.prefix, repo: "synthetic", readAt: NOW, epics: [],
    actors: [{ principalId: "builder", displayName: "Example Builder" }], tasks: empty ? [] : index === 0 ? alpha : beta,
  }]));
  const snapshots: WorkProject[] = projects.map(project => {
    const tasks = live.get(project.logicalKey)!.tasks;
    return {
      asset: project.logicalKey, prefix: project.prefix, name: project.displayName, ok: true, error: null,
      counts: { open: tasks.filter(task => task.status === "open" && task.issueType !== "gate").length,
        highPriority: 0, ready: 0, inProgress: tasks.filter(task => task.status === "in_progress").length,
        blocked: 0, closedRecent: 0, deferred: tasks.filter(task => task.status === "deferred").length, waiting: 0 },
      history: emptyWorkHistory(), priorities: null, epics: [], ready: [], waiting: [], recentlyClosed: [],
      inProgress: tasks.filter(task => task.status === "in_progress"), deferred: tasks.filter(task => task.status === "deferred"),
      blocked: tasks.filter(task => task.status === "open"),
    };
  });
  const snapshot: WorkPayload = { generatedAt: NOW, capturedAt: NOW, pollCadenceHours: 1 / 60,
    owner: "synthetic", historyDays: 0, projects: snapshots };
  return { live, snapshot };
}
