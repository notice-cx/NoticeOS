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
  const rawRetry = response.headers.get('retry-after');
  const retry = rawRetry && /^\d+$/.test(rawRetry) ? now + Number(rawRetry) * 1000 : rawRetry ? Date.parse(rawRetry) : NaN;
  // Respect a supplied Retry-After; otherwise cool down
  // refusals for five minutes. The next attempt is not a quota-reset claim.
  const until = Number.isFinite(retry) && retry > now && retry <= 8.64e15 ? retry : now + (response.status === 429 ? 300_000 : 60_000);
  return new Ga4ReadError(`${prefix}_http_${response.status}`, new Date(startedAt).toISOString(), new Date(until).toISOString(), response.status === 429 ? ga4RateLimitKind(message) : undefined);
}
