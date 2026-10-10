// Is this one of the installation's sites? Every lane that takes a site id
// from a request checks here first, so an unknown id is a clean refusal
// rather than a foreign-key failure deeper in. A retired site is still known:
// sites are retired, never deleted, and a retired site's history is still
// written and read.

import type { WorkspaceStore } from '@noticeos/postgres';

/** The order sites are listed in, the Tower's and the collectors' alike
 * (`@noticeos/contract` site-order.ts). */
export { SITE_ORDER } from '@noticeos/contract';

/** Whether the store holds a site with this id, retired or not. */
export async function assetKnown(store: WorkspaceStore, asset: string): Promise<boolean> {
  const rows = await store.read((tx) => tx.query(`SELECT 1 AS known FROM noticeos.assets WHERE asset_id = $1`, [asset]));
  return rows.length > 0;
}

/** Every site id the store holds, retired ones included. */
export async function knownAssetIds(store: WorkspaceStore): Promise<Set<string>> {
  const rows = await store.read((tx) => tx.query<{ asset_id: string }>(`SELECT asset_id FROM noticeos.assets`));
  return new Set(rows.map((row) => row.asset_id));
}
