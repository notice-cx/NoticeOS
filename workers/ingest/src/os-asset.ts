/**
 * Asset #0 — the OS itself (docs/06) — as the STORE names it: the row with
 * `is_os` set (db/postgres/migrations/0001_baseline.sql, where one workspace
 * holds at most one), never an id written into the product (beads `ro-k9hf`,
 * `ro-ujb9.118`). An installation may seed its OS under any id.
 *
 * The one reader. The self-report, the egress alert and the runner's
 * `GET /api/os-asset` all ask here, so they cannot disagree about which row it
 * is. A store with no OS row answers null, and whatever would have been about
 * the OS has no subject. On Postgres, through the call's store (bead
 * ro-ujb9.76.4.2).
 */
export async function readOsAssetId(env: Pick<IngestEnv, 'STORE'>): Promise<string | null> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<{ asset_id: string }>(`SELECT asset_id FROM noticeos.assets WHERE is_os`),
  );
  return row?.asset_id ?? null;
}
