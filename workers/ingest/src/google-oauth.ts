// Signing in to Google from the Integrations page: the whole round trip lives
// in the ingest Worker because the Tower is served unauthenticated on the LAN
// and must never hold a credential. The authorization URL is built here, the
// code is exchanged here, and the refresh token is sealed here; no token,
// client secret or state signing key crosses the Service Binding. Standalone
// retains its signed state; hosted entry uses single-use custody in the
// identity store, committed by the fixed receiver before these helpers run.

import {
  type CredentialMetadata,
  type GoogleOAuthCompletion,
  type GoogleOAuthStart,
  type GoogleDiscoveredProperty,
  type GoogleReadProduct,
  GOOGLE_OAUTH_AUTHORIZE_URL,
  GOOGLE_OAUTH_REVOKE_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_OAUTH_STATE_TTL_MS,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_TESTING_GRANT_DAYS,
  googleOAuthRedirectUri,
  googleRedirectVerdict,
} from '@noticeos/contract';
import {
  CredentialKeyError,
  carriedExpiry,
  credentialConnected,
  credentialSigningKey,
  credentialSummary,
  putCredential,
  recordCredentialOutcome,
  resolveCredential,
} from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { PROBE_CAPABILITY } from './probe-capability.js';
import {
  type GoogleAuth,
  type GoogleOAuthGrant,
  GOOGLE_SCOPES,
  arrayField,
  asRecord,
  base64UrlBytes,
  decodeBase64Url,
  providerError,
  responseJson,
  stringField,
} from './google-auth.js';

const REQUEST_TIMEOUT_MS = 20_000;

/** The two scopes a collector cannot work without; `openid`/`email` only cost
 * the card an address. */
const REQUIRED_SCOPES = [GOOGLE_SCOPES.ga4, GOOGLE_SCOPES.gsc] as const;

// ---------------------------------------------------------------------------
// What the OS holds for Google
// ---------------------------------------------------------------------------

/** Everything the Google collectors need to know about their credential, read
 * once and passed down. */
export interface ResolvedGoogleCredential {
  credential: Awaited<ReturnType<typeof resolveCredential>>;
  /** Where the credential came from — `store`, `env`, or `none`. */
  source: 'store' | 'env' | 'none';
  /** The account → properties map, when one is configured. */
  accounts: string | undefined;
  /** The sign-in, when the operator made one AND the OAuth app is set. */
  oauth: GoogleOAuthGrant | null;
  /** False exactly when Integrations draws Google as not connected: no stored
   * row (readable or not) and no complete env binding. */
  connected: boolean;
}

/**
 * The Google credential, both halves. The refresh token and the client
 * id/secret are two separate rows: the app is a fact about this deployment
 * that survives every reconnection, the grant a fact about one sign-in.
 */
export async function resolveGoogleCredential(
  env: IngestEnv,
): Promise<ResolvedGoogleCredential> {
  const credential = await resolveCredential(env, 'google');
  const refreshToken = credential.fields.GOOGLE_OAUTH_REFRESH_TOKEN;
  let oauth: GoogleOAuthGrant | null = null;
  if (refreshToken !== undefined && refreshToken !== '') {
    const app = await resolveGoogleOAuthApp(env);
    if (app !== null) {
      const summary = await credentialSummary(env, 'google');
      oauth = {
        ...app,
        refreshToken,
        account: summary?.metadata?.account ?? null,
        scopes: summary?.metadata?.scopes ?? [],
      };
    }
  }
  return {
    credential,
    source: credential.source,
    accounts: credential.fields.GOOGLE_SIGNAL_ACCOUNTS,
    oauth,
    connected: await credentialConnected(env, 'google', credential),
  };
}

/** The console app the sign-in runs through, or null when it has not been
 * entered yet. */
export async function resolveGoogleOAuthApp(
  env: IngestEnv,
  policy: 'legacy-fallback' | 'store-only' = 'legacy-fallback',
): Promise<{ clientId: string; clientSecret: string } | null> {
  const app = await resolveCredential(env, 'google-oauth-app', policy);
  const clientId = app.fields.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = app.fields.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** The credential a collector should authenticate with: the sign-in when there
 * is one, otherwise nothing (each account entry brings its own service-account
 * key). */
export function googleOAuthAuth(grant: GoogleOAuthGrant | null): GoogleAuth | null {
  return grant === null ? null : { kind: 'oauth', grant };
}

// ---------------------------------------------------------------------------
// The state nonce
// ---------------------------------------------------------------------------

interface StatePayload {
  /** Random, so two sign-ins started a second apart are different strings. */
  n: string;
  /** Epoch ms this state stops being accepted. */
  e: number;
  /** The redirect URI this state was minted for. */
  r: string;
}

/** Sign one state. Throws `CredentialKeyError` when there is no bootstrap key. */
export async function signOAuthState(
  env: IngestEnv,
  redirectUri: string,
  nowMs: number,
): Promise<string> {
  const payload: StatePayload = {
    n: base64UrlBytes(crypto.getRandomValues(new Uint8Array(16))),
    e: nowMs + GOOGLE_OAUTH_STATE_TTL_MS,
    r: redirectUri,
  };
  const body = base64UrlBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await credentialSigningKey(env);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64UrlBytes(new Uint8Array(signature))}`;
}

export type StateVerdict =
  | { ok: true; redirectUri: string }
  | { ok: false; error: 'state_invalid' | 'state_expired' };

/**
 * Check a state came from this install, has not expired, and names the redirect
 * URI it is presented at. Expiry is its own answer because it is the one an
 * honest operator hits, and "start again" differs from "something is wrong".
 */
export async function verifyOAuthState(
  env: IngestEnv,
  state: string,
  redirectUri: string,
  nowMs: number,
): Promise<StateVerdict> {
  const split = state.lastIndexOf('.');
  if (split <= 0) return { ok: false, error: 'state_invalid' };
  const body = state.slice(0, split);
  const signature = state.slice(split + 1);

  let key: CryptoKey;
  try {
    key = await credentialSigningKey(env);
  } catch (error) {
    if (error instanceof CredentialKeyError) return { ok: false, error: 'state_invalid' };
    throw error;
  }

  let verified = false;
  try {
    verified = await crypto.subtle.verify(
      'HMAC',
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(body),
    );
  } catch {
    return { ok: false, error: 'state_invalid' };
  }
  if (!verified) return { ok: false, error: 'state_invalid' };

  let payload: StatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body))) as StatePayload;
  } catch {
    return { ok: false, error: 'state_invalid' };
  }
  if (typeof payload.r !== 'string' || payload.r !== redirectUri) {
    return { ok: false, error: 'state_invalid' };
  }
  if (typeof payload.e !== 'number' || payload.e <= nowMs) {
    return { ok: false, error: 'state_expired' };
  }
  return { ok: true, redirectUri: payload.r };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface BeginGoogleOAuthInput {
  /** The origin the operator has the Tower open at; the redirect URI is derived from it. */
  origin: string;
  nowMs?: number;
}

/**
 * Where to send the browser, or the one thing standing in the way.
 * `prompt=consent` + `access_type=offline` together guarantee a refresh token:
 * Google issues one only on a fresh consent. `include_granted_scopes` is
 * deliberately absent: this OS asks for exactly what it reads.
 */
export async function beginGoogleOAuth(
  env: IngestEnv,
  input: BeginGoogleOAuthInput,
): Promise<GoogleOAuthStart> {
  // Every refusal below is a code the Tower words, with its one press beside it.
  const verdict = googleRedirectVerdict(input.origin);
  if (!verdict.usable) return { ok: false, error: 'redirect_unusable' };
  const app = await resolveGoogleOAuthApp(env);
  if (app === null) return { ok: false, error: 'app_missing' };
  const redirectUri = googleOAuthRedirectUri(input.origin);
  let state: string;
  try {
    state = await signOAuthState(env, redirectUri, input.nowMs ?? Date.now());
  } catch (error) {
    if (error instanceof CredentialKeyError) return { ok: false, error: 'key_missing' };
    throw error;
  }
  return googleAuthorizationUrl(app.clientId, redirectUri, state);
}

/** Called only within the receiver's post-commit live integration context. */
export async function beginStoredGoogleOAuth(env: IngestEnv, origin: string, state: string): Promise<GoogleOAuthStart> {
  if (!googleRedirectVerdict(origin).usable) return { ok: false, error: 'redirect_unusable' };
  const app = await resolveGoogleOAuthApp(env, 'store-only');
  if (app === null) return { ok: false, error: 'app_missing' };
  return googleAuthorizationUrl(app.clientId, googleOAuthRedirectUri(origin), state);
}
function googleAuthorizationUrl(clientId: string, redirectUri: string, state: string): GoogleOAuthStart {
  const authorizeUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();
  return { ok: true, authorizeUrl: authorizeUrl.toString(), redirectUri };
}

// ---------------------------------------------------------------------------
// Finish
// ---------------------------------------------------------------------------

export interface CompleteGoogleOAuthInput {
  /** The authorization code Google put on the callback. */
  code: string;
  state: string;
  /** The redirect URI the callback was served at, re-derived from the request
   * rather than trusted from the state. */
  redirectUri: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Turn an authorization code into a stored refresh token. The code is used
 * once and never persisted, logged or echoed. A grant missing either read
 * scope is refused rather than stored: a credential that can read Analytics
 * but not Search Console would look connected and fail one lane a day later.
 */
export async function completeGoogleOAuth(
  env: IngestEnv,
  input: CompleteGoogleOAuthInput,
): Promise<GoogleOAuthCompletion> {
  const nowMs = input.nowMs ?? Date.now();
  // Standalone compatibility only; hosted custody is committed by the entry.
  const state = await verifyOAuthState(env, input.state, input.redirectUri, nowMs);
  if (!state.ok) return { ok: false, error: state.error };
  return exchangeGoogleOAuth(env, input, 'legacy-fallback');
}

/** No state/authority input: the fixed receiver alone calls this after claim. */
export async function exchangeStoredGoogleOAuth(env: IngestEnv,
  input: Pick<CompleteGoogleOAuthInput, 'code' | 'redirectUri'>): Promise<GoogleOAuthCompletion> {
  return exchangeGoogleOAuth(env, input, 'store-only');
}
async function exchangeGoogleOAuth(env: IngestEnv,
  input: Pick<CompleteGoogleOAuthInput, 'code' | 'redirectUri'> & { nowMs?: number; fetchImpl?: typeof fetch },
  policy: 'legacy-fallback' | 'store-only'): Promise<GoogleOAuthCompletion> {
  const nowMs = input.nowMs ?? Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;

  // The client id and secret were removed while Google's screen was open.
  const app = await resolveGoogleOAuthApp(env, policy);
  if (app === null) return { ok: false, error: 'app_missing' };

  let payload: unknown;
  try {
    const response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        redirect_uri: input.redirectUri,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    payload = await responseJson(response);
    // Google answered no. Its status rides along; its body never does.
    if (!response.ok) return { ok: false, error: 'exchange_failed', status: response.status };
  } catch {
    // The thrown thing may be holding a url with the code in it. Google did
    // not answer, which is a different instruction from a refusal.
    return { ok: false, error: 'unreachable' };
  }

  const record = asRecord(payload);
  const refreshToken = stringField(record, 'refresh_token');
  // No refresh token: Google withholds one while an earlier grant stands, so
  // the page's press is Google's own connections screen, then Sign in again.
  if (refreshToken === null) return { ok: false, error: 'no_refresh_token' };

  const scopes = (stringField(record, 'scope') ?? '').split(' ').filter(Boolean);
  const withheld = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (withheld.length > 0) {
    return {
      ok: false,
      error: 'scope_incomplete',
      withheld: withheld.map((scope): GoogleReadProduct => (scope === GOOGLE_SCOPES.ga4 ? 'Google Analytics' : 'Search Console')),
    };
  }

  const account =
    idTokenEmail(stringField(record, 'id_token')) ??
    (await userInfoEmail(stringField(record, 'access_token'), fetchImpl));

  // When this sign-in dies, as far as anything here can know: Google publishes
  // no API that says whether a consent screen is still in Testing, and a
  // Testing screen expires every refresh token after seven days. The default is
  // the Testing setup; the card states the assumption with a one-press
  // correction, and `carriedExpiry` keeps the operator's answer through every
  // later sign-in.
  const previous = (await credentialSummary(env, 'google', policy))?.metadata ?? null;
  const metadata: CredentialMetadata = {
    account,
    scopes,
    connectedAt: new Date(nowMs).toISOString(),
    ...carriedExpiry(previous, {
      expiresAt: new Date(nowMs + GOOGLE_TESTING_GRANT_DAYS * 86_400_000).toISOString(),
      expirySource: 'flow',
    }),
  };

  // Carry forward whatever else the credential held: `putCredential` replaces
  // rather than merges.
  const existing = await resolveCredential(env, 'google', policy);
  const fields: Record<string, string> = {};
  if (existing.source === 'store' && existing.fields.GOOGLE_SIGNAL_ACCOUNTS) {
    fields.GOOGLE_SIGNAL_ACCOUNTS = existing.fields.GOOGLE_SIGNAL_ACCOUNTS;
  }
  fields.GOOGLE_OAUTH_REFRESH_TOKEN = refreshToken;

  const stored = await putCredential(env, { provider: 'google', fields, metadata });
  if (stored.ok) {
    // Google just issued this grant for both read scopes: that is the proof,
    // so the panel reads Signed in rather than Not checked.
    const at = new Date(nowMs).toISOString();
    await recordCredentialOutcome(env, 'google', { ok: true, error: null, at });
    await observeIntegration(env, await tryHealthConnection(env, 'google'), {
      capability: PROBE_CAPABILITY.google, observedAt: at, ok: true, code: 'provider', evidenceSource: 'probe',
    });
  }
  if (!stored.ok) return { ok: false, error: 'store_failed' };
  return { ok: true, account, scopes };
}

/**
 * The address out of the id token Google just issued. The signature is not
 * verified: the token came back over TLS on a request this Worker made,
 * authenticated with the client secret, and it is read for a display string
 * that authorizes nothing.
 */
export function idTokenEmail(idToken: string | null): string | null {
  if (idToken === null) return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]!)));
    return stringField(asRecord(claims), 'email');
  } catch {
    return null;
  }
}

/** The fallback when the grant carried no id token: one free userinfo read.
 * A failure costs the card an address and nothing else. */
async function userInfoEmail(
  accessToken: string | null,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  if (accessToken === null) return null;
  try {
    const response = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return stringField(asRecord(await responseJson(response)), 'email');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

/**
 * Tell Google to forget the grant, before the store forgets the token: a
 * network failure then leaves the token stored and still revocable, whereas
 * deleting first would leave a live grant this OS can no longer name. Best
 * effort; nothing here can fail a disconnect. Returns whether Google confirmed.
 */
export async function revokeGoogleGrant(
  env: IngestEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let token: string | undefined;
  try {
    token = (await resolveCredential(env, 'google')).fields.GOOGLE_OAUTH_REFRESH_TOKEN;
  } catch {
    return false;
  }
  if (token === undefined || token === '') return false;
  try {
    const response = await fetchImpl(GOOGLE_OAUTH_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// What this account can see
// ---------------------------------------------------------------------------

/**
 * The GA4 properties this credential can see: the Admin API's account
 * summaries. Free, read-only and unstored. The caller knows how to get a
 * token, because knowing which credential is in force means knowing about the
 * collectors, which this module deliberately does not.
 */
export async function listGa4Properties(
  token: string,
  fetchImpl: typeof fetch,
): Promise<GoogleDiscoveredProperty[]> {
  const response = await fetchImpl(
    'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw providerError('ga4_admin', response.status, body);
  const found: GoogleDiscoveredProperty[] = [];
  for (const summary of arrayField(asRecord(body), 'accountSummaries')) {
    const account = asRecord(summary);
    const accountName = stringField(account, 'displayName');
    for (const entry of arrayField(account, 'propertySummaries')) {
      const property = asRecord(entry);
      // `properties/123456789`: the collector stores the bare id.
      const ref = stringField(property, 'property')?.split('/').pop() ?? null;
      if (ref === null) continue;
      found.push({
        lane: 'ga4',
        ref,
        label: stringField(property, 'displayName') ?? ref,
        detail: accountName,
      });
    }
  }
  return found;
}

/** The Search Console sites this credential can see, with the permission
 * level Google reports for each. */
export async function listGscSites(
  token: string,
  fetchImpl: typeof fetch,
): Promise<GoogleDiscoveredProperty[]> {
  const response = await fetchImpl('https://www.googleapis.com/webmasters/v3/sites', {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await responseJson(response);
  if (!response.ok) throw providerError('gsc', response.status, body);
  const found: GoogleDiscoveredProperty[] = [];
  for (const entry of arrayField(asRecord(body), 'siteEntry')) {
    const site = asRecord(entry);
    const ref = stringField(site, 'siteUrl');
    if (ref === null) continue;
    found.push({
      lane: 'gsc',
      ref,
      label: ref,
      detail: stringField(site, 'permissionLevel'),
    });
  }
  return found;
}
