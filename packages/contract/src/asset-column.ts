/** Cross-Worker contract for the editable asset columns. The ingest Worker
 * owns the `assets` table; the Tower writes these columns through the private
 * ingest Service Binding, and plain data crosses, never a credential. The
 * write carries `expect`: the comparison and the update hold the same row
 * lock, so concurrent saves cannot both accept one observed value. Every
 * field is re-validated inside ingest (workers/ingest/src/asset-state.ts, the
 * runtime authority for the enums below).
 */

import type { AssetStatus, StoreColumn } from './configuration.mjs';
import type { ValidationIssue } from './validation-issue.js';
export type { AssetStatus, StoreColumn } from './configuration.mjs';
export { ASSET_STATUSES, STORE_COLUMNS, DISPLAY_NAME_MAX } from './configuration.mjs';

/**
 * What the store currently holds for one asset's editable columns. An
 * unknown asset comes back as `known: false` rather than an error: nothing is
 * there is an answer.
 */
export interface AssetStateRead {
  asset: string;
  known: boolean;
  /** Keyed by the store's own column names, because that is what an op names
   * and what the `expect` guard compares against. */
  columns: { status: string; sense_only: number; display_name: string } | null;
  updatedAt: string | null;
}

/** One column edit. One op per call: the all-or-nothing decision over a set
 * of ops belongs to whoever assembled the set. */
export interface WriteAssetColumnInput {
  asset: string;
  column: StoreColumn;
  value: string | number;
  /** Browser and changeset writes carry the value they observed. The writer
   * compares it while holding the row lock. Omission is retained only for
   * existing privileged standalone callers, never hosted request admission. */
  expect?: string | number | boolean | null;
}

/**
 * The outcome of one column write. A rejected value and an unknown asset are
 * results, not thrown errors; only an infrastructure failure throws. `value`
 * is read back from the UPDATE rather than echoed.
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
  | { ok: false; error: 'validation'; issues: ValidationIssue[] };


// Creating and deleting an asset row: operator actions over same-origin Tower
// routes proxied to the ingest binding. A row insert creates a join key and a
// delete of an asset that holds nothing removes one; neither touches a row of
// provider evidence, and nothing here writes a migration.

/**
 * A new asset row, as the wizard describes it. `status` and `senseOnly`
 * default to how a new asset starts: `onboarding`, observing only. `is_os` is
 * not here: asset #0 is a fact about this repo, not something a route may
 * mint a second of.
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

/** A duplicate is a result, not a thrown error. `asset_exists` names the site
 * that holds the id, or else the domain. */
export type CreateAssetResult =
  | { ok: true; asset: AssetRowSummary }
  | { ok: false; error: 'asset_exists'; asset: string; existingStatus: AssetStatus | null }
  | { ok: false; error: 'validation'; issues: ValidationIssue[] };

// The order of sites: every list follows each site's stored place
// (site-order.ts), and the operator sets it by moving one site at a time.

/**
 * Move one site to the place another site holds. Named by the site, not by a
 * number: a list the caller drew a moment ago may have gained a site since.
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
  | { ok: false; error: 'validation'; issues: ValidationIssue[] };
