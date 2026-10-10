// A token per site, saved on its row.
//
// Clarity issues one export token per project and offers no free call to prove
// it, so the connect panel saves each site's token the moment it is pasted,
// merged into the one encrypted per-site map here, and the proof is the
// export — run for the named sites only, by an explicit Run now. Against a
// real store and WebCrypto; Clarity is stubbed at the network boundary.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCredential } from '../src/credentials.js';
import { runCollectNow } from '../src/dispatch.js';
import { putSiteToken } from '../src/site-tokens.js';
import { ARCHIVE_RUNS, forgetCredentials, pgCount, reset, storedCredential } from './helpers.js';

const FIRST = 'SEKRIT-clarity-first-9d2c-do-not-echo';
const SECOND = 'SEKRIT-clarity-second-1a7e-do-not-echo';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

const tokens = async () => JSON.parse((await resolveCredential(env, 'clarity')).fields.CLARITY_TOKENS ?? '{}') as Record<string, string>;

/** Clarity's export, as far as one call goes: a known token answers a block
 * of pages; any other is refused. */
function clarity(known = [FIRST, SECOND]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    calls.push(authorization.replace(/^Bearer /, ''));
    if (!known.some((token) => authorization === `Bearer ${token}`)) return Response.json({ message: 'Unauthorized' }, { status: 401 });
    return Response.json([{ metricName: 'Traffic', information: [{ sessionsCount: '12', Url: 'https://meadow.example/' }] }]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('one site’s token, saved on its row', () => {
  beforeEach(async () => {
    await reset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await forgetCredentials();
  });

  it('merges each paste into the per-site map, never replacing another site’s token', async () => {
    const first = await putSiteToken(env, { provider: 'clarity', asset: 'meadow.example', token: `  ${FIRST}  ` });
    expect(first.ok).toBe(true);
    expect(await tokens()).toEqual({ 'meadow.example': FIRST });

    await putSiteToken(env, { provider: 'clarity', asset: 'northwind.example', token: SECOND });
    expect(await tokens()).toEqual({ 'meadow.example': FIRST, 'northwind.example': SECOND });
    // A new paste for a site replaces its own token only.
    await putSiteToken(env, { provider: 'clarity', asset: 'meadow.example', token: SECOND });
    expect(await tokens()).toEqual({ 'meadow.example': SECOND, 'northwind.example': SECOND });
    // What comes back is the summary: names, never a value.
    expect(JSON.stringify(first)).not.toContain(FIRST);
  });

  it('refuses a blank token, a site that is not the installation’s own, and a provider with one key', async () => {
    expect(await putSiteToken(env, { provider: 'clarity', asset: 'meadow.example', token: '   ' })).toMatchObject({ ok: false, error: 'validation', issues: [{ path: 'token' }] });
    expect(await putSiteToken(env, { provider: 'clarity', asset: 'nobody.example', token: FIRST })).toMatchObject({ ok: false, error: 'validation', issues: [{ path: 'asset' }] });
    expect(await putSiteToken(env, { provider: 'bing-webmaster', asset: 'meadow.example', token: FIRST })).toEqual({ ok: false, error: 'not_supported', provider: 'bing-webmaster' });
    expect(await putSiteToken(env, { provider: 'nope', asset: 'meadow.example', token: FIRST })).toMatchObject({ ok: false, error: 'unknown_provider' });
    expect(await storedCredential('clarity')).toBeNull();
  });

  it('runs the export now for the named site only, spending one call there and none elsewhere', async () => {
    await putSiteToken(env, { provider: 'clarity', asset: 'meadow.example', token: FIRST });
    await putSiteToken(env, { provider: 'clarity', asset: 'northwind.example', token: SECOND });
    const { fetchImpl, calls } = clarity();
    const result = await runCollectNow(env, { provider: 'clarity', assets: ['meadow.example'] }, { fetchImpl, nowMs: NOW });
    expect(result).toMatchObject({ ok: true, provider: 'clarity', job: 'clarity', sites: [{ asset: 'meadow.example', outcome: 'collected', code: null }] });
    expect(calls).toEqual([FIRST]);
    expect(await pgCount(`SELECT count(*) AS n FROM ${ARCHIVE_RUNS} WHERE integration = 'clarity' AND asset = 'northwind.example'`)).toBe(0);
  });

  it('says a refused token failed, with Clarity’s own code', async () => {
    await putSiteToken(env, { provider: 'clarity', asset: 'meadow.example', token: FIRST });
    const result = await runCollectNow(env, { provider: 'clarity', assets: ['meadow.example'] }, { fetchImpl: clarity([]).fetchImpl, nowMs: NOW });
    expect(result.ok && result.sites[0]).toMatchObject({ asset: 'meadow.example', outcome: 'failed' });
    expect(result.ok && result.sites[0]!.code).not.toBeNull();
  });
});
