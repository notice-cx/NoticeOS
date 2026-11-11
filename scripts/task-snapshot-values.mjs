// Pure task values the snapshot summary and the runner's filing lanes share.
/** Enough of a failure to diagnose it, bounded so a runaway message cannot
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
