import type { LiveTask, LiveTasksPayload } from '@shared/tasks';
import { emptyWorkHistory, type WorkPayload, type WorkProject } from '@shared/work';

export const SEARCH_PROJECT = 'search.example';
export const SEARCH_TARGET = 'ex-249';
export const SEARCH_NOW = '2026-09-06T12:00:00.000Z';
export function searchTasks(): LiveTask[] {
  return Array.from({ length: 250 }, (_, index) => ({
    id: `ex-${index}`, title: index === 249 ? 'Repair API: retry (v2)' : `Routine task ${index}`,
    status: 'open', priority: 2, issueType: 'task', assignee: 'Ada',
    updatedAt: SEARCH_NOW, closedAt: null, parent: null, deferUntil: null,
    description: 'description-only phrase', acceptance: '', labels: ['review'], ready: true,
    dependencies: [], comments: 0, metadata: null, createdAt: SEARCH_NOW,
    startedAt: null, closeReason: null, awaitType: null,
  }));
}
export function searchBoard(project = SEARCH_PROJECT): LiveTasksPayload {
  return { project, prefix: 'ex', repo: '.', readAt: SEARCH_NOW, closedSince: '2026-08-30', tasks: searchTasks(), epics: null };
}
export function searchProject(): WorkProject {
  return {
    asset: SEARCH_PROJECT, prefix: 'ex', name: 'Search Example', ok: true, error: null,
    counts: { open: 250, highPriority: 0, ready: 250, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    history: emptyWorkHistory(), priorities: null, epics: null,
    ready: searchTasks().slice(0, 5), inProgress: [], recentlyClosed: [], deferred: [], waiting: [],
  };
}
export function searchSnapshot(): WorkPayload {
  return { generatedAt: SEARCH_NOW, capturedAt: SEARCH_NOW, pollCadenceHours: 1 / 60,
    owner: 'config/beads.json', historyDays: 0, projects: [searchProject()] };
}
