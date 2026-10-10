// The asset write lane: the three columns of `assets` anything is allowed to
// edit (`status`, `sense_only`, `display_name`), a site's place in the list
// (`moveAsset`), and creating an asset. Nothing removes one: a site is
// retired, never deleted. The Tower reaches these functions through the
// WorkerEntrypoint RPCs, so no operator bearer crosses into a LAN-served app.
//
// This module takes a column name from an untrusted body and builds no SQL
// from it: each sanctioned column has its own pinned statement, chosen by
// exact match against the allowlist. Nothing here writes a migration; what it
// inserts and changes is rows.

import { PRODUCT_NAME, SITE_ORDER, STORE_COLUMNS } from '@noticeos/contract';
import type {
  AssetRowSummary,
  AssetStateRead,
  AssetStateWriteResult,
  AssetStatus,
  CreateAssetInput,
  CreateAssetResult,
  MoveAssetResult,
  StoreColumn,
} from '@noticeos/contract';
import { javascriptInstant, type Transaction } from '@noticeos/postgres';
import { recordMutation, type MutationActor } from '@noticeos/postgres/mutation-audit';
import {
  Issues,
  SITE_ROW_FIELDS,
  asObject,
  declaredNumber,
  declaredString,
  enumValue,
} from './routes/validate.js';

/** The enum, the allowlist and the result shapes are the cross-Worker contract;
 * re-exported here because this is where they are enforced, and `UPDATE_SQL`
 * fails to compile if the allowlist grows a column with no pinned statement. */
export { ASSET_STATUSES, DISPLAY_NAME_MAX, STORE_COLUMNS } from '@noticeos/contract';
export type {
  AssetRowSummary,
  AssetStateRead,
  AssetStateWriteResult,
  AssetStatus,
  CreateAssetInput,
  CreateAssetResult,
  MoveAssetInput,
  MoveAssetResult,
  StoreColumn,
} from '@noticeos/contract';

/** A site's whole row, as every statement below returns it. */
const SITE_ROW = 'asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at';

/** The row as Postgres returns it (db/postgres/model.json `assets`). */
type StoredSiteRow = {
  asset_id: string;
  domain: string | null;
  display_name: string;
  status: string;
  sense_only: boolean;
  is_os: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * The row in the shape this lane's callers read: the id under its old name,
 * the two flags as 0/1 and instants as JavaScript writes them.
 */
interface SiteRow {
  id: string;
  domain: string | null;
  display_name: string;
  status: string;
  sense_only: number;
  is_os: number;
  created_at: string;
  updated_at: string;
}

function siteRow(row: StoredSiteRow): SiteRow {
  return {
    id: row.asset_id,
    domain: row.domain,
    display_name: row.display_name,
    status: row.status,
    sense_only: row.sense_only ? 1 : 0,
    is_os: row.is_os ? 1 : 0,
    created_at: javascriptInstant(row.created_at),
    updated_at: javascriptInstant(row.updated_at),
  };
}

/**
 * One pinned statement per sanctioned column: a name that arrives in a request
 * body is never interpolated, and two literal statements cannot be talked into
 * editing a third column.
 */
const UPDATE_SQL: Record<StoreColumn, string> = {
  status: `UPDATE noticeos.assets SET status = $2, updated_at = $3::timestamptz WHERE asset_id = $1
           RETURNING ${SITE_ROW}`,
  sense_only: `UPDATE noticeos.assets SET sense_only = $2, updated_at = $3::timestamptz WHERE asset_id = $1
               RETURNING ${SITE_ROW}`,
  display_name: `UPDATE noticeos.assets SET display_name = $2, updated_at = $3::timestamptz WHERE asset_id = $1
                 RETURNING ${SITE_ROW}`,
};

/**
 * What the store holds for one asset's editable columns. An unknown asset
 * comes back as `known: false` rather than a 404: the question is the
 * changeset's `expect` guard, and "nothing is there" is an answer the CLI can
 * render as a mismatch rather than abort on.
 */
export async function readAssetState(env: IngestEnv, asset: string): Promise<AssetStateRead> {
  const [row] = await env.STORE.read((tx) =>
    tx.query<StoredSiteRow>(`SELECT ${SITE_ROW} FROM noticeos.assets WHERE asset_id = $1`, [asset]),
  );
  if (!row) return { asset, known: false, columns: null, updatedAt: null };
  const site = siteRow(row);
  return {
    asset,
    known: true,
    columns: {
      status: site.status,
      sense_only: site.sense_only,
      display_name: site.display_name,
    },
    updatedAt: site.updated_at,
  };
}

/** The value check for one column, the same enum and 0/1 the table's CHECK
 * constraints declare, so a bad value is a named issue rather than a raw
 * constraint failure. */
function columnValue(
  issues: Issues,
  column: StoreColumn,
  raw: unknown,
): string | number | null {
  if (column === 'status') {
    return declaredString(issues, raw, 'value', { ...SITE_ROW_FIELDS.status, required: true });
  }
  if (column === 'display_name') {
    return declaredString(issues, raw, 'value', SITE_ROW_FIELDS.displayName);
  }
  return declaredNumber(issues, raw, 'value', { ...SITE_ROW_FIELDS.senseOnly, required: true });
}

/**
 * Set one sanctioned column on one asset row. One op per request: a changeset
 * resolves every op against current reality and refuses the whole document on
 * any mismatch, and that decision belongs in the CLI, whose file edits this
 * Worker cannot roll back. `updated_at` is stamped from the runtime's clock:
 * it is metadata about when the store changed, and the store is here.
 */
export async function writeAssetColumn(
  env: IngestEnv,
  body: unknown,
  nowMs: number = Date.now(),
  actor: MutationActor | null = null,
): Promise<AssetStateWriteResult> {
  const raw = asObject(body);
  if (!raw) {
    return {
      ok: false,
      error: 'validation',
      issues: [{ path: '', code: 'invalid_type', message: 'body must be a JSON object' }],
    };
  }

  const issues = new Issues();
  const asset = declaredString(issues, raw.asset, 'asset', SITE_ROW_FIELDS.id);
  const column = enumValue(issues, raw.column, 'column', STORE_COLUMNS);
  const value = column === null ? null : columnValue(issues, column, raw.value);
  const guarded = Object.hasOwn(raw, 'expect');
  if (guarded && raw.expect !== null && typeof raw.expect !== 'string'
    && typeof raw.expect !== 'boolean' && (typeof raw.expect !== 'number' || !Number.isFinite(raw.expect))) {
    issues.add('expect', 'invalid_type', 'expect must be an observed column value');
  }

  if (!issues.ok || asset === null || column === null || value === null) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  const updatedAt = new Date(nowMs).toISOString();
  return env.STORE.write(async (tx): Promise<AssetStateWriteResult> => {
    // Every guarded edit reads, compares and updates under the same row lock.
    const [target] = await tx.query<StoredSiteRow>(
      `SELECT ${SITE_ROW} FROM noticeos.assets WHERE asset_id = $1 FOR UPDATE`, [asset],
    );
    if (!target) return { ok: false, error: 'unknown_asset', asset };
    // The OS has no name to set: its row is the product, always called
    // PRODUCT_NAME, and a write there would be a change nobody could see.
    if (column === 'display_name') {
      if (target.is_os === true) {
        return {
          ok: false,
          error: 'validation',
          issues: [{ path: 'column', code: 'fixed', message: `The OS is always called ${PRODUCT_NAME}; its name is not a setting` }],
        };
      }
    }

    const current = readBack(siteRow(target), column);
    if (guarded && current !== raw.expect) return { ok: false, error: 'expect_mismatch', column, current };

    // The table's flag is a boolean; the lane's 0/1 is its declared field.
    const stored = column === 'sense_only' ? value === 1 : value;
    const [row] = await tx.query<StoredSiteRow>(UPDATE_SQL[column], [asset, stored, updatedAt]);

    // No row updated means no such asset: a clean 422 rather than a silent no-op.
    if (!row) return { ok: false, error: 'unknown_asset', asset };

    await recordMutation(tx, actor, { event: 'asset.column', assetId: asset, subject: { column } });

    const site = siteRow(row);
    return {
      ok: true,
      asset,
      column,
      value: readBack(site, column),
      updatedAt: site.updated_at,
    };
  });
}

/** The value the UPDATE returned, in the column's own type. */
function readBack(row: SiteRow, column: StoreColumn): string | number {
  if (column === 'status') return row.status;
  if (column === 'display_name') return row.display_name;
  return row.sense_only;
}

// ---------------------------------------------------------------------------
// A site's place in the list.
//
// Every list of sites follows each site's stored `list_position`. A new site
// takes the next place from the workspace's own counter (the numbering trigger
// on `assets`); retiring and restoring leave its place alone. This is the one
// write that changes a place.
// ---------------------------------------------------------------------------

/**
 * Move `asset` to the place `to` holds: `to` and every site between the two
 * move one place toward the place `asset` left, no other place changes, and
 * the list holds the same set of places afterwards.
 *
 * The move locks the counter row first, as the numbering trigger does for a
 * create, so a move and a create, or two moves, take turns. Two statements,
 * because the unique key on places is checked row by row as an UPDATE runs:
 * the sites in the span first step out of the way above every place the
 * counter has handed out, then each takes its new place. (A DEFERRABLE key
 * cannot settle the `ON CONFLICT DO NOTHING` a create relies on.)
 */
export async function moveAsset(
  env: IngestEnv,
  body: unknown,
  nowMs: number = Date.now(),
  actor: MutationActor | null = null,
): Promise<MoveAssetResult> {
  const raw = asObject(body);
  if (!raw) {
    return {
      ok: false,
      error: 'validation',
      issues: [{ path: '', code: 'invalid_type', message: 'body must be a JSON object' }],
    };
  }
  const issues = new Issues();
  const asset = declaredString(issues, raw.asset, 'asset', SITE_ROW_FIELDS.id);
  const to = declaredString(issues, raw.to, 'to', SITE_ROW_FIELDS.id);
  if (raw.expectRevision !== undefined && (typeof raw.expectRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.expectRevision))) {
    issues.add('expectRevision', 'invalid_type', 'Expected a saved order revision');
  }
  if (!issues.ok || asset === null || to === null) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  const at = new Date(nowMs).toISOString();
  return env.STORE.write(async (tx): Promise<MoveAssetResult> => {
    const [counter] = await tx.query<{ last: string }>(
      `SELECT last_number::text AS last FROM noticeos.workspace_counters WHERE counter = 'list_position' FOR UPDATE`,
    );
    const readOrder = async () => (await tx.query<{ asset_id: string }>(
      `SELECT asset_id FROM noticeos.assets ORDER BY ${SITE_ORDER}`,
    )).map(row => row.asset_id);
    if (raw.expectRevision !== undefined && raw.expectRevision !== await orderRevision(await readOrder())) {
      return { ok: false, error: 'expect_mismatch' };
    }
    const placeOf = new Map(
      (
        await tx.query<{ asset_id: string; place: string }>(
          `SELECT asset_id, list_position::text AS place FROM noticeos.assets WHERE asset_id IN ($1, $2)`,
          [asset, to],
        )
      ).map((row) => [row.asset_id, Number(row.place)]),
    );
    const from = placeOf.get(asset);
    const onto = placeOf.get(to);
    if (from === undefined) return { ok: false, error: 'unknown_asset', asset };
    if (onto === undefined) return { ok: false, error: 'unknown_asset', asset: to };
    // Every site took its place through the counter, so a site means a counter.
    if (counter === undefined) throw new Error('the site list has places but no list_position counter');

    let undoTo: string | null = null;
    if (from !== onto) {
      const [low, high] = from < onto ? [from, onto] : [onto, from];
      const span = await tx.query<{ asset_id: string; place: string }>(
        `SELECT asset_id, list_position::text AS place FROM noticeos.assets
          WHERE list_position BETWEEN $1 AND $2 ORDER BY list_position`,
        [low, high],
      );
      // The span's own places, dealt out again: `asset` at the far end, the
      // others closing up behind it in the order they stood.
      const others = span.filter((row) => row.asset_id !== asset).map((row) => row.asset_id);
      const dealt = from < onto ? [...others, asset] : [asset, ...others];
      // The original place may span hidden or retired assets; the row now in
      // that exact place is the inverse target.
      undoTo = from < onto ? dealt[0]! : dealt.at(-1)!;
      await tx.execute(
        `UPDATE noticeos.assets SET list_position = list_position + $3::bigint WHERE list_position BETWEEN $1 AND $2`,
        [low, high, counter.last],
      );
      await tx.execute(
        `UPDATE noticeos.assets AS a SET list_position = m.place, updated_at = $3::timestamptz
           FROM unnest($1::text[], $2::bigint[]) AS m(site, place)
          WHERE a.asset_id = m.site`,
        [dealt, span.map((row) => row.place), at],
      );
      await recordMutation(tx, actor, { event: 'asset.move', assetId: asset,
        subject: { to, changedCount: dealt.length } });
    }

    const order = await readOrder();
    return { ok: true, asset, order, revision: await orderRevision(order), undoTo };
  });
}

/** A compact compare-and-set token for the ordered identities, not a credential. */
async function orderRevision(order: readonly string[]): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(order)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Creating an asset. A mistaken add is retired, as any site is.
// ---------------------------------------------------------------------------

function summarize(row: SiteRow): AssetRowSummary {
  return {
    id: row.id,
    domain: row.domain,
    displayName: row.display_name,
    status: row.status as AssetStatus,
    senseOnly: row.sense_only,
    isOs: row.is_os,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create one asset row. `is_os` is not an input and is always false: a route
 * that could mint a second OS asset would quietly change the portfolio's
 * shape. `status` defaults to `onboarding` and `senseOnly` to 1: a new asset
 * observes before it acts. A duplicate is a result, not an error: the insert
 * does nothing on a conflict (the id, or the domain, one site per domain) and
 * the answer names the site that holds it; the existing row is never updated.
 */
export async function createAsset(
  env: IngestEnv,
  body: unknown,
  nowMs: number = Date.now(),
  actor: MutationActor | null = null,
): Promise<CreateAssetResult> {
  const raw = asObject(body);
  if (!raw) {
    return {
      ok: false,
      error: 'validation',
      issues: [{ path: '', code: 'invalid_type', message: 'body must be a JSON object' }],
    };
  }

  // Every field is the site row's declared one, so the refusal is worded as
  // every register words one. A domain is a label on the row: nothing resolves
  // or fetches it, and absent means "no domain".
  const issues = new Issues();
  const id = declaredString(issues, raw.id, 'id', SITE_ROW_FIELDS.id);
  const displayName = declaredString(issues, raw.displayName, 'displayName', SITE_ROW_FIELDS.displayName);
  const domain = declaredString(issues, raw.domain, 'domain', SITE_ROW_FIELDS.domain);
  // Absent means the defaults. The declared enum is what makes the cast true.
  const status = (declaredString(issues, raw.status, 'status', SITE_ROW_FIELDS.status) ?? 'onboarding') as AssetStatus;
  const senseOnly = declaredNumber(issues, raw.senseOnly, 'senseOnly', SITE_ROW_FIELDS.senseOnly) ?? 1;

  if (!issues.ok || id === null || displayName === null) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  const at = new Date(nowMs).toISOString();
  return env.STORE.write(async (tx): Promise<CreateAssetResult> => {
    const [row] = await tx.query<StoredSiteRow>(
      `INSERT INTO noticeos.assets
         (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, false, $7::timestamptz, $7::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING ${SITE_ROW}`,
      [tx.workspaceId, id, domain, displayName, status, senseOnly === 1, at],
    );
    if (!row) return { ok: false, error: 'asset_exists', ...await holderOf(tx, id, domain) };
    await recordMutation(tx, actor, { event: 'asset.create', assetId: id, subject: {} });
    const site = siteRow(row);
    return { ok: true, asset: summarize(site) };
  });
}

/** The site a refused create collided with: the one with this id, or else the
 * one holding this domain. */
async function holderOf(tx: Transaction, id: string, domain: string | null): Promise<{ asset: string; existingStatus: AssetStatus | null }> {
  const [held] = await tx.query<{ asset_id: string; status: AssetStatus }>(
    `SELECT asset_id, status FROM noticeos.assets
      WHERE asset_id = $1 OR domain = $2
      ORDER BY asset_id = $1 DESC
      LIMIT 1`,
    [id, domain],
  );
  return { asset: held?.asset_id ?? id, existingStatus: held?.status ?? null };
}
