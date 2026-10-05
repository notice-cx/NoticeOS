import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IngestWorker from '../src/index.js';
import { connectCredential } from '../src/credential-connect.js';
import { selectD1Databases } from '../src/cloudflare-d1.js';
import { reset } from './helpers.js';

const accountId = 'a'.repeat(32), databaseId = '11111111-1111-4111-8111-111111111111';
const path = '/api/backup/cloudflare-d1';
let token: string;
beforeEach(async () => { await reset(); token = crypto.randomUUID(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request = (suffix = '', init: RequestInit = {}) => {
  const headers = new Headers({ authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return new Request('http://localhost' + path + suffix, { ...init, headers });
};
const worker = () => new IngestWorker(createExecutionContext(), { ...env, OPERATOR_TOKEN: token });
it('unauthenticated, browser, hosted and demo backup calls refuse before SQL or provider access', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('No provider contact'); }); vi.stubGlobal('fetch', fetchImpl);
  const postgres: Hyperdrive = { connectionString: 'postgresql://invalid@localhost:1/invalid',
    host: 'localhost', port: 1, user: 'invalid', password: '', database: 'invalid',
    connect() { throw new Error('No database contact'); } };
  const invalid = (profile: 'standalone' | 'hosted' | 'demo') => Object.defineProperty({
    ...env, OPERATOR_TOKEN: token, POSTGRES: postgres, NOTICEOS_WORKSPACE_PROFILE: profile,
  }, 'STORE', { get() { throw new Error('No SQL store access'); } });
  const local = new IngestWorker(createExecutionContext(), invalid('standalone'));
  expect((await local.backupCloudflareD1(request('', { headers: { authorization: 'Bearer rejected' } }))).status).toBe(403);
  expect((await local.backupCloudflareD1(request('', { headers: { origin: 'http://localhost' } }))).status).toBe(403);
  for (const profile of ['hosted', 'demo'] as const) {
    const other = new IngestWorker(createExecutionContext(), invalid(profile));
    expect((await other.backupCloudflareD1(request())).status).toBe(403);
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('the machine path cannot list provider inventory, change selection, or add authority selectors', async () => {
  const native = worker();
  for (const original of [request('?view=databases'), request('?workspaceId=' + crypto.randomUUID()),
    request('', { method: 'PUT', body: JSON.stringify({ version: 1, accountId, targets: [] }) }),
    request('', { method: 'POST', body: JSON.stringify({ accountId, databaseId, url: 'https://other.example' }) }),
    new Request('http://localhost/api/other', { headers: { authorization: `Bearer ${token}` } })]) {
    expect((await native.backupCloudflareD1(original)).status).toBe(400);
  }
});
it('the authenticated saved-target path returns no provider secrets, exports and streams exact private SQL', async () => {
  const asset = (await env.STORE.read(tx => tx.query<{ asset_id: string }>('SELECT asset_id FROM noticeos.assets ORDER BY asset_id LIMIT 1')))[0]!.asset_id;
  const providerToken = crypto.randomUUID();
  const fields = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: providerToken };
  const list: typeof fetch = async () => Response.json({ success: true, result: [{ uuid: databaseId, name: 'Fixture database' }] });
  await connectCredential(env, { provider: 'cloudflare', fields }, { fetchImpl: list });
  const selection = { version: 1 as const, accountId, targets: [{ databaseId, asset }] };
  await selectD1Databases(env, selection, { fetchImpl: list });
  const native = worker(); const status = await (await native.backupCloudflareD1(request())).json();
  expect(status).toMatchObject({ accountId, selection }); expect(JSON.stringify(status)).not.toContain(providerToken);
  const download = `https://${'b'.repeat(32)}.r2.cloudflarestorage.com/fixture.sql`;
  const sql = 'CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(19);';
  vi.stubGlobal('fetch', (async (url, init) => {
    if (String(url) === download) { expect(new Headers(init?.headers).has('authorization')).toBe(false); return new Response(sql); }
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${providerToken}`);
    return Response.json({ success: true, result: { type: 'export', status: 'complete', success: true, result: { signed_url: download } } });
  }) as typeof fetch);
  const exported = await (await native.backupCloudflareD1(request('', { method: 'POST', body: JSON.stringify({ accountId, databaseId }) }))).json() as { state: string; runId: string; sha256: string };
  expect(exported.state).toBe('complete');
  const response = await native.backupCloudflareD1(request(`?view=artifact&accountId=${accountId}&databaseId=${databaseId}&runId=${exported.runId}`));
  expect(response.headers.get('x-noticeos-sha256')).toBe(exported.sha256);
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(sql);
});
