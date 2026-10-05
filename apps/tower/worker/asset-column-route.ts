// PATCH /api/assets/:id — the store-owned settings on one asset.
//
// `assets.status` (lifecycle stage), `assets.sense_only` (automation mode) and
// `assets.display_name` (the Tower label) are the only columns of the row
// anything may edit; everything else is identity or entity metadata (db/README
// §assets). They are STORE-owned, not file-owned, so they do not go
// through the config write lane: the lane exists only in the local dev server,
// while these work in every deployment, because a Worker can always reach the
// store. D18, bead ro-pbzu.5; `display_name` joined them in bead ro-z349.1, so
// an asset created from the wizard can be renamed after the typo is spotted.
//
// The row itself is written by ingest, which owns the table, through
// `writeAssetColumn()` on its WorkerEntrypoint — the private INGEST Service
// Binding, exactly as the annotation write goes. Hosted receivers independently
// admit the original request; the binding alone is not customer authority.
//
// What is here is browser-facing only: the same-origin guard, the JSON
// envelope, the EXPECT GUARD (the value the browser last saw must still be the
// value the store holds, or the save is refused rather than blindly
// overwriting a change made somewhere else), and the mapping from ingest's
// result to this route's error vocabulary. The column allowlist, the lifecycle
// enum, the 0/1 rule and the 1–80-character name live in
// workers/ingest/src/asset-state.ts.

import type {
  AssetStateRead,
  AssetStateWriteResult,
  StoreColumn,
  WriteAssetColumnInput,
} from "@noticeos/contract";
import { STORE_COLUMNS } from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/**
 * The two ingest RPCs this route calls. `env.INGEST` satisfies it structurally;
 * declaring the surface here rather than importing the binding's type keeps
 * this file free of Workers globals (the test project typechecks it too) and
 * lets a test bind a double. Same trick as `AnnotationWriter` in
 * ./annotation-route.
 */
export interface AssetColumnWriter {
  readAssetState(asset: string, originalProof?: Request): Promise<AssetStateRead>;
  writeAssetColumn(input: WriteAssetColumnInput, originalProof?: Request): Promise<AssetStateWriteResult>;
}

function isStoreColumn(value: unknown): value is StoreColumn {
  return (STORE_COLUMNS as readonly string[]).includes(value as string);
}

/** What the store holds for one column, in the shape the browser sent it: the
 * `expect` a Save carries is the value the UI rendered, so `sense_only` arrives
 * as 0/1 and `status`/`display_name` as strings — exactly what the row holds. */
function currentValue(read: AssetStateRead, column: StoreColumn): string | number | null {
  if (!read.known || read.columns === null) return null;
  if (column === "status") return read.columns.status;
  if (column === "display_name") return read.columns.display_name;
  return read.columns.sense_only;
}

/**
 * Handle one column edit. `asset` has already been extracted from the path.
 *
 * Error vocabulary matches the flag, decision and annotation routes:
 * 405 method_not_allowed · 403 forbidden · 415 unsupported_media_type ·
 * 400 bad_request · 422 invalid_asset_column · 404 asset_not_found ·
 * 409 expect_mismatch · 500 asset_column_write_failed.
 */
export async function handleAssetColumnRequest(
  request: Request,
  url: URL,
  ingest: AssetColumnWriter,
  asset: string,
): Promise<Response> {
  if (request.method !== "PATCH") {
    return jsonError("method_not_allowed", 405);
  }
  if (crossOrigin(request, url)) {
    return jsonError("forbidden", 403);
  }
  if (!isJsonRequest(request)) {
    return jsonError("unsupported_media_type", 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("bad_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("invalid_asset_column", 422, { field: "body" });
  }
  const record = body as Record<string, unknown>;
  if (!isStoreColumn(record.column)) {
    return jsonError("invalid_asset_column", 422, {
      field: "column",
      detail: `only ${STORE_COLUMNS.join(", ")} are store-editable`,
    });
  }
  const column = record.column;
  if (!("expect" in record)) {
    return jsonError("invalid_asset_column", 422, {
      field: "expect",
      detail: "expect is the concurrency guard and is required",
    });
  }
  const value = record.value;
  if (typeof value !== "string" && typeof value !== "number") {
    return jsonError("invalid_asset_column", 422, { field: "value" });
  }

  // This early read can reject an already stale page. The writer repeats the
  // comparison under its row lock so concurrent saves cannot both win.
  let current: string | number | null;
  try {
    const read = await ingest.readAssetState(asset);
    if (!read.known) {
      return jsonError("asset_not_found", 404, { id: asset });
    }
    current = currentValue(read, column);
  } catch {
    return jsonError("asset_column_write_failed", 500);
  }
  if (current !== record.expect) {
    return jsonError("expect_mismatch", 409, { column, current });
  }

  let result: AssetStateWriteResult;
  try {
    // A claim, not a check: ingest is the validator. It re-checks the column,
    // the lifecycle enum and the 0/1 rule, because an HTTP body is untrusted
    // wherever it entered.
    result = await ingest.writeAssetColumn({ asset, column, value, expect: record.expect as WriteAssetColumnInput['expect'] });
  } catch {
    // Keep the service boundary opaque: the browser gets a code, not ingest's
    // internals, and treats it as "the change was not saved".
    return jsonError("asset_column_write_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "expect_mismatch") {
      return jsonError("expect_mismatch", 409, { column: result.column, current: result.current });
    }
    if (result.error === "unknown_asset") {
      return jsonError("asset_not_found", 404, { id: asset });
    }
    return jsonError("invalid_asset_column", 422, {
      field: result.issues[0]?.path ?? "body",
      detail: result.issues[0]?.message,
    });
  }

  return Response.json(
    {
      ok: true,
      asset: result.asset,
      column: result.column,
      value: result.value,
      updatedAt: result.updatedAt,
    },
    { headers: JSON_HEADERS },
  );
}
