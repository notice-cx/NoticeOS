import { HANDOFF_LABELS } from '../packages/contract/src/task-metadata.mjs';
import { PANEL_REVIEW_LABEL } from './panel-review-summary.mjs';
import { TaskServiceUnavailable, withNoticeosRecords } from './task-records.mjs';
import { taskRecord } from './task-snapshot-values.mjs';

type TaskRow = Record<string, unknown>;
export interface NtasksReads {
  call(input: { method: 'GET'; path: string }): Promise<{ status: number; body: unknown }>;
}

function recordList(value: unknown): TaskRow[] | null {
  return Array.isArray(value) && value.every((entry): entry is TaskRow => taskRecord(entry) !== null) ? value : null;
}

function dependenciesOf(task: TaskRow) {
  if (task.dependencies == null) return [];
  const dependencies = recordList(task.dependencies);
  if (dependencies === null) throw new TaskServiceUnavailable('invalid-response');
  return dependencies;
}

export const FEED_PAGE = 200;
export const FEED_PAGES = 5;

/** Ntasks's label read: at most this many pages of LABEL_PAGE per label. */
export const LABEL_PAGES = 10;
export const LABEL_PAGE = 200;
/** The snapshot's two label reads and the labels each takes in. */
export const LABEL_READS = Object.freeze({ handoffs: HANDOFF_LABELS, panelReview: [PANEL_REVIEW_LABEL] });

/**
 * Every task of the project carrying `label`, in every status and closed at
 * any time, through Ntasks's label read. Throws when Ntasks does not answer
 * it, and when more than LABEL_PAGES pages carry it: a cut list would read
 * as complete.
 */
export async function readLabelled(service: NtasksReads, projectId: string, label: string, { pages = LABEL_PAGES } = {}) {
  const tasks: TaskRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({ project: projectId, label, limit: String(LABEL_PAGE), ...(after === null ? {} : { after }) });
    const response = await service.call({ method: 'GET', path: `/api/tasks?${query}` });
    const { status } = response;
    const body = taskRecord(response.body);
    const rows = recordList(body?.tasks);
    if (status !== 200 || body === null || rows === null) {
      const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
      throw new Error(`Ntasks's read of the ${label} label answered HTTP ${status}${detail}`);
    }
    tasks.push(...rows);
    if (typeof body.next !== 'string') return tasks;
    after = body.next;
  }
  throw new Error(`more than ${pages * LABEL_PAGE} tasks carry the ${label} label`);
}

/** The tasks a read's labels name, each once. */
export async function readLabels(service: NtasksReads, projectId: string, labels: readonly string[]) {
  const rows = new Map<unknown, TaskRow>();
  for (const label of labels) for (const task of await readLabelled(service, projectId, label)) rows.set(task.id, task);
  return [...rows.values()];
}

/** One Ntasks task as a row of snake_case fields: the shape the snapshot
 * summary (scripts/task-snapshot-summary.mjs) and the runner's filing lanes
 * read. */
export function runnerRow(ntasksTask: TaskRow) {
  const task = withNoticeosRecords(ntasksTask);
  return {
    id: task.id, title: task.title, status: task.status, priority: task.priority, issue_type: task.issueType,
    assignee: task.assignee, updated_at: task.updatedAt, closed_at: task.closedAt, created_at: task.createdAt,
    started_at: task.startedAt, parent: task.parent, defer_until: task.deferUntil, due_at: task.dueAt ?? null, description: task.description,
    acceptance_criteria: task.acceptance, labels: task.labels, comment_count: task.comments, metadata: task.metadata,
    close_reason: task.closeReason, ...(task.awaitType ? { await_type: task.awaitType } : {}),
    dependencies: dependenciesOf(task).map((edge) => ({ id: edge.id, dependency_type: edge.type, title: edge.title, status: edge.status })),
  };
}

const waitsOnBlocker = (task: TaskRow) => dependenciesOf(task).some((edge) => edge.type === 'blocks' && edge.status !== 'closed');
const labelReads = Object.keys(LABEL_READS) as (keyof typeof LABEL_READS)[];

/** The snapshot summary's lists (TASK_REQUIRED_READS, TASK_OPTIONAL_READS)
 * from a project's two boards: every status (with its epics), and the closes
 * over TASK_CLOSES_DAYS, and the label reads (LABEL_READS) where Ntasks
 * answered them; a read it did not answer stays absent, which the cards show
 * as one never made. */
export function boardReads(board: unknown, closes: unknown, labelled: Record<string, unknown> = {}) {
  // A board without a task list is no answer: its lists stay absent, so the
  // summary fails the project rather than reporting an empty one.
  const all = taskRecord(board);
  const tasks = recordList(all?.tasks);
  const closed = recordList(taskRecord(closes)?.tasks);
  const epics = recordList(all?.epics);
  const open = (tasks ?? []).filter((task) => task.status !== 'closed');
  const active = open.filter((task) => task.status === 'open' || task.status === 'in_progress' || task.status === 'blocked');
  return {
    ...(tasks === null ? {} : {
      active: active.map(runnerRow),
      ready: open.filter((task) => task.ready === true).map(runnerRow),
      blocked: active.filter((task) => task.status === 'blocked' || (task.status === 'open' && task.ready !== true && waitsOnBlocker(task))).map(runnerRow),
      deferred: open.filter((task) => task.status === 'deferred').map(runnerRow),
      human: open.filter((task) => task.issueType !== 'gate'
        && (Array.isArray(task.labels) || typeof task.labels === 'string') && task.labels.includes('human')).map(runnerRow),
      gates: open.filter((task) => task.issueType === 'gate').map((task) => ({ ...runnerRow(task), await_type: task.awaitType ?? 'human' })),
    }),
    ...(closed === null ? {} : { closed: closed.filter((task) => task.status === 'closed').map(runnerRow) }),
    ...Object.fromEntries(labelReads.flatMap((read) => {
      const rows = recordList(labelled[read]);
      return rows === null ? [] : [[read, rows.map(runnerRow)]];
    })),
    ...(epics === null ? {} : { epics: epics.map((epic) => ({
      epic: { id: epic.id, title: epic.title, status: epic.status, priority: epic.priority },
      total_children: epic.total, closed_children: epic.closed, eligible_for_close: epic.eligibleForClose === true,
    })) }),
  };
}

/** The feed after `cursor`, at most FEED_PAGES pages: the projects it names,
 * and where to ask next. `complete` is false when more remained. */
export async function readFeed(service: NtasksReads, cursor: number, { pages = FEED_PAGES, limit = FEED_PAGE, checkHiddenEvents = false } = {}) {
  const changed = new Set<string>();
  let at = cursor;
  for (let page = 0; page < pages; page += 1) {
    const response = await service.call({ method: 'GET', path: `/api/changes?after=${at}&limit=${limit}` });
    const { status } = response;
    const body = taskRecord(response.body);
    if (status !== 200 || !Array.isArray(body?.events) || typeof body.lastSeq !== 'number' || !Number.isSafeInteger(body.lastSeq) || body.lastSeq < at) {
      throw new TaskServiceUnavailable(status === 401 || status === 403 ? 'refused' : 'invalid-response', status);
    }
    for (const value of body.events) {
      const event = taskRecord(value);
      if (typeof event?.projectId === 'string') changed.add(event.projectId);
    }
    const moved = body.lastSeq !== at;
    at = body.lastSeq;
    if (!moved || !checkHiddenEvents && body.events.length < limit) return { changed, cursor: at, complete: true };
  }
  return { changed, cursor: at, complete: false };
}
