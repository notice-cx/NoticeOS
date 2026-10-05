import type { Ga4RateLimit } from '@noticeos/contract';
import { Ga4ReadError } from './ga4-read-errors.js';
import { normalizeSignalError } from './signal-store.js';
import { cachedProviderRead, providerCacheScope, ProviderReadCacheError, type ProviderReadCache, type ProviderReadFailure } from './provider-read-cache.js';

export type Ga4ReadCache = ProviderReadCache;
export const ga4CacheScope = providerCacheScope;
interface Ga4StoredFailure extends ProviderReadFailure { rateLimit?: Ga4RateLimit }

/** Keep the established Google keys, cooldowns and one early cold-cache read.
 * The shared core stores completed data rather than cross-request promises. */
export async function cachedGa4Read<T>(context: Ga4ReadCache | null, capability: string, nowMs: number, ttlMs: number, read: () => Promise<T>): Promise<{ value: T; observedAt: string }> {
  if (!context) {
    const observedAt = new Date(nowMs).toISOString();
    return { value: await read(), observedAt };
  }
  try {
    const entry = await cachedProviderRead<T, Ga4StoredFailure>(context, {
      cacheNamespace: 'ga4/v2', leaseNamespace: 'ga4-read', capability,
      nowMs, ttlMs, leaseMs: 30_000, allowEarlyRead: true, failureRetryMs: 60_000,
    }, read, (error, at, retryAt) => {
      const normalized = normalizeSignalError(error, 'The Google traffic read failed.');
      return { ok: false, code: normalized.code, observedAt: at,
        refreshAt: error instanceof Ga4ReadError ? error.nextAttemptAt : retryAt,
        ...(error instanceof Ga4ReadError && error.rateLimit ? { rateLimit: error.rateLimit } : {}),
      };
    });
    if (!entry.ok) throw new Ga4ReadError(entry.code, entry.observedAt, entry.refreshAt, entry.rateLimit);
    return { value: entry.value, observedAt: entry.observedAt };
  } catch (error) {
    if (error instanceof ProviderReadCacheError) {
      throw new Ga4ReadError(`ga4_read_${error.code}`, error.observedAt, error.nextAttemptAt);
    }
    throw error;
  }
}
