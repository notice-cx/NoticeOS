/** Safe categories only. Provider messages may contain identifiers and must
 * never be copied into the live payload or logs. */
import type { Ga4RateLimit } from '@noticeos/contract';
import { SignalError } from './signal-store.js';

export function ga4RateLimitKind(message: string): Ga4RateLimit {
  if (/server.?errors?/i.test(message)) return 'server-errors';
  if (/concurren/i.test(message)) return 'concurrency';
  if (/daily|per.day|per.property.per.day/i.test(message)) return /token/i.test(message) ? 'daily-tokens' : 'daily-requests';
  if (/hour/i.test(message)) return /project/i.test(message) ? 'project-hourly-tokens' : 'hourly-tokens';
  if (/minute/i.test(message)) return 'requests-per-minute';
  if (/second/i.test(message)) return 'requests-per-second';
  return 'unspecified';
}

export class Ga4ReadError extends SignalError {
  constructor(code: string, readonly observedAt: string, readonly nextAttemptAt: string, readonly rateLimit?: Ga4RateLimit) {
    super(code, 'The Google traffic read is unavailable.');
  }
}

export function ga4ReadFailure(prefix: string, response: Response, body: unknown, startedAt = Date.now(), now = startedAt): Ga4ReadError {
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
  // The next attempt is a cooldown, never a quota-reset claim.
  const until = ga4RetryAfter(response, now) ?? now + (response.status === 429 ? 300_000 : 60_000);
  return new Ga4ReadError(`${prefix}_http_${response.status}`, new Date(startedAt).toISOString(), new Date(until).toISOString(), response.status === 429 ? ga4RateLimitKind(message) : undefined);
}

export function ga4RetryAfter(response: Response, now: number): number | null {
  const raw = response.headers.get('retry-after');
  const retry = raw && /^\d+$/.test(raw) ? now + Number(raw) * 1000 : raw ? Date.parse(raw) : NaN;
  return Number.isFinite(retry) && retry > now && retry <= 8.64e15 ? retry : null;
}
