import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';

export interface ProviderReadCache {
  /** The call's store, where the lease row lives (`noticeos.integration_leases`). */
  store: WorkspaceStore;
  cache: Cache;
  /** SHA-256 of the adapter's resolved connection and complete target mapping.
   * The cache boundary adds the store and workspace; callers cannot omit them. */
  scope: string;
  /** Changes the cached value without resetting the shared request cooldown. */
  version?: string;
  clock?: () => number;
}
export interface ProviderReadFailure { ok: false; code: string; observedAt: string; refreshAt: string }
export type StoredProviderRead<T, Failure extends ProviderReadFailure> =
  | { ok: true; value: T; observedAt: string; refreshAt: string }
  | Failure;
export interface ProviderReadPolicy {
  cacheNamespace: string;
  leaseNamespace: string;
  capability: string;
  nowMs: number;
  ttlMs: number;
  leaseMs: number;
  allowEarlyRead: boolean;
  failureRetryMs: number;
}
export class ProviderReadCacheError extends Error {
  constructor(readonly code: 'cache_unavailable' | 'coordination_unavailable' | 'in_progress', readonly observedAt: string, readonly nextAttemptAt: string) {
    super('The provider read is unavailable.');
  }
}

export async function providerCacheScope(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Completed values cross calls; request-owned I/O never does. Workspace rows
 * coordinate cold reads, and each adapter retains its existing retry policy. */
export async function cachedProviderRead<T, Failure extends ProviderReadFailure>(
  context: ProviderReadCache,
  policy: ProviderReadPolicy,
  read: () => Promise<T>,
  failedRead: (error: unknown, observedAt: string, retryAt: string) => Failure,
): Promise<StoredProviderRead<T, Failure>> {
  let nowMs = policy.nowMs;
  const { ttlMs, capability } = policy;
  const clock = context.clock ?? (() => nowMs);
  let at = new Date(clock()).toISOString();
  const workspace = await providerCacheScope([context.store.where, await context.store.workspaceId()]);
  const key = `https://noticeos-cache.internal/${policy.cacheNamespace}/${workspace}/${context.scope}/${capability}/${context.version ?? 'current'}`;
  const lease = `${policy.leaseNamespace}:${context.scope}:${capability}`;
  let prior: StoredProviderRead<T, Failure> | undefined;
  try {
    const response = await context.cache.match(key);
    if (response) prior = await response.json<StoredProviderRead<T, Failure>>();
  } catch {
    throw new ProviderReadCacheError('cache_unavailable', at, new Date(nowMs + policy.failureRetryMs).toISOString());
  }
  nowMs = clock();
  if (prior && Date.parse(prior.refreshAt) > nowMs) return prior;
  const owner = crypto.randomUUID();
  // One owner at a time; a refusal's cooldown blocks everyone, a success's
  // blocks only callers with something to show. The claim returns the cooldown
  // it found (a claim never changes it; none yet is NULL), and a row only when
  // it now owns the lease. Postgres locks the row, so of two claims at once the
  // second waits for the first and then finds it held.
  let claim: { cooldown_until: string | null } | undefined;
  try {
    const takeNow = nowMs;
    [claim] = await context.store.write((tx) => tx.query<{ cooldown_until: string | null }>(
      `INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)
       ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE l.expires_at <= $5::timestamptz
          AND (l.cooldown_until IS NULL OR l.cooldown_until <= $5::timestamptz OR ($6::boolean AND l.last_error IS NULL))
       RETURNING l.cooldown_until`,
      [tx.workspaceId, lease, owner, new Date(takeNow + policy.leaseMs), new Date(takeNow), policy.allowEarlyRead && !prior]));
  } catch {
    throw new ProviderReadCacheError('coordination_unavailable', at, new Date(nowMs + policy.failureRetryMs).toISOString());
  }
  if (!claim) {
    const [held] = await context.store.read((tx) => tx.query<{ cooldown_until: string | null; expires_at: string; last_error: string | null }>(
      'SELECT cooldown_until, expires_at, last_error FROM noticeos.integration_leases WHERE lease_key = $1', [lease]));
    if (held && held.cooldown_until !== null && instantMs(held.cooldown_until) > nowMs && held.last_error) {
      const failure = JSON.parse(held.last_error) as Failure;
      return failure;
    }
    if (prior) return prior;
    const retryAt = Math.max(nowMs + 1_000,
      held?.cooldown_until ? instantMs(held.cooldown_until) : 0,
      held ? instantMs(held.expires_at) : 0);
    throw new ProviderReadCacheError('in_progress', at, new Date(retryAt).toISOString());
  }
  // Inside the last success's cooldown: only a caller with nothing cached gets
  // here, and its release (below) holds the lease through its own cooldown.
  const early = claim.cooldown_until !== null && instantMs(claim.cooldown_until) > nowMs;
  let entry: StoredProviderRead<T, Failure> | undefined;
  try {
    // A previous owner may have completed between our cache read and claim.
    const completed = await context.cache.match(key);
    if (completed) {
      const cached = await completed.json<StoredProviderRead<T, Failure>>();
      if (Date.parse(cached.refreshAt) > nowMs) return cached;
    }
    try {
      nowMs = clock();
      at = new Date(nowMs).toISOString();
      entry = { ok: true, value: await read(), observedAt: at, refreshAt: new Date(nowMs + ttlMs).toISOString() };
    } catch (error) {
      entry = failedRead(error, at, new Date(nowMs + policy.failureRetryMs).toISOString());
    }
    // Keep the last observation while one caller refreshes it; refreshAt is
    // the provider cadence, and observedAt always dates the actual attempt.
    await context.cache.put(key, Response.json(entry, { headers: { 'cache-control': 'max-age=86400' } }));
    return entry;
  } finally {
    if (entry) {
      const cooldown = Date.parse(entry.refreshAt);
      const written = entry;
      await context.store.write((tx) => tx.execute(
        `UPDATE noticeos.integration_leases SET expires_at = $1::timestamptz, cooldown_until = $2::timestamptz, last_error = $3
          WHERE lease_key = $4 AND owner = $5`,
        [new Date(early ? cooldown : 0), new Date(cooldown), written.ok ? null : JSON.stringify(written), lease, owner]));
    } else {
      // Nothing was read: the cooldown stays as the claim found it. A lease
      // given back ends at the epoch, as D1's `expires_at = 0` did.
      await context.store.write((tx) => tx.execute(
        'UPDATE noticeos.integration_leases SET expires_at = $1::timestamptz WHERE lease_key = $2 AND owner = $3',
        [new Date(0), lease, owner]));
    }
  }
}

/** A stored instant in epoch milliseconds. */
function instantMs(instant: string): number {
  return Date.parse(javascriptInstant(instant));
}
