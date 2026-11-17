// runner/task-service-poll.mjs — the task snapshot while this installation's
// tasks live in Ntasks (docs/11-integrations.md#ntasks). Each tick reads at
// most FEED_PAGES pages of Ntasks's change feed after the kept position,
// rereads the boards of every project the feed names (and of any whose
// boards are older than BOARD_MAX_AGE_MS, since a deferral ending changes
// ready work with no event), keeps them where the Tower's task routes find
// them offline (scripts/task-service-cache.mts), and builds the snapshot the
// Tower's portfolio screens read from those boards.

import { ALL_STATUSES, boardKey, labelKey, readCached, readSyncState, writeCached, writeSyncState } from '../task-service-cache.mjs';
import { mapTaskProjects, TaskServiceUnavailable } from '../task-service.mjs';
import { boardReads, LABEL_READS, readFeed, readLabels } from '../ntasks-board.mjs';
export { boardReads, LABEL_PAGE, LABEL_PAGES, LABEL_READS, readFeed, readLabelled, runnerRow, FEED_PAGE, FEED_PAGES } from '../ntasks-board.mjs';
import { TASK_CLOSES_DAYS, tasksClosedSince, tasksClosesSince, taskProjectError, summarizeTaskProject } from '../task-snapshot-summary.mjs';

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

/** The closes the snapshot reaches back over, as one closed-only board read. */
const closesKey = (asset) => boardKey(asset, 'closed', TASK_CLOSES_DAYS);

/** Reads one project's two boards and keeps them; false when Ntasks gave neither. */
async function refreshBoards(service, project, cacheDir, now) {
  const id = encodeURIComponent(project.project.projectId);
  const [board, closes] = await Promise.all([`/api/tasks?project=${id}`, `/api/tasks?project=${id}&status=closed&closedDays=${TASK_CLOSES_DAYS}`]
    .map((path) => service.call({ method: 'GET', path })));
  if (board.status !== 200 || closes.status !== 200 || !Array.isArray(board.body?.tasks) || !Array.isArray(closes.body?.tasks)) return false;
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
  const reach = { closedSince: tasksClosedSince(now()), closesSince: tasksClosesSince(now()) };
  const entries = [];
  for (const project of projects) {
    if (!project.project) { entries.push(taskProjectError(project, `No Ntasks project has the prefix ${project.prefix}`)); continue; }
    const board = await readCached(cacheDir, boardKey(project.asset, ALL_STATUSES));
    const closes = await readCached(cacheDir, closesKey(project.asset));
    if (failed.has(project.asset) || !board || !closes) { entries.push(taskProjectError(project, `Ntasks did not answer for ${project.project.displayName}`)); continue; }
    const labelled = {};
    for (const read of Object.keys(LABEL_READS)) {
      const kept = await readCached(cacheDir, labelKey(project.asset, read));
      if (Array.isArray(kept?.body)) labelled[read] = kept.body;
    }
    entries.push(summarizeTaskProject(project, boardReads(board.body, closes.body, labelled), reach));
  }
  return { body: { capturedAt: new Date(now()).toISOString(), projects: entries }, feed };
}
