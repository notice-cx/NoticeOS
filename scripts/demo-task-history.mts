/** The demo's daily task photographs from the first site's creation to its
 * cutoff, which the daily rollup the Home and the Wall chart keeps. Each day's
 * boards are the seed's tasks as their dated changes left them that day, with
 * readiness by Ntasks's rule (Ntasks docs/task-store.md, "Ready work"): a task
 * that is not closed is blocked by a blocks link onto a task that is not
 * closed, or by a blocked parent; an open task that is not blocked, not a gate
 * and not deferred past the day, nor its parent, is ready. Each day is then
 * summarized as the board refresh summarizes the live boards
 * (scripts/demo-ntasks.mts).
 */
import type { NtasksSeed, NtasksSeedTask } from './demo-ntasks-seed.mjs';
import { boardResults, LABEL_READS } from './runner/task-service-poll.mjs';
import { BEADS_CLOSES_DAYS, beadsClosedSince, beadsClosesSince, summarizeBeadsProject } from './task-snapshot-summary.mjs';
import type { BeadsProjectInput } from '../packages/contract/src/task-snapshot.mjs';
import type { generateDemoScenario } from './demo-scenario.mjs';
import { shiftDemoDay } from './demo-scenario.mjs';

type Scenario = ReturnType<typeof generateDemoScenario>;
const DAY_MS = 86_400_000;

/** One task as Ntasks's board answers it, as far as the snapshot reads. */
interface BoardTask {
  id: string; title: string; status: string; priority: number; issueType: string; assignee: string | null;
  assigneeModel: string | null; closedBy: string | null; closedModel: string | null; closeReason: string | null;
  updatedAt: string; createdAt: string; startedAt: string | null; closedAt: string | null; parent: string | null;
  deferUntil: string | null; dueAt: null; description: string; acceptance: string; labels: string[];
  comments: number; metadata: Record<string, unknown>; awaitType: string | null; ready: boolean;
  dependencies: { id: string; type: string; title: string; status: string }[];
}

/** The task as its changes up to `instant` left it, or null before it was filed. */
function stateAt(task: NtasksSeedTask, instant: string): Omit<BoardTask, 'ready' | 'dependencies'> | null {
  if (task.createdAt > instant) return null;
  let status = 'open', assignee: string | null = null, assigneeModel: string | null = null, deferUntil: string | null = null;
  let metadata = task.metadata, updatedAt = task.createdAt, startedAt: string | null = null;
  let close: { at: string; by: string; model: string | null; reason: string } | null = null;
  for (const change of task.changes) {
    if (change.at > instant) break;
    updatedAt = change.at;
    if (change.status !== undefined) status = change.status;
    if (change.assignee !== undefined) {
      assignee = change.assignee;
      assigneeModel = assignee !== null && assignee === change.by ? change.model ?? null : null;
    }
    if (change.deferUntil !== undefined) deferUntil = change.deferUntil;
    if (change.metadata !== undefined) metadata = change.metadata;
    if (change.close) close = { at: change.at, by: change.by, model: change.model ?? null, reason: change.close.reason };
    else if (status !== 'closed') close = null;
    if (status === 'in_progress' && startedAt === null) startedAt = change.at;
  }
  return { id: task.id, title: task.title, status, priority: task.priority, issueType: task.type, assignee, assigneeModel,
    closedBy: close?.by ?? null, closedModel: close?.model ?? null, closeReason: close?.reason ?? null, updatedAt,
    createdAt: task.createdAt, startedAt, closedAt: close?.at ?? null, parent: task.parent ?? null, deferUntil, dueAt: null,
    description: task.description, acceptance: task.acceptance, labels: [...task.labels].sort(),
    comments: task.comments.filter(comment => comment.at <= instant).length, metadata,
    awaitType: task.awaitsPerson ? 'human' : null };
}

/** One project's boards at `instant`: every task with its epics, and the closes the snapshot reaches back over. */
export function demoBoardsAt(seed: NtasksSeed, prefix: string, instant: string) {
  const states = new Map<string, NonNullable<ReturnType<typeof stateAt>>>();
  const links = new Map<string, NtasksSeedTask['links']>();
  for (const task of seed.tasks) {
    const state = stateAt(task, instant);
    if (!state) continue;
    states.set(task.id, state);
    links.set(task.id, task.links);
  }
  const blocked = new Map<string, boolean>();
  const isBlocked = (id: string, seen = new Set<string>()): boolean => {
    const known = blocked.get(id);
    if (known !== undefined) return known;
    const state = states.get(id)!;
    if (seen.has(id) || state.status === 'closed') return false;
    seen.add(id);
    const answer = (links.get(id) ?? []).some(link => states.has(link.to) && states.get(link.to)!.status !== 'closed')
      || (state.parent !== null && states.has(state.parent) && isBlocked(state.parent, seen));
    blocked.set(id, answer);
    return answer;
  };
  const deferred = (id: string | null) => {
    const state = id === null ? undefined : states.get(id);
    return state !== undefined && state.deferUntil !== null && state.deferUntil > instant;
  };
  const own = [...states.values()].filter(state => state.id.startsWith(`${prefix}-`));
  const tasks: BoardTask[] = own.map(state => ({ ...state,
    ready: state.status === 'open' && !isBlocked(state.id) && state.issueType !== 'gate' && !deferred(state.id) && !deferred(state.parent),
    dependencies: (links.get(state.id) ?? []).filter(link => states.has(link.to))
      .map(link => ({ id: link.to, type: link.type, title: states.get(link.to)!.title, status: states.get(link.to)!.status })) }));
  const epics = tasks.filter(task => task.issueType === 'epic' && task.status !== 'closed').map(epic => {
    const children = tasks.filter(task => task.parent === epic.id);
    const closed = children.filter(task => task.status === 'closed').length;
    return { id: epic.id, title: epic.title, status: epic.status, priority: epic.priority, total: children.length, closed,
      eligibleForClose: children.length > 0 && closed === children.length, createdAt: epic.createdAt };
  }).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(({ createdAt: _createdAt, ...epic }) => epic);
  const closesFrom = new Date(Date.parse(instant) - BEADS_CLOSES_DAYS * DAY_MS).toISOString();
  const closes = tasks.filter(task => task.status === 'closed' && (task.closedAt ?? '') >= closesFrom);
  const labelled = Object.fromEntries(Object.entries(LABEL_READS as Record<string, readonly string[]>)
    .map(([read, labels]) => [read, tasks.filter(task => task.labels.some(label => labels.includes(label)))]));
  return { board: { tasks: tasks.filter(task => task.status !== 'closed' || closes.includes(task)), epics }, closes: { tasks: closes }, labelled };
}

/** Each day's photograph, oldest first: every project whose site existed that day. */
export function demoTaskHistory(seed: NtasksSeed, scenario: Scenario): { capturedAt: string; projects: BeadsProjectInput[] }[] {
  const first = scenario.assets.map(asset => asset.createdAt.slice(0, 10)).sort()[0]!;
  const last = scenario.manifest.referenceDate;
  const days: { capturedAt: string; projects: BeadsProjectInput[] }[] = [];
  for (let day = first; day <= last; day = shiftDemoDay(day, 1)) {
    const instant = day === last ? scenario.manifest.cutoff : `${day}T23:59:59.000Z`;
    const at = Date.parse(instant);
    const reach = { closedSince: beadsClosedSince(at), closesSince: beadsClosesSince(at) };
    const projects: BeadsProjectInput[] = [];
    for (const project of scenario.manifest.taskProjects) {
      if (instant < scenario.assets.find(asset => asset.id === project.asset)!.createdAt) continue;
      const { board, closes, labelled } = demoBoardsAt(seed, project.prefix, instant);
      const summary = summarizeBeadsProject({ asset: project.asset, prefix: project.prefix }, boardResults(board, closes, labelled), reach) as BeadsProjectInput;
      if (!summary.ok) throw new Error(`The demo's task history for ${project.prefix} on ${day} does not summarize.`);
      projects.push(summary);
    }
    days.push({ capturedAt: instant, projects });
  }
  return days;
}
