// runner/task-service-register.mjs — what the runner's filing lanes
// (panel-review.mjs, watch-readbacks.mjs) do in the task register while it is
// Ntasks: read a project's tasks, read one task, comment, file and link, each
// through the installation's task service and named for the lane's own agent.
// Rows come back in the shape `bd --json` gave (task-service-poll.mjs bdRow),
// so the lanes' rules read them unchanged.

import { mapTaskProjects, TaskServiceUnavailable } from '../task-service.mjs';
import { bdRow, readLabelled } from './task-service-poll.mjs';

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
    /** Every task carrying `label`, open or closed at any time. */
    async labelled(spoke, label) {
      return (await readLabelled(service, await projectOf(spoke), label)).map(bdRow);
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
    /** Sets the one link between two tasks of the project to related, replacing
     * the kind it had, or removes it with `remove`. */
    async relate(spoke, taskId, otherId, { remove = false } = {}) {
      await service.tool('link_tasks', { workspace: '', project: await projectOf(spoke), task: taskId, to: otherId,
        ...(remove ? { remove: true } : { type: 'related' }) }, actor);
    },
  });
}

export { TaskServiceUnavailable };
