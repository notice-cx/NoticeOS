import type { LiveTask, LiveTasksPayload } from "@shared/tasks";
import { emptyWorkHistory, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";
import type { TaskChoices } from "@noticeos/contract/task-choices";

// The rows the Next tab, its brief and Focus are drawn from in their tests: one
// live project whose decisions, agents' work and held-back tasks each exercise
// one list, read the way the board reads them.

export const NOW_ISO = "2026-08-01T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW_ISO);

export const CARD = { valuePerMonth: 1100, likelihood: 0.7, reviewMinutes: 10, daysToSignal: 14, measurability: "holdout" as const };

export const CHOICES: TaskChoices = {
  question: "Which day does the newsletter go out?",
  options: [
    { key: "a", label: "Monday" },
    { key: "b", label: "Tuesday", detail: "Opens were highest on Tuesdays.", recommended: true },
    { key: "c", label: "Friday" },
  ],
};

export function item(overrides: Partial<WorkItem> = {}): WorkItem {
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

export function project(overrides: Partial<WorkProject> = {}): WorkProject {
  return {
    asset: "meadow.example",
    prefix: "md",
    name: "Meadow Board",
    ok: true,
    error: null,
    counts: { open: 3, highPriority: 1, ready: 2, inProgress: 1, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    priorities: [1, 0, 3, 0, 0],
    epics: null,
    deferred: [],
    waiting: [],
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    history: emptyWorkHistory(),
    ...overrides,
  };
}

export function payload(projects: WorkProject[] = [project()]): WorkPayload {
  return {
    generatedAt: NOW_ISO,
    capturedAt: "2026-08-01T11:59:00.000Z",
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects,
    historyDays: 0,
  };
}

export function liveTask(overrides: Partial<LiveTask> = {}): LiveTask {
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

export function board(tasks: LiveTask[], asset = "meadow.example", epics: LiveTasksPayload["epics"] = null): LiveTasksPayload {
  return { project: asset, prefix: asset.slice(0, 2), repo: `../${asset}`, readAt: "2026-08-01T11:59:30.000Z", tasks, epics };
}

const blockedOn = (id: string, title: string) => [{ id, type: "blocks", title, status: "open" }];

/** Three decisions (a carded choice, a question that releases two tasks, a
 * gate), two agents' rows, and four tasks held back for each reason. */
export function scenario(): LiveTask[] {
  return [
    liveTask({ id: "md-c1", title: "Pick the newsletter day", labels: ["human"], ready: true, choices: CHOICES, card: CARD,
      createdAt: "2026-07-25T12:00:00.000Z", parent: "md-e" }),
    liveTask({ id: "md-a1", title: "Name the newsletter", labels: ["human"], ready: true, createdAt: "2026-07-20T12:00:00.000Z" }),
    liveTask({ id: "md-g1", title: "Approve the spend", issueType: "gate", awaitType: "human", createdAt: "2026-07-31T12:00:00.000Z" }),
    liveTask({ id: "md-w1", title: "Ship the sitemap fix", status: "in_progress", priority: 1, assignee: "agent-x",
      startedAt: "2026-08-01T09:00:00.000Z" }),
    liveTask({ id: "md-n1", title: "Write the welcome email", ready: true, card: { ...CARD, valuePerMonth: 400 } }),
    liveTask({ id: "md-r1", title: "Draft the first issue", status: "blocked", dependencies: blockedOn("md-a1", "Name the newsletter") }),
    liveTask({ id: "md-r2", title: "Design the header", status: "blocked", dependencies: blockedOn("md-a1", "Name the newsletter") }),
    liveTask({ id: "md-p1", title: "Translate the archive", status: "deferred", deferUntil: "2026-09-01T00:00:00.000Z" }),
    liveTask({ id: "md-x1", title: "Tidy the footer", ready: true, card: { ...CARD, valuePerMonth: 10, reviewMinutes: 30 } }),
  ];
}

/** The scenario's epic, as both reads carry it. */
export const EPIC = { id: "md-e", title: "Newsletter launch", status: "open", priority: 1, total: 6, closed: 2 };

export function scenarioPayload(): WorkPayload {
  return payload([project({
    epics: [{ ...EPIC, counts: { open: 4, inProgress: 0, blocked: 0, deferred: 0 }, priorities: [0, 1, 3, 0, 0] }],
  })]);
}

export function scenarioBoards(): Record<string, LiveTasksPayload> {
  return { "meadow.example": board(scenario(), "meadow.example", [{ ...EPIC, eligibleForClose: false }]) };
}
