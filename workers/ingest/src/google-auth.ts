// How this OS proves to Google that it is allowed to read, both ways behind
// one door: a service-account key signed into a JWT, or the operator's
// sign-in. The auth is one value (`GoogleAuth`) and one function
// (`googleAccessToken`), so no collector branches on which kind it holds. A
// service-account token is minted per scope; an OAuth token carries the whole
// granted scope set, so `scope` is what the service-account path signs and
// what the OAuth path merely checks. Nothing is logged: not a key, a token, a
// refresh token or a code, and `providerError` truncates Google's message.

import { createHash } from 'node:crypto';
import { asRecord, stringField } from './shared.js';
import { SignalError, boundedResponseJson } from './signal-store.js';

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
 * long-lived token that buys short-lived ones. `account` and `scopes` ride
 * along so every error that mentions an identity names this one.
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

/** Who this credential is, in a sentence an operator can act on. Never a
 * secret: both are addresses Google itself shows on the property's user list. */
export function googleAuthIdentity(auth: GoogleAuth): string {
  return auth.kind === 'service-account'
    ? auth.account.clientEmail
    : (auth.grant.account ?? 'the signed-in Google account');
}

/** What has to be granted where, when a property refuses this credential: the
 * two paths need genuinely different instructions. */
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
 * An access token for this credential and this scope: the one door. Nothing
 * here caches; `ga4-realtime.ts` has its own cache because it runs every 30
 * seconds.
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
 * The OAuth path: trade the stored refresh token for an access token carrying
 * every granted scope. A refresh token Google has revoked answers
 * `invalid_grant`, which becomes `google_oauth_revoked`: "reconnect the card"
 * and "check the property grant" are different instructions.
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

/** The failure code a revoked or expired grant raises, so a collector, a probe
 * and a card recognise the one condition only a reconnection fixes. */
export const GOOGLE_OAUTH_REVOKED_CODE = 'google_oauth_revoked';

/**
 * The sentence an operator meets when Google stops accepting the sign-in. It
 * names the likeliest cause: a consent screen still in Testing expires every
 * refresh token after seven days. It is ours, not Google's: nothing derived
 * from a request that carried a refresh token may be copied into a store
 * column or a page.
 */
export const GOOGLE_OAUTH_REVOKED_MESSAGE = 'Google revoked this sign-in: Testing-mode grants last 7 days.';

/** Whether a failure is Google refusing the sign-in itself, read structurally
 * so a collector, a probe and a card recognise it identically. */
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

export function responseJson(response: Response): Promise<unknown> {
  return boundedResponseJson(response, 'Google', MAX_RESPONSE_BYTES);
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

/** Whether a failure was Google saying "this token is no good": the one class a
 * fresh token can fix, and the reason every collector may retry once. */
export function isGoogleAuthExpiry(error: unknown): boolean {
  return error instanceof SignalError && /_http_401$/.test(error.code);
}

// ---------------------------------------------------------------------------
// Small shared readers and encoders
// ---------------------------------------------------------------------------

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
