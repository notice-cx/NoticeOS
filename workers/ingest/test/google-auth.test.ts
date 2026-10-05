import { describe, expect, it } from 'vitest';
import { GOOGLE_SCOPES, googleAuthCacheKey, type GoogleAuth, type GoogleOAuthGrant } from '../src/google-auth.js';

function grant(): GoogleOAuthGrant {
  return {
    clientId: 'fixture.apps.googleusercontent.com',
    clientSecret: crypto.randomUUID(),
    refreshToken: crypto.randomUUID(),
    account: 'reader@example.test',
    scopes: [GOOGLE_SCOPES.ga4, GOOGLE_SCOPES.gsc],
  };
}

describe('Google token-cache identity', () => {
  it('separates different equal-length grants for the same client and account', () => {
    const first = grant();
    const second = { ...first, refreshToken: crypto.randomUUID() };
    expect(second.refreshToken.length).toBe(first.refreshToken.length);
    expect(googleAuthCacheKey({ kind: 'oauth', grant: second }, GOOGLE_SCOPES.ga4))
      .not.toBe(googleAuthCacheKey({ kind: 'oauth', grant: first }, GOOGLE_SCOPES.ga4));
  });

  it('reuses equivalent grants while separating scopes, callers and client-secret rotations', () => {
    const first = grant();
    const key = googleAuthCacheKey({ kind: 'oauth', grant: first }, GOOGLE_SCOPES.ga4);
    expect(googleAuthCacheKey({ kind: 'oauth', grant: { ...first, scopes: [...first.scopes].reverse() } }, GOOGLE_SCOPES.ga4)).toBe(key);
    for (const changed of [
      { ...first, clientSecret: crypto.randomUUID() },
      { ...first, clientId: 'other.apps.googleusercontent.com' },
      { ...first, account: 'other@example.test' },
      { ...first, scopes: [GOOGLE_SCOPES.ga4] },
    ]) {
      expect(googleAuthCacheKey({ kind: 'oauth', grant: changed }, GOOGLE_SCOPES.ga4)).not.toBe(key);
    }
    expect(googleAuthCacheKey({ kind: 'oauth', grant: first }, GOOGLE_SCOPES.gsc)).not.toBe(key);
  });

  it('separates service-account key rotations even when a key ID is absent or reused', () => {
    for (const privateKeyId of [null, 'fixture-key']) {
      const account = { clientEmail: 'service@example.test', privateKeyId, privateKey: crypto.randomUUID() };
      const first: GoogleAuth = { kind: 'service-account', account };
      const rotated: GoogleAuth = { kind: 'service-account', account: { ...account, privateKey: crypto.randomUUID() } };
      const key = googleAuthCacheKey(first, GOOGLE_SCOPES.ga4);
      expect(googleAuthCacheKey({ kind: 'service-account', account: { ...account } }, GOOGLE_SCOPES.ga4)).toBe(key);
      expect(googleAuthCacheKey(rotated, GOOGLE_SCOPES.ga4)).not.toBe(key);
      expect(googleAuthCacheKey(first, GOOGLE_SCOPES.gsc)).not.toBe(key);
    }
  });

  it('returns opaque keys with no credential material or caller address', () => {
    const oauth = grant();
    const account = { clientEmail: 'service@example.test', privateKeyId: 'fixture-key', privateKey: crypto.randomUUID() };
    for (const auth of [{ kind: 'oauth', grant: oauth }, { kind: 'service-account', account }] as const) {
      const key = googleAuthCacheKey(auth, GOOGLE_SCOPES.ga4);
      expect(key).toMatch(/^google-token:[a-f0-9]{64}$/u);
      for (const value of [oauth.refreshToken, oauth.clientSecret, oauth.account!, account.privateKey, account.clientEmail]) {
        expect(key).not.toContain(value);
      }
    }
  });
});
