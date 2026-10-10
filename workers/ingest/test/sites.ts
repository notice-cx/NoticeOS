// Test fixtures act as the Postgres owner; product calls use the application role.
import { env } from 'cloudflare:test';
import { SITE_ORDER } from '@noticeos/contract';
import { asOwner } from './helpers';

/** One site, with complete fixture metadata. */
export interface TestSite {
  id: string;
  domain?: string | null;
  displayName: string;
  status: string;
  senseOnly?: 0 | 1;
  isOs?: 0 | 1;
  createdAt?: string;
  updatedAt?: string;
}

/** A site's row in the shape product callers read. */
export interface SiteRow {
  id: string;
  domain: string | null;
  display_name: string;
  status: string;
  sense_only: number;
  is_os: number;
  created_at: string;
  updated_at: string;
}

/** A SQL literal for owner statements: fixture values only, quotes doubled. */
function literal(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
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

/** Insert these rows into the Postgres copy, as its owner, one after another
 * in the order given: each takes the next place in the list, as a site the
 * product adds does. */
async function insertIntoStore(rows: SiteRow[]): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map((row, index) =>
    `(${[
      String(index),
      literal(row.id),
      literal(row.domain),
      literal(row.display_name),
      literal(row.status),
      literal(row.sense_only === 1),
      literal(row.is_os === 1),
      `${literal(row.created_at)}::timestamptz`,
      `${literal(row.updated_at)}::timestamptz`,
    ].join(', ')})`,
  );
  await asOwner(
    `INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
     SELECT w.workspace_id, v.asset_id, v.domain, v.display_name, v.status, v.sense_only, v.is_os, v.created_at, v.updated_at
       FROM noticeos.workspaces w,
       (VALUES ${values.join(',\n       ')}) AS v(added, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
      ORDER BY v.added;`,
  );
}

/** Ids in code-unit order, whatever the store's collation is. */
const byId = (a: SiteRow, b: SiteRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every site the Postgres copy holds, by id, read through the test's store. */
export async function storeSites(): Promise<SiteRow[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{
      id: string; domain: string | null; display_name: string; status: string;
      sense_only: boolean; is_os: boolean; created_at: string; updated_at: string;
    }>(`SELECT asset_id AS id, domain, display_name, status, sense_only, is_os,
               to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
          FROM noticeos.assets`),
  );
  return rows.map((row) => ({ ...row, sense_only: row.sense_only ? 1 : 0, is_os: row.is_os ? 1 : 0 })).sort(byId);
}

/** Every site id the Postgres copy holds, by each site's stored place: the
 * order every list of sites gives them (`SITE_ORDER`, @noticeos/contract
 * site-order.ts). */
export async function listedSites(): Promise<string[]> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ asset_id: string }>(`SELECT asset_id FROM noticeos.assets ORDER BY ${SITE_ORDER}`),
  );
  return rows.map((row) => row.asset_id);
}

/** These ids in the order the site list gives them. */
export async function inSiteOrder(ids: readonly string[]): Promise<string[]> {
  const rank = new Map((await listedSites()).map((id, index) => [id, index]));
  return [...ids].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

/** One site's stored row, or null when it does not exist. */
export async function siteInStore(id: string): Promise<SiteRow | null> {
  return (await storeSites()).find((row) => row.id === id) ?? null;
}

/** Add sites to the store. */
export async function addSites(sites: TestSite[]): Promise<void> {
  const at = new Date().toISOString();
  const rows = sites.map((site) => fullRow(site, at));
  await insertIntoStore(rows);
}

/** What a test may change about a site. */
export interface SiteChange {
  status?: string;
  isOs?: 0 | 1;
  displayName?: string;
  senseOnly?: 0 | 1;
  updatedAt?: string;
}

/** Change these sites (every site, with no ids) in the store. */
export async function changeSites(ids: string[] | null, change: SiteChange): Promise<void> {
  const pgSet: string[] = [];
  if (change.status !== undefined) {
    pgSet.push(`status = ${literal(change.status)}`);
  }
  if (change.isOs !== undefined) {
    pgSet.push(`is_os = ${literal(change.isOs === 1)}`);
  }
  if (change.displayName !== undefined) {
    pgSet.push(`display_name = ${literal(change.displayName)}`);
  }
  if (change.senseOnly !== undefined) {
    pgSet.push(`sense_only = ${literal(change.senseOnly === 1)}`);
  }
  if (change.updatedAt !== undefined) {
    pgSet.push(`updated_at = ${literal(change.updatedAt)}::timestamptz`);
  }
  if (pgSet.length === 0) throw new TypeError('changeSites needs something to change');
  await asOwner(
    `UPDATE noticeos.assets SET ${pgSet.join(', ')}${ids === null ? '' : ` WHERE asset_id IN (${ids.map(literal).join(', ')})`};`,
  );
}

/** Remove these sites (every site, with no ids) from the store. A site's
 * other rows go first, in the store, as its foreign keys require. */
export async function removeSites(ids: string[] | null = null): Promise<void> {
  if (ids !== null && ids.length === 0) return;
  await asOwner(`DELETE FROM noticeos.assets${ids === null ? '' : ` WHERE asset_id IN (${ids.map(literal).join(', ')})`};`);
}
