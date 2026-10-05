import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { connectCredential } from '../src/credential-connect.js';
import { assertCredentialOwner, credentialSummary, resolveCredential } from '../src/credentials.js';
import { probeCredential } from '../src/credential-probes.js';
import { CloudflareD1Error, listD1Databases } from '../src/cloudflare-d1-client.js';
import { storedCredential, forgetCredentials, reset } from './helpers.js';

const ACCOUNT = 'a'.repeat(32);
const DATABASE = '11111111-1111-4111-8111-111111111111';
const token = () => crypto.randomUUID();
const fields = (value: string) => ({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: value });
beforeEach(async () => { await reset(); });
afterEach(async () => { await forgetCredentials(); });

function listing(value: string): typeof fetch {
  return (async (input, init) => {
    expect(String(input)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?page=1&per_page=100`);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${value}`);
    return Response.json({ success: true, result: [{ uuid: DATABASE, name: 'Example database' }], result_info: { page: 1, per_page: 100, count: 1, total_count: 1 } });
  }) as typeof fetch;
}

it('connects the specified account, stores ciphertext and returns only accepted access facts', async () => {
  const value = token();
  const connected = await connectCredential(env, { provider: 'cloudflare', fields: fields(value) }, { fetchImpl: listing(value) });
  expect(connected).toMatchObject({ ok: true, verdict: 'accepted', facts: { databases: 1 } });
  expect(JSON.stringify(connected)).not.toContain(value);
  expect((await resolveCredential(env, 'cloudflare', 'store-only')).fields).toEqual(fields(value));
  const row = await storedCredential('cloudflare');
  expect(row).not.toBeNull();
  expect(new TextDecoder().decode(row!.ciphertext)).not.toContain(value);
  expect(JSON.stringify(await credentialSummary(env, 'cloudflare'))).not.toContain(value);
});

it('keeps the working token when its replacement is refused', async () => {
  const original = token(); const replacement = token();
  await connectCredential(env, { provider: 'cloudflare', fields: fields(original) }, { fetchImpl: listing(original) });
  const result = await connectCredential(env, { provider: 'cloudflare', fields: fields(replacement) }, {
    fetchImpl: (async () => Response.json({ errors: [{ message: replacement }] }, { status: 403 })) as typeof fetch,
  });
  expect(result).toMatchObject({ ok: true, verdict: 'refused' });
  expect((await resolveCredential(env, 'cloudflare')).fields.CLOUDFLARE_API_TOKEN).toBe(original);
  expect(JSON.stringify(result)).not.toContain(replacement);
});

it('reports a provider transport failure without storing or exposing its error', async () => {
  const value = token();
  const result = await connectCredential(env, { provider: 'cloudflare', fields: fields(value) }, {
    fetchImpl: (async () => { throw new Error(value); }) as typeof fetch,
  });
  expect(result).toMatchObject({ ok: true, verdict: 'unreachable' });
  expect((await resolveCredential(env, 'cloudflare')).source).toBe('none');
  expect(JSON.stringify(result)).not.toContain(value);
});

it('checks account access without starting an export', async () => {
  const value = token();
  await connectCredential(env, { provider: 'cloudflare', fields: fields(value) }, { fetchImpl: listing(value) });
  expect(await probeCredential(env, 'cloudflare', { fetchImpl: listing(value) })).toMatchObject({ ok: true, result: { outcome: 'answered', facts: { databases: 1 } }, message: 'Answered · 1 database' });
});

it('reads every declared page and refuses inconsistent pagination instead of accepting partial coverage', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ uuid: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`, name: `Database ${i}` }));
  let calls = 0;
  const listed = await listD1Databases(fields(token()), (async input => {
    const page = Number(new URL(String(input)).searchParams.get('page')); calls++;
    const result = rows.slice((page - 1) * 100, page * 100);
    return Response.json({ success: true, result, result_info: { page, per_page: 100, count: result.length, total_count: rows.length } });
  }) as typeof fetch);
  expect(listed).toHaveLength(101); expect(calls).toBe(2);
  for (const result_info of [
    { page: 1, per_page: 100, count: 1, total_count: 200 },
    { page: 2, per_page: 100, count: 1, total_count: 1 },
    { page: 1, per_page: 10, count: 1, total_count: 1 },
    { page: 1, per_page: 100, count: 2, total_count: 1 },
    { page: 1, per_page: 100, count: 1, total_count: 1001 },
  ]) {
    await expect(listD1Databases(fields(token()), (async () => Response.json({ success: true, result: rows.slice(0, 1), result_info })) as typeof fetch)).rejects.toBeInstanceOf(CloudflareD1Error);
  }
});

it('refuses a credential owned by another workspace before provider I/O', async () => {
  const value = token();
  await connectCredential(env, { provider: 'cloudflare', fields: fields(value) }, { fetchImpl: listing(value) });
  const held = await resolveCredential(env, 'cloudflare');
  await expect(assertCredentialOwner(env, { ...held, workspaceId: crypto.randomUUID() }, 'cloudflare')).rejects.toThrow();
});

it('refuses account path injection before a network request', async () => {
  let calls = 0;
  await expect(listD1Databases({ ...fields(token()), CLOUDFLARE_ACCOUNT_ID: '../other' }, (async () => { calls++; return new Response(); }) as typeof fetch)).rejects.toBeInstanceOf(CloudflareD1Error);
  expect(calls).toBe(0);
});

it('refuses malformed, duplicate and incomplete provider inventories', async () => {
  for (const result of [[{ uuid: '../other', name: 'Invalid' }], [{ uuid: DATABASE, name: 'One' }, { uuid: DATABASE, name: 'Duplicate' }]]) {
    await expect(listD1Databases(fields(token()), (async () => Response.json({ success: true, result })) as typeof fetch)).rejects.toBeInstanceOf(CloudflareD1Error);
  }
  await expect(listD1Databases(fields(token()), (async () => Response.json({ success: true, result: [], result_info: { total_pages: 11 } })) as typeof fetch)).rejects.toMatchObject({ code: 'too_large' });
});
