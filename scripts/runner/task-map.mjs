// runner/task-map.mjs — the hourly task-map lane. An installation's tasks live
// in Ntasks, which keeps no task databases to check the saved projects
// against, so the lane stands down on every pass and says why.

import { isShuttingDown } from './lifecycle.mjs';
import { laneSkips, log } from './log.mjs';
import { taskBackend, taskLaneSkip } from './task-service-poll.mjs';

const taskMapState = { skipping: null };

export async function runTaskMapCheck(deps = {}) {
  const {
    state = taskMapState,
    emit = log,
    stopped = () => isShuttingDown(),
    taskService = null,
  } = deps;

  const { skip } = laneSkips('task map check', state, emit);

  if (stopped()) return null;
  const backend = await taskBackend(taskService);
  return skip(taskLaneSkip(backend, 'check task databases') ?? 'tasks live in Ntasks, which keeps no task databases to check');
}
