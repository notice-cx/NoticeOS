import type { MoveAssetInput, MoveAssetResult } from '@noticeos/contract';
import { assetMutationInput } from '../../../scripts/workspace-operations.mjs';
import { JSON_HEADERS, crossOrigin, isJsonRequest, jsonError } from './http';

export interface AssetOrderWriter {
  moveAsset(input: MoveAssetInput, originalProof?: Request): Promise<MoveAssetResult>;
}

/** The target is a site identity, never an index from a possibly stale screen. */
export async function handleAssetOrderRequest(request: Request, url: URL,
  ingest: AssetOrderWriter, asset: string): Promise<Response> {
  if (request.method !== 'PATCH') return jsonError('method_not_allowed', 405);
  if (crossOrigin(request, url)) return jsonError('forbidden', 403);
  if (!isJsonRequest(request)) return jsonError('unsupported_media_type', 415);
  let input: MoveAssetInput;
  try {
    const { route, body } = await assetMutationInput(request);
    if (route.kind !== 'order' || route.asset !== asset) return jsonError('invalid_asset_order', 422);
    // The receiver validates field values; this boundary validates the exact envelope.
    input = { asset, to: body.to as string,
      ...(Object.hasOwn(body, 'expectRevision') ? { expectRevision: body.expectRevision as string } : {}) };
  } catch { return jsonError('invalid_asset_order', 422); }
  let result: MoveAssetResult;
  try { result = await ingest.moveAsset(input); }
  catch { return jsonError('asset_order_write_failed', 500); }
  if (!result.ok) {
    if (result.error === 'expect_mismatch') return jsonError('expect_mismatch', 409);
    if (result.error === 'unknown_asset') return jsonError('asset_not_found', 404);
    return jsonError('invalid_asset_order', 422);
  }
  return Response.json(result, { headers: JSON_HEADERS });
}
