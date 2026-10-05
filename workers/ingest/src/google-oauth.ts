// Signing in to Google from the Integrations page — the whole round trip
// (bead `ro-vu8d.3`, epic `ro-vu8d`, D21, doc 15 flow C).
//
// WHY IT ALL LIVES IN THE INGEST WORKER. The Tower is served unauthenticated on
// the LAN and must never hold a credential. So its two routes carry a redirect
// and an authorization code and nothing else: the authorization URL is BUILT
// here, the code is EXCHANGED here, and the refresh token is sealed into the
// store here. No token, no client secret and no state signing key ever crosses
// the Service Binding in either direction.
//
// Standalone retains its legacy signed state. Hosted entry uses durable,
// person/session/workspace-bound single-use custody in the identity store.
// The fixed receiver commits that custody before these provider helpers run.

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

/** The two scopes a collector cannot work without. `openid`/`email` are asked
 * for as well but their absence only costs the card an address, so an
 * incomplete grant is judged on these. */
const REQUIRED_SCOPES = [GOOGLE_SCOPES.ga4, GOOGLE_SCOPES.gsc] as const;

// ---------------------------------------------------------------------------
// What the OS holds for Google
// ---------------------------------------------------------------------------

/** Everything the Google collectors need to know about their credential, read
 * once and passed down rather than re-resolved per lane. */
export interface ResolvedGoogleCredential {
  credential: Awaited<ReturnType<typeof resolveCredential>>;
  /** Where the credential came from — `store`, `env`, or `none`. */
  source: 'store' | 'env' | 'none';
  /** The account → properties map, when one is configured. Undefined under an
   * OAuth-only install, which has no properties mapped until `ro-vu8d.4`. */
  accounts: string | undefined;
  /** The sign-in, when the operator made one AND the OAuth app is set. */
  oauth: GoogleOAuthGrant | null;
  /**
   * False exactly when Integrations draws Google as not connected: no stored
   * row (readable or not) and no complete env binding (bead `ro-ujb9.172`).
   * A row this Worker cannot open is still a connection, one that broke.
   */
  connected: boolean;
}

/**
 * The Google credential, both halves.
 *
 * The refresh token and the client id/secret are two SEPARATE rows on purpose
 * (`google` and `google-oauth-app`): the app is a fact about this deployment
 * that survives every reconnection, and the grant is a fact about one sign-in.
 * Rotating a client secret must not log the operator out, and disconnecting
 * must not throw away the console setup they would have to redo.
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
 * URI it is being presented at.
 *
 * Every refusal is `state_invalid` except the expiry, which is its own answer
 * because it is the one an honest operator hits — a consent screen left open
 * over lunch — and "start again" is a different instruction from "something is
 * wrong".
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
  /** The origin the operator has the Tower open at. The redirect URI is derived
   * from it, because that is the only place it can be right. */
  origin: string;
  nowMs?: number;
}

/**
 * Where to send the browser, or the one thing standing in the way.
 *
 * `prompt=consent` + `access_type=offline` together are what guarantee a
 * REFRESH token: Google issues one only on a fresh consent, and an operator who
 * has connected before would otherwise be handed an hour-long access token and
 * a card that goes dead overnight. `include_granted_scopes` is deliberately
 * absent — this OS asks for exactly what it reads and nothing it inherited.
 */
export async function beginGoogleOAuth(
  env: IngestEnv,
  input: BeginGoogleOAuthInput,
): Promise<GoogleOAuthStart> {
  // Every refusal below is a code the Tower words (`googleOAuthNotice`), with
  // its one press — the loopback address, the client fields — beside it.
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
  /** The redirect URI the callback was served at — re-derived from the request
   * rather than trusted from the state, so the two have to agree. */
  redirectUri: string;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Turn an authorization code into a stored refresh token.
 *
 * The code is used ONCE and never persisted, logged or echoed. What is stored
 * is the refresh token (sealed) plus the two non-secret facts the card needs:
 * the account address and the scopes Google actually granted.
 *
 * A grant missing either read scope is REFUSED rather than stored. Google's
 * consent screen lets an operator untick a box, and a credential that can read
 * Analytics but not Search Console would look connected and then fail one lane
 * a day later with a 403 nobody could trace back to a checkbox.
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
    // Google answered no — a redirect mismatch, a wrong client secret, a code
    // already spent. Its status rides along; its body never does, and neither
    // does anything derived from what was sent.
    if (!response.ok) return { ok: false, error: 'exchange_failed', status: response.status };
  } catch {
    // The thrown thing may be holding a url, and this url has a code in it.
    // Never copy a transport error's message here. Google did not answer,
    // which is a different instruction (try again) from a refusal.
    return { ok: false, error: 'unreachable' };
  }

  const record = asRecord(payload);
  const refreshToken = stringField(record, 'refresh_token');
  // No refresh token: the grant would die within the hour. Google withholds
  // one while an earlier grant stands, so the page's press is Google's own
  // connections screen (remove the old access), then Sign in again.
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

  // WHEN THIS SIGN-IN DIES, as far as anything here can honestly know (bead
  // `ro-vu8d.8`).
  //
  // Google publishes NO API that reports whether a consent screen is still in
  // Testing, and a Testing screen expires every refresh token seven days after
  // it is granted. So the default is the setup this OS itself prescribes — doc
  // 11's console steps say External plus a test user, which IS a Testing screen
  // — and the card states the assumption in words with a one-press correction
  // beside it. An operator who has published the app answers once and
  // `carriedExpiry` keeps that answer through every later sign-in.
  //
  // This is the difference between .8 and what shipped in `ro-vu8d.3`: the
  // revoked-grant detection in `google-auth.ts` is honest and arrives AFTER the
  // collectors have already failed. A date is what lets the card speak first.
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

  // Carry forward whatever else the credential held — a service-account map an
  // install is still pulling properties from must survive a sign-in, and
  // `putCredential` replaces rather than merges by design.
  const existing = await resolveCredential(env, 'google', policy);
  const fields: Record<string, string> = {};
  if (existing.source === 'store' && existing.fields.GOOGLE_SIGNAL_ACCOUNTS) {
    fields.GOOGLE_SIGNAL_ACCOUNTS = existing.fields.GOOGLE_SIGNAL_ACCOUNTS;
  }
  fields.GOOGLE_OAUTH_REFRESH_TOKEN = refreshToken;

  const stored = await putCredential(env, { provider: 'google', fields, metadata });
  if (stored.ok) {
    // Google just issued this grant for both read scopes: that is the proof,
    // stamped where the connect panel's accepted keys are (bead
    // `ro-ujb9.96.7.7`), so the panel reads Signed in rather than Not checked.
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
 * The address out of the id token Google just issued.
 *
 * The signature is NOT verified, and that is correct here rather than lazy:
 * this token came back over TLS on a response to a request this Worker made,
 * authenticated with the client secret. There is no third party in the path
 * whose forgery a signature check would catch. It is read for a display string
 * and nothing is authorized by it.
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
 * A failure costs the card an address and nothing else, so it never throws. */
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
 * Tell Google to forget the grant, before the store forgets the token.
 *
 * BEST EFFORT AND IN THAT ORDER. Revoking first means a network failure leaves
 * the token still stored and still revocable on the next attempt; deleting
 * first would leave a live grant on the operator's Google account that this OS
 * can no longer name. Nothing here can fail a disconnect — an operator pressing
 * Disconnect while offline still gets the credential removed, and the grant is
 * one they can remove from their Google account page.
 *
 * Returns whether Google confirmed, so the card can say which happened.
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
 * The GA4 properties this credential can see — the Admin API's account
 * summaries, which `analytics.readonly` already covers.
 *
 * Free, read-only and unstored. The caller (`credential-probes.ts`) is the one
 * that knows how to get a token, because working out WHICH credential is in
 * force means knowing about the collectors and this module deliberately does
 * not.
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
      // `properties/123456789` — the collector stores the bare id.
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

/** The Search Console sites this credential can see, with the permission level
 * Google reports for each — the cheapest call Search Console has. */
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
