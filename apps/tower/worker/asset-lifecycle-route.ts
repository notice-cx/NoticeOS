// POST /api/assets — create an asset row (a row, never a schema change). There
// is no delete: a site is never deleted; Archive (asset-column-route.ts) is the
// way out, and adding an archived domain again answers `409 asset_exists`.
// Browser-facing only: ingest (workers/ingest/src/asset-state.ts) validates
// every field against `SITE_ROW_FIELDS` and names the refused one.

import type { CreateAssetInput, CreateAssetResult } from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/** Declared here rather than imported from the binding so this file stays free
 * of Workers globals. */
export interface AssetLifecycleWriter {
  createAsset(input: CreateAssetInput, originalProof?: Request): Promise<CreateAssetResult>;
}

/** The first rejected field, in the shape every write route reports one. */
function invalid(result: { issues: { path: string; message: string }[] }): Response {
  return jsonError("invalid_asset", 422, {
    field: result.issues[0]?.path ?? "body",
    detail: result.issues[0]?.message,
  });
}

/**
 * `201` with the row the store wrote (read back, not echoed) · `409
 * asset_exists` naming the site that holds the id or the domain ·
 * `422 invalid_asset` naming the field · `403` cross-origin · `415` non-JSON ·
 * `400` unparseable · `500` when the binding failed. The body passes through as
 * a claim; ingest is the validator.
 */
export async function handleCreateAssetRequest(
  request: Request,
  url: URL,
  ingest: AssetLifecycleWriter,
): Promise<Response> {
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
    return jsonError("invalid_asset", 422, { field: "body" });
  }

  let result: CreateAssetResult;
  try {
    result = await ingest.createAsset(body as CreateAssetInput);
  } catch {
    // Keep the service boundary opaque: the browser gets a code, not ingest's
    // internals, and treats it as "the asset was not created".
    return jsonError("asset_create_failed", 500);
  }

  if (!result.ok) {
    if (result.error === "asset_exists") {
      return jsonError("asset_exists", 409, { id: result.asset, existingStatus: result.existingStatus });
    }
    return invalid(result);
  }

  // 201 with a Location: the wizard navigates to the new asset's page.
  return Response.json(
    { ok: true, asset: result.asset },
    {
      status: 201,
      headers: {
        ...JSON_HEADERS,
        location: `/api/assets/${encodeURIComponent(result.asset.id)}`,
      },
    },
  );
}
