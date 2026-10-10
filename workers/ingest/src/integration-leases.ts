import type { WorkspaceStore } from '@noticeos/postgres';

/** A lease given back ends at the epoch, so a taker on any clock finds it free. */
const RELEASED = new Date(0);

export interface LeaseClaim {
  key: string;
  owner: string;
  nowMs: number;
  expiresAtMs: number;
  /** A further condition a held row `l` must meet to be taken over; in it `$5`
   * is now and `$6` is `param`. */
  takeoverAlso?: { sql: string; param: boolean };
}

/**
 * Take a lease in one statement: the row is created held, or taken over once
 * it has expired (and `takeoverAlso` holds). Postgres locks the row, so of two
 * takers at once the second waits for the first and then finds it held. The
 * row's cooldown as the claim found it when this owner now holds the lease, or
 * null when someone else does.
 */
export async function claimLease(
  store: WorkspaceStore,
  claim: LeaseClaim,
): Promise<{ cooldown_until: string | null } | null> {
  const also = claim.takeoverAlso;
  const [taken] = await store.write((tx) =>
    tx.query<{ cooldown_until: string | null }>(
      `INSERT INTO noticeos.integration_leases AS l (workspace_id, lease_key, owner, expires_at)
       VALUES ($1::uuid, $2, $3, $4::timestamptz)
       ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE l.expires_at <= $5::timestamptz${also ? `\n          AND ${also.sql}` : ''}
       RETURNING l.cooldown_until`,
      [tx.workspaceId, claim.key, claim.owner, new Date(claim.expiresAtMs), new Date(claim.nowMs), ...(also ? [also.param] : [])],
    ),
  );
  return taken ?? null;
}

/** Give back a lease this owner still holds. The row stays: it may carry a
 * cooldown, a block or a cached value for whoever takes it next. */
export async function releaseLease(store: WorkspaceStore, key: string, owner: string): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      'UPDATE noticeos.integration_leases SET expires_at = $1::timestamptz WHERE lease_key = $2 AND owner = $3',
      [RELEASED, key, owner],
    ),
  );
}
