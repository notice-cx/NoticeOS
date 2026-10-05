// POST /api/assets — an asset row is born.
//
// WHY THIS IS A ROUTE AT ALL. Until 2026-09-04 an asset was born as a seed
// MIGRATION plus a handful of hand edits to config files. The add-asset wizard
// (epic `ro-z349`) needs a create. Bead `ro-z349.1`.
//
// THERE IS NO DELETE. A site is never deleted: the store is history, and
// `retired` is the one exit (db/postgres/README.md, choice 5). The operator
// removed the Delete card and its `DELETE /api/assets/:id` on 2026-09-29 (bead
// `ro-ujb9.76.4.5`); Archive, a column write (asset-column-route.ts), is the
// way out, and adding the domain again answers `409 asset_exists` naming the
// archived site.
//
// AND WHY IT IS THE SAME CLASS AS THE EXISTING WRITES. What crosses here is a
// ROW, never a schema change: migrations stay an explicit operator-only sequence
// (AGENTS.md), and nothing in this file or below it writes one. Inserting an
// `assets` row creates a join key and the label hanging off it. Same posture as
// the column write beside it (asset-column-route.ts): same-origin only, proxied
// to the worker that owns the table over the private INGEST Service Binding, no
// credential crossing into a LAN-served, unauthenticated app.
//
// What is here is browser-facing only: the same-origin guard, the JSON envelope
// and the mapping from ingest's results to this route's error vocabulary. The id
// shape, the lifecycle enum and the display-name length are checked in
// workers/ingest/src/asset-state.ts, against the site row's declared fields
// (`SITE_ROW_FIELDS`, scripts/config-registers.mts) — it re-checks every field
// because an HTTP body is untrusted wherever it entered, and its refusal (the
// `detail` below) names the field by its label.

import type { CreateAssetInput, CreateAssetResult } from "@noticeos/contract";
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from "./http";

/**
 * The ingest RPC this route calls. `env.INGEST` satisfies it structurally;
 * declaring the surface here rather than importing the binding's type keeps this
 * file free of Workers globals and lets a test bind a double — the same trick
 * `AssetColumnWriter` uses next door.
 */
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
 * Create one asset.
 *
 * `201` with the row the store actually wrote (read back, not echoed) · `409
 * asset_exists` naming the site that holds the id or the domain ·
 * `422 invalid_asset` naming the field ·
 * `403` cross-origin · `415` non-JSON · `400` unparseable · `500` when the
 * binding itself failed.
 *
 * The body is `{id, displayName, domain?, status?, senseOnly?}`. It is passed
 * through as a CLAIM rather than validated here: ingest is the validator, and a
 * second copy of the id regex in this file would be a second answer.
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

  // 201 with a Location, because this route made a resource and the caller's
  // next move is to open it — the wizard navigates to the new asset's page.
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
