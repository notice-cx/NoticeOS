// The credential store. One rule holds the design up: a stored credential
// leaves this Worker only as bytes a provider receives — never to the Tower,
// never to a log, never into an error message. Most of what follows is that
// rule asserted from a different angle each time. Against a real Postgres copy
// and real WebCrypto, because the round-trips, bytea, ON CONFLICT and the
// store-beats-env order are facts about the runtime, not about a mock.

import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_KEY_VERSION,
  credentialKeyLine,
  credentialKeyState,
  credentialSummary,
  deleteCredential,
  listCredentialSummaries,
  PREVIOUS_KEY_BINDING,
  ROTATE_NEEDS_PREVIOUS_KEY,
  putCredential,
  resolveCredential,
  rotateCredentialKeys,
  saveMediavineSession,
  setCredentialExpiry,
  recordCredentialOutcome,
  sourcedCredentialRef,
  validateCredentialFields,
} from '../src/credentials.js';
import { probeCredential } from '../src/credential-probes.js';
import { handleRotateCredentialKey } from '../src/routes/rotate-key.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { DISCORD_TEST_MESSAGE } from '@noticeos/contract/provider-requests';
import { INTEGRATION_PROVIDER_IDS, integrationProvider } from '@noticeos/contract';
import { runBingSignals } from '../src/bing-signals.js';
import { forgetConfigCache, seedConfigDocuments } from '../src/config-store.js';
import {
  asOwner,
  emptyTables,
  forgetCredentials,
  reset,
  setConnection,
  storedCredential,
  storedSecretCount,
} from './helpers.js';

/**
 * The one string this file hunts for. Every response, every summary and every
 * captured log line is searched for it, so a regression that starts echoing a
 * credential fails here rather than in production.
 */
const BING_SECRET = 'SEKRIT-bing-9f2a-do-not-echo';
const DFS_PASSWORD = 'SEKRIT-dataforseo-4b71-do-not-echo';
const FEED_URL = 'https://calendar.example.test/ical/op@example.test/private-SEKRIT/basic.ics';
/** A webhook url is a bearer credential wearing a url's clothes, exactly like a
 * secret ICS address — so it is hunted for in every verdict too. */
const DISCORD_WEBHOOK =
  'https://discord.com/api/webhooks/1234567890/SEKRIT-discord-token-do-not-echo';
/** One asset's Clarity data-export token — a per-asset credential, so the
 * value is hunted for while the asset ids beside it are deliberately public. */
const CLARITY_TOKEN = 'SEKRIT-clarity-a71c-do-not-echo';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');

beforeEach(async () => {
  await reset();
});
afterEach(async () => {
  await forgetCredentials();
});

/** The env, minus its bootstrap key — a fresh install that has not generated
 * one, or a deployment where the secret was never set. */
function withoutKey(): IngestEnv {
  return { ...env, CREDENTIALS_KEY: '' } as unknown as IngestEnv;
}

/** The env, minus one provider's own binding. The test runtime loads the
 * operator's `.dev.vars` (vitest.config), so "no binding" is a fact this file
 * has to STATE — on a machine with a CALENDAR_FEEDS secret, `env` alone would
 * make the unconfigured provider look configured. */
function withoutBinding(name: string): IngestEnv {
  const bare = { ...env } as Record<string, unknown>;
  delete bare[name];
  return bare as unknown as IngestEnv;
}

const row = storedCredential;

/** Every byte a column holds, as text. What a `strings` over the database
 * would show — which is the honest test of "is it encrypted at rest". */
function blobText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

/** Sealed bytes in every form a text could carry them: Postgres's hex, plain
 * hex and base64. */
function byteForms(bytes: Uint8Array): string[] {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [`\\x${hex}`, hex, btoa(String.fromCharCode(...bytes))];
}

/** Swap the console out for a recorder for the duration of one call. Used to
 * prove that nothing a lane logs carries a credential. */
async function withCapturedLogs<T>(
  work: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
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

describe('the bootstrap key', () => {
  it('reports itself usable when the test binding is a real 32 bytes', () => {
    expect(credentialKeyState(env)).toEqual({ present: true, reason: null, blocker: null });
  });

  it('refuses every crypto op without one, and the refusal is the fix', async () => {
    const state = credentialKeyState(withoutKey());
    expect(state.present).toBe(false);
    // The Tower draws the code; the sentence is the command line's.
    expect(state.blocker).toBe('key-missing');
    // The command line's line is the banner's state, the binding and the one
    // command.
    expect(state.reason).toBe('No encryption key · CREDENTIALS_KEY · openssl rand -base64 32');
    expect(state.reason).toBe(credentialKeyLine('key-missing', 'CREDENTIALS_KEY'));

    const result = await putCredential(withoutKey(), {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== 'key_missing') {
      throw new Error(`expected a key_missing refusal, got ${JSON.stringify(result)}`);
    }
    expect(result.message).toContain('openssl rand -base64 32');
  });

  it('names the length when the key is the wrong size, rather than failing later', () => {
    const short = { ...env, CREDENTIALS_KEY: btoa('too-short') } as unknown as IngestEnv;
    const state = credentialKeyState(short);
    expect(state.present).toBe(false);
    expect(state.reason).toContain('32');
  });
});

describe('sealing and opening', () => {
  it('round-trips a credential, and the row holds ciphertext rather than the value', async () => {
    const put = await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    expect(put.ok).toBe(true);

    const stored = await row('bing-webmaster');
    expect(stored).not.toBeNull();
    expect(stored!.key_version).toBe(CREDENTIAL_KEY_VERSION);
    expect(stored!.scope).toBe('shared');
    // The names are deliberately in the clear — that is what lets the page say
    // "this provider has a login but no password" with no key at all.
    expect(stored!.field_names).toEqual(['BING_WEBMASTER_API_KEY']);
    // …and the VALUE is not, anywhere in the row.
    expect(blobText(stored!.ciphertext)).not.toContain(BING_SECRET);
    expect(JSON.stringify(stored)).not.toContain(BING_SECRET);
    // A 96-bit nonce, which is the size AES-GCM is specified for.
    expect(stored!.iv.byteLength).toBe(12);
    expect(stored!.secret_version).toBe(1);

    const resolved = await resolveCredential(env, 'bing-webmaster');
    expect(resolved.source).toBe('store');
    expect(resolved.fields.BING_WEBMASTER_API_KEY).toBe(BING_SECRET);
  });

  it('seals the same value under a fresh IV every write — the one GCM rule', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const first = await row('bing-webmaster');
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const second = await row('bing-webmaster');

    expect(blobText(second!.iv)).not.toBe(blobText(first!.iv));
    expect(blobText(second!.ciphertext)).not.toBe(blobText(first!.ciphertext));
    // One secret per provider: a new one REPLACES, it does not accumulate
    // copies of a secret the operator has already replaced.
    expect(second!.secret_version).toBe(first!.secret_version + 1);
    expect(await storedSecretCount()).toBe(1);
  });

  it('falls back to env rather than taking the lane down when the key cannot open the row', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const { result, lines } = await withCapturedLogs(() =>
      resolveCredential(withoutKey(), 'bing-webmaster'),
    );
    // The env binding vitest.config.ts supplies carries the run instead.
    expect(result.source).toBe('env');
    expect(result.fields.BING_WEBMASTER_API_KEY).toBe('test-bing-key');
    expect(lines.join('\n')).toContain('credential_unreadable');
    expect(lines.join('\n')).not.toContain(BING_SECRET);
  });
});

describe('store first, env second', () => {
  it('reads the env binding while nothing is stored', async () => {
    const resolved = await resolveCredential(env, 'bing-webmaster');
    expect(resolved.source).toBe('env');
    expect(resolved.fields.BING_WEBMASTER_API_KEY).toBe('test-bing-key');
  });

  it('lets the store win, and hands the provider back on disconnect', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    expect((await resolveCredential(env, 'bing-webmaster')).source).toBe('store');

    const deleted = await deleteCredential(env, 'bing-webmaster');
    expect(deleted).toEqual({
      ok: true,
      summary: expect.objectContaining({ provider: 'bing-webmaster', source: 'env' }),
    });
    const after = await resolveCredential(env, 'bing-webmaster');
    expect(after.source).toBe('env');
    expect(after.fields.BING_WEBMASTER_API_KEY).toBe('test-bing-key');
  });

  it('deletes without the bootstrap key — losing the key must not strand the secret', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const deleted = await deleteCredential(withoutKey(), 'bing-webmaster');
    expect(deleted.ok).toBe(true);
    expect(await row('bing-webmaster')).toBeNull();
    // The secret went with its connection.
    expect(await storedSecretCount()).toBe(0);
  });

  it('calls a provider with no store row and no env binding `none`', async () => {
    // No CALENDAR_FEEDS binding exists in the test env.
    const resolved = await resolveCredential(withoutBinding('CALENDAR_FEEDS'), 'calendar');
    expect(resolved.source).toBe('none');
  });

  it('reads the older single-asset binding as that asset’s key', async () => {
    // An install still on `CLARITY_PROJECT_API_TOKEN` collects, and the card
    // must not say Not connected over it. The fold lives in `packages/contract`
    // so the collector, the card and the importer read one rule; what is pinned
    // here is that the resolver agrees.
    const legacy = {
      ...withoutBinding('CLARITY_TOKENS'),
      CLARITY_PROJECT_API_TOKEN: 'single-project-token',
    } as unknown as IngestEnv;

    const resolved = await resolveCredential(legacy, 'clarity');
    expect(resolved.source).toBe('env');
    expect(JSON.parse(resolved.fields.CLARITY_TOKENS!)).toEqual({
      'meadow.example': 'single-project-token',
    });
    // The slot that actually held it, so the manifest row stays honest.
    expect(resolved.legacySlots).toEqual({ 'meadow.example': 'CLARITY_PROJECT_API_TOKEN' });

    const summary = (await listCredentialSummaries(legacy)).summaries.find(
      (entry) => entry.provider === 'clarity',
    )!;
    expect(summary.source).toBe('env');
    expect(summary.missingFields).toEqual([]);
    expect(summary.assetsHeld).toEqual(['meadow.example']);
  });

  it('serves the first Clarity site in the STORE’s register, whatever it is called', async () => {
    // Which asset the older binding serves is the installation's answer —
    // `legacyBindingAsset` over its own register, store first — never a site
    // written into the catalog. A store whose first Clarity site is another
    // asset gets the token filed there, by the card and the collector alike.
    await emptyTables(['config_documents']);
    forgetConfigCache();
    const seeded = await seedConfigDocuments(env, {
      documents: {
        'config/integrations.json': {
          assets: {
            'home-os': { 'discord-webhooks': { status: 'needs-setup' } },
            'first.example': { clarity: { status: 'needs-setup' } },
          },
        },
      },
      actor: 'config:seed',
    });
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    forgetConfigCache();
    try {
      const legacy = {
        ...withoutBinding('CLARITY_TOKENS'),
        CLARITY_PROJECT_API_TOKEN: 'single-project-token',
      } as unknown as IngestEnv;
      const resolved = await resolveCredential(legacy, 'clarity');
      expect(resolved.legacySlots).toEqual({ 'first.example': 'CLARITY_PROJECT_API_TOKEN' });
      const summary = (await listCredentialSummaries(legacy)).summaries.find(
        (entry) => entry.provider === 'clarity',
      )!;
      expect(summary.assetsHeld).toEqual(['first.example']);
    } finally {
      await emptyTables(['config_documents']);
      forgetConfigCache();
    }
  });

  it('refuses an unknown provider by name', async () => {
    const result = await putCredential(env, { provider: 'not-a-provider', fields: {} });
    expect(result).toEqual({ ok: false, error: 'unknown_provider', provider: 'not-a-provider' });
  });
});

describe('summaries — names and metadata, never values', () => {
  it('answers for every provider, connected or not, and carries no secret', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });

    const state = await listCredentialSummaries(withoutBinding('CALENDAR_FEEDS'));
    expect(state.keyPresent).toBe(true);
    // Every provider in the catalog, in catalog order — a card that says "not
    // connected" is a card, not a missing row.
    expect(state.summaries.map((summary) => summary.provider)).toEqual(INTEGRATION_PROVIDER_IDS);

    const bing = state.summaries.find((summary) => summary.provider === 'bing-webmaster')!;
    expect(bing.source).toBe('store');
    expect(bing.fields).toEqual(['BING_WEBMASTER_API_KEY']);
    expect(bing.missingFields).toEqual([]);
    expect(bing.keyVersion).toBe(CREDENTIAL_KEY_VERSION);
    expect(bing.lastOkAt).toBeNull();

    // The env-only provider reads `env`, and the unconfigured one reads `none`.
    expect(
      state.summaries.find((summary) => summary.provider === 'google')!.source,
    ).toBe('env');
    expect(
      state.summaries.find((summary) => summary.provider === 'calendar')!.source,
    ).toBe('none');

    // THE GREP. Nothing that crosses this boundary may contain a value.
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(BING_SECRET);
    expect(serialized).not.toContain(DFS_PASSWORD);
    expect(serialized).not.toContain('test-bing-key');
  });

  it('clears the last verdict when a credential is replaced', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    await setConnection('bing-webmaster', {
      last_ok_at: '2026-09-01T00:00:00.000Z',
      last_used_at: '2026-09-01T00:00:00.000Z',
    });

    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: 'a-different-key' },
    });
    const state = await listCredentialSummaries(env);
    const bing = state.summaries.find((summary) => summary.provider === 'bing-webmaster')!;
    // What the OLD key proved says nothing about the new one; a stale green
    // check beside a broken credential is worse than no check at all.
    expect(bing.lastOkAt).toBeNull();
    expect(bing.lastUsedAt).toBeNull();
  });

  it('reports which ASSETS a per-asset credential covers, without the key and without a token', async () => {
    // Clarity is one row holding a map, so which assets are covered has to be
    // answerable from the row's public half — a card whose bootstrap key was
    // rotated still has to say what it is holding. Ids are public; tokens never
    // leave.
    await putCredential(env, {
      provider: 'clarity',
      fields: {
        CLARITY_TOKENS: JSON.stringify({
          'northwind.example': `${CLARITY_TOKEN}-2`,
          'meadow.example': CLARITY_TOKEN,
        }),
      },
    });

    const stored = await row('clarity');
    expect(blobText(stored!.ciphertext)).not.toContain(CLARITY_TOKEN);
    // In the clear beside the ciphertext, sorted so the card is stable.
    expect(stored!.asset_ids).toEqual(['meadow.example', 'northwind.example']);

    const withoutTheKey = await listCredentialSummaries(withoutKey());
    const clarity = withoutTheKey.summaries.find((s) => s.provider === 'clarity')!;
    expect(clarity.assetsHeld).toEqual(['meadow.example', 'northwind.example']);
    expect(JSON.stringify(clarity)).not.toContain(CLARITY_TOKEN);

    // A shared provider has no per-asset dimension to report, ever.
    expect(
      withoutTheKey.summaries.find((s) => s.provider === 'bing-webmaster')!.assetsHeld,
    ).toEqual([]);
  });

  it('reads the same coverage out of the legacy binding, so the move changes nothing on the card', async () => {
    // A per-asset credential is partial by design — the operator collects
    // tokens one project at a time — so an install still on `CLARITY_TOKENS`
    // must not read as covering NOTHING until it moves into the store.
    const onEnv = {
      ...env,
      CLARITY_TOKENS: JSON.stringify({ 'meadow.example': CLARITY_TOKEN }),
    } as unknown as IngestEnv;
    const state = await listCredentialSummaries(onEnv);
    const clarity = state.summaries.find((summary) => summary.provider === 'clarity')!;
    expect(clarity.source).toBe('env');
    expect(clarity.assetsHeld).toEqual(['meadow.example']);
    expect(JSON.stringify(clarity)).not.toContain(CLARITY_TOKEN);
  });
});

describe('validation — the same rules whichever door the write came through', () => {
  const dataforseo = integrationProvider('dataforseo')!;
  const google = integrationProvider('google')!;
  const calendar = integrationProvider('calendar')!;

  it('names a missing required field', () => {
    const issues = validateCredentialFields(dataforseo, {
      DATAFORSEO_LOGIN: 'op@example.test',
    });
    expect(issues.map((issue) => issue.path)).toEqual(['DATAFORSEO_PASSWORD']);
    expect(issues[0]!.code).toBe('required');
  });

  it('rejects a field the provider does not have', () => {
    const issues = validateCredentialFields(dataforseo, {
      DATAFORSEO_LOGIN: 'op@example.test',
      DATAFORSEO_PASSWORD: DFS_PASSWORD,
      API_KEY: 'stray',
    });
    expect(issues.map((issue) => issue.path)).toEqual(['API_KEY']);
    // The message names the FIELD and the alternatives, never the value.
    expect(issues[0]!.message).not.toContain('stray');
  });

  it('rejects a json field that is not JSON, and one that is not an object', () => {
    expect(
      validateCredentialFields(google, { GOOGLE_SIGNAL_ACCOUNTS: 'not json' })[0]!.code,
    ).toBe('invalid_json');
    expect(
      validateCredentialFields(google, { GOOGLE_SIGNAL_ACCOUNTS: '[1,2]' })[0]!.code,
    ).toBe('invalid_json');
  });

  it('rejects a feed map whose entries are not http urls, by LABEL', () => {
    const issues = validateCredentialFields(calendar, {
      CALENDAR_FEEDS: JSON.stringify({ work: 'file:///etc/passwd' }),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('"work"');
    // The url is the credential; a rejection that echoed it would leak it into
    // a browser and a server log at once.
    expect(issues[0]!.message).not.toContain('/etc/passwd');
  });

  it('accepts the two shapes a feed entry may take', () => {
    expect(
      validateCredentialFields(calendar, {
        CALENDAR_FEEDS: JSON.stringify({
          work: FEED_URL,
          personal: { url: FEED_URL, color: '#6ea8fe' },
        }),
      }),
    ).toEqual([]);
  });

  it('holds a single url field to the same standard as one feed entry', () => {
    // The commonest Discord mistake is pasting the webhook ID rather than the
    // whole address, so it is refused by field rather than stored as a string
    // nobody can post to.
    const discord = integrationProvider('discord')!;
    expect(validateCredentialFields(discord, { DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK })).toEqual([]);
    const issues = validateCredentialFields(discord, { DISCORD_WEBHOOK_URL: '1234567890' });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('invalid_url');
    expect(issues[0]!.message).not.toContain('1234567890');
    expect(
      validateCredentialFields(discord, { DISCORD_WEBHOOK_URL: 'file:///etc/passwd' })[0]!.code,
    ).toBe('invalid_url');
  });

  it('refuses a whole write when any field is invalid', async () => {
    const result = await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test' },
    });
    expect(result.ok).toBe(false);
    expect(await row('dataforseo')).toBeNull();
  });
});

describe('probes — one cheap real call, nothing persisted, no secret in the answer', () => {
  it('asks Bing for its verified sites and stamps the credential', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const calls: string[] = [];
    const probe = await probeCredential(env, 'bing-webmaster', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ d: [{ Url: 'https://meadow.example/', IsVerified: true }] });
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    // A result the card draws, and the same result as one short line.
    expect(probe.result).toEqual({ outcome: 'answered', facts: { sites: 1 } });
    expect(probe.message).toBe('Answered · 1 site');
    expect(probe.checkedAt).toBe(new Date(NOW).toISOString());
    // The cheapest authenticated read Bing offers, and only that one.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('GetUserSites');
    // The verdict is what the operator sees — never the key that produced it.
    expect(JSON.stringify(probe)).not.toContain(BING_SECRET);

    const stored = await row('bing-webmaster');
    expect(stored!.last_ok_at).toBe(new Date(NOW).toISOString());
    expect(stored!.last_used_at).toBe(new Date(NOW).toISOString());
    expect(stored!.last_error).toBeNull();
  });

  it('records a refusal as `ok: false` plus the reason, not as a thrown error', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const probe = await probeCredential(env, 'bing-webmaster', {
      nowMs: NOW,
      fetchImpl: (async () =>
        Response.json({ Message: 'Invalid API key' }, { status: 401 })) as typeof fetch,
    });
    expect(probe.ok).toBe(false);
    expect(JSON.stringify(probe)).not.toContain(BING_SECRET);

    const stored = await row('bing-webmaster');
    expect(stored!.last_ok_at).toBeNull();
    expect(stored!.last_error).not.toBeNull();
    expect(String(stored!.last_error)).not.toContain(BING_SECRET);
  });

  it('reads the DataForSEO account endpoint and reports the credit left', async () => {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
    const calls: string[] = [];
    const probe = await probeCredential(env, 'dataforseo', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({
          status_code: 20000,
          tasks: [{ result: [{ login: 'op@example.test', money: { balance: 42.5 } }] }],
        });
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    expect(probe.result).toEqual({ outcome: 'answered', facts: { creditUsd: '42.5' } });
    expect(probe.message).toContain('$42.50');
    expect(calls[0]).toBe('https://api.dataforseo.com/v3/appendix/user_data');
    expect(JSON.stringify(probe)).not.toContain(DFS_PASSWORD);

    // And it keeps the figure, dated: the one thing a probe persists, a fact
    // about the credential rather than the provider's data. The instant rides
    // with it so the card can only ever say how old it is.
    const summary = (await credentialSummary(env, 'dataforseo'))!;
    expect(summary.metadata?.balance).toEqual({
      usd: '42.5',
      seenAt: new Date(NOW).toISOString(),
    });
    // A metadata-only write, in the clear beside the secret: the verdict
    // columns are the outcome recorder's, and a balance must not be able to
    // move them.
    const stamped = await row('dataforseo');
    // Exact, at the six decimals provider prices keep.
    expect(stamped!.balance_usd).toBe('42.500000');
    expect(JSON.stringify(stamped)).not.toContain(DFS_PASSWORD);
  });

  it('keeps the credit to the provider\'s own digits, from its answer to the store to the card', async () => {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
    // The provider's JSON text, as sent: digits a float cannot hold.
    const answer = (balance: string) =>
      (async () =>
        new Response(`{"status_code":20000,"tasks":[{"result":[{"money":{"balance":${balance}}}]}]}`, {
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

    // Past a float's precision: its digits round to …123456; the float
    // nearest them prints as 12345678.1234565 and would round to …123457.
    expect(String(Number('12345678.12345649999'))).toBe('12345678.1234565');
    const exact = await probeCredential(env, 'dataforseo', { nowMs: NOW, fetchImpl: answer('12345678.12345649999') });
    expect(exact.result.facts?.creditUsd).toBe('12345678.12345649999');
    expect((await row('dataforseo'))!.balance_usd).toBe('12345678.123456');
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance?.usd).toBe('12345678.123456');

    // More decimals than the store keeps: six kept, the seventh rounded half
    // away from zero; the card shows cents either way.
    const seven = await probeCredential(env, 'dataforseo', { nowMs: NOW, fetchImpl: answer('0.1234565') });
    expect(seven.message).toBe('Answered · $0.12 credit');
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance?.usd).toBe('0.123457');

    // A half cent is a whole one: the float 1.005 would have printed $1.00.
    const half = await probeCredential(env, 'dataforseo', { nowMs: NOW, fetchImpl: answer('1.005') });
    expect(half.message).toBe('Answered · $1.01 credit');
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance?.usd).toBe('1.005');

    // A figure the type cannot hold is refused; the card keeps the one it had.
    const tooLarge = await probeCredential(env, 'dataforseo', { nowMs: NOW, fetchImpl: answer('100000000') });
    expect(tooLarge.ok).toBe(true);
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance?.usd).toBe('1.005');
  });

  it('leaves the balance behind when a new password is pasted over the old one', async () => {
    // A rotation may name a DIFFERENT prepaid account, so carrying the credit
    // across one would attribute a figure to an account nobody read it from —
    // the same reason `last_ok_at` is cleared. The card says nothing has been
    // seen yet until the next answer carries one.
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
    await probeCredential(env, 'dataforseo', {
      nowMs: NOW,
      fetchImpl: (async () =>
        Response.json({
          status_code: 20000,
          tasks: [{ result: [{ money: { balance: 42.5 } }] }],
        })) as typeof fetch,
    });
    await setCredentialExpiry(env, {
      provider: 'dataforseo',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    // Dating a credential says nothing about what its account holds.
    expect((await credentialSummary(env, 'dataforseo'))!.metadata?.balance).toMatchObject({
      usd: '42.5',
    });

    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'op@example.test', DATAFORSEO_PASSWORD: 'SEKRIT-rotated-a1' },
    });
    const after = (await credentialSummary(env, 'dataforseo'))!;
    expect(after.metadata?.balance ?? null).toBeNull();
    // The operator's own expiry survives, because that is THEIR answer rather
    // than a reading of the account.
    expect(after.metadata?.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('mints one read-only token per Google scope and never asks for data', async () => {
    await putCredential(env, {
      provider: 'google',
      fields: { GOOGLE_SIGNAL_ACCOUNTS: env.GOOGLE_SIGNAL_ACCOUNTS },
    });
    const calls: string[] = [];
    const probe = await probeCredential(env, 'google', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === 'https://oauth2.googleapis.com/token') {
          return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
        }
        if (url === 'https://www.googleapis.com/webmasters/v3/sites') {
          return Response.json({
            siteEntry: [
              { siteUrl: 'sc-domain:meadow.example' },
              { siteUrl: 'sc-domain:northwind.example' },
            ],
          });
        }
        return Response.json({ dimensions: [] });
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    // GA4 answered too: no "not mapped" fact.
    expect(probe.result).toMatchObject({ outcome: 'answered', facts: { sites: 2 } });
    expect(probe.result.facts?.ga4Unmapped).toBeUndefined();
    // sites.list is free; the GA4 call is `metadata`, which returns no rows and
    // spends no reporting tokens. Neither reads a single day of data.
    expect(calls.some((url) => url.endsWith('/metadata'))).toBe(true);
    expect(calls.some((url) => url.includes(':runReport'))).toBe(false);
  });

  it('names calendar feeds by LABEL and never by url', async () => {
    await putCredential(env, {
      provider: 'calendar',
      fields: {
        CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL, broken: 'https://gone.example.test/x' }),
      },
    });
    const probe = await probeCredential(env, 'calendar', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input) === FEED_URL) {
          return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
        }
        return new Response('gone', { status: 404 });
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(false);
    expect(probe.result).toEqual({ outcome: 'refused', facts: { feeds: 1, feedsTotal: 2 }, failing: ['broken'], fix: { kind: 'replace' } });
    expect(probe.message).toContain('broken');
    expect(probe.message).toContain('1 of 2');
    // The secret ICS link is a bearer credential wearing a url's clothes.
    expect(probe.message).not.toContain('private-SEKRIT');
    expect(probe.message).not.toContain(FEED_URL);
  });

  it('posts one labelled message to Discord and never echoes the webhook url', async () => {
    // The one probe with a side effect. Discord offers a read of the webhook
    // object, and it would prove the wrong thing: this data source is live when
    // a notification arrives, not when a url exists. So the test posts, the
    // contract declares that cost, and the card prints it before the press.
    await putCredential(env, {
      provider: 'discord',
      fields: { DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK },
    });
    const posts: { url: string; body: string }[] = [];
    const probe = await probeCredential(env, 'discord', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body).content).toBe(DISCORD_TEST_MESSAGE);
    // The message says what it is and that nothing is wrong — it lands in the
    // channel the operator watches for real alerts.
    expect(DISCORD_TEST_MESSAGE).toContain('NoticeOS');
    expect(DISCORD_TEST_MESSAGE).toContain('ignore');
    // The url IS the credential; it reaches Discord and nothing else.
    expect(JSON.stringify(probe)).not.toContain(DISCORD_WEBHOOK);
    expect((await row('discord'))!.last_ok_at).toBe(new Date(NOW).toISOString());
  });

  it('reads a deleted Discord webhook as deleted, without quoting Discord back', async () => {
    await putCredential(env, {
      provider: 'discord',
      fields: { DISCORD_WEBHOOK_URL: DISCORD_WEBHOOK },
    });
    const probe = await probeCredential(env, 'discord', {
      nowMs: NOW,
      fetchImpl: (async () =>
        Response.json({ message: 'Unknown Webhook', code: 10015 }, { status: 404 })) as typeof fetch,
    });
    expect(probe.ok).toBe(false);
    // Gone: the one press is a new webhook.
    expect(probe.result).toEqual({ outcome: 'refused', status: 404, fix: { kind: 'replace' } });
    // Discord's own body is provider-controlled text and is never reflected.
    expect(probe.message).not.toContain('Unknown Webhook');
    expect(probe.message).not.toContain(DISCORD_WEBHOOK);
  });

  it('answers for Clarity without calling Clarity, and stamps no verdict it did not earn', async () => {
    // Clarity's export allows ten calls per project per day and has no free
    // check, so the probe makes no call — and, because it proved nothing, it
    // must not touch `last_ok_at`, which the card renders as the credential
    // having worked. Stamping it would also wipe the `last_error` a real run left.
    await putCredential(env, {
      provider: 'clarity',
      fields: {
        CLARITY_TOKENS: JSON.stringify({
          'meadow.example': CLARITY_TOKEN,
          'northwind.example': `${CLARITY_TOKEN}-2`,
        }),
      },
    });
    await recordCredentialOutcome(env, 'clarity', {
      ok: false,
      error: 'Access was refused · northwind.example',
      at: new Date(NOW - 3_600_000).toISOString(),
    });

    const probe = await probeCredential(env, 'clarity', {
      nowMs: NOW,
      fetchImpl: (async () => {
        throw new Error('the Clarity probe must not spend one of the ten');
      }) as typeof fetch,
    });

    expect(probe.ok).toBe(true);
    // Not checked, with how many sites hold a token and the press that does
    // prove them: the export itself, Run now.
    expect(probe.result).toEqual({ outcome: 'not-checked', facts: { tokens: 2 }, fix: { kind: 'run-now' } });
    expect(JSON.stringify(probe)).not.toContain(CLARITY_TOKEN);

    const stored = await row('clarity');
    expect(stored!.last_ok_at).toBeNull();
    // The collector's verdict survives the press, because the press proved
    // nothing that could replace it.
    expect(stored!.last_error).toBe('Access was refused · northwind.example');
  });

  it('tests PostHog with one project read per mapped asset and never runs a query', async () => {
    // The region and project come from the asset's Sources tab; an asset with a
    // key and no project is named as not checked, not failed.
    const PH_KEY = 'phx_probe_test_key';
    await putCredential(env, {
      provider: 'posthog',
      fields: { POSTHOG_KEYS: JSON.stringify({ 'meadow.example': PH_KEY, 'northwind.example': `${PH_KEY}-2` }) },
    });
    const calls: { url: string; method: string; authorization: string | null }[] = [];
    const probe = await probeCredential(env, 'posthog', {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
        return Response.json({ id: 424242, timezone: 'America/New_York' });
      }) as typeof fetch,
    });
    expect(calls).toEqual([
      { url: 'https://us.posthog.com/api/projects/424242/', method: 'GET', authorization: `Bearer ${PH_KEY}` },
    ]);
    expect(probe.ok).toBe(true);
    // The site with no project picked is not checked, and mapping it is the press.
    expect(probe.result).toEqual({ outcome: 'answered', facts: { sites: 1 }, unchecked: ['northwind.example'], fix: { kind: 'map', sites: ['northwind.example'] } });
    expect(JSON.stringify(probe)).not.toContain(PH_KEY);
    // A free read that answered is a verdict the card may show.
    expect((await row('posthog'))!.last_ok_at).toBe(new Date(NOW).toISOString());

    const refused = await probeCredential(env, 'posthog', {
      nowMs: NOW,
      fetchImpl: (async () => Response.json({ detail: 'Invalid key' }, { status: 401 })) as typeof fetch,
    });
    expect(refused.ok).toBe(false);
    expect(refused.result).toMatchObject({ outcome: 'refused', status: 401, failing: ['meadow.example'], fix: { kind: 'replace' } });
    expect(JSON.stringify(refused)).not.toContain(PH_KEY);
  });

  it('says so plainly when the provider is not connected at all', async () => {
    const probe = await probeCredential(withoutBinding('CALENDAR_FEEDS'), 'calendar', { nowMs: NOW });
    expect(probe.ok).toBe(false);
    expect(probe.result).toEqual({ outcome: 'not-connected', fix: { kind: 'connect' } });
    expect(probe.message).toBe('Not connected');
  });

  it('refuses an unknown provider without reaching the network', async () => {
    const probe = await probeCredential(env, 'nope', {
      nowMs: NOW,
      fetchImpl: (async () => {
        throw new Error('the probe must not fetch for an unknown provider');
      }) as typeof fetch,
    });
    expect(probe.ok).toBe(false);
    expect(probe.result).toEqual({ outcome: 'invalid', failing: ['nope'] });
  });
});

describe('what a collector records about the credential it ran on', () => {
  it('marks the run `store:` and stamps the credential when the store served it', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });

    const { lines } = await withCapturedLogs(() =>
      runBingSignals(env, {
        nowMs: NOW,
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('GetUserSites')) {
            return Response.json({ d: [{ Url: 'https://meadow.example/', IsVerified: true }] });
          }
          return Response.json({
            d: [
              {
                Date: '/Date(1756944000000)/',
                Clicks: 5,
                Impressions: 50,
              },
            ],
          });
        }) as typeof fetch,
      }),
    );

    const refs = await env.STORE.read((tx) =>
      tx.query<{ credential_ref: string }>(
        `SELECT DISTINCT credential_ref FROM noticeos.signal_runs WHERE integration = 'bing-webmaster'`,
      ),
    );
    // `signal_runs` now says WHERE the credential came from, so "the collector
    // is still on .dev.vars" is a fact you read rather than one you assume.
    expect(refs.map((entry) => entry.credential_ref)).toEqual([
      'store:BING_WEBMASTER_API_KEY',
    ]);
    expect(sourcedCredentialRef('BING_WEBMASTER_API_KEY', 'env')).toBe(
      'BING_WEBMASTER_API_KEY',
    );

    const stored = await row('bing-webmaster');
    expect(stored!.last_ok_at).not.toBeNull();

    // The lane logs a completion line; none of what it logs is the key.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(BING_SECRET);
  });

  it('keeps the legacy ref when the env binding served the run', async () => {
    await runBingSignals(env, {
      nowMs: NOW,
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).includes('GetUserSites')) {
          return Response.json({ d: [{ Url: 'https://meadow.example/', IsVerified: true }] });
        }
        return Response.json({ d: [] });
      }) as typeof fetch,
    });
    const refs = await env.STORE.read((tx) =>
      tx.query<{ credential_ref: string }>(
        `SELECT DISTINCT credential_ref FROM noticeos.signal_runs WHERE integration = 'bing-webmaster'`,
      ),
    );
    expect(refs.map((entry) => entry.credential_ref)).toEqual([
      'BING_WEBMASTER_API_KEY',
    ]);
  });
});

describe('when a credential stops working', () => {
  const NEXT_MONTH = '2026-10-04T00:00:00.000Z';

  it('records a date the operator entered, without touching the ciphertext or the verdict', async () => {
    // The whole reason this is its OWN write and not a field on `putCredential`:
    // dating a credential must not mean retyping it. So the blob, the IV and the
    // proof that the key works all have to survive untouched.
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const before = (await row('bing-webmaster'))!;

    const result = await setCredentialExpiry(env, {
      provider: 'bing-webmaster',
      expiresAt: NEXT_MONTH,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary.metadata).toEqual({
      account: null,
      scopes: [],
      connectedAt: null,
      expiresAt: NEXT_MONTH,
      expirySource: 'operator',
    });

    const after = (await row('bing-webmaster'))!;
    expect(blobText(after.ciphertext)).toBe(blobText(before.ciphertext));
    expect(blobText(after.iv)).toBe(blobText(before.iv));
    expect(after.key_version).toBe(before.key_version);
    expect(after.secret_version).toBe(before.secret_version);
    // A date is a public fact, so it is in the CLEAR beside the ciphertext —
    // which is what lets the page read it with no bootstrap key at all.
    expect(after.expires_at).toBe(NEXT_MONTH);
    expect(after.expiry_source).toBe('operator');
    // And the secret is still the secret.
    expect((await resolveCredential(env, 'bing-webmaster')).fields.BING_WEBMASTER_API_KEY).toBe(
      BING_SECRET,
    );
  });

  it('works with no bootstrap key, because a rotated key is exactly when you need to say so', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const result = await setCredentialExpiry(withoutKey(), {
      provider: 'bing-webmaster',
      expiresAt: NEXT_MONTH,
    });
    expect(result.ok).toBe(true);
  });

  it('takes null as an ANSWER — this one does not expire — rather than as an erasure', async () => {
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'ops@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
    await setCredentialExpiry(env, { provider: 'dataforseo', expiresAt: NEXT_MONTH });
    const cleared = await setCredentialExpiry(env, {
      provider: 'dataforseo',
      expiresAt: null,
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('unreachable');
    // `expirySource` survives with a null date on purpose: it is the record that
    // somebody ANSWERED, which is what stops a later flow assuming again.
    expect(cleared.summary.metadata?.expiresAt).toBeNull();
    expect(cleared.summary.metadata?.expirySource).toBe('operator');
  });

  it('refuses a date for a provider that states no expiry, rather than storing a guess', async () => {
    await putCredential(env, {
      provider: 'calendar',
      fields: { CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL }) },
    });
    const refused = await setCredentialExpiry(env, {
      provider: 'calendar',
      expiresAt: NEXT_MONTH,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    if (refused.error !== 'not_expirable') throw new Error('unreachable');
    // The refusal names the provider and the fact, in one line.
    expect(refused.message).toContain('no expiry date');
  });

  it('refuses to date a provider with nothing stored, and refuses an unreadable date', async () => {
    const missing = await setCredentialExpiry(env, {
      provider: 'bing-webmaster',
      expiresAt: NEXT_MONTH,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.error).toBe('not_stored');

    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const nonsense = await setCredentialExpiry(env, {
      provider: 'bing-webmaster',
      expiresAt: 'sometime next week',
    });
    expect(nonsense.ok).toBe(false);
    if (nonsense.ok) throw new Error('unreachable');
    expect(nonsense.error).toBe('validation');
  });

  it('carries a recorded expiry into the summary the Tower reads, and no value with it', async () => {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    await setCredentialExpiry(env, { provider: 'bing-webmaster', expiresAt: NEXT_MONTH });
    const state = await listCredentialSummaries(env);
    const bing = state.summaries.find((entry) => entry.provider === 'bing-webmaster');
    expect(bing?.metadata?.expiresAt).toBe(NEXT_MONTH);
    expect(JSON.stringify(state)).not.toContain(BING_SECRET);
  });
});

describe('rotating the bootstrap key', () => {
  /** A second 32-byte key, so a rotation has somewhere to go. Deliberately not
   * random per run: a failure has to be reproducible from the transcript. */
  const NEW_KEY = btoa(String.fromCharCode(...new Array(32).fill(0).map((_, i) => (i * 7 + 3) % 256)));

  /** The env AFTER the operator has moved the old key aside and put a new one
   * in `CREDENTIALS_KEY` — the two-key window the whole operation lives in. */
  function rotatedEnv(): IngestEnv {
    return {
      ...env,
      CREDENTIALS_KEY: NEW_KEY,
      [PREVIOUS_KEY_BINDING]: (env as unknown as Record<string, string>).CREDENTIALS_KEY,
    } as unknown as IngestEnv;
  }

  /** The env once the old key has been removed — the state the runbook ends in,
   * and the one that proves the rotation actually moved the bytes. */
  function newKeyOnly(): IngestEnv {
    const bare = { ...env, CREDENTIALS_KEY: NEW_KEY } as Record<string, unknown>;
    delete bare[PREVIOUS_KEY_BINDING];
    return bare as unknown as IngestEnv;
  }

  async function storeTwo(): Promise<void> {
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    await putCredential(env, {
      provider: 'dataforseo',
      fields: { DATAFORSEO_LOGIN: 'ops@example.test', DATAFORSEO_PASSWORD: DFS_PASSWORD },
    });
  }

  it('refuses without the previous key, and says how to get into the window', async () => {
    // Rotation is only meaningful while BOTH keys are readable. A pass that
    // "succeeded" by re-sealing everything under the key it was already using
    // would be a command reporting work it did not do.
    await storeTwo();
    const refused = await rotateCredentialKeys(env);
    expect(refused.ok).toBe(false);
    // A code the CLI prints the runbook for, and the state as one line.
    expect(refused.refusal).toBe('previous-key-missing');
    expect(refused.reason).toBe(ROTATE_NEEDS_PREVIOUS_KEY);
    expect(refused.reason).toContain(PREVIOUS_KEY_BINDING);
    expect(refused.rotated).toBe(0);
  });

  it('answers the route 401 without the operator, 409 outside the two-key window, 200 inside it', async () => {
    await storeTwo();
    const post = (target: IngestEnv, token: string) =>
      handleRotateCredentialKey(
        new Request('http://ingest.local/api/credentials/rotate-key', {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
        target,
      );
    expect((await post(env, '')).status).toBe(401);
    const refused = await post(env, OPERATOR_TOKEN);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, refusal: 'previous-key-missing', rotated: 0 });
    const done = await post(rotatedEnv(), OPERATOR_TOKEN);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, rotated: 2 });
  });

  it('re-seals every row under the new key, bumps the version, and moves the bytes', async () => {
    await storeTwo();
    const before = await Promise.all([row('bing-webmaster'), row('dataforseo')]);

    const result = await rotateCredentialKeys(rotatedEnv());
    expect(result).toMatchObject({
      ok: true,
      rows: 2,
      rotated: 2,
      alreadyCurrent: 0,
      keyVersion: 2,
      unreadable: [],
      contended: [],
    });

    const after = await Promise.all([row('bing-webmaster'), row('dataforseo')]);
    for (const [index, current] of after.entries()) {
      expect(current!.key_version).toBe(2);
      // New key AND a fresh IV: re-sealing under the same nonce would be the one
      // way to break GCM outright.
      expect(blobText(current!.ciphertext)).not.toBe(blobText(before[index]!.ciphertext));
      expect(blobText(current!.iv)).not.toBe(blobText(before[index]!.iv));
      // `updated_at` does NOT move — a rotation is not something the operator
      // did to this credential, and a card reading "Stored 2 minutes ago" for a
      // secret nobody touched would be a lie.
      expect(current!.updated_at).toBe(before[index]!.updated_at);
    }

    // The point of the whole exercise: the old key can now be removed and every
    // provider still resolves `store`, with the same values.
    const bing = await resolveCredential(newKeyOnly(), 'bing-webmaster');
    expect(bing.source).toBe('store');
    expect(bing.fields.BING_WEBMASTER_API_KEY).toBe(BING_SECRET);
    const dfs = await resolveCredential(newKeyOnly(), 'dataforseo');
    expect(dfs.fields.DATAFORSEO_PASSWORD).toBe(DFS_PASSWORD);
  });

  it('keeps every provider readable DURING the window, from either generation', async () => {
    // A mixed-version table is the normal state of a pass in flight, and a
    // collector that fired mid-sweep must not fail because it landed on the
    // half that had already moved.
    await storeTwo();
    await rotateCredentialKeys(rotatedEnv());
    // Put one row back on the old key, by hand, exactly as an interrupted pass
    // would have left it.
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    const mixed = rotatedEnv();
    expect((await resolveCredential(mixed, 'bing-webmaster')).fields.BING_WEBMASTER_API_KEY).toBe(
      BING_SECRET,
    );
    expect((await resolveCredential(mixed, 'dataforseo')).fields.DATAFORSEO_PASSWORD).toBe(
      DFS_PASSWORD,
    );
  });

  it('is resumable: a second run finishes what was left, without bumping again', async () => {
    await storeTwo();
    await rotateCredentialKeys(rotatedEnv());
    // An interrupted pass, built by hand: one row back under the OLD key and
    // stamped at version 1, one already at version 2 under the new one. The
    // save goes through the old env (so the bytes are the old generation) and
    // the version is then walked back, because `putCredential` now stamps the
    // table's high-water mark and cannot produce this state on its own.
    await putCredential(env, {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    // A secret is never rewritten by the application; the owner stands in for
    // the pass that was interrupted.
    await asOwner(
      `UPDATE noticeos.connection_secrets s SET key_version = 1
         FROM noticeos.integration_connections c
        WHERE c.workspace_id = s.workspace_id AND c.connection_id = s.connection_id
          AND c.provider = 'bing-webmaster'`,
    );
    expect((await row('bing-webmaster'))!.key_version).toBe(1);

    const finished = await rotateCredentialKeys(rotatedEnv());
    // The SPLIT table lands on the version already reached rather than 3: a
    // second run is finishing, not restarting.
    expect(finished).toMatchObject({ ok: true, keyVersion: 2, rotated: 1, alreadyCurrent: 1 });
    expect((await row('bing-webmaster'))!.key_version).toBe(2);
  });

  it('does nothing, and bumps nothing, when every row is already on the new key', async () => {
    await storeTwo();
    await rotateCredentialKeys(rotatedEnv());
    const again = await rotateCredentialKeys(rotatedEnv());
    expect(again).toMatchObject({
      ok: true,
      rows: 2,
      rotated: 0,
      alreadyCurrent: 2,
      keyVersion: 2,
    });
  });

  it('names a row neither key can open, and leaves its bytes exactly as they were', async () => {
    // The acceptance criterion: a row that cannot be re-sealed is NAMED rather
    // than dropped. Deleting it would destroy the only record that the provider
    // was ever connected, and rewriting it is impossible.
    await storeTwo();
    const stranded = btoa(String.fromCharCode(...new Array(32).fill(0).map((_, i) => (i * 11 + 5) % 256)));
    // A row sealed under a THIRD key nobody holds any more.
    await putCredential(
      { ...env, CREDENTIALS_KEY: stranded } as unknown as IngestEnv,
      { provider: 'calendar', fields: { CALENDAR_FEEDS: JSON.stringify({ work: FEED_URL }) } },
    );
    const before = await row('calendar');

    const result = await rotateCredentialKeys(rotatedEnv());
    expect(result.ok).toBe(true);
    expect(result.unreadable).toEqual(['calendar']);
    expect(result.rotated).toBe(2);

    const after = await row('calendar');
    expect(blobText(after!.ciphertext)).toBe(blobText(before!.ciphertext));
    expect(blobText(after!.iv)).toBe(blobText(before!.iv));
    expect(after!.key_version).toBe(before!.key_version);
    expect(after!.secret_version).toBe(before!.secret_version);
  });

  it('stamps a LATER save with the version the table reached, not the build constant', async () => {
    // Otherwise every Save after a rotation would put the table straight back
    // into the split state the rotation just resolved.
    await storeTwo();
    await rotateCredentialKeys(rotatedEnv());
    await putCredential(newKeyOnly(), {
      provider: 'bing-webmaster',
      fields: { BING_WEBMASTER_API_KEY: BING_SECRET },
    });
    expect((await row('bing-webmaster'))!.key_version).toBe(2);
    const summary = await credentialSummary(newKeyOnly(), 'bing-webmaster');
    expect(summary?.keyVersion).toBe(2);
  });

  it('answers an empty store honestly, and reports nothing but counts and provider ids', async () => {
    expect(await rotateCredentialKeys(rotatedEnv())).toMatchObject({
      ok: true,
      rows: 0,
      rotated: 0,
      keyVersion: null,
    });

    await storeTwo();
    const result = await rotateCredentialKeys(rotatedEnv());
    const printed = JSON.stringify(result);
    // The one rule, asserted from this angle too: nothing a rotation reports
    // has ever been a credential or a key.
    expect(printed).not.toContain(BING_SECRET);
    expect(printed).not.toContain(DFS_PASSWORD);
    expect(printed).not.toContain(NEW_KEY);
    expect(printed).not.toContain((env as unknown as Record<string, string>).CREDENTIALS_KEY);
  });

  it('refuses a previous key that is set but unusable, naming the binding', async () => {
    await storeTwo();
    const bad = await rotateCredentialKeys({
      ...env,
      CREDENTIALS_KEY: NEW_KEY,
      [PREVIOUS_KEY_BINDING]: 'not-a-key',
    } as unknown as IngestEnv);
    expect(bad.ok).toBe(false);
    expect(bad.refusal).toBe('key-invalid');
    expect(bad.reason).toBe('Encryption key unusable · CREDENTIALS_KEY_PREVIOUS · not base64 · openssl rand -base64 32');
  });
});

describe('on Postgres, a secret leaves in no statement, log line, answer or error', () => {
  const MEDIAVINE_PASSWORD = 'SEKRIT-mediavine-5c0e-do-not-echo';
  const SESSION = 'SEKRIT-mediavine-session-81d2-do-not-echo';
  const NEXT_KEY = btoa(String.fromCharCode(...new Array(32).fill(0).map((_, i) => (i * 13 + 1) % 256)));

  /** Every secret this block writes, and the keys that seal them. */
  const SECRETS = [BING_SECRET, MEDIAVINE_PASSWORD, SESSION, NEXT_KEY];

  /** Every text Postgres keeps of a statement this database ran (its query
   * statistics, pg_stat_statements): what an operator with statistics access
   * reads. A value sent as a parameter is not in it; a literal would be. */
  async function statementTexts(): Promise<string[]> {
    const rows = await env.STORE.read((tx) =>
      tx.query<{ query: string }>(
        `SELECT query FROM public.pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())`,
      ),
    );
    return rows.map((row) => row.query);
  }

  it('keeps no secret and no sealed byte in the statements Postgres records, the answers or the log', async () => {
    // Loaded at the server's start where the build has it (CI's does,
    // scripts/postgres-dev.mjs); the copy needs the view.
    await asOwner('CREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
    const sealed: Uint8Array[] = [];
    const keep = async (provider: string) => {
      const stored = (await row(provider))!;
      sealed.push(stored.ciphertext, stored.iv);
    };
    const rotated = {
      ...env,
      CREDENTIALS_KEY: NEXT_KEY,
      [PREVIOUS_KEY_BINDING]: (env as unknown as Record<string, string>).CREDENTIALS_KEY,
    } as unknown as IngestEnv;

    const { result: answered, lines } = await withCapturedLogs(async () => {
      // Connect, test, date, rotate the key, renew a session, read, disconnect:
      // every statement the store runs on a secret.
      await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } });
      await keep('bing-webmaster');
      await probeCredential(env, 'bing-webmaster', {
        nowMs: NOW,
        fetchImpl: (async () => Response.json({ d: [] })) as typeof fetch,
      });
      await setCredentialExpiry(env, { provider: 'bing-webmaster', expiresAt: '2026-10-04T00:00:00.000Z' });
      await putCredential(env, {
        provider: 'mediavine',
        fields: { MEDIAVINE_USER: 'op@example.test', MEDIAVINE_PASSWORD },
      });
      await keep('mediavine');
      expect(await rotateCredentialKeys(rotated)).toMatchObject({ ok: true, rotated: 2 });
      await keep('bing-webmaster');
      await saveMediavineSession(rotated, SESSION);
      await keep('mediavine');
      expect((await resolveCredential(rotated, 'mediavine')).fields.MEDIAVINE_SESSION).toBe(SESSION);
      // No key opens a secret twice: the rotation and the session save each
      // wrote the next version and removed the one before.
      expect(await storedSecretCount()).toBe(2);
      const answers = JSON.stringify([await listCredentialSummaries(rotated), await credentialSummary(rotated, 'mediavine')]);
      await deleteCredential(env, 'mediavine');
      return answers;
    });

    const texts = await statementTexts();
    // Not vacuous: the statements that carried a secret are there, by text.
    expect(texts.some((text) => text.includes('INSERT INTO noticeos.connection_secrets'))).toBe(true);
    expect(texts.some((text) => text.includes('noticeos.integration_connections'))).toBe(true);

    const forbidden = [...SECRETS, ...sealed.flatMap(byteForms)];
    for (const text of [...texts, ...lines, answered]) {
      for (const secret of forbidden) expect(text).not.toContain(secret);
    }
  });

  /** Every text an error carries, its causes' included: what a log line or
   * an answer built from it could ever show. */
  function errorTexts(error: unknown): string {
    const texts: string[] = [];
    for (let at = error, depth = 0; at !== null && typeof at === 'object' && depth < 5; depth += 1) {
      for (const name of Object.getOwnPropertyNames(at)) texts.push(String((at as Record<string, unknown>)[name]));
      at = (at as { cause?: unknown }).cause;
    }
    return texts.join('\n');
  }

  it('refuses a write of a secret with an error that holds no row: row security withholds it', async () => {
    // Postgres puts a refused row's values in its error ("Failing row
    // contains …") — except on a table with row security, which every
    // noticeos table has (0001_baseline.sql). This holds the store to it.
    await putCredential(env, { provider: 'bing-webmaster', fields: { BING_WEBMASTER_API_KEY: BING_SECRET } });
    const before = (await row('bing-webmaster'))!;
    // Every new secret refused, by a rule the owner adds to this copy alone.
    await asOwner(
      'ALTER TABLE noticeos.connection_secrets ADD CONSTRAINT refuse_every_secret CHECK (key_version < 0) NOT VALID;',
    );
    try {
      // Known bytes, written directly, so the check below knows what to hunt.
      const marker = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x5e, 0xc2, 0xe7, 0x01]);
      const direct = await env.STORE.write((tx) =>
        tx.execute(
          `INSERT INTO noticeos.connection_secrets
             (workspace_id, connection_id, secret_version, ciphertext, iv, key_version, field_names, created_at)
           SELECT workspace_id, connection_id, 99, $2, $3, 1, '["BING_WEBMASTER_API_KEY"]', now()
             FROM noticeos.integration_connections WHERE provider = $1`,
          [before.provider, marker, new Uint8Array(12)],
        ),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      // The store's own write of a new secret, refused the same way.
      const saved = await putCredential(env, {
        provider: 'bing-webmaster',
        fields: { BING_WEBMASTER_API_KEY: `${BING_SECRET}-2` },
      }).then(
        () => null,
        (error: unknown) => error,
      );

      for (const refused of [direct, saved]) {
        const texts = errorTexts(refused);
        // It says which rule refused it, and nothing of the row.
        expect(texts).toContain('refuse_every_secret');
        expect(texts).not.toContain('Failing row');
        expect(texts).not.toContain(BING_SECRET);
        for (const form of byteForms(marker)) expect(texts).not.toContain(form);
        expect(texts).not.toMatch(/\\x[0-9a-f]{16}/u);
      }
      // The transaction kept nothing: the old secret stands, and still opens.
      expect((await row('bing-webmaster'))!.secret_version).toBe(before.secret_version);
      expect((await resolveCredential(env, 'bing-webmaster')).fields.BING_WEBMASTER_API_KEY).toBe(BING_SECRET);
    } finally {
      await asOwner('ALTER TABLE noticeos.connection_secrets DROP CONSTRAINT refuse_every_secret;');
    }
  });
});
