import { observeIntegration, tryHealthConnection, type HealthConnection } from './integration-health-context.js';
import { MediavineClient, MediavineError, type Session, type Site } from '@noticeos/mediavine';
import type { MediavineResult } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { assertCredentialOwner, recordCredentialOutcome, resolveCredential, saveMediavineSession, type ResolvedCredential } from './credentials.js';

export interface MediavineOptions { nowMs?: number; fetchImpl?: typeof fetch; beforeRequest?: () => Promise<void>; assertLease?: () => Promise<void> }
export function mediavineMessage(error: unknown): string {
  return error instanceof MediavineError ? error.message : 'Mediavine could not complete this action. Try again later.';
}
/** The Mediavine lease's key in `noticeos.integration_leases`: one row for the
 * whole account, kept between leases, since it also carries the cooldown, the
 * sign-in block and the cached site list. */
export const MEDIAVINE_LEASE = 'mediavine';
/** A lease given back: it ended at the epoch, as D1's `expires_at = 0` did, so
 * a taker on any clock finds it free. */
const RELEASED = new Date(0);
/**
 * One lease covers login, refresh, reports, probes and credential changes
 * across Worker instances. Taking it is one statement: the row is created
 * held, or taken over when it has expired (and, unless `localOnly`, no
 * cooldown or sign-in block holds it). Postgres locks the row, so of two
 * takers at once the second waits for the first and then finds it held.
 */
export async function withMediavineLease<T>(env: IngestEnv, work: (assertLease: () => Promise<void>) => Promise<T>, options: MediavineOptions = {}, localOnly = false): Promise<T> {
  const now = options.nowMs ?? Date.now();
  const started = Date.now();
  const owner = crypto.randomUUID();
  const taken = await env.STORE.write((tx) => tx.execute(
    `INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
     VALUES ($1::uuid, $2, $3, $4::timestamptz)
     ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
      WHERE l.expires_at <= $5::timestamptz
        AND ($6::boolean OR ((l.cooldown_until IS NULL OR l.cooldown_until <= $5::timestamptz) AND NOT l.auth_blocked))`,
    [tx.workspaceId, MEDIAVINE_LEASE, owner, new Date(now + 600_000), new Date(now), localOnly]));
  if (taken !== 1) {
    const [held] = await env.STORE.read((tx) => tx.query<{ auth_blocked: boolean; last_error: string | null }>(
      'SELECT auth_blocked, last_error FROM noticeos.integration_leases WHERE lease_key = $1', [MEDIAVINE_LEASE]));
    if (!localOnly && held?.auth_blocked) throw new MediavineError('auth', held.last_error ?? 'Reconnect your Mediavine account.');
    throw new MediavineError('busy', 'Mediavine is already syncing or waiting before another request. Try again later.');
  }
  const assertLease = async () => {
    const current = now + Date.now() - started;
    const renewed = await env.STORE.write((tx) => tx.execute(
      `UPDATE noticeos.integration_leases SET expires_at = $1::timestamptz
        WHERE lease_key = $2 AND owner = $3 AND expires_at > $4::timestamptz`,
      [new Date(current + 600_000), MEDIAVINE_LEASE, owner, new Date(current)]));
    if (renewed !== 1) throw new MediavineError('busy', 'This Mediavine sync expired. Try again.');
  };
  try { return await work(assertLease); }
  catch (error) {
    if (error instanceof MediavineError && (error.kind === 'auth' || error.kind === 'permission')) {
      await env.STORE.write((tx) => tx.execute(
        'UPDATE noticeos.integration_leases SET auth_blocked = true, last_error = $1 WHERE lease_key = $2 AND owner = $3',
        [error.message, MEDIAVINE_LEASE, owner]));
    }
    if (error instanceof MediavineError && error.retryAt !== null) {
      // GREATEST passes over a NULL: no cooldown yet is D1's 0.
      await env.STORE.write((tx) => tx.execute(
        'UPDATE noticeos.integration_leases SET cooldown_until = GREATEST(cooldown_until, $1::timestamptz) WHERE lease_key = $2 AND owner = $3',
        [new Date(error.retryAt ?? now + 3_600_000), MEDIAVINE_LEASE, owner]));
    }
    throw error;
  } finally {
    // The row stays: it carries the cooldown, the block and the site list. Its
    // owner is kept too (a lease owner is never blank); an ended lease is free
    // whoever last held it.
    await env.STORE.write((tx) => tx.execute(
      'UPDATE noticeos.integration_leases SET expires_at = $1::timestamptz WHERE lease_key = $2 AND owner = $3',
      [RELEASED, MEDIAVINE_LEASE, owner]));
  }
}
export async function mediavineClient(env: IngestEnv, options: MediavineOptions = {}, captured?: ResolvedCredential): Promise<MediavineClient> {
  const credential = captured ?? await resolveCredential(env, 'mediavine');
  await assertCredentialOwner(env, credential, 'mediavine');
  if (credential.source !== 'store') throw new MediavineError('auth', 'Connect your Mediavine account first.');
  const email = credential.fields.MEDIAVINE_USER;
  const password = credential.fields.MEDIAVINE_PASSWORD;
  if (!email || !password) throw new MediavineError('auth', 'Reconnect your Mediavine account.');
  let session: Session | null = null;
  try {
    const held = JSON.parse(credential.fields.MEDIAVINE_SESSION ?? 'null') as Partial<Session> | null;
    if (held && typeof held.accessToken === 'string' && typeof held.refreshToken === 'string' && typeof held.expiresAt === 'number') {
      session = { accessToken: held.accessToken, refreshToken: held.refreshToken, expiresAt: held.expiresAt };
    }
  } catch { /* A corrupt session can be replaced by one explicit sign-in. */ }
  return new MediavineClient({ credentials: { email, password }, session,
    saveSession: async value => { await options.assertLease?.(); await saveMediavineSession(env, value === null ? null : JSON.stringify(value)); },
    fetchImpl: options.fetchImpl, now: options.nowMs === undefined ? undefined : () => options.nowMs!,
    beforeRequest: options.beforeRequest,
  });
}
/**
 * The sites the stored login can read, from the 15-minute cache or one call.
 * `evidence: false` is the connect panel's listing (bead `ro-ujb9.96.7.6`): a
 * listing is not a test, so it stamps no verdict and records no observation —
 * opening the panel twice never moves a status. A failed call still cools the
 * connection down, as every Mediavine call does.
 */
export async function discoverMediavineSites(env: IngestEnv, options: MediavineOptions & { evidence?: boolean } = {}, capability: 'mediavine-discovery' | 'mediavine-test' = 'mediavine-discovery'): Promise<MediavineResult<Site[]> & { checkedAt: string; monitoringAvailable?: boolean; kind?: MediavineError['kind'] | 'network' }> {
  const now = options.nowMs ?? Date.now();
  const evidence = options.evidence !== false;
  let checkedAt = new Date(now).toISOString();
  let health: HealthConnection | null = null;
  try {
    const credential = await resolveCredential(env, 'mediavine');
    health = await tryHealthConnection(env, 'mediavine', credential);
    const sites = await withMediavineLease(env, async (assertLease) => {
      const client = await mediavineClient(env, { ...options, assertLease, beforeRequest: assertLease }, credential);
      const [cached] = await env.STORE.read((tx) => tx.query<{ sites: string | null; sites_checked_at: string | null }>(
        'SELECT sites::text AS sites, sites_checked_at FROM noticeos.integration_leases WHERE lease_key = $1', [MEDIAVINE_LEASE]));
      const checkedMs = cached?.sites_checked_at ? Date.parse(javascriptInstant(cached.sites_checked_at)) : null;
      if (cached?.sites && checkedMs !== null && checkedMs > now - 900_000) {
        checkedAt = new Date(checkedMs).toISOString();
        return JSON.parse(cached.sites) as Site[];
      }
      let sites: Site[];
      try { sites = await client.sites(); }
      catch (error) {
        await assertLease();
        await env.STORE.write((tx) => tx.execute(
          'UPDATE noticeos.integration_leases SET cooldown_until = GREATEST(cooldown_until, $1::timestamptz) WHERE lease_key = $2',
          [new Date(now + 900_000), MEDIAVINE_LEASE]));
        if (evidence) await recordCredentialOutcome(env, 'mediavine', { ok: false, error: mediavineMessage(error), at: checkedAt });
        throw error;
      }
      await assertLease();
      await env.STORE.write((tx) => tx.execute(
        'UPDATE noticeos.integration_leases SET sites = $1::jsonb, sites_checked_at = $2::timestamptz WHERE lease_key = $3',
        [JSON.stringify(sites), new Date(now), MEDIAVINE_LEASE]));
      if (evidence) await recordCredentialOutcome(env, 'mediavine', { ok: true, at: new Date(now).toISOString() });
      return sites;
    }, options);
    if (!evidence) return { ok: true, value: sites, checkedAt };
    const monitoringAvailable = await observeIntegration(env, health, { capability, observedAt: checkedAt, ok: true, evidenceSource: 'probe' });
    return { ok: true, value: sites, checkedAt, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
  } catch (error) {
    const kind = error instanceof MediavineError ? error.kind : 'network' as const;
    if (!evidence) return { ok: false, message: mediavineMessage(error), checkedAt, kind };
    const monitoringAvailable = error instanceof MediavineError && error.kind === 'busy' ? true : await observeIntegration(env, health, { capability, observedAt: checkedAt, ok: false, code: error instanceof MediavineError ? error.kind : 'network', nextAttemptAt: error instanceof MediavineError && error.retryAt !== null ? new Date(error.retryAt).toISOString() : null, evidenceSource: 'probe' });
    return { ok: false, message: mediavineMessage(error), checkedAt, ...(!monitoringAvailable ? { monitoringAvailable: false } : {}) };
  }
}
