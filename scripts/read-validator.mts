/** The parts of a read's validator that the Tower's Worker, its local lanes
 * and the browser share (apps/tower/shared/read-validator.ts holds the rest):
 * which fields are left out of the validator, the header a 304 carries them in,
 * and how `If-None-Match` is compared. */

/** Top-level fields that say when an answer was made, not what it says: a
 * read sets `generatedAt` or `readAt` to the moment it ran, and the task
 * snapshot's `capturedAt` moves every minute whether or not a task changed.
 * The validator leaves them out, and a 304 carries their new values in
 * `ANSWER_TIMES_HEADER`. */
export const ANSWER_TIME_FIELDS = ['generatedAt', 'readAt', 'capturedAt'] as const;
export const ANSWER_TIMES_HEADER = 'x-noticeos-answer-times';

/** A JSON body as what it says (the validator's input) and when it was made. */
export function splitAnswerTimes(text: string): { content: string; times: Record<string, string> } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { content: text, times: {} }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { content: text, times: {} };
  const rest: Record<string, unknown> = { ...value };
  const times: Record<string, string> = {};
  for (const field of ANSWER_TIME_FIELDS) {
    const time = rest[field];
    if (typeof time === 'string') { times[field] = time; delete rest[field]; }
  }
  return { content: Object.keys(times).length > 0 ? JSON.stringify(rest) : text, times };
}

/** A held copy with the answer times a 304 carried. */
export function withAnswerTimes(text: string, header: string | null): string {
  if (header === null) return text;
  let times: unknown;
  let value: unknown;
  try { times = JSON.parse(header); value = JSON.parse(text); } catch { return text; }
  if (times === null || typeof times !== 'object' || value === null || typeof value !== 'object' || Array.isArray(value)) return text;
  const next: Record<string, unknown> = { ...value };
  for (const field of ANSWER_TIME_FIELDS) {
    const time = (times as Record<string, unknown>)[field];
    if (typeof time === 'string' && field in next) next[field] = time;
  }
  return JSON.stringify(next);
}

/** Whether `If-None-Match` names this validator. A weak form of the same tag
 * matches, as RFC 9110 compares for `If-None-Match`; `*` never does here,
 * because it is a write precondition, not a read's. */
export function namesValidator(ifNoneMatch: string | null | undefined, validator: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((candidate) => candidate.trim().replace(/^W\//u, '') === validator);
}
