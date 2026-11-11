// Pure task values shared by standalone and hosted snapshot readers.
/** Enough of a failure to diagnose it, bounded so a runaway stderr cannot
 * become the payload. Must stay under the route's own cap. */
export const TASK_SNAPSHOT_ERROR_MAX = 300;

export function taskText(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function taskInstant(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** A `bd` failure the operator can act on, in one bounded line. */
export function taskFailure(key, result) {
  const detail = taskText(result?.stderr) || taskText(result?.stdout) || 'no output';
  return `bd ${key} exited ${result?.code ?? '?'}: ${detail.split('\n')[0].slice(0, TASK_SNAPSHOT_ERROR_MAX)}`;
}

/** Every status but closed. A lane that files again on recurrence asks only
 * for these: a closed task is a finished episode, not a claim on this one. */
export const TASK_OPEN_STATUSES = 'open,in_progress,blocked,deferred';

/** Every task one repo holds under `label`, as `bd list` argv. A `limit` of 0
 * is unlimited. */
export function taskLabelListArgs(repoDir, label, { closed = false, limit = 0 } = {}) {
  return [
    '-C',
    repoDir,
    'list',
    '--label',
    label,
    '--status',
    closed ? `${TASK_OPEN_STATUSES},closed` : TASK_OPEN_STATUSES,
    '--json',
    '--limit',
    String(limit),
  ];
}
