import type { BoardProject, BoardTask } from "@/lib/task-board-read";

export function blockerTask(id: string, dependencies: string[] = [], overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id, title: `Task ${id}`, project: "example.com", issueType: "task", status: "open", priority: 2,
    assignee: null, updatedAt: null, closedAt: null, parent: null, deferUntil: null, labels: [], ready: false, awaitType: null,
    dependencies: dependencies.map(id => ({ id, type: "blocks", title: null, status: null })),
    ...overrides,
  };
}

export function blockerProject(tasks: BoardTask[], overrides: Partial<BoardProject> = {}): BoardProject {
  return {
    asset: "example.com", prefix: "ex", name: "Example project", ok: true, error: null, source: "live", actionable: false,
    readAt: "2026-10-21T12:00:00Z", closedSince: null, laneError: null,
    stats: { open: tasks.length, urgent: 0, inProgress: 0, blocked: 0, closed: 0 },
    tasks, waiting: [], epicNames: new Map(), totals: { waiting: 0, tasks: tasks.length },
    ...overrides,
  };
}
