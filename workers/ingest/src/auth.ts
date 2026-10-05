// Bearer-token authentication. Two lanes:
//   - assets push pulses, authed against env.ASSET_TOKENS (a JSON map
//     asset-id -> token) keyed by the asset id in the pulse body;
//   - the operator pushes revenue, authed against env.OPERATOR_TOKEN.
//
// env.ASSET_TOKENS is ONE map serving both directions: an asset holds a single
// secret (its own ASSET_TOKEN), which this module CHECKS on the way in and
// src/pull.ts PRESENTS on the way out when the OS scrapes that same asset's
// self-report endpoint. There is no second per-asset token map.
//
// Comparisons are constant-time: both sides are SHA-256'd first so equal-length
// digests go into crypto.subtle.timingSafeEqual, which keeps the token length
// itself from leaking through an early length check.

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Constant-time equality over the SHA-256 digests of two strings. */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/**
 * Authenticate an asset pulse: the presented bearer token must match the token
 * registered for `assetId` in env.ASSET_TOKENS. Unknown assets still run a
 * comparison against a placeholder so the response timing does not reveal which
 * asset ids are registered.
 */
export async function authenticateAsset(
  request: Request,
  assetTokensJson: string,
  assetId: string,
): Promise<boolean> {
  const token = bearer(request);
  if (!token) return false;
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(assetTokensJson) as Record<string, unknown>;
  } catch {
    return false;
  }
  const expected = map[assetId];
  if (typeof expected !== 'string') {
    await secretEquals(token, '\0no-such-asset');
    return false;
  }
  return secretEquals(token, expected);
}

/** Authenticate the operator against env.OPERATOR_TOKEN. */
export async function authenticateOperator(
  request: Request,
  operatorToken: string,
): Promise<boolean> {
  const token = bearer(request);
  if (!token) return false;
  return secretEquals(token, operatorToken);
}
