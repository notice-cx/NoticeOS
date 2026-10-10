// PATCH /api/assets/:id — the store-owned settings on one asset.
//
// `assets.status` (lifecycle stage), `assets.sense_only` (automation mode) and
// `assets.display_name` (the Tower label) are the only editable columns. They
// are store-owned, so they work in every deployment. Ingest writes the row
// through `writeAssetColumn()` over the INGEST binding; hosted receivers still
// admit the original request. This route adds the expect guard: the value the
// browser last saw must still be the stored value. The column rules live in
// workers/ingest/src/asset-state.ts.

import type {
  AssetStateRead,
  AssetStateWriteResult,
  StoreColumn,
  WriteAssetColumnInput,
} from "@noticeos/contract";
import { STORE_COLUMNS } from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/** Declared here rather than imported from the binding so this file stays free
 * of Workers globals (the test project typechecks it). */
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
    // A claim, not a check: ingest is the validator.
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
