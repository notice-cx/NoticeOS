// runner/task-service-register.mjs — what the runner's filing lanes
// (panel-review.mjs, watch-readbacks.mjs) do in the task register while it is
// Ntasks: read a project's tasks, read one task, comment, file and link, each
// through the installation's task service and named for the lane's own agent.
// Rows come back in the shape `bd --json` gave (task-service-poll.mjs bdRow),
// so the lanes' rules read them unchanged.

import { mapTaskProjects, TaskServiceUnavailable } from '../task-service.mjs';
import { bdRow } from './task-service-poll.mjs';

/** Closed tasks a label read reaches back over: Ntasks's longest closed read. */
export const LABEL_CLOSED_DAYS = 56;

function failed(what, reply) {
  const detail = typeof reply.body?.detail === 'string' ? `: ${reply.body.detail}` : '';
  return new Error(`Ntasks ${what} answered HTTP ${reply.status}${detail}`);
}

/**
 * The register for `service`, acting as `actor`. Each call names the saved
 * task project (a config/beads.json spoke) it is for, and is refused when no
 * Ntasks project has that project's prefix.
 */
export function ntasksRegister(service, actor) {
  async function projectOf(spoke) {
    const [mapped] = mapTaskProjects([spoke], await service.projects());
    if (!mapped?.project) throw new Error(`no Ntasks project has the prefix ${spoke.prefix}`);
    return mapped.project.projectId;
  }
  async function get(path, what) {
    const reply = await service.call({ method: 'GET', path });
    if (reply.status !== 200) throw failed(what, reply);
    return reply.body;
  }
  return Object.freeze({
    /** Every task carrying `label`, open or closed in the last LABEL_CLOSED_DAYS days. */
    async labelled(spoke, label) {
      const id = encodeURIComponent(await projectOf(spoke));
      const [board, closes] = await Promise.all([get(`/api/tasks?project=${id}`, 'board read'),
        get(`/api/tasks?project=${id}&status=closed&closedDays=${LABEL_CLOSED_DAYS}`, 'closed read')]);
      const rows = new Map();
      for (const task of [...(board?.tasks ?? []), ...(closes?.tasks ?? [])]) {
        if (typeof task?.id === 'string' && Array.isArray(task.labels) && task.labels.includes(label)) rows.set(task.id, bdRow(task));
      }
      return [...rows.values()];
    },
    async show(spoke, taskId) {
      const body = await get(`/api/tasks/${encodeURIComponent(taskId)}?project=${encodeURIComponent(await projectOf(spoke))}`, 'task read');
      if (body?.task?.id !== taskId) throw new Error('Ntasks answered for another task');
      return bdRow(body.task);
    },
    async comment(spoke, taskId, text, idempotencyKey) {
      const reply = await service.call({ method: 'POST', path: `/api/tasks/${encodeURIComponent(taskId)}/comments`,
        body: { projectId: await projectOf(spoke), text }, idempotencyKey, onBehalfOf: actor });
      if (reply.status < 200 || reply.status >= 300) throw failed('comment', reply);
    },
    /** Files a task and answers its id; the same key files it once. */
    async create(spoke, fields, idempotencyKey) {
      const reply = await service.call({ method: 'POST', path: '/api/tasks', body: { ...fields, projectId: await projectOf(spoke) },
        idempotencyKey, onBehalfOf: actor });
      if (reply.status < 200 || reply.status >= 300 || typeof reply.body?.id !== 'string') throw failed('create', reply);
      return reply.body.id;
    },
    /** Links two tasks of the project as related; a link they already have stays as it is. */
    async relate(spoke, taskId, otherId) {
      await service.tool('add_dependency', { workspace: '', project: await projectOf(spoke), task: taskId, depends_on: otherId, type: 'related' }, actor);
    },
  });
}

export { TaskServiceUnavailable };
