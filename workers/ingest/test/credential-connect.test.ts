// The connect panel's save-and-test (bead `ro-ujb9.96.7.1`).
//
// One rule carries the design: the provider is asked FIRST and the credential
// is stored only when it says yes. Against real Postgres and real WebCrypto; the
// providers are stubbed at the network boundary (the `fetchImpl` the call
// goes out through), so Bing's and DataForSEO's own endpoints, request shapes
// and answers are what is exercised.

import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { credentialSummary, putCredential, resolveCredential } from '../src/credentials.js';
import { credentialVerdict, forgetCredentials, reset, storedHealthStates } from './helpers.js';

const BING_SECRET = 'SEKRIT-bing-connect-7c1e-do-not-echo';
const DFS_PASSWORD = 'SEKRIT-dataforseo-connect-2d9a-do-not-echo';
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const AT = new Date(NOW).toISOString();

/** Bing Webmaster Tools, as far as `GetUserSites` goes: a key it knows lists two
 * verified sites and one it has not verified; any other key is an HTTP 400
 * carrying Bing's own error. */
function bing(calls: string[] = [], known = BING_SECRET): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.origin !== 'https://ssl.bing.com') throw new TypeError('network: unexpected host');
    if (url.searchParams.get('apikey') !== known) {
      return Response.json({ ErrorCode: 3, Message: 'ERROR!!! InvalidApiKey' }, { status: 400 });
    }
    return Response.json({ d: [
      { Url: 'https://meals.example/', IsVerified: true },
      { Url: 'https://nosh.example/', IsVerified: true },
      { Url: 'https://unverified.example/', IsVerified: false },
    ] });
  }) as typeof fetch;
}

/** DataForSEO's free account endpoint: the right Basic credentials read an
 * account with credit; anything else is a 401. */
function dataforseo(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const expected = `Basic ${btoa(`op@example.test:${DFS_PASSWORD}`)}`;
    if (new Headers(init?.headers).get('authorization') !== expected) return new Response('', { status: 401 });
    return Response.json({ status_code: 20000, tasks: [{ result: [{ money: { balance: 18.72 } }] }] });
  }) as typeof fetch;
}

const unreachable = (async () => { throw new TypeError('network down'); }) as typeof fetch;

async function stored(provider: string) {
  const verdict = await credentialVerdict(provider);
  return verdict === null ? null : { provider, last_ok_at: verdict.lastOkAt, last_error: verdict.lastError };
}

beforeEach(async () => { await reset(); });
afterEach(async () => { await forgetCredentials(); });

it('does not expose the retired credential migration door', async () => {
  const response = await SELF.fetch('https://ingest.local/api/credentials/from-backup', { method: 'POST' });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'not_found' });
});

describe('save and test: the provider answers before anything is stored', () => {
  it('stores an accepted Bing key with its verdict already stamped, and says how many sites it reads', async () => {
    const calls: string[] = [];
    const result = await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } },
      { fetchImpl: bing(calls), nowMs: NOW });

    expect(result).toEqual({ ok: true, verdict: 'accepted', checkedAt: AT, facts: { sites: 2 } });
    // Bing's cheapest authenticated read, and only that one.
    expect(calls).toEqual(['/webmaster/api.svc/json/GetUserSites']);
    // Stored AND proven: the card's "this credential worked" is the answer
    // that just arrived, never "Not tested yet" beside a green chip.
    expect(await stored('bing-webmaster')).toEqual({ provider: 'bing-webmaster', last_ok_at: AT, last_error: null });
    expect((await resolveCredential(env, 'bing-webmaster')).fields.BING_WEBMASTER_API_KEY).toBe(BING_SECRET);
    // The health row the Test button feeds records the same proof.
    expect((await storedHealthStates()).filter((row) =>
      row.provider === 'bing-webmaster' && row.capability === 'bing-discovery' && row.outcome === 'success')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(BING_SECRET);
  });

  it('stores nothing when Bing refuses the key, and says refused rather than unreachable', async () => {
    const result = await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'SEKRIT-wrong-key' } },
      { fetchImpl: bing(), nowMs: NOW });

    expect(result).toEqual({ ok: true, verdict: 'refused', checkedAt: AT });
    expect(await stored('bing-webmaster')).toBeNull();
    expect(await storedHealthStates()).toEqual([]);
    // Bing's own error text never travels: the verdict is the whole answer.
    expect(JSON.stringify(result)).not.toContain('InvalidApiKey');
  });

  it('keeps a working key when its replacement is refused', async () => {
    await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } },
      { fetchImpl: bing(), nowMs: NOW });
    const refused = await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'SEKRIT-typo' } },
      { fetchImpl: bing(), nowMs: NOW + 60_000 });

    expect(refused).toMatchObject({ ok: true, verdict: 'refused' });
    expect((await resolveCredential(env, 'bing-webmaster')).fields.BING_WEBMASTER_API_KEY).toBe(BING_SECRET);
    expect(await stored('bing-webmaster')).toEqual({ provider: 'bing-webmaster', last_ok_at: AT, last_error: null });
  });

  it('calls a provider that does not answer unreachable, and stores nothing', async () => {
    const result = await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } },
      { fetchImpl: unreachable, nowMs: NOW });
    expect(result).toEqual({ ok: true, verdict: 'unreachable', checkedAt: AT });
    expect(await stored('bing-webmaster')).toBeNull();

    const throttled = await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } },
      { fetchImpl: (async () => Response.json({ Message: 'Too many requests' }, { status: 429 })) as typeof fetch, nowMs: NOW });
    expect(throttled).toMatchObject({ verdict: 'unreachable' });
  });

  it('stores accepted DataForSEO details with the credit the account reported', async () => {
    const calls: string[] = [];
    const result = await connectCredential(env, {
      provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    }, { fetchImpl: dataforseo(calls), nowMs: NOW });

    expect(result).toEqual({ ok: true, verdict: 'accepted', checkedAt: AT, facts: { creditUsd: '18.72' } });
    expect(calls).toEqual(['https://api.dataforseo.com/v3/appendix/user_data']);
    const summary = (await credentialSummary(env, 'dataforseo'))!;
    expect(summary.lastOkAt).toBe(AT);
    // Kept dated beside the credential, as the Test button keeps it.
    expect(summary.metadata?.balance).toEqual({ usd: '18.72', seenAt: AT });
    expect(JSON.stringify(result)).not.toContain(DFS_PASSWORD);
  });

  it('stores nothing when DataForSEO rejects the login and password', async () => {
    const result = await connectCredential(env, {
      provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: 'SEKRIT-wrong' },
    }, { fetchImpl: dataforseo(), nowMs: NOW });
    expect(result).toEqual({ ok: true, verdict: 'refused', checkedAt: AT });
    expect(await stored('dataforseo')).toBeNull();
  });
});

describe('Discord and calendar feeds in the panel (bead ro-ujb9.96.7.14)', () => {
  const WEBHOOK = 'https://discord.com/api/webhooks/1/SEKRIT-discord-connect-do-not-echo';
  const FEED = 'https://calendar.example/SEKRIT-feed-do-not-echo/basic.ics';

  /** Discord's webhook: the known one takes the test message (204); any other
   * is a webhook Discord no longer knows (404). */
  function discord(posts: { url: string; body: string }[] = []): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(null, { status: String(input) === WEBHOOK ? 204 : 404 });
    }) as typeof fetch;
  }
  /** The calendar host: the known feed is a calendar; another answers a
   * sign-in page, as a rotated secret link does. */
  function calendars(): typeof fetch {
    return (async (input: RequestInfo | URL) => String(input) === FEED
      ? new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 })
      : new Response('<html>Sign in</html>', { status: 200 })) as typeof fetch;
  }

  it('keeps a webhook only once its labelled test message is delivered', async () => {
    const posts: { url: string; body: string }[] = [];
    const result = await connectCredential(env, { provider: 'discord', fields: { DISCORD_WEBHOOK_URL: WEBHOOK } },
      { fetchImpl: discord(posts), nowMs: NOW });
    expect(result).toEqual({ ok: true, verdict: 'accepted', checkedAt: AT, facts: {} });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body)).toEqual({ content: 'NoticeOS connection test — nothing is wrong, you can ignore this.' });
    expect(await stored('discord')).toEqual({ provider: 'discord', last_ok_at: AT, last_error: null });
    expect(JSON.stringify(result)).not.toContain('SEKRIT');
  });

  it('stores no webhook Discord refuses, and calls a network failure no answer', async () => {
    const refused = await connectCredential(env, { provider: 'discord', fields: { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/2/SEKRIT-gone' } },
      { fetchImpl: discord(), nowMs: NOW });
    expect(refused).toEqual({ ok: true, verdict: 'refused', checkedAt: AT });
    expect(await connectCredential(env, { provider: 'discord', fields: { DISCORD_WEBHOOK_URL: WEBHOOK } }, { fetchImpl: unreachable, nowMs: NOW }))
      .toEqual({ ok: true, verdict: 'unreachable', checkedAt: AT });
    expect(await stored('discord')).toBeNull();
  });

  it('keeps the feed map only when every feed reads as a calendar, and counts them', async () => {
    const accepted = await connectCredential(env, { provider: 'calendar', fields: { CALENDAR_FEEDS: JSON.stringify({ work: FEED }) } },
      { fetchImpl: calendars(), nowMs: NOW });
    expect(accepted).toEqual({ ok: true, verdict: 'accepted', checkedAt: AT, facts: { feeds: 1 } });
    expect(await stored('calendar')).toEqual({ provider: 'calendar', last_ok_at: AT, last_error: null });
    expect(JSON.stringify(accepted)).not.toContain('SEKRIT');
  });

  it('stores no feed map with a feed that is not a calendar', async () => {
    const refused = await connectCredential(env, {
      provider: 'calendar', fields: { CALENDAR_FEEDS: JSON.stringify({ work: FEED, old: 'https://calendar.example/SEKRIT-rotated.ics' }) },
    }, { fetchImpl: calendars(), nowMs: NOW });
    expect(refused).toEqual({ ok: true, verdict: 'refused', checkedAt: AT });
    expect(await stored('calendar')).toBeNull();
  });
});

describe('what it refuses before asking any provider', () => {
  it('refuses a provider that does not connect with one key', async () => {
    let asked = false;
    // Clarity's tokens are pasted per site, on their own rows (bead ro-ujb9.96.7.9).
    const result = await connectCredential(env, { provider: 'clarity', fields: { CLARITY_TOKENS: '{"example.com":"SEKRIT"}' } },
      { fetchImpl: (async () => { asked = true; return new Response(''); }) as typeof fetch, nowMs: NOW });
    expect(result).toEqual({ ok: false, error: 'not_supported', provider: 'clarity' });
    expect(asked).toBe(false);
    expect(await connectCredential(env, { provider: 'nope', fields: {} }, { fetchImpl: unreachable }))
      .toEqual({ ok: false, error: 'unknown_provider', provider: 'nope' });
  });

  it('names the field the schema refuses, and never sends it to the provider', async () => {
    let asked = false;
    const result = await connectCredential(env, { provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'op@example.test' } },
      { fetchImpl: (async () => { asked = true; return new Response(''); }) as typeof fetch, nowMs: NOW });
    expect(result).toMatchObject({ ok: false, error: 'validation', issues: [{ path: 'DATAFORSEO_PASSWORD', code: 'required' }] });
    expect(asked).toBe(false);
  });

  it('reports a store that cannot hold the accepted key instead of pretending it did', async () => {
    const bare = { ...env, CREDENTIALS_KEY: '' } as unknown as IngestEnv;
    const result = await connectCredential(bare, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } },
      { fetchImpl: bing(), nowMs: NOW });
    expect(result).toMatchObject({ ok: false, error: 'key_missing' });
    expect(await stored('bing-webmaster')).toBeNull();
  });

  it('leaves an unrelated stored credential exactly as it was', async () => {
    await putCredential(env, { provider: 'dataforseo', fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD } });
    await connectCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: 'SEKRIT-wrong' } },
      { fetchImpl: bing(), nowMs: NOW });
    expect((await resolveCredential(env, 'dataforseo')).fields.DATAFORSEO_PASSWORD).toBe(DFS_PASSWORD);
  });
});
