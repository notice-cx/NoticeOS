// Direct Postgres site fixtures: every test owns its copy (ro-ujb9.76.40.2).
import type { WorkspaceStore } from "@noticeos/postgres";
import type { TestStore } from "./postgres-store";

export interface TestSite {
  id: string;
  /** Default: the id; null for none. */
  domain?: string | null;
  displayName: string;
  status: string;
  senseOnly?: number;
  isOs?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** A fixture row, converted to Postgres booleans at insertion. */
export interface SiteRow extends Record<string, unknown> {
  id: string;
  domain: string | null;
  display_name: string;
  status: string;
  sense_only: number;
  is_os: number;
  created_at: string;
  updated_at: string;
}

function fullRow(site: TestSite, at: string): SiteRow {
  return {
    id: site.id,
    domain: site.domain === undefined ? site.id : site.domain,
    display_name: site.displayName,
    status: site.status,
    sense_only: site.senseOnly ?? 1,
    is_os: site.isOs ?? 0,
    created_at: site.createdAt ?? at,
    updated_at: site.updatedAt ?? site.createdAt ?? at,
  };
}

export async function addSites(to: TestStore, sites: TestSite[]): Promise<void> {
  await insertRows(to.call, sites.map((site) => fullRow(site, new Date().toISOString())));
}

async function insertRows(store: WorkspaceStore, rows: SiteRow[]): Promise<void> {
  if (rows.length === 0) return;
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
       SELECT $1::uuid, s.asset_id, s.domain, s.display_name, s.status, s.sense_only, s.is_os, s.created_at, s.updated_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[], $7::boolean[], $8::timestamptz[], $9::timestamptz[])
           WITH ORDINALITY AS s(asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at, added)
        ORDER BY s.added`,
      [
        tx.workspaceId,
        rows.map((row) => row.id),
        rows.map((row) => row.domain),
        rows.map((row) => row.display_name),
        rows.map((row) => row.status),
        rows.map((row) => row.sense_only === 1),
        rows.map((row) => row.is_os === 1),
        rows.map((row) => row.created_at),
        rows.map((row) => row.updated_at),
      ],
    ),
  );
}
