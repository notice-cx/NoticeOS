// Connecting Google by signing in. What these assertions protect, in the order
// an attacker or an accident would meet them: a state this install did not
// sign, or signed for another address, or signed too long ago, never reaches
// Google's token endpoint; a code is exchanged exactly once and what comes back
// is sealed rather than echoed; the refresh token appears in no summary, return
// value or log line; a grant missing a scope is refused; a disconnect revokes
// at Google before it deletes; and every collector authenticates the same way
// whichever credential it holds. Against a real store, real WebCrypto and a
// mocked token endpoint: the state is an HMAC over a key derived from
// `CREDENTIALS_KEY`, and a mock of that would be testing the mock.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_TESTING_GRANT_DAYS,
  googleOAuthRedirectUri,
  googleLoopbackOrigin,
  googleRedirectVerdict,
} from '@noticeos/contract';
import {
  credentialSummary,
  putCredential,
  resolveCredential,
  setCredentialExpiry,
} from '../src/credentials.js';
import {
  beginGoogleOAuth,
  completeGoogleOAuth,
  idTokenEmail,
  resolveGoogleCredential,
  resolveGoogleOAuthApp,
  revokeGoogleGrant,
  signOAuthState,
  verifyOAuthState,
} from '../src/google-oauth.js';
import {
  discoverGoogleProperties,
  disconnectCredential,
  probeCredential,
} from '../src/credential-probes.js';
import {
  GOOGLE_OAUTH_REVOKED_MESSAGE,
  refreshGoogleAccessToken,
} from '../src/google-auth.js';
import { runGoogleSignals } from '../src/google-signals.js';
import { discoverSites } from '../src/site-discovery.js';
import { runCollectNow } from '../src/dispatch.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import { reset, emptyTables, forgetCredentials, storedCredential } from './helpers.js';

/** The one string this file hunts for. Every summary, every return value and
 * every captured log line is searched for it. */
const REFRESH_TOKEN = 'SEKRIT-google-refresh-1//do-not-echo';
const CLIENT_SECRET = 'SEKRIT-google-client-secret-do-not-echo';
const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const CODE = 'SEKRIT-authorization-code-do-not-echo';

const ORIGIN = 'http://127.0.0.1:5173';
const REDIRECT_URI = googleOAuthRedirectUri(ORIGIN);
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

it('hosted stored-only app resolution never reads ambient provider bindings or legacy config', async () => {
  const target = bare();
  Object.defineProperties(target, {
    GOOGLE_OAUTH_CLIENT_ID: { get() { throw new Error('ambient-provider-read'); } },
    GOOGLE_OAUTH_CLIENT_SECRET: { get() { throw new Error('ambient-provider-read'); } },
  });
  expect(await resolveGoogleOAuthApp(target, 'store-only')).toBeNull();
  expect(await credentialSummary(target, 'google', 'store-only')).toBeNull();
  await storeOAuthApp();
  expect(await resolveGoogleOAuthApp(target, 'store-only')).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
});

it('stored-only resolution refuses unreadable credentials instead of falling back to a deployment grant', async () => {
  await storeOAuthApp();
  const target = { ...bare(), CREDENTIALS_KEY: '', GOOGLE_OAUTH_CLIENT_ID: crypto.randomUUID(), GOOGLE_OAUTH_CLIENT_SECRET: crypto.randomUUID() };
  expect(await resolveGoogleOAuthApp(target, 'store-only')).toBeNull();
  expect(await resolveCredential(target, 'google-oauth-app', 'store-only')).toMatchObject({ source: 'none', fields: {}, legacySlots: {} });
});

beforeEach(async () => {
  await reset();
});
afterEach(async () => {
  await forgetCredentials();
});

/** The env minus the operator's real Google binding, so an unconfigured
 * provider is a fact this file STATES rather than one it hopes for. */
function bare(): IngestEnv {
  const copy = { ...env } as Record<string, unknown>;
  delete copy.GOOGLE_SIGNAL_ACCOUNTS;
  return copy as unknown as IngestEnv;
}

async function storeOAuthApp(target: IngestEnv = bare()): Promise<void> {
  const stored = await putCredential(target, {
    provider: 'google-oauth-app',
    fields: {
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    },
  });
  expect(stored.ok).toBe(true);
}

/** An id token with the shape Google returns: three base64url segments, the
 * middle one the claims. Only the claims are read (see `idTokenEmail`). */
function idToken(email: string): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${b64({ alg: 'RS256' })}.${b64({ email, sub: '1', aud: CLIENT_ID })}.sig`;
}

interface TokenCall {
  url: string;
  body: string;
}

/** A token endpoint that records what it was asked and answers what Google
 * would. `overrides` shapes the payload for the refusal cases. */
function tokenEndpoint(
  calls: TokenCall[],
  overrides: Record<string, unknown> = {},
  status = 200,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? '') });
    if (url === TOKEN_URL) {
      return Response.json(
        {
          access_token: 'ya29.access-token',
          expires_in: 3599,
          refresh_token: REFRESH_TOKEN,
          scope: GOOGLE_OAUTH_SCOPES.join(' '),
          token_type: 'Bearer',
          id_token: idToken('ops@example.test'),
          ...overrides,
        },
        { status },
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

/** Swap the console out for a recorder. Used to prove nothing this flow logs
 * carries a token, a secret or a code. */
async function withCapturedLogs<T>(
  work: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

// ---------------------------------------------------------------------------

describe('the redirect address', () => {
  it('accepts https and loopback, and refuses the LAN as a code whose fix is the loopback address', () => {
    expect(googleRedirectVerdict('https://tower.example.com').usable).toBe(true);
    expect(googleRedirectVerdict('http://127.0.0.1:5173').usable).toBe(true);
    expect(googleRedirectVerdict('http://localhost:5173').usable).toBe(true);

    // The case this OS actually meets: `os:up` binds the LAN by default, and
    // Google refuses every plain-http address that is not loopback. The
    // refusal has to carry the address to use instead, or an operator is
    // stranded on an `invalid_request` from Google with no hint.
    const lan = googleRedirectVerdict('http://192.168.1.20:5173');
    expect(lan).toEqual({ usable: false, problem: 'insecure-host' });
    expect(googleLoopbackOrigin('http://192.168.1.20:5173')).toBe('http://127.0.0.1:5173');
    expect(googleRedirectVerdict('not a url')).toEqual({ usable: false, problem: 'not-an-address' });
  });

  it('derives the callback path from the origin, with no trailing-slash trap', () => {
    expect(googleOAuthRedirectUri('http://127.0.0.1:5173')).toBe(
      'http://127.0.0.1:5173/api/integrations/google/oauth/callback',
    );
    expect(googleOAuthRedirectUri('http://127.0.0.1:5173/')).toBe(
      'http://127.0.0.1:5173/api/integrations/google/oauth/callback',
    );
  });
});

describe('starting a sign-in', () => {
  it('refuses before the OAuth app is entered, and says which step is missing', async () => {
    const start = await beginGoogleOAuth(bare(), { origin: ORIGIN, nowMs: NOW });
    expect(start.ok).toBe(false);
    if (start.ok) throw new Error('unreachable');
    expect(start.error).toBe('app_missing');
  });

  it('refuses an origin Google will not return to, before minting anything', async () => {
    await storeOAuthApp();
    const start = await beginGoogleOAuth(bare(), {
      origin: 'http://192.168.1.20:5173',
      nowMs: NOW,
    });
    expect(start.ok).toBe(false);
    if (start.ok) throw new Error('unreachable');
    expect(start.error).toBe('redirect_unusable');
  });

  it('asks Google for offline access, a fresh consent, and exactly its read scopes', async () => {
    await storeOAuthApp();
    const start = await beginGoogleOAuth(bare(), { origin: ORIGIN, nowMs: NOW });
    expect(start.ok).toBe(true);
    if (!start.ok) throw new Error('unreachable');

    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    // Both together are what guarantee a REFRESH token: Google issues one only
    // on a fresh consent, so a second connect without `prompt=consent` would
    // return an hour-long access token and a card that dies overnight.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(
      [...GOOGLE_OAUTH_SCOPES].sort(),
    );
    // Read-only, both of them. `webmasters` (writable) must never appear.
    expect(start.authorizeUrl).not.toContain('auth/webmasters&');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('never puts the client secret in the URL the browser is sent to', async () => {
    await storeOAuthApp();
    const start = await beginGoogleOAuth(bare(), { origin: ORIGIN, nowMs: NOW });
    if (!start.ok) throw new Error('unreachable');
    expect(start.authorizeUrl).not.toContain(CLIENT_SECRET);
  });
});

describe('the state nonce', () => {
  it('accepts only a state this install signed, for this address, in time', async () => {
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);

    expect(await verifyOAuthState(bare(), state, REDIRECT_URI, NOW + 1000)).toEqual({
      ok: true,
      redirectUri: REDIRECT_URI,
    });
    // A different address: the state is bound to the origin it was minted for,
    // so one taken from a loopback session cannot be replayed at another host.
    expect(
      await verifyOAuthState(bare(), state, 'https://evil.example/callback', NOW + 1000),
    ).toEqual({ ok: false, error: 'state_invalid' });
    // Ten minutes later it is expired, and that is its OWN answer — a consent
    // screen left open over lunch is an honest mistake, and "start again" is a
    // different instruction from "something is wrong".
    expect(await verifyOAuthState(bare(), state, REDIRECT_URI, NOW + 11 * 60_000)).toEqual({
      ok: false,
      error: 'state_expired',
    });
  });

  it('refuses a forged or edited state', async () => {
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const [body, signature] = state.split('.');

    for (const forged of [
      'not-a-state',
      body!, // no signature at all
      `${body}.${'A'.repeat(43)}`, // a signature of the right shape, wrong bytes
      `${body}x.${signature}`, // the payload edited under a good signature
    ]) {
      expect(
        (await verifyOAuthState(bare(), forged, REDIRECT_URI, NOW + 1000)).ok,
        `"${forged.slice(0, 24)}…" must not verify`,
      ).toBe(false);
    }
  });

  it('signs two starts differently, so one state is never two sign-ins', async () => {
    const a = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const b = await signOAuthState(bare(), REDIRECT_URI, NOW);
    expect(a).not.toBe(b);
  });
});

describe('finishing a sign-in', () => {
  it('never reaches Google when the state does not check out', async () => {
    await storeOAuthApp();
    const calls: TokenCall[] = [];
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state: 'forged',
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint(calls),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBe('state_invalid');
    // THE POINT: no exchange was attempted, so a forged callback cannot be used
    // to make this OS spend a code on somebody else's behalf.
    expect(calls).toEqual([]);
    expect(await credentialSummary(bare(), 'google')).toMatchObject({ source: 'none' });
  });

  it('never reaches Google when the state has expired', async () => {
    await storeOAuthApp();
    const calls: TokenCall[] = [];
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW + 11 * 60_000,
      fetchImpl: tokenEndpoint(calls),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBe('state_expired');
    expect(calls).toEqual([]);
  });

  it('exchanges the code once, stores the refresh token, and echoes nothing', async () => {
    await storeOAuthApp();
    const calls: TokenCall[] = [];
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);

    const { result: outcome, lines } = await withCapturedLogs(() =>
      completeGoogleOAuth(bare(), {
        code: CODE,
        state,
        redirectUri: REDIRECT_URI,
        nowMs: NOW,
        fetchImpl: tokenEndpoint(calls),
      }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.account).toBe('ops@example.test');
    expect(outcome.scopes).toContain('https://www.googleapis.com/auth/analytics.readonly');

    // ONE exchange, with the redirect URI Google will check against.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TOKEN_URL);
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe(CODE);
    expect(sent.get('redirect_uri')).toBe(REDIRECT_URI);

    // The token is IN the store…
    const resolved = await resolveCredential(bare(), 'google');
    expect(resolved.source).toBe('store');
    expect(resolved.fields.GOOGLE_OAUTH_REFRESH_TOKEN).toBe(REFRESH_TOKEN);

    // …and nowhere else. The summary carries names and the account address;
    // the ciphertext carries the token; the row's public half carries neither.
    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.auth).toBe('oauth');
    expect(summary?.fields).toEqual(['GOOGLE_OAUTH_REFRESH_TOKEN']);
    expect(summary?.metadata?.account).toBe('ops@example.test');
    expect(JSON.stringify(summary)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(outcome)).not.toContain(REFRESH_TOKEN);

    // Nothing in the clear beside the secret carries it either.
    const row = await storedCredential('google');
    expect(JSON.stringify({ ...row, ciphertext: null, iv: null })).not.toContain(REFRESH_TOKEN);

    // And NOTHING was logged that carries the token, the code or the secret.
    const log = lines.join('\n');
    for (const secret of [REFRESH_TOKEN, CODE, CLIENT_SECRET]) {
      expect(log).not.toContain(secret);
    }
  });

  it('keeps a service-account map that was already stored', async () => {
    // An install that pastes a map for its PROPERTIES and signs in for its
    // AUTH holds both. `putCredential` replaces rather than merges by design,
    // so the callback carries the map forward itself.
    await storeOAuthApp();
    await putCredential(bare(), {
      provider: 'google',
      fields: { GOOGLE_SIGNAL_ACCOUNTS: '{"portfolio":{"properties":{}}}' },
    });
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });
    expect(outcome.ok).toBe(true);

    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.fields.sort()).toEqual([
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_SIGNAL_ACCOUNTS',
    ]);
  });

  it('keeps the grant when a later save does not mention it', async () => {
    // The other direction: pasting a service-account map on a card that is
    // signed in must not silently throw away a live grant, leaving a token
    // valid at Google that this OS can no longer revoke. A `managed` field
    // survives a write that does not name it.
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });

    await putCredential(bare(), {
      provider: 'google',
      fields: { GOOGLE_SIGNAL_ACCOUNTS: '{"portfolio":{"properties":{}}}' },
    });
    const resolved = await resolveCredential(bare(), 'google');
    expect(resolved.fields.GOOGLE_OAUTH_REFRESH_TOKEN).toBe(REFRESH_TOKEN);
    expect(resolved.fields.GOOGLE_SIGNAL_ACCOUNTS).toBeTruthy();
  });

  it('refuses a grant with no refresh token rather than storing an hour of access', async () => {
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([], { refresh_token: undefined }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBe('no_refresh_token');
    expect(await credentialSummary(bare(), 'google')).toMatchObject({ source: 'none' });
  });

  it('refuses a grant that unticked a scope, and names which one', async () => {
    // Google's consent screen lets an operator untick a box. A credential that
    // can read Analytics but not Search Console would look connected and then
    // fail one lane a day later with a 403 nobody could trace to a checkbox.
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([], {
        scope: 'openid email https://www.googleapis.com/auth/analytics.readonly',
      }),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error).toBe('scope_incomplete');
    expect(outcome.withheld).toEqual(['Search Console']);
    expect(await credentialSummary(bare(), 'google')).toMatchObject({ source: 'none' });
  });

  it("answers Google's refusal as a code and its status, never a sentence or the code it was sent", async () => {
    // The page words each code and puts its one press beside it
    // (`googleOAuthNotice`); nothing the ingest wrote could reach the screen,
    // so it writes nothing.
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([], { error: 'redirect_uri_mismatch' }, 400),
    });
    expect(outcome).toEqual({ ok: false, error: 'exchange_failed', status: 400 });
    expect(JSON.stringify(outcome)).not.toContain(CODE);
  });

  it('tells Google not answering apart from Google refusing', async () => {
    // Two instructions: a refusal's press is the OAuth client's console page;
    // no answer is simply try again.
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for ${REDIRECT_URI}?code=${CODE}`);
      },
    });
    expect(outcome).toEqual({ ok: false, error: 'unreachable' });
  });

  it('reads the account address out of the id token without trusting it for access', () => {
    expect(idTokenEmail(idToken('ops@example.test'))).toBe('ops@example.test');
    expect(idTokenEmail('not-a-token')).toBeNull();
    expect(idTokenEmail(null)).toBeNull();
  });
});

describe('using the grant', () => {
  async function connect(): Promise<void> {
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });
    expect(outcome.ok).toBe(true);
  }

  it('resolves both halves into one credential a collector can use', async () => {
    await connect();
    const resolved = await resolveGoogleCredential(bare());
    expect(resolved.oauth).not.toBeNull();
    expect(resolved.oauth!.clientId).toBe(CLIENT_ID);
    expect(resolved.oauth!.account).toBe('ops@example.test');
    // No map was pasted, so there is nothing to point the credential at yet.
    expect(resolved.accounts).toBeUndefined();
  });

  it('has no grant at all when the OAuth app is gone, however good the token is', async () => {
    await connect();
    await forgetCredentials(['google-oauth-app']);
    const resolved = await resolveGoogleCredential(bare());
    expect(resolved.oauth).toBeNull();
  });

  it('refreshes an access token from the stored refresh token', async () => {
    const calls: TokenCall[] = [];
    const token = await refreshGoogleAccessToken(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        refreshToken: REFRESH_TOKEN,
        account: 'ops@example.test',
        scopes: [],
      },
      tokenEndpoint(calls),
    );
    expect(token).toBe('ya29.access-token');
    const sent = new URLSearchParams(calls[0]!.body);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe(REFRESH_TOKEN);
  });

  it('tells a REVOKED grant apart from an ordinary refusal', async () => {
    // The two need different instructions — "reconnect the card" versus "check
    // the property grant" — and burying both under a 400 is how a dead
    // credential looks like a flaky API.
    const revoked = (async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch;
    await expect(
      refreshGoogleAccessToken(
        {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
          account: null,
          scopes: [],
        },
        revoked,
      ),
    ).rejects.toMatchObject({ code: 'google_oauth_revoked' });
  });

  it('answers the connection test with what actually happened, not "could not be reached"', async () => {
    // `probeCredential` catches everything and rewrites it, because a transport
    // error may be holding a url that has a token in it — but a revoked grant
    // must not be reported as a network problem. The one exception is a
    // `SignalError` this repo raised carrying a constant sentence, so nothing
    // derived from the request is copied anywhere.
    await connect();
    const probe = await probeCredential(bare(), 'google', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input) === TOKEN_URL
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json({}, { status: 500 })) as typeof fetch,
    });
    expect(probe.ok).toBe(false);
    // A refused sign-in whose one press is signing in again — never "no answer".
    expect(probe.result).toEqual({ outcome: 'refused', failing: ['Google sign-in'], fix: { kind: 'sign-in' } });
    expect(probe.message).not.toContain('No answer');

    // And it lands in the column the card reads, so the state survives the
    // page reload that follows.
    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.lastError).toBe(probe.message);
    // Never the refresh token, in any of it.
    expect(JSON.stringify({ probe, summary })).not.toContain(REFRESH_TOKEN);
  });

  it('stamps the credential with the sentence, not the enum, when the nightly pull meets it', async () => {
    // The card renders `credentials.last_error` verbatim, so a stamp reading
    // "Every Google property failed (google_oauth_revoked)." is an enum shown to
    // a person. A revoked grant is a statement about the CREDENTIAL — nothing
    // about any property is wrong — and it reaches every property at once, so
    // one stamp can honestly speak for the whole run.
    await connect();
    await putCredential(bare(), {
      provider: 'google',
      fields: {
        GOOGLE_SIGNAL_ACCOUNTS: JSON.stringify({
          // No `service_account_b64`, so this entry authenticates with the sign-in.
          portfolio: { properties: { 'meals.example': { ga4_property_id: '123456' } } },
        }),
      },
    });

    const result = await runGoogleSignals(bare(), {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) =>
        String(input) === TOKEN_URL
          ? Response.json({ error: 'invalid_grant' }, { status: 400 })
          : Response.json({}, { status: 500 })) as typeof fetch,
    });
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBeGreaterThan(0);

    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.lastError).toBe(GOOGLE_OAUTH_REVOKED_MESSAGE);
    // The per-property outcomes still carry the CODE — machine-readable
    // evidence stays machine-readable; only the operator-facing column changed.
    expect(result.outcomes.every((outcome) => outcome.errorCode === 'google_oauth_revoked')).toBe(
      true,
    );
  });

  it('probes with the sign-in, and names the ACCOUNT in a refusal', async () => {
    await connect();
    const calls: string[] = [];
    const google = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'ya29.access-token', expires_in: 3599 });
      }
      if (url.includes('/webmasters/v3/sites')) {
        return Response.json({ siteEntry: [{ siteUrl: 'sc-domain:meals.example' }] });
      }
      return Response.json({}, { status: 200 });
    }) as typeof fetch;

    const probe = await probeCredential(bare(), 'google', { fetchImpl: google, nowMs: NOW });
    expect(probe.ok).toBe(true);
    expect(probe.result).toMatchObject({ outcome: 'answered', facts: { sites: 1, account: 'ops@example.test' } });
    // Nothing that ran carries the token into the verdict.
    expect(probe.message).not.toContain(REFRESH_TOKEN);
  });

  it('probes the SERVICE ACCOUNT path unchanged, with its own instruction', async () => {
    // The other way in still works, and its refusal still sends the operator to
    // add a robot rather than to check which account they signed in with.
    const calls: string[] = [];
    const google = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'ya29.sa-token', expires_in: 3599 });
      }
      if (url.includes('/webmasters/v3/sites')) {
        return Response.json({ error: { message: 'no' } }, { status: 403 });
      }
      return Response.json({}, { status: 200 });
    }) as typeof fetch;

    // `env` (not `bare()`) carries the suite's generated service-account map.
    const probe = await probeCredential(env, 'google', { fetchImpl: google, nowMs: NOW });
    expect(probe.ok).toBe(false);
    // The robot is given the role on Google's own page: the press, not a sentence.
    expect(probe.result).toMatchObject({
      outcome: 'refused', status: 403, failing: ['Search Console'],
      fix: { kind: 'grant', product: 'Search Console', role: 'Full user', to: 'signals-test@example.test' },
    });
  });

  it('lists what the account can see, for the picker and for the operator', async () => {
    await connect();
    const google = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'ya29.access-token', expires_in: 3599 });
      }
      if (url.includes('analyticsadmin.googleapis.com')) {
        return Response.json({
          accountSummaries: [
            {
              displayName: 'Reindex Ventures',
              propertySummaries: [
                { property: 'properties/412330001', displayName: 'Meal Planner' },
                { property: 'properties/412330002', displayName: 'Nosh' },
              ],
            },
          ],
        });
      }
      if (url.includes('/webmasters/v3/sites')) {
        return Response.json({
          siteEntry: [{ siteUrl: 'sc-domain:meals.example', permissionLevel: 'siteOwner' }],
        });
      }
      return Response.json({}, { status: 200 });
    }) as typeof fetch;

    const found = await discoverGoogleProperties(bare(), { fetchImpl: google, nowMs: NOW });
    expect(found.ok).toBe(true);
    expect(found.auth).toBe('oauth');
    expect(found.account).toBe('ops@example.test');
    // The GA4 ref is the BARE id — what a collector stores as `propertyRef` —
    // not the `properties/123` resource name the Admin API answers with.
    expect(found.properties).toEqual([
      { lane: 'ga4', ref: '412330001', label: 'Meal Planner', detail: 'Reindex Ventures' },
      { lane: 'ga4', ref: '412330002', label: 'Nosh', detail: 'Reindex Ventures' },
      {
        lane: 'gsc',
        ref: 'sc-domain:meals.example',
        label: 'sc-domain:meals.example',
        detail: 'siteOwner',
      },
    ]);
  });

  it('reports each half of a discovery independently', async () => {
    await connect();
    const partial = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'ya29.access-token', expires_in: 3599 });
      }
      if (url.includes('analyticsadmin.googleapis.com')) {
        return Response.json({ error: { message: 'disabled' } }, { status: 403 });
      }
      return Response.json({ siteEntry: [{ siteUrl: 'sc-domain:nosh.example' }] });
    }) as typeof fetch;

    const found = await discoverGoogleProperties(bare(), { fetchImpl: partial, nowMs: NOW });
    expect(found.ok).toBe(false);
    expect(found.message).toContain('Analytics');
    // One API being down must not hide what the other answered.
    expect(found.properties.map((entry) => entry.ref)).toEqual(['sc-domain:nosh.example']);
  });

  it('says there is nothing to list before anything is connected', async () => {
    const found = await discoverGoogleProperties(bare(), { nowMs: NOW });
    expect(found.ok).toBe(false);
    expect(found.auth).toBeNull();
    expect(found.properties).toEqual([]);
  });
});

describe('disconnecting', () => {
  it('revokes at Google BEFORE it deletes, and deletes either way', async () => {
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });

    const revoked: { url: string; body: string; stillStored: boolean }[] = [];
    const google = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const row = await storedCredential('google');
      revoked.push({
        url: String(input),
        body: String(init?.body ?? ''),
        stillStored: row !== null,
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const result = await disconnectCredential(bare(), 'google', { fetchImpl: google });
    expect(result.ok).toBe(true);

    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.url).toBe(REVOKE_URL);
    expect(new URLSearchParams(revoked[0]!.body).get('token')).toBe(REFRESH_TOKEN);
    // ORDER IS THE POINT: a network failure must leave the token still stored
    // and still revocable, never a live grant this OS can no longer name.
    expect(revoked[0]!.stillStored).toBe(true);

    expect(await credentialSummary(bare(), 'google')).toMatchObject({ source: 'none' });
  });

  it('still forgets the credential when Google cannot be reached', async () => {
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    await completeGoogleOAuth(bare(), {
      code: CODE,
      state,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });

    const offline = (() => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await revokeGoogleGrant(bare(), offline)).toBe(false);

    const result = await disconnectCredential(bare(), 'google', { fetchImpl: offline });
    expect(result.ok).toBe(true);
    expect(await credentialSummary(bare(), 'google')).toMatchObject({ source: 'none' });
  });

  it('revokes nothing for a provider with no grant', async () => {
    let called = false;
    const google = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await disconnectCredential(bare(), 'bing-webmaster', { fetchImpl: google });
    expect(called).toBe(false);
  });
});

describe('when a sign-in is due to stop working', () => {
  it('dates the grant seven days out, because the console setup this OS prescribes is Testing mode', () => {
    // Google publishes no API that reports whether a consent screen is still in
    // Testing, and the console steps doc 11 prescribes (External + a test user)
    // produce one — which expires every refresh token after seven days. So the
    // default is that setup, stamped `flow` and stated in words on the card,
    // with a one-press correction beside it.
    return (async () => {
      await storeOAuthApp();
      const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
      expect(
        (
          await completeGoogleOAuth(bare(), {
            code: CODE,
            state,
            redirectUri: REDIRECT_URI,
            nowMs: NOW,
            fetchImpl: tokenEndpoint([]),
          })
        ).ok,
      ).toBe(true);

      const summary = await credentialSummary(bare(), 'google');
      expect(summary?.metadata?.expirySource).toBe('flow');
      expect(summary?.metadata?.expiresAt).toBe(
        new Date(NOW + GOOGLE_TESTING_GRANT_DAYS * 86_400_000).toISOString(),
      );
      // And the countdown is anchored on THIS sign-in, not on the row's age.
      expect(summary?.metadata?.connectedAt).toBe(new Date(NOW).toISOString());
    })();
  });

  it('never overwrites the operator\'s own answer with the flow\'s assumption', async () => {
    // An operator who has published their app answers once. If a reconnection
    // put the seven-day countdown back, the correction would have to be re-made
    // after every sign-in — which is how an honest warning becomes one people
    // learn to dismiss.
    await storeOAuthApp();
    const first = await signOAuthState(bare(), REDIRECT_URI, NOW);
    await completeGoogleOAuth(bare(), {
      code: CODE,
      state: first,
      redirectUri: REDIRECT_URI,
      nowMs: NOW,
      fetchImpl: tokenEndpoint([]),
    });

    // "Published — this does not expire." A null date IS the answer.
    expect((await setCredentialExpiry(bare(), { provider: 'google', expiresAt: null })).ok).toBe(
      true,
    );

    const later = NOW + 3 * 86_400_000;
    const second = await signOAuthState(bare(), REDIRECT_URI, later);
    await completeGoogleOAuth(bare(), {
      code: CODE,
      state: second,
      redirectUri: REDIRECT_URI,
      nowMs: later,
      fetchImpl: tokenEndpoint([]),
    });

    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.metadata?.expiresAt).toBeNull();
    expect(summary?.metadata?.expirySource).toBe('operator');
    // The rest of the grant still moved — this is a carry-forward of ONE fact,
    // not a frozen metadata blob.
    expect(summary?.metadata?.connectedAt).toBe(new Date(later).toISOString());
  });
});

// The connect panel: the sign-in is its own proof, the account's GA4 properties
// and Search Console sites are listed with the host each answers for (two lanes
// on one row), and Start's collection is the quarter-hourly Google step narrowed
// to the named sites.
describe('Google in the connect panel', () => {
  afterEach(async () => {
    await emptyTables(['config_documents']);
    forgetConfigCache();
  });
  async function connect(): Promise<void> {
    await storeOAuthApp();
    const state = await signOAuthState(bare(), REDIRECT_URI, NOW);
    const outcome = await completeGoogleOAuth(bare(), { code: CODE, state, redirectUri: REDIRECT_URI, nowMs: NOW, fetchImpl: tokenEndpoint([]) });
    expect(outcome.ok).toBe(true);
  }
  const account = (calls: string[] = []) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === TOKEN_URL) return Response.json({ access_token: 'ya29.access-token', expires_in: 3599 });
    if (url.endsWith('/v1beta/accountSummaries?pageSize=200')) {
      return Response.json({ accountSummaries: [{ displayName: 'Example Co', propertySummaries: [
        { property: 'properties/412330001', displayName: 'Plate — web' },
        { property: 'properties/412330002', displayName: 'menu.example.org' },
      ] }] });
    }
    if (url.endsWith('/properties/412330001/dataStreams')) {
      return Response.json({ dataStreams: [{ type: 'WEB_DATA_STREAM', webStreamData: { defaultUri: 'https://www.plate.example.com' } }] });
    }
    if (url.includes('/dataStreams')) return Response.json({ dataStreams: [] });
    if (url.endsWith('/webmasters/v3/sites')) {
      return Response.json({ siteEntry: [
        { siteUrl: 'sc-domain:plate.example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://unverified.example/', permissionLevel: 'siteUnverifiedUser' },
      ] });
    }
    if (url.includes(':runReport') && init?.method === 'POST') {
      return Response.json({ dimensionHeaders: [{ name: 'date' }],
        metricHeaders: ['sessions', 'activeUsers', 'screenPageViews', 'eventCount'].map((name) => ({ name })),
        rows: [], metadata: { timeZone: 'UTC' } });
    }
    return Response.json({}, { status: 200 });
  }) as typeof fetch;

  it('stamps the sign-in as proof, so the panel reads Signed in', async () => {
    await storeOAuthApp();
    const start = await beginGoogleOAuth(bare(), { origin: ORIGIN, nowMs: NOW });
    if (!start.ok) throw new Error(start.error);
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    const done = await completeGoogleOAuth(bare(), { code: CODE, state, redirectUri: REDIRECT_URI, nowMs: NOW, fetchImpl: tokenEndpoint([]) });
    expect(done.ok).toBe(true);
    const summary = await credentialSummary(bare(), 'google');
    expect(summary?.lastOkAt).toBe(new Date(NOW).toISOString());
  });

  it('lists GA4 by its web stream address and Search Console by its own, stamping nothing', async () => {
    await connect();
    const before = await credentialSummary(bare(), 'google');
    const found = await discoverSites(bare(), 'google', { fetchImpl: account(), nowMs: NOW });
    expect(found).toMatchObject({ ok: true, kind: 'account' });
    if (!found.ok) return;
    expect(found.sites).toEqual([
      { lane: 'ga4', ref: '412330001', label: 'Plate — web', host: 'plate.example.com', mapping: { propertyId: '412330001' }, ready: true },
      // No web stream: a property named for its domain answers for it.
      { lane: 'ga4', ref: '412330002', label: 'menu.example.org', host: 'menu.example.org', mapping: { propertyId: '412330002' }, ready: true },
      { lane: 'gsc', ref: 'sc-domain:plate.example.com', label: 'sc-domain:plate.example.com', host: 'plate.example.com', mapping: { siteUrl: 'sc-domain:plate.example.com' }, ready: true },
      // Listed, never ticked: Google will not serve an unverified site.
      { lane: 'gsc', ref: 'https://unverified.example/', label: 'https://unverified.example/', host: 'unverified.example', mapping: { siteUrl: 'https://unverified.example/' }, ready: false },
    ]);
    expect(await credentialSummary(bare(), 'google')).toEqual(before);
    expect(JSON.stringify(found)).not.toContain(REFRESH_TOKEN);
  });

  it('says a refused grant is refused, and an install with no Google is not connected', async () => {
    expect(await discoverSites(bare(), 'google', { fetchImpl: account(), nowMs: NOW })).toMatchObject({ ok: false, reason: 'not-connected' });
    await connect();
    const refusing = (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch;
    expect(await discoverSites(bare(), 'google', { fetchImpl: refusing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'refused' });
  });

  it("collects only the named site's mapped properties through the quarter-hourly step", async () => {
    await connect();
    const calls: string[] = [];
    const register = { assets: {
      'meals.example': { ga4: { status: 'needs-setup', propertyId: '412330001' } },
      'nosh.example': { ga4: { status: 'needs-setup', propertyId: '412330009' } },
    } };
    await emptyTables(['config_documents']);
    forgetConfigCache();
    const seeded = await seedConfigDocuments(env, { documents: { 'config/integrations.json': register }, actor: 'config:seed' }, NOW);
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const run = await runCollectNow(bare(), { provider: 'google', assets: ['meals.example'] }, { fetchImpl: account(calls), nowMs: NOW });
    expect(run, JSON.stringify(run)).toMatchObject({ ok: true, job: 'counters' });
    // The named site's property only — never the other site's.
    expect(calls.some((url) => url.includes('412330001:runReport'))).toBe(true);
    expect(calls.some((url) => url.includes('412330009'))).toBe(false);
  });
});
