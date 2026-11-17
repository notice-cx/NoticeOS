import { TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';

/** Ntasks gave no answer. `reason` is the ingest's: `not-connected`, `network`,
 * `timeout`, `redirect`, `too-large`, `invalid-response`, or `ingest` when the
 * ingest itself did not answer. Nothing it was asked to change is known to have changed. */
export class TaskServiceUnavailable extends Error {
  override name = 'TaskServiceUnavailable';
  constructor(readonly reason: string, readonly status?: number) { super(`The task service did not answer (${reason}).`); }
}
/** Ntasks refused to register the Tower as a connected app: its RFC 7591 code and HTTP status. */
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A task as Ntasks's task routes answer it, with its close and its claim also
 * written under the NoticeOS metadata keys the task snapshot, the readback lane
 * and the Tower's close attribution read (packages/contract/src/task-metadata.mts).
 * Ntasks keeps them on the task itself; a close it imported without a closer
 * gains none. */
export function withNoticeosRecords<T extends Record<string, unknown>>(task: T): T {
  const recorded: Record<string, string> = {};
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '' ? value : null;
  const closedBy = text(task.closedBy), closedAt = text(task.closedAt);
  if (closedBy !== null && closedAt !== null) {
    recorded[TASK_METADATA.closedBy.name] = closedBy;
    recorded[TASK_METADATA.closedAt.name] = closedAt;
    const model = text(task.closedModel), resolution = text(task.resolution), duplicateOf = text(task.duplicateOf);
    if (model !== null) recorded[TASK_METADATA.closedModel.name] = model;
    if (resolution !== null) recorded[TASK_METADATA.resolution.name] = resolution;
    if (duplicateOf !== null) recorded[TASK_METADATA.duplicateOf.name] = duplicateOf;
  }
  const claimedModel = text(task.assigneeModel);
  if (claimedModel !== null) recorded[TASK_METADATA.claimedModel.name] = claimedModel;
  if (Object.keys(recorded).length === 0) return task;
  return { ...task, metadata: { ...(row(task.metadata) ?? {}), ...recorded } };
}
