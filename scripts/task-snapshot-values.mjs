// Pure task values shared by standalone and hosted snapshot readers.
/** Enough of a failure to diagnose it, bounded so a runaway stderr cannot
 * become the payload. Must stay under the route's own cap. */
export const BEADS_ERROR_MAX = 300;

export function beadsText(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

export function beadsInstant(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** A `bd` failure the operator can act on, in one bounded line. */
export function beadsFailure(key, result) {
  const detail = beadsText(result?.stderr) || beadsText(result?.stdout) || 'no output';
  return `bd ${key} exited ${result?.code ?? '?'}: ${detail.split('\n')[0].slice(0, BEADS_ERROR_MAX)}`;
}
