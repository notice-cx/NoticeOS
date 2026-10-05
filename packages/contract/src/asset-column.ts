/** Cross-Worker contract for the two editable asset columns.
 *
 * `assets.status` and `assets.sense_only` are the only columns of the `assets`
 * table anything is allowed to edit after the row is seeded (db/README §assets).
 * The ingest Worker owns the table and the operator bearer that guards its HTTP
 * lane; the Control Tower is served unauthenticated on the trusted LAN, so it
 * must never hold that bearer — since D18 it writes these two columns through
 * the private INGEST Service Binding instead, where the binding itself is the
 * capability. Same posture as the annotation write: plain data crosses, never a
 * credential.
 *
 * The read half supports an early stale-page refusal. The write also carries
 * `expect`: the authoritative comparison and update hold the same store row
 * lock, so concurrent saves cannot both accept one observed value.
 *
 * Every field of the input is re-validated inside ingest
 * (workers/ingest/src/asset-state.ts, which is the runtime authority for the
 * enums below). These types describe the shape a caller intends, not a shape
 * ingest is willing to trust.
 */

import type { AssetStatus, StoreColumn } from './configuration.mjs';
export type { AssetStatus, StoreColumn } from './configuration.mjs';
export { ASSET_STATUSES, STORE_COLUMNS, DISPLAY_NAME_MAX } from './configuration.mjs';

/**
 * What the store currently holds for one asset's editable columns.
 *
 * An unknown asset comes back as `known: false` rather than an error, because
 * the question this read answers is "what is there now?" — and *nothing is
 * there* is an answer to it. The caller renders that as a 404 or as `(absent)`;
 * neither wants a thrown transport error instead of the fact.
 */
export interface AssetStateRead {
  asset: string;
  known: boolean;
  /** Keyed by the store's own column names, because that is what an op names
   * and what the `expect` guard compares against. */
  columns: { status: string; sense_only: number; display_name: string } | null;
  updatedAt: string | null;
}

/** One column edit. ONE op per call: the all-or-nothing decision over a set of
 * ops belongs to whoever assembled the set, not to the writer. */
export interface WriteAssetColumnInput {
  asset: string;
  column: StoreColumn;
  value: string | number;
  /** Browser and changeset writes carry the value they observed. The writer
   * compares it while holding the row lock. Omission is retained only for
   * existing privileged standalone callers, never hosted request admission. */
  expect?: string | number | boolean | null;
}

/** One rejected field, in the `{path, code, message}` shape every ingest lane
 * reports — one validation vocabulary, whichever door the write arrived at. */
export interface AssetColumnIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * The outcome of one column write.
 *
 * A rejected value and an unknown asset are RESULTS, not thrown errors: both are
 * ordinary answers a caller renders. Only an infrastructure failure (a D1 error)
 * throws across the binding. `value` is read back from the UPDATE rather than
 * echoed: if the two ever disagreed, the operator should hear the row that
 * exists, not the one they asked for.
 */
export type AssetStateWriteResult =
  | {
      ok: true;
      asset: string;
      column: StoreColumn;
      value: string | number;
      updatedAt: string;
    }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'expect_mismatch'; column: StoreColumn; current: string | number }
  | { ok: false; error: 'validation'; issues: AssetColumnIssue[] };


// ---------------------------------------------------------------------------
// Creating and deleting an asset row (bead `ro-z349.1`).
//
// Until 2026-09-04 an asset was born as a seed MIGRATION and a handful of hand
// edits, and there was no way back that was not another migration. The add-asset
// wizard needs a create; a mistaken add needs a delete. Both are OPERATOR
// actions over same-origin Tower routes proxied to the ingest binding — the same
// class as the column write above, not a new capability: a row insert into
// `assets` creates a join key, and a delete of an asset that holds nothing
// removes one. Neither touches a row of provider evidence.
//
// The SCHEMA is still operator-only: nothing here writes a migration.
// ---------------------------------------------------------------------------

/**
 * A new asset row, as the wizard describes it.
 *
 * `status` and `senseOnly` are optional and default the way docs/15-A says a new
 * asset starts — `onboarding`, observing only. `is_os` is NOT here and never
 * will be: asset #0 is a fact about this repo, not something a route may mint a
 * second of.
 */
export interface CreateAssetInput {
  id: string;
  displayName: string;
  /** Canonical domain; null for an asset that is not a website. */
  domain?: string | null;
  status?: AssetStatus;
  senseOnly?: 0 | 1;
}

/** The row as the store wrote it — read back, not echoed, so the operator hears
 * what exists rather than what they asked for. */
export interface AssetRowSummary {
  id: string;
  domain: string | null;
  displayName: string;
  status: AssetStatus;
  senseOnly: number;
  isOs: number;
  createdAt: string;
  updatedAt: string;
}

/** A duplicate is a RESULT, not a thrown error: "that asset already exists"
 * is an ordinary answer a wizard renders beside the id field. `asset_exists`
 * names the site that holds the id, or else the domain. */
export type CreateAssetResult =
  | { ok: true; asset: AssetRowSummary }
  | { ok: false; error: 'asset_exists'; asset: string; existingStatus: AssetStatus | null }
  | { ok: false; error: 'validation'; issues: AssetColumnIssue[] };

// ---------------------------------------------------------------------------
// The order of sites (bead `ro-ujb9.76.52`).
//
// Every list of sites follows each site's stored place (site-order.ts). The
// operator sets the order by moving one site at a time; this is that one write.
// ---------------------------------------------------------------------------

/**
 * Move one site to the place another site holds.
 *
 * Named by the site, not by a number: a list the caller drew a moment ago may
 * have gained a site since, and "where Pacer is" still means what the operator
 * pointed at.
 */
export interface MoveAssetInput {
  /** The site that moves. */
  asset: string;
  /** The site whose place it takes. That site, and every site between the
   * two, moves one place toward the place `asset` left. */
  to: string;
  /** Undo refuses if the full workspace order changed after the original move. */
  expectRevision?: string;
}

/** The move's outcome. `order` is every site id in the order the store now
 * lists them, read back after the move. */
export type MoveAssetResult =
  | { ok: true; asset: string; order: string[]; revision: string; undoTo: string | null }
  | { ok: false; error: 'expect_mismatch' }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'validation'; issues: AssetColumnIssue[] };
