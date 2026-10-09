// THE TOWER'S READS OF THE SITE LIST, on Postgres (bead ro-ujb9.76.4.2).
//
// `noticeos.assets` through the call's store (`env.STORE`, index.ts). Every
// Tower reader that needs the sites alone asks here, so the row reaches each
// of them in the shape the D1 row had: the id under its old name, the two flags
// as 0/1, instants as JavaScript writes them. A reader that joins the sites
// with a table still on D1 keeps reading D1, which the ingest keeps in step
// (workers/ingest/src/asset-state.ts) until that table's unit moves it.
//
// Sites are listed by each site's stored place in the list (`SITE_ORDER`,
// shared with the ingest's collectors through @noticeos/contract; bead
// ro-ujb9.76.52): a new site at the end, an imported list in the order D1
// held it, a moved site where the operator put it. A site is never deleted
// (db/postgres/README.md, choice 5): a retired one is still listed, as it
// always was; each reader decides whether to show it.

import { SITE_ORDER } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";

/** One site, as every Tower reader of the site list takes it. */
export interface SiteRecord {
  id: string;
  domain: string | null;
  displayName: string;
  status: string;
  /** 1 = the OS observes only; 0 = it may act. */
  senseOnly: number;
  /** 1 for the OS's own row. */
  isOs: number;
  createdAt: string;
  updatedAt: string;
}

type StoredSite = {
  id: string;
  domain: string | null;
  displayName: string;
  status: string;
  senseOnly: boolean;
  isOs: boolean;
  createdAt: string;
  updatedAt: string;
};

const SITE_COLUMNS = `asset_id AS id, domain, display_name AS "displayName", status,
       sense_only AS "senseOnly", is_os AS "isOs", created_at AS "createdAt", updated_at AS "updatedAt"`;

function record(row: StoredSite): SiteRecord {
  return {
    ...row,
    senseOnly: row.senseOnly ? 1 : 0,
    isOs: row.isOs ? 1 : 0,
    createdAt: javascriptInstant(row.createdAt),
    updatedAt: javascriptInstant(row.updatedAt),
  };
}

/** Every site, retired ones included, by its place in the list. */
export async function readSites(store: WorkspaceStore): Promise<SiteRecord[]> {
  const rows = await store.read((tx) =>
    tx.query<StoredSite>(`SELECT ${SITE_COLUMNS} FROM noticeos.assets ORDER BY ${SITE_ORDER}`),
  );
  return rows.map(record);
}

/** The sites with these ids that the store holds, by id. */
export async function readSitesById(store: WorkspaceStore, ids: readonly string[]): Promise<Map<string, SiteRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await store.read((tx) =>
    tx.query<StoredSite>(`SELECT ${SITE_COLUMNS} FROM noticeos.assets WHERE asset_id = ANY($1::text[])`, [ids]),
  );
  return new Map(rows.map((row) => [row.id, record(row)]));
}

/** One site, or null when the store holds none with this id. */
export async function readSite(store: WorkspaceStore, id: string): Promise<SiteRecord | null> {
  const [row] = await store.read((tx) =>
    tx.query<StoredSite>(`SELECT ${SITE_COLUMNS} FROM noticeos.assets WHERE asset_id = $1`, [id]),
  );
  return row ? record(row) : null;
}
