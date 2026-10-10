// The Tower's reads of the site list (`noticeos.assets`). Every reader that
// needs the sites alone asks here and gets one shape: the two flags as 0/1,
// instants as JavaScript writes them. Sites come in their stored list order
// (`SITE_ORDER`, shared with ingest). A site is never deleted: retired ones are
// listed too and each reader decides whether to show them.

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
