// The Tower's reads of the site list (`noticeos.assets`). Every reader that
// needs the sites alone asks here and gets one shape: the two flags as 0/1,
// instants as JavaScript writes them. Sites come in their stored list order
// (`SITE_ORDER`, shared with ingest). A site is never deleted: retired ones are
// listed too and each reader decides whether to show them.

import { assetLifecycleStatus } from "@noticeos/contract/asset-lifecycle";
import { SITE_ORDER } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";

/** One site, as every Tower reader of the site list takes it. */
export interface SiteRecord {
  id: string;
  domain: string | null;
  displayName: string;
  status: string;
  storedStatus: string;
  hasCollectedData: boolean;
  /** 1 = the OS observes only; 0 = it may act. */
  senseOnly: number;
  /** 1 for the OS's own row. */
  isOs: number;
  createdAt: string;
  updatedAt: string;
}

type StoredSite = {
  hasCollectedData: boolean;
  id: string;
  domain: string | null;
  displayName: string;
  status: string;
  senseOnly: boolean;
  isOs: boolean;
  createdAt: string;
  updatedAt: string;
};

const SITE_SELECT = `SELECT asset_id AS id, domain, display_name AS "displayName", status,
       sense_only AS "senseOnly", is_os AS "isOs", created_at AS "createdAt", updated_at AS "updatedAt",
       (EXISTS (SELECT 1 FROM noticeos.current_pulses d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id)
        OR EXISTS (SELECT 1 FROM noticeos.counter_readings d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id)
        OR EXISTS (SELECT 1 FROM noticeos.signal_runs d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id AND d.status = 'success' AND d.observation_count > 0)
        OR EXISTS (SELECT 1 FROM noticeos.revenue_observations d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id)
        OR EXISTS (SELECT 1 FROM noticeos.ledger_entries d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id AND d.kind IN ('revenue', 'cost'))
        OR EXISTS (SELECT 1 FROM noticeos.hygiene_checks d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id)
        OR EXISTS (SELECT 1 FROM noticeos.codebase_reports d WHERE d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id)) AS "hasCollectedData" FROM noticeos.assets a`;

function record(row: StoredSite): SiteRecord {
  return {
    ...row,
    storedStatus: row.status,
    status: assetLifecycleStatus(row.status, row.hasCollectedData),
    senseOnly: row.senseOnly ? 1 : 0,
    isOs: row.isOs ? 1 : 0,
    createdAt: javascriptInstant(row.createdAt),
    updatedAt: javascriptInstant(row.updatedAt),
  };
}

/** Every site, retired ones included, by its place in the list. */
export async function readSites(store: WorkspaceStore): Promise<SiteRecord[]> {
  const rows = await store.read((tx) =>
    tx.query<StoredSite>(`${SITE_SELECT} ORDER BY ${SITE_ORDER}`),
  );
  return rows.map(record);
}

/** The sites with these ids that the store holds, by id. */
export async function readSitesById(store: WorkspaceStore, ids: readonly string[]): Promise<Map<string, SiteRecord>> {
  if (ids.length === 0) return new Map();
  const rows = await store.read((tx) =>
    tx.query<StoredSite>(`${SITE_SELECT} WHERE asset_id = ANY($1::text[])`, [ids]),
  );
  return new Map(rows.map((row) => [row.id, record(row)]));
}

/** One site, or null when the store holds none with this id. */
export async function readSite(store: WorkspaceStore, id: string): Promise<SiteRecord | null> {
  const [row] = await store.read((tx) =>
    tx.query<StoredSite>(`${SITE_SELECT} WHERE asset_id = $1`, [id]),
  );
  return row ? record(row) : null;
}

/** A trusted SQL asset expression stays visible unless its registry row is archived. */
export function unarchivedAssetSql(asset: string, workspace: string): string {
  return `NOT EXISTS (SELECT 1 FROM noticeos.assets archived_asset
    WHERE archived_asset.workspace_id = ${workspace} AND archived_asset.asset_id = ${asset} AND archived_asset.status = 'retired')`;
}
