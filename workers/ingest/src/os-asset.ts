/**
 * Asset #0, the OS itself, as the store names it: the row with `is_os` set
 * (one workspace holds at most one), never an id written into the product. The
 * one reader: the self-report, the egress alert and `GET /api/os-asset` all
 * ask here. A store with no OS row answers null.
 */
export async function readOsAssetId(env: Pick<IngestEnv, 'STORE'>): Promise<string | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ asset_id: string }>(`SELECT asset_id FROM noticeos.assets WHERE is_os`),
  );
  return row?.asset_id ?? null;
}
