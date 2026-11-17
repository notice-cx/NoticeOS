import { HANDOFF_LABELS } from '../packages/contract/src/task-metadata.mjs';
import { PANEL_REVIEW_LABEL } from './panel-review-summary.mjs';
import { TaskServiceUnavailable, withNoticeosRecords } from './task-records.mjs';

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
export async function readLabelled(service, projectId, label, { pages = LABEL_PAGES } = {}) {
  const tasks = [];
  let after = null;
  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({ project: projectId, label, limit: String(LABEL_PAGE), ...(after === null ? {} : { after }) });
    const { status, body } = await service.call({ method: 'GET', path: `/api/tasks?${query}` });
    if (status !== 200 || !Array.isArray(body?.tasks)) {
      const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
      throw new Error(`Ntasks's read of the ${label} label answered HTTP ${status}${detail}`);
    }
    tasks.push(...body.tasks);
    if (typeof body.next !== 'string') return tasks;
    after = body.next;
  }
  throw new Error(`more than ${pages * LABEL_PAGE} tasks carry the ${label} label`);
}

/** The tasks a read's labels name, each once. */
export async function readLabels(service, projectId, labels) {
  const rows = new Map();
  for (const label of labels) for (const task of await readLabelled(service, projectId, label)) rows.set(task.id, task);
  return [...rows.values()];
}

/** One Ntasks task as a row of snake_case fields: the shape the snapshot
 * summary (scripts/task-snapshot-summary.mjs) and the runner's filing lanes
 * read. */
export function runnerRow(ntasksTask) {
  const task = withNoticeosRecords(ntasksTask);
  return {
    id: task.id, title: task.title, status: task.status, priority: task.priority, issue_type: task.issueType,
    assignee: task.assignee, updated_at: task.updatedAt, closed_at: task.closedAt, created_at: task.createdAt,
    started_at: task.startedAt, parent: task.parent, defer_until: task.deferUntil, due_at: task.dueAt ?? null, description: task.description,
    acceptance_criteria: task.acceptance, labels: task.labels, comment_count: task.comments, metadata: task.metadata,
    close_reason: task.closeReason, ...(task.awaitType ? { await_type: task.awaitType } : {}),
    dependencies: (task.dependencies ?? []).map((edge) => ({ id: edge.id, dependency_type: edge.type, title: edge.title, status: edge.status })),
  };
}

const waitsOnBlocker = (task) => (task.dependencies ?? []).some((edge) => edge.type === 'blocks' && edge.status !== 'closed');

/** The snapshot summary's lists (TASK_REQUIRED_READS, TASK_OPTIONAL_READS)
 * from a project's two boards: every status (with its epics), and the closes
 * over TASK_CLOSES_DAYS, and the label reads (LABEL_READS) where Ntasks
 * answered them; a read it did not answer stays absent, which the cards show
 * as one never made. */
export function boardReads(board, closes, labelled = {}) {
  // A board without a task list is no answer: its lists stay absent, so the
  // summary fails the project rather than reporting an empty one.
  const tasks = Array.isArray(board?.tasks) ? board.tasks : null;
  const closed = Array.isArray(closes?.tasks) ? closes.tasks : null;
  const open = (tasks ?? []).filter((task) => task.status !== 'closed');
  const active = open.filter((task) => ['open', 'in_progress', 'blocked'].includes(task.status));
  return {
    ...(tasks === null ? {} : {
      active: active.map(runnerRow),
      ready: open.filter((task) => task.ready === true).map(runnerRow),
      blocked: active.filter((task) => task.status === 'blocked' || (task.status === 'open' && task.ready !== true && waitsOnBlocker(task))).map(runnerRow),
      deferred: open.filter((task) => task.status === 'deferred').map(runnerRow),
      human: open.filter((task) => task.issueType !== 'gate' && (task.labels ?? []).includes('human')).map(runnerRow),
      gates: open.filter((task) => task.issueType === 'gate').map((task) => ({ ...runnerRow(task), await_type: task.awaitType ?? 'human' })),
    }),
    ...(closed === null ? {} : { closed: closed.filter((task) => task.status === 'closed').map(runnerRow) }),
    ...Object.fromEntries(Object.keys(LABEL_READS).filter((read) => Array.isArray(labelled[read]))
      .map((read) => [read, labelled[read].map(runnerRow)])),
    ...(Array.isArray(board?.epics) ? { epics: board.epics.map((epic) => ({
      epic: { id: epic.id, title: epic.title, status: epic.status, priority: epic.priority },
      total_children: epic.total, closed_children: epic.closed, eligible_for_close: epic.eligibleForClose === true,
    })) } : {}),
  };
}

/** The feed after `cursor`, at most FEED_PAGES pages: the projects it names,
 * and where to ask next. `complete` is false when more remained. */
export async function readFeed(service, cursor, { pages = FEED_PAGES, limit = FEED_PAGE, checkHiddenEvents = false } = {}) {
  const changed = new Set();
  let at = cursor;
  for (let page = 0; page < pages; page += 1) {
    const { status, body } = await service.call({ method: 'GET', path: `/api/changes?after=${at}&limit=${limit}` });
    if (status !== 200 || !Array.isArray(body?.events) || !Number.isSafeInteger(body.lastSeq) || body.lastSeq < at) {
      throw new TaskServiceUnavailable(status === 401 || status === 403 ? 'refused' : 'invalid-response', status);
    }
    for (const event of body.events) if (typeof event?.projectId === 'string') changed.add(event.projectId);
    const moved = body.lastSeq !== at;
    at = body.lastSeq;
    if (!moved || !checkHiddenEvents && body.events.length < limit) return { changed, cursor: at, complete: true };
  }
  return { changed, cursor: at, complete: false };
}
