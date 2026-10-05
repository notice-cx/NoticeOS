// The asset write lane — the three columns of `assets` anything is allowed to
// edit (db/README §assets: `status`, `sense_only` and `display_name`, and
// nothing else), the site's place in the list of sites (`moveAsset`, bead
// ro-ujb9.76.52), plus creating an asset. Nothing removes one: a site is
// retired, never deleted (db/postgres/README.md, choice 5; bead
// ro-ujb9.76.4.5).
//
// ON POSTGRES (bead ro-ujb9.76.4.2; the port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md). The site list is
// `noticeos.assets`, read and written through this call's store, `env.STORE`.
// Postgres is the one answer: every read here asks it, and every write is one
// transaction on it.
//
// TWO CALLERS. `scripts/config-apply.mjs`, the operator's changeset tool, over
// the operator-authed routes below; and — since D18 (ro-pbzu.5) — the Control
// Tower, which writes an asset's lifecycle stage, automation mode and name
// straight from the asset page, and since 2026-09-04 (bead ro-z349.1) creates
// the row itself. The Tower reaches these functions through the
// WorkerEntrypoint RPCs (`readAssetState` / `writeAssetColumn` / `createAsset`
// in ../index.ts), not the HTTP lane: the binding is the
// capability, so no operator bearer crosses into a LAN-served, unauthenticated
// app. Both a READ (the `expect` guard resolves the current value before
// anything is written) and a WRITE come through here, whichever caller asked.
//
// WHY THESE ARE ROUTES. Until now the script reached the store by shelling out to
// `wrangler d1 execute --local --persist-to ../../.wrangler/state`, which starts
// a SECOND miniflare over the sqlite file the live runtime already holds open as
// its D1DatabaseObject — the 2026-08-02 corruption topology (ro-mad, ro-icq).
// `config:apply` is run by hand beside a live `os:up`, because that is the only
// state the operator's machine is ever in, and it is a WRITER. So the write goes
// through the runtime that owns the file (bead ro-bko).
//
// WHAT THIS MODULE WILL NOT DO. It takes a column NAME from an untrusted body and
// it still builds no SQL from it: each sanctioned column has its own pinned
// statement below, chosen by an exact match against the allowlist. A column the
// store does not sanction is a 422 naming the sanctioned ones, never a query.
// And nothing here writes a MIGRATION — the schema is operator-only
// (AGENTS.md); what this module inserts and changes is ROWS.

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

/** The lifecycle enum, the column allowlist and the result shapes are the
 * cross-Worker contract now (`@noticeos/contract` asset-column.ts), because
 * the Tower calls this module over the Service Binding rather than reading a
 * JSON body. They are re-exported here because THIS file is where they are
 * enforced: the values below are what an untrusted body is actually checked
 * against, and `UPDATE_SQL` fails to compile if the allowlist ever grows a
 * column with no pinned statement behind it. */
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
 * The row in the shape this lane's callers have always read: the id under its
 * old name, the two flags as 0/1 and instants as JavaScript writes them. The
 * contract and the Tower take it so.
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
 * One pinned statement per sanctioned column.
 *
 * A single statement with the column name interpolated would be the obvious
 * shape and the wrong one: the name arrives in a request body, and "it was
 * checked against an allowlist first" is a property of code somebody can later
 * move. Two literal statements cannot be talked into editing a third column.
 * (`SITE_ROW` is a constant list of what comes back, never input.)
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
 * What the store currently holds for one asset's editable columns.
 *
 * An unknown asset comes back as `known: false` rather than a 404, because the
 * question this read answers is the changeset's `expect` guard — "what is there
 * now?" — and *nothing is there* is an answer to it. The CLI renders that as
 * `(absent)`, reports the op as a mismatch, and tells the operator to re-stage;
 * a 404 would abort the whole run with a transport error instead of the diff
 * they can act on.
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

/** The value check for one column — the same enum and the same 0/1 the table's
 * CHECK constraints declare, so a bad value is a named issue rather than a raw
 * constraint failure. Each is the site row's declared field (`SITE_ROW_FIELDS`),
 * so the refusal names it as the Settings tab does ("Automation must be at most
 * 1"); a column write always carries a value, so each is required here. */
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
 * Set one sanctioned column on one asset row.
 *
 * ONE op per request, mirroring what the CLI does: a changeset resolves every op
 * against current reality first and refuses the whole document on any mismatch,
 * then applies the ops one at a time. Batching them here would move that
 * all-or-nothing decision into this Worker, where it does not belong — the file
 * edits in the same changeset are not ours to roll back.
 *
 * `updated_at` is stamped from the runtime's clock, not the caller's: it is
 * entity metadata about when the store changed (db/README §assets), and the
 * store is here.
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
    // A competing writer waits, then observes the committed winning value.
    const [target] = await tx.query<StoredSiteRow>(
      `SELECT ${SITE_ROW} FROM noticeos.assets WHERE asset_id = $1 FOR UPDATE`, [asset],
    );
    if (!target) return { ok: false, error: 'unknown_asset', asset };
    // THE OS HAS NO NAME TO SET (bead `ro-ujb9.77.10`). Its row is the product,
    // always called PRODUCT_NAME (`@noticeos/contract` asset-name.ts), and its
    // stored display_name is legacy data nothing shows — so a write there would
    // be a change nobody could see. Refused by name, never silently kept.
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

    // No row updated means no such asset — the same clean 422 the annotation and
    // insight lanes give, rather than a silent no-op the caller reads as success.
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
// A site's place in the list (bead `ro-ujb9.76.52`).
//
// Every list of sites follows each site's stored place, `list_position`
// (@noticeos/contract site-order.ts). A new site takes the next place, at the
// end, from the workspace's own counter (0001_baseline.sql, the numbering
// trigger on `assets`); retiring and restoring a site leave its place alone,
// and nothing removes a site. This is the one write that changes a place: the operator's reorder control
// makes it.
// ---------------------------------------------------------------------------

/**
 * Move `asset` to the place `to` holds.
 *
 * THE RULE. `asset` takes `to`'s place; `to` and every site between the two
 * move one place toward the place `asset` left. Moved down the list, each site
 * it passes moves up one; moved up, each moves down one. No other site's place
 * changes, and the list holds the same set of places afterwards (a gap a
 * refused create left stays where it was). Moving a site onto its own place
 * changes nothing.
 *
 * ONE AT A TIME. A new site takes its place from the workspace's counter row
 * (`workspace_counters`, 'list_position'), which the numbering trigger locks
 * in the inserting transaction. A move locks the same row first, so a move and
 * a create, or two moves, take turns: each reads places nobody else is
 * changing, and no create hands out a place while a move has sites parked
 * above the counter.
 *
 * TWO STATEMENTS. The unique key on a workspace's places is checked row by row
 * as an UPDATE runs, so one UPDATE shifting neighbours would collide with a
 * neighbour it had not shifted yet. So the sites in the span first step out of
 * the way, above every place the counter has handed out, and then each takes
 * its new place, which that step emptied. (A DEFERRABLE key would allow one
 * statement, but a deferrable key cannot settle the `ON CONFLICT DO NOTHING` a
 * create relies on.)
 *
 * Each site whose place changed is stamped `updated_at` from the runtime's
 * clock in the same transaction.
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
      // The span's own places, in order, dealt out again: `asset` at the far
      // end, the others closing up behind it in the order they stood.
      const others = span.filter((row) => row.asset_id !== asset).map((row) => row.asset_id);
      const dealt = from < onto ? [...others, asset] : [asset, ...others];
      // The original place may span hidden or retired assets. The row now in
      // that exact place, rather than the UI neighbor, is the inverse target.
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
// Creating an asset (bead `ro-z349.1`).
//
// Until now an asset was born as a seed MIGRATION plus a handful of hand edits.
// The add-asset wizard needs a create. A mistaken add is archived, as any site
// is: `status = 'retired'`, a column write above.
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
 * Create one asset row.
 *
 * WHAT IT WILL NOT SET. `is_os` is not an input and is always false: asset #0 is
 * a fact about this repo (db/0002 seeds it) and it decides which asset the Tower
 * renders first, so a route that could mint a second one would quietly change
 * the portfolio's shape. `created_at` and `updated_at` are stamped from the
 * runtime's clock for the same reason `writeAssetColumn` stamps `updated_at`
 * there — they are metadata about when the STORE changed, and the store is here.
 *
 * DEFAULTS. `status` defaults to `onboarding` (docs/15-A: "Creates the asset row
 * in state `onboarding`") and `senseOnly` to 1, the table's own default — a
 * brand-new asset observes before it acts. A wizard that asks sends both.
 *
 * A DUPLICATE IS A RESULT, not an error. Reading before inserting would race
 * with itself; instead the insert does nothing on a conflict and an empty
 * RETURNING is read as "already there". The row that exists is left exactly as
 * it was: this call never doubles as an update. A conflict is either key the
 * store holds a site by: its id, or its domain (one site per domain,
 * db/postgres/migrations/0001_baseline.sql `assets_one_per_domain`), and the
 * answer names the site that holds it.
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

  // Every field is the site row's declared one (`SITE_ROW_FIELDS`, bead
  // `ro-ujb9.183`), so the refusal Add a site shows beside its Domain input is
  // "Domain must be a hostname such as example.com" — worded as every register
  // words one — while the issue's path keeps the body's key. A domain is a
  // LABEL on the row: nothing here resolves or fetches it, and absent means "no
  // domain" (asset #0 is a service).
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
