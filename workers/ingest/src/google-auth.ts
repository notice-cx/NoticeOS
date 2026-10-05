// How this OS proves to Google that it is allowed to read — BOTH ways, behind
// one door (bead `ro-vu8d.3`).
//
// WHY THIS MODULE EXISTS. Until now there was exactly one way in: a
// service-account key, signed into a JWT, exchanged for a scoped access token.
// Since the Integrations page learned to sign in (D21), there are two, and four
// call sites needed the second — the daily collectors, the realtime read, the
// archive lane, and the connection probe. A second `if` in each of those four
// is four places to get a token refresh wrong, so the auth is ONE value
// (`GoogleAuth`) and ONE function (`googleAccessToken`), and every collector
// asks for a token without knowing or caring which kind it holds.
//
// THE ONE DIFFERENCE WORTH KNOWING. A service-account token is minted PER
// SCOPE: ask for Analytics and you get a token that cannot read Search Console.
// An OAuth token carries the whole granted scope set at once, so `scope` is
// what the service-account path signs and what the OAuth path merely checks it
// was granted. Callers pass a scope either way; the difference stays here.
//
// NOTHING IS LOGGED. Not a key, not a token, not a refresh token, not a code.
// The errors this file raises carry Google's own message about the REQUEST, and
// `providerError` truncates it — the credential is never part of one.

import { createHash } from 'node:crypto';
import { SignalError } from './signal-store.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** The two read scopes a collector asks for by name. */
export const GOOGLE_SCOPES = {
  ga4: 'https://www.googleapis.com/auth/analytics.readonly',
  gsc: 'https://www.googleapis.com/auth/webmasters.readonly',
} as const;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;

/** A robot account's key, decoded out of the pasted map. */
export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
}

/**
 * A grant the operator made by signing in: the app that asked, plus the
 * long-lived token that buys short-lived ones.
 *
 * `account` and `scopes` ride along because every error message that mentions
 * an identity should mention THIS one — "the signed-in account" is not an
 * answer an operator can act on, and `ops@example.com` is.
 */
export interface GoogleOAuthGrant {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  account: string | null;
  scopes: readonly string[];
}

export type GoogleAuth =
  | { kind: 'service-account'; account: GoogleServiceAccount }
  | { kind: 'oauth'; grant: GoogleOAuthGrant };

/** Who this credential is, in a sentence an operator can act on: the robot's
 * address, or the person's. Never a secret — both are addresses Google itself
 * shows on the property's user list. */
export function googleAuthIdentity(auth: GoogleAuth): string {
  return auth.kind === 'service-account'
    ? auth.account.clientEmail
    : (auth.grant.account ?? 'the signed-in Google account');
}

/** What has to be granted where, when a property refuses this credential. The
 * two paths need genuinely different instructions, and an operator reading
 * "grant the service account Viewer" while signed in as themselves is being
 * sent to a screen that will not help. */
export function googleGrantHint(auth: GoogleAuth, role: string): string {
  const who = googleAuthIdentity(auth);
  return auth.kind === 'service-account'
    ? `Add ${who} as ${role} on the property.`
    : `${who} lacks ${role} on the property — sign in with another account.`;
}

/** Scope and full credential identity, including rotations, without retaining
 * the credential in the cache key. JSON framing keeps field boundaries exact.
 * Workspace/connection authorization remains the caller's responsibility. */
export function googleAuthCacheKey(auth: GoogleAuth, scope: string): string {
  const credential = auth.kind === 'service-account'
    ? [auth.account.clientEmail, auth.account.privateKeyId, auth.account.privateKey]
    : [auth.grant.clientId, auth.grant.clientSecret, auth.grant.refreshToken,
      auth.grant.account, [...auth.grant.scopes].sort()];
  return `google-token:${createHash('sha256').update(JSON.stringify([auth.kind, scope, credential])).digest('hex')}`;
}

/**
 * An access token for this credential and this scope. The ONE door.
 *
 * Both paths hit the same token endpoint with different grant types, and both
 * return a bearer token with a lifetime of roughly an hour. Nothing here caches
 * — `ga4-realtime.ts` has its own cache because it runs every 30 seconds, and a
 * cache in this module would be a second one.
 */
export async function googleAccessToken(
  auth: GoogleAuth,
  scope: string,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  return auth.kind === 'service-account'
    ? mintGoogleAccessToken(auth.account, scope, nowMs, fetchImpl)
    : refreshGoogleAccessToken(auth.grant, fetchImpl);
}

/**
 * The service-account path: sign a one-hour assertion with the robot's private
 * key and trade it for a scoped token.
 */
export async function mintGoogleAccessToken(
  serviceAccount: GoogleServiceAccount,
  scope: string,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<string> {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (serviceAccount.privateKeyId) header.kid = serviceAccount.privateKeyId;
  const nowSeconds = Math.floor(nowMs / 1000);
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson({
    iss: serviceAccount.clientEmail,
    scope,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(serviceAccount.privateKey).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    fetchImpl,
  );
}

/**
 * The OAuth path: trade the stored refresh token for an access token.
 *
 * The token that comes back carries every scope the operator granted, so this
 * is called once per collector run rather than once per scope. A refresh token
 * Google has revoked (the operator removed the app from their account, or the
 * project went back to testing mode) answers `invalid_grant`, which becomes a
 * `google_oauth_revoked` failure — a distinct code, because "reconnect the
 * card" and "check the property grant" are different instructions and burying
 * both under a 400 is how a dead credential looks like a flaky API.
 */
export async function refreshGoogleAccessToken(
  grant: GoogleOAuthGrant,
  fetchImpl: typeof fetch,
): Promise<string> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: grant.clientId,
      client_secret: grant.clientSecret,
      refresh_token: grant.refreshToken,
    }),
    fetchImpl,
  );
}

/** The failure code a revoked or expired grant raises. Named so a collector,
 * a probe and a card can all recognise the one condition that only a
 * reconnection fixes. */
export const GOOGLE_OAUTH_REVOKED_CODE = 'google_oauth_revoked';

/**
 * The sentence an operator meets when Google stops accepting the sign-in (bead
 * `ro-vu8d.14`).
 *
 * IT NAMES THE LIKELIEST CAUSE, because `invalid_grant` has three and only one
 * of them is common: a consent screen still in **Testing** expires every
 * refresh token after seven days, and the console setup this OS prescribes
 * makes a Testing screen. The other two — the operator removed NoticeOS from
 * their Google account permissions, or the client secret was rotated — are
 * fixed by the same first instruction. The actions are not in the sentence
 * (bead `ro-ujb9.96.6.24`): the card on /integrations draws them as presses —
 * Sign in again, its loudest control once the grant fails, and Publish app ↗
 * on the expiry line, the one that makes it stop recurring.
 *
 * IT IS OURS, NOT GOOGLE'S. Google's own `invalid_grant` body says nothing an
 * operator can act on, and nothing derived from a request that carried a
 * refresh token may be copied into a store column or a page. This string is a
 * constant, so what reaches `credentials.last_error` is a sentence this repo
 * wrote.
 */
export const GOOGLE_OAUTH_REVOKED_MESSAGE = 'Google revoked this sign-in: Testing-mode grants last 7 days.';

/** Whether a failure is Google refusing the SIGN-IN itself — the one condition
 * that no retry, no fresh token and no property grant can fix. Read
 * structurally so a collector, a probe and a card recognise it identically. */
export function isGoogleOAuthRevoked(error: unknown): boolean {
  return error instanceof SignalError && error.code === GOOGLE_OAUTH_REVOKED_CODE;
}

async function tokenRequest(
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await responseJson(response);
  if (!response.ok) {
    const record = asRecord(payload);
    if (stringField(record, 'error') === 'invalid_grant') {
      throw new SignalError(GOOGLE_OAUTH_REVOKED_CODE, GOOGLE_OAUTH_REVOKED_MESSAGE);
    }
    throw providerError('token', response.status, payload);
  }
  const token = stringField(asRecord(payload), 'access_token');
  if (!token) throw new SignalError('token_invalid_response', 'Google returned no access token.');
  return token;
}

/** The one place a base64 service-account key becomes usable. */
export function decodeServiceAccount(
  encoded: string,
  account: string,
): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64(encoded)));
  } catch {
    throw new SignalError(
      'credential_invalid',
      `Google account "${account}" has an unreadable service-account key.`,
    );
  }
  const record = asRecord(parsed);
  const clientEmail = stringField(record, 'client_email');
  const privateKey = stringField(record, 'private_key');
  if (!clientEmail || !privateKey) {
    throw new SignalError(
      'credential_invalid',
      `Google account "${account}" is missing client_email or private_key.`,
    );
  }
  return {
    clientEmail,
    privateKey,
    privateKeyId: stringField(record, 'private_key_id'),
  };
}

// ---------------------------------------------------------------------------
// Reading what Google answered
// ---------------------------------------------------------------------------

export async function responseJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new SignalError(
      'response_too_large',
      `Google response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
    );
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SignalError(
          'response_too_large',
          `Google response exceeded ${MAX_RESPONSE_BYTES} bytes.`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SignalError('response_invalid_json', 'Google returned invalid JSON.');
  }
}

export function providerError(prefix: string, status: number, body: unknown): SignalError {
  const record = asRecord(body);
  const nested = asRecord(record?.error);
  const message =
    stringField(nested, 'message') ??
    stringField(record, 'error_description') ??
    `Google request failed with HTTP ${status}.`;
  return new SignalError(`${prefix}_http_${status}`, message.slice(0, 500));
}

/** Whether a failure was Google saying "this token is no good" — the one class
 * that a fresh token can fix, and the reason every collector may retry ONCE. */
export function isGoogleAuthExpiry(error: unknown): boolean {
  return error instanceof SignalError && /_http_401$/.test(error.code);
}

// ---------------------------------------------------------------------------
// Small shared readers and encoders
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function arrayField(record: Record<string, unknown> | null, field: string): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function pemToBytes(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new SignalError('credential_invalid', 'Service-account private key is empty.');
  try {
    return decodeBase64(base64);
  } catch {
    throw new SignalError('credential_invalid', 'Service-account private key is malformed.');
  }
}

export function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** The inverse of `base64UrlBytes`, for reading a JWT payload Google signed. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return decodeBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}
