// runner/task-service-poll.mjs — the task snapshot while this installation's
// tasks live in Ntasks (docs/11-integrations.md#ntasks). Each tick reads at
// most FEED_PAGES pages of Ntasks's change feed after the kept position,
// rereads the boards of every project the feed names (and of any whose
// boards are older than BOARD_MAX_AGE_MS, since a deferral ending changes
// ready work with no event), keeps them where the Tower's task routes find
// them offline (scripts/task-service-cache.mts), and builds the snapshot the
// Tower's portfolio screens read from those boards.

import { ALL_STATUSES, boardKey, labelKey, readCached, readSyncState, writeCached, writeSyncState } from '../task-service-cache.mjs';
import { HANDOFF_LABELS } from '../../packages/contract/src/task-metadata.mjs';
import { PANEL_REVIEW_LABEL } from '../panel-review-summary.mjs';
import { mapTaskProjects, TaskServiceUnavailable, withNoticeosRecords } from '../task-service.mjs';
import { BEADS_CLOSES_DAYS, beadsClosedSince, beadsClosesSince, beadsProjectError, summarizeBeadsProject } from '../task-snapshot-summary.mjs';

export const FEED_PAGE = 200;
export const FEED_PAGES = 5;
export const BOARD_MAX_AGE_MS = 15 * 60_000;

/** Where this installation's tasks live: `ntasks`, `none` while no task
 * service is connected, or `unknown` when the ingest has never said. */
export async function taskBackend(service) {
  return service == null ? 'none' : service.backend();
}

export const NO_TASK_SERVICE = 'no task service is connected';

/** Why a task lane stands down while its tasks are not in Ntasks, or null when they are. */
export function taskLaneSkip(backend, lane) {
  if (backend === 'ntasks') return null;
  const why = backend === 'unknown' ? 'the ingest has not said whether tasks live in Ntasks' : NO_TASK_SERVICE;
  return `${why}, so this lane does not ${lane}`;
}

/** The task-service lane's record: whether the ingest says Ntasks is connected. */
export async function taskServiceCheck(service) {
  if (service == null) return { outcome: 'skipped', detail: NO_TASK_SERVICE };
  try {
    return await service.connected() ? { outcome: 'ran', detail: 'Ntasks is connected' } : { outcome: 'skipped', detail: NO_TASK_SERVICE };
  } catch {
    return { outcome: 'ran', detail: 'the ingest did not say whether a task service is connected' };
  }
}

/** The nightly backup's task setting: `ntasks` while tasks live there, which
 * adds Ntasks's export to the set; none while no task service is connected;
 * `unknown` when the ingest does not answer now, when no backup runs
 * (BACKUP_TASKS_UNKNOWN). Its own read, never an earlier answer: a stale
 * "not connected" would publish a set without the tasks. */
export async function backupTaskHub(service) {
  if (service == null) return undefined;
  try { return await service.connected({ fresh: true }) ? 'ntasks' : undefined; } catch { return 'unknown'; }
}

/** Why no backup ran: a set taken now could leave the tasks out and replace one that has them. */
export const BACKUP_TASKS_UNKNOWN = 'The ingest has not said whether tasks live in Ntasks, so no backup ran; earlier sets are kept.';

/** Ntasks's label read: at most this many pages of LABEL_PAGE per label. */
export const LABEL_PAGES = 10;
export const LABEL_PAGE = 200;
/** The snapshot's two label reads and the labels each takes in, as bd's list did. */
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
async function readLabels(service, projectId, labels) {
  const rows = new Map();
  for (const label of labels) for (const task of await readLabelled(service, projectId, label)) rows.set(task.id, task);
  return [...rows.values()];
}

/** The closes the snapshot reaches back over, as one closed-only board read. */
const closesKey = (asset) => boardKey(asset, 'closed', BEADS_CLOSES_DAYS);

/** One board task as `bd list --json` reported it: the shape the snapshot
 * summary reads (scripts/task-snapshot-summary.mjs). */
export function bdRow(ntasksTask) {
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

const answered = (rows) => ({ code: 0, stdout: JSON.stringify(rows), stderr: '' });
const waitsOnBlocker = (task) => (task.dependencies ?? []).some((edge) => edge.type === 'blocks' && edge.status !== 'closed');

/** The snapshot summary's inputs from a project's two boards: every status
 * (with its epics), and the closes over BEADS_CLOSES_DAYS, and the label reads
 * (LABEL_READS) where Ntasks answered them; a read it did not answer stays
 * absent, which the cards show as one never made. */
export function boardResults(board, closes, labelled = {}) {
  const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
  const open = tasks.filter((task) => task.status !== 'closed');
  const active = open.filter((task) => ['open', 'in_progress', 'blocked'].includes(task.status));
  return {
    active: answered(active.map(bdRow)),
    ready: answered(open.filter((task) => task.ready === true).map(bdRow)),
    blocked: answered(active.filter((task) => task.status === 'blocked' || (task.status === 'open' && task.ready !== true && waitsOnBlocker(task))).map(bdRow)),
    closed: answered((Array.isArray(closes?.tasks) ? closes.tasks : []).filter((task) => task.status === 'closed').map(bdRow)),
    deferred: answered(open.filter((task) => task.status === 'deferred').map(bdRow)),
    human: answered(open.filter((task) => task.issueType !== 'gate' && (task.labels ?? []).includes('human')).map(bdRow)),
    gates: answered(open.filter((task) => task.issueType === 'gate').map((task) => ({ ...bdRow(task), await_type: task.awaitType ?? 'human' }))),
    ...Object.fromEntries(Object.keys(LABEL_READS).filter((read) => Array.isArray(labelled[read]))
      .map((read) => [read, answered(labelled[read].map(bdRow))])),
    ...(Array.isArray(board?.epics) ? { epics: answered(board.epics.map((epic) => ({
      epic: { id: epic.id, title: epic.title, status: epic.status, priority: epic.priority },
      total_children: epic.total, closed_children: epic.closed, eligible_for_close: epic.eligibleForClose === true,
    }))) } : {}),
  };
}

/** The feed after `cursor`, at most FEED_PAGES pages: the projects it names,
 * and where to ask next. `complete` is false when more remained. */
export async function readFeed(service, cursor, { pages = FEED_PAGES, limit = FEED_PAGE } = {}) {
  const changed = new Set();
  let at = cursor;
  for (let page = 0; page < pages; page += 1) {
    const { status, body } = await service.call({ method: 'GET', path: `/api/changes?after=${at}&limit=${limit}` });
    if (status !== 200 || !Array.isArray(body?.events) || !Number.isSafeInteger(body.lastSeq)) {
      throw new TaskServiceUnavailable(status === 401 || status === 403 ? 'refused' : 'invalid-response', status);
    }
    for (const event of body.events) if (typeof event?.projectId === 'string') changed.add(event.projectId);
    const moved = body.lastSeq !== at;
    at = body.lastSeq;
    if (body.events.length < limit || !moved) return { changed, cursor: at, complete: true };
  }
  return { changed, cursor: at, complete: false };
}

/** Reads one project's two boards and keeps them; false when Ntasks gave neither. */
async function refreshBoards(service, project, cacheDir, now) {
  const id = encodeURIComponent(project.project.projectId);
  const [board, closes] = await Promise.all([`/api/tasks?project=${id}`, `/api/tasks?project=${id}&status=closed&closedDays=${BEADS_CLOSES_DAYS}`]
    .map((path) => service.call({ method: 'GET', path })));
  if (board.status !== 200 || closes.status !== 200) return false;
  await writeCached(cacheDir, boardKey(project.asset, ALL_STATUSES), { ...board.body, project: project.asset }, now);
  await writeCached(cacheDir, closesKey(project.asset), { ...closes.body, project: project.asset }, now);
  // A label read Ntasks did not answer is kept as unknown, never as the last answer.
  for (const [read, labels] of Object.entries(LABEL_READS)) {
    const tasks = await readLabels(service, project.project.projectId, labels).catch(() => null);
    await writeCached(cacheDir, labelKey(project.asset, read), tasks, now);
  }
  return true;
}

/**
 * One sync: the feed, the boards it names, and the snapshot body built from
 * the kept boards. Throws TaskServiceUnavailable when Ntasks did not answer,
 * so the caller files nothing and the last snapshot keeps its own time.
 */
export async function syncTaskService({ service, spokes, cacheDir, now = Date.now }) {
  const origin = await service.origin();
  if (origin === null) throw new TaskServiceUnavailable('not-connected');
  const state = await readSyncState(cacheDir, origin);
  const feed = await readFeed(service, state.cursor);
  const projects = mapTaskProjects(spokes, await service.projects());
  const boards = { ...state.boards };
  const failed = new Set();
  for (const project of projects) {
    if (!project.project) continue;
    const id = project.project.projectId;
    const kept = await readCached(cacheDir, boardKey(project.asset, ALL_STATUSES)) !== null && await readCached(cacheDir, closesKey(project.asset)) !== null;
    const stale = !kept || state.cursor === 0 || feed.changed.has(id) || !(now() - Date.parse(boards[id] ?? '') < BOARD_MAX_AGE_MS);
    if (!stale) continue;
    if (await refreshBoards(service, project, cacheDir, now)) boards[id] = new Date(now()).toISOString();
    else {
      // The next tick rereads it, quiet feed or not.
      delete boards[id];
      failed.add(project.asset);
    }
  }
  await writeSyncState(cacheDir, { origin, cursor: feed.cursor, boards });
  const reach = { closedSince: beadsClosedSince(now()), closesSince: beadsClosesSince(now()) };
  const entries = [];
  for (const project of projects) {
    if (!project.project) { entries.push(beadsProjectError(project, `No Ntasks project has the prefix ${project.prefix}`)); continue; }
    const board = await readCached(cacheDir, boardKey(project.asset, ALL_STATUSES));
    const closes = await readCached(cacheDir, closesKey(project.asset));
    if (failed.has(project.asset) || !board || !closes) { entries.push(beadsProjectError(project, `Ntasks did not answer for ${project.project.displayName}`)); continue; }
    const labelled = {};
    for (const read of Object.keys(LABEL_READS)) {
      const kept = await readCached(cacheDir, labelKey(project.asset, read));
      if (Array.isArray(kept?.body)) labelled[read] = kept.body;
    }
    entries.push(summarizeBeadsProject(project, boardResults(board.body, closes.body, labelled), reach));
  }
  return { body: { capturedAt: new Date(now()).toISOString(), projects: entries }, feed };
}
