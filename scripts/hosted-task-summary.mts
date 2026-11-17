import type { BeadsProjectInput } from '../packages/contract/src/task-snapshot.mjs';
import type { MappedTaskProject } from './task-projects.mjs';
import { boardReads, LABEL_READS, readFeed, readLabels, type NtasksReads } from './ntasks-board.mjs';
import { summarizeTaskProject, TASK_CLOSES_DAYS, taskProjectError, tasksClosedSince, tasksClosesSince } from './task-snapshot-summary.mjs';
import { TaskServiceUnavailable } from './task-records.mjs';

export function assertHostedTaskReadAccess(status: number | undefined): void {
  if (status === 401 || status === 403) throw new TaskServiceUnavailable('refused', status);
}

async function readTogether<T>(reads: readonly Promise<T>[]): Promise<T[]> {
  const replies = await Promise.allSettled(reads);
  // Once a refusal is known, an interruption of a separate read cannot hide it.
  const denial = replies.find(reply => reply.status === 'rejected'
    && reply.reason instanceof TaskServiceUnavailable && reply.reason.reason === 'refused');
  if (denial?.status === 'rejected') throw denial.reason;
  return replies.map(reply => {
    if (reply.status === 'rejected') throw reply.reason;
    return reply.value;
  });
}

/** An interrupted capture leaves both the baseline and cursor at their last
 * saved values. An expired cursor triggers a fresh read, with the same page cap. */
export async function hostedTaskChanges(service: NtasksReads, cursor: number): Promise<{ changed: Set<string>; cursor: number; complete: boolean; reset: boolean }> {
  const options = { pages: 3, checkHiddenEvents: true };
  try { return { ...await readFeed(service, cursor, options), reset: false }; }
  catch (error) {
    if (cursor === 0 || !(error instanceof TaskServiceUnavailable) || ![400, 410].includes(error.status ?? 0)) throw error;
    return { ...await readFeed(service, 0, options), reset: true };
  }
}

/** Read one project completely before starting the next. This limits response
 * memory and avoids an unchecked fan-out to the service on a large portfolio. */
export async function readHostedTaskBoards(service: NtasksReads, projects: readonly MappedTaskProject[], now: number): Promise<BeadsProjectInput[]> {
  const reach = { closedSince: tasksClosedSince(now), closesSince: tasksClosesSince(now) };
  const results: BeadsProjectInput[] = [];
  for (const project of projects) {
    if (project.project === null) {
      results.push(taskProjectError(project, 'Ntasks has not granted access to this project.'));
      continue;
    }
    const id = encodeURIComponent(project.project.projectId);
    const [board, closes] = await readTogether([`/api/tasks?project=${id}`, `/api/tasks?project=${id}&status=closed&closedDays=${TASK_CLOSES_DAYS}`]
      .map(path => service.call({ method: 'GET', path })));
    assertHostedTaskReadAccess(board?.status);
    assertHostedTaskReadAccess(closes?.status);
    if (board?.status !== 200 || closes?.status !== 200) throw new TaskServiceUnavailable('invalid-response');
    const labels = await readTogether(Object.entries(LABEL_READS).map(async ([key, names]) =>
      [key, await readLabels(service, project.project!.projectId, names)] as const));
    const entry = summarizeTaskProject(project, boardReads(board.body, closes.body, Object.fromEntries(labels)), reach);
    if (!entry.ok) throw new TaskServiceUnavailable('invalid-response');
    results.push(entry);
  }
  return results;
}
