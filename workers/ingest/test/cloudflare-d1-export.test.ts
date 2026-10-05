import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openWorkspaceStore } from '@noticeos/postgres';
import { CLOUDFLARE_D1_TARGETS } from '@noticeos/contract/cloudflare-d1';
import { connectCredential } from '../src/credential-connect.js';
import { credentialSummary, deleteCredential, putCredential, resolveCredential, saveCloudflareSelection } from '../src/credentials.js';
import { d1Artifact, d1Status, exportD1Database, selectD1Databases, d1DownloadUrl } from '../src/cloudflare-d1.js';
import IngestWorker from '../src/index.js';
import { d1Bounded, d1Api } from '../src/cloudflare-d1-client.js';
import { asOwner, reset } from './helpers.js';

const ACCOUNT = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const DATABASE = '11111111-1111-4111-8111-111111111111';
const DOWNLOAD = `https://${OTHER}.r2.cloudflarestorage.com/fixture.sql?signature=synthetic-only`;
const SQL = 'CREATE TABLE fixture (id INTEGER);\nINSERT INTO fixture VALUES (7);\n';
let asset: string; let token: string;
const listing = () => Response.json({ success: true, result: [{ uuid: DATABASE, name: 'Fixture database' }] });
const complete = (url = DOWNLOAD) => Response.json({ success: true, result: { type: 'export', status: 'complete', success: true, result: { signed_url: url } } });
const fields = (account = ACCOUNT) => ({ CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token });
const selection = () => ({ version: 1 as const, accountId: ACCOUNT, targets: [{ databaseId: DATABASE, asset }] });
const listed: typeof fetch = async () => listing();
beforeEach(async () => {
  await reset(); token = crypto.randomUUID();
  asset = (await env.STORE.read(tx => tx.query<{ asset_id: string }>('SELECT asset_id FROM noticeos.assets ORDER BY asset_id LIMIT 1')))[0]!.asset_id;
});
afterEach(() => vi.restoreAllMocks());
async function connected() {
  expect(await connectCredential(env, { provider: 'cloudflare', fields: fields() }, { fetchImpl: listed })).toMatchObject({ verdict: 'accepted' });
  await selectD1Databases(env, selection(), { fetchImpl: listed });
}
function exporting(): typeof fetch {
  return (async (input, init) => {
    if (String(input) === DOWNLOAD) {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
      return new Response(SQL);
    }
    expect(String(input)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe('error');
    return complete();
  }) as typeof fetch;
}
it('requires explicit listed database and known asset selection, carrying it through token replacement', async () => {
  await connected();
  expect((await credentialSummary(env, 'cloudflare'))?.assetsHeld).toEqual([asset]);
  expect((await d1Status(env)).selection).toEqual(selection());
  token = crypto.randomUUID();
  await connectCredential(env, { provider: 'cloudflare', fields: fields() }, { fetchImpl: listed });
  expect((await d1Status(env)).selection).toEqual(selection());
  await expect(selectD1Databases(env, { ...selection(), targets: [{ databaseId: DATABASE, asset: 'unknown.example' }] }, { fetchImpl: listed })).rejects.toMatchObject({ code: 'invalid_selection' });
  await expect(selectD1Databases(env, { ...selection(), targets: [{ databaseId: crypto.randomUUID(), asset }] }, { fetchImpl: listed })).rejects.toMatchObject({ code: 'invalid_selection' });
});
it('refuses client-supplied managed selection before provider I/O', async () => {
  const fetchImpl = vi.fn(listed);
  expect(await connectCredential(env, { provider: 'cloudflare', fields: { ...fields(), [CLOUDFLARE_D1_TARGETS]: JSON.stringify(selection()) } }, { fetchImpl })).toMatchObject({ ok: false, error: 'validation' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('preserves old selections on account rotation and refuses them before export I/O', async () => {
  await connected();
  await connectCredential(env, { provider: 'cloudflare', fields: fields(OTHER) }, { fetchImpl: listed });
  expect(await d1Status(env)).toMatchObject({ accountId: OTHER, selection: selection(), accountMismatch: true });
  const fetchImpl = vi.fn(exporting());
  await expect(exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl })).rejects.toMatchObject({ code: 'account_mismatch' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('does not overwrite selections captured before another save', async () => {
  await connected(); const held = await resolveCredential(env, 'cloudflare');
  await selectD1Databases(env, { ...selection(), targets: [] }, { fetchImpl: listed });
  expect(await saveCloudflareSelection(env, held, selection())).toBe(false);
  expect((await d1Status(env)).selection?.targets).toEqual([]);
});
it('polls with the original bookmark, downloads without bearer or redirects, and stores hashed SQL', async () => {
  await connected(); let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input) === DOWNLOAD) return exporting()(input, init);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(calls === 0 ? { output_format: 'polling' } : { output_format: 'polling', current_bookmark: 'fixture-bookmark' });
    calls++;
    return calls < 3 ? Response.json({ success: true, result: { status: 'active', type: 'export', at_bookmark: 'fixture-bookmark' } }) : complete();
  };
  const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl, pollMs: 0 });
  expect(result).toMatchObject({ state: 'complete', bytes: new TextEncoder().encode(SQL).byteLength, failure: null });
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(calls).toBe(3);
  expect(await (await d1Artifact(env, ACCOUNT, DATABASE, result.runId)).text()).toBe(SQL);
  expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain('signature');
  expect((await d1Status(env)).receipts[0]).toMatchObject({ latest: result, complete: result });
});
it('records sanitized failures and keeps the prior complete artifact', async () => {
  await connected(); const original = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: exporting() });
  const failed = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async () => Response.json({ errors: [{ message: token + DOWNLOAD }] }, { status: 403 }) });
  expect(failed).toMatchObject({ state: 'failed', failure: 'access_denied', bytes: null });
  const status = await d1Status(env);
  expect(status.receipts[0]).toMatchObject({ latest: failed, complete: original });
  expect(JSON.stringify(status)).not.toContain(token); expect(JSON.stringify(status)).not.toContain('signature');
  expect(await (await d1Artifact(env, ACCOUNT, DATABASE, original.runId)).text()).toBe(SQL);
  expect(await env.STORE.read(tx => tx.query('SELECT owner FROM noticeos.integration_leases WHERE expires_at > now()'))).toEqual([]);
});
it('bounds an API transport and streamed body that ignore abort', async () => {
  await connected();
  for (const fetchImpl of [
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch,
  ]) {
    const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl, deadlineMs: 20 });
    expect(result).toMatchObject({ state: 'failed', failure: 'timeout' });
  }
});
it('refuses an unending empty API stream without starving the deadline', async () => {
  await connected();
  let chunks = 0;
  const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array()); },
  })) });
  expect(result).toMatchObject({ state: 'failed', failure: 'invalid_response' });
  expect(chunks).toBeLessThan(70);
});
it('refuses a second run while the first owns the lease', async () => {
  await connected();
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async (input, init) => {
    if (String(input) !== DOWNLOAD) { entered(); await gate; }
    return exporting()(input, init);
  } });
  try {
    await ready;
    const fetchImpl = vi.fn(exporting());
    await expect(exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl })).rejects.toMatchObject({ code: 'already_running' });
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally { release(); expect((await first).state).toBe('complete'); }
});
it('stores multipart SQL with an exact hash and retains two completed artifacts', async () => {
  await connected();
  const bytes = new Uint8Array(8 * 1024 ** 2 + 137).fill(65);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const first = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async input => String(input) === DOWNLOAD ? new Response(bytes) : complete() });
  expect(first).toMatchObject({ state: 'complete', bytes: bytes.byteLength, sha256: digest });
  expect((await (await d1Artifact(env, ACCOUNT, DATABASE, first.runId)).arrayBuffer()).byteLength).toBe(bytes.byteLength);
  const second = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: exporting() });
  expect((await d1Artifact(env, ACCOUNT, DATABASE, first.runId)).status).toBe(200);
  const third = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: exporting() });
  expect(third.state).toBe('complete');
  await expect(d1Artifact(env, ACCOUNT, DATABASE, first.runId)).rejects.toMatchObject({ code: 'artifact_unavailable' });
  expect((await d1Artifact(env, ACCOUNT, DATABASE, second.runId)).status).toBe(200);
});
it('a stalled storage create times out without promoting a partial artifact', async () => {
  await connected();
  const bucket = new Proxy(env.RAW_SIGNALS, { get(target, key, receiver) {
    if (key === 'createMultipartUpload') return () => new Promise<R2MultipartUpload>(() => {});
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const result = await exportD1Database({ ...env, RAW_SIGNALS: bucket }, ACCOUNT, DATABASE, { fetchImpl: exporting(), deadlineMs: 50 });
  expect(result).toMatchObject({ state: 'failed', failure: 'timeout' });
  expect((await d1Status(env)).receipts[0]?.complete).toBeNull();
});
it('refuses changed bookmarks, unsafe download destinations, redirects and empty or oversized SQL', async () => {
  await connected();
  for (const url of ['http://localhost/export', 'https://127.0.0.1/export', 'https://other.example/export', `https://${OTHER}.r2.cloudflarestorage.com:444/export`, `https://user@${OTHER}.r2.cloudflarestorage.com/export`]) expect(() => d1DownloadUrl(url)).toThrow('unsafe_download');
  const unsafe = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async () => complete('https://localhost/export') });
  expect(unsafe.failure).toBe('unsafe_download');
  for (const body of ['', SQL]) {
    const result = await exportD1Database(env, ACCOUNT, DATABASE, { maxBytes: 10, fetchImpl: async input => String(input) === DOWNLOAD ? new Response(body) : complete() });
    expect(result).toMatchObject({ state: 'failed', failure: body ? 'too_large' : 'invalid_response' });
  }
  const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async input => String(input) === DOWNLOAD ? new Response(null, { status: 302, headers: { location: 'https://other.example' } }) : complete() });
  expect(result.failure).toBe('provider_unavailable');
});
it('refuses publication when the connection changes during an export', async () => {
  await connected();
  const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async (input, init) => {
    if (String(input) === DOWNLOAD) {
      await putCredential(env, { provider: 'cloudflare', fields: { ...fields(), CLOUDFLARE_API_TOKEN: crypto.randomUUID() } });
    }
    return exporting()(input, init);
  } });
  expect(result).toMatchObject({ state: 'failed', failure: 'connection_changed' });
  expect((await d1Status(env)).receipts[0]?.complete).toBeNull();
});
it('keeps another workspace unable to select, export or read private artifacts', async () => {
  await connected(); const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: exporting() });
  const workspaceId = crypto.randomUUID();
  await asOwner(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES('${workspaceId}','d1-fixture','D1 fixture')`);
  const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
  try {
    const other = { ...env, STORE: store };
    await expect(d1Artifact(other, ACCOUNT, DATABASE, result.runId)).rejects.toMatchObject({ code: 'not_connected' });
    await expect(exportD1Database(other, ACCOUNT, DATABASE, { fetchImpl: vi.fn(exporting()) })).rejects.toMatchObject({ code: 'not_connected' });
    await expect(saveCloudflareSelection(other, await resolveCredential(env, 'cloudflare'), selection())).rejects.toThrow('ownership');
  } finally {
    await store.close(); await asOwner(`DELETE FROM noticeos.workspaces WHERE workspace_id='${workspaceId}'`);
  }
});
it('demo receiver refuses inventory, selection, export and artifact reads before store or provider access', async () => {
  const origin = 'https://d1.example.test';
  const bindings = { ...env, NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_WORKSPACE_ORIGIN: origin,
    NOTICEOS_DEMO_WORKSPACE_ID: crypto.randomUUID(), NOTICEOS_IDENTITY_DATABASE_URL: 'postgresql://fixture@localhost/fixture',
    NOTICEOS_WORKSPACE_DATABASE_URL: 'postgresql://fixture@localhost/fixture', NOTICEOS_IDENTITY_SESSION_SECRET: crypto.randomUUID() };
  const worker = new IngestWorker(createExecutionContext(), bindings);
  for (const request of [
    new Request(origin + '/api/integrations/cloudflare/d1?view=databases'),
    new Request(origin + '/api/integrations/cloudflare/d1', { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(selection()) }),
    new Request(origin + '/api/integrations/cloudflare/d1', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ accountId: ACCOUNT, databaseId: DATABASE }) }),
    new Request(origin + `/api/integrations/cloudflare/d1?view=artifact&accountId=${ACCOUNT}&databaseId=${DATABASE}&runId=${crypto.randomUUID()}`),
  ]) await expect(worker.cloudflareD1(request)).rejects.toThrow('Workspace entry');
});

it('an unreadable receipt baseline is preserved before any provider or storage work', async () => {
  await connected(); const original = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: exporting() });
  const corrupt = JSON.stringify({ latest: original, complete: original, previous: 'corrupted-fixture' });
  await env.STORE.write(tx => tx.execute('UPDATE noticeos.integration_leases SET sites = $1::jsonb WHERE lease_key = $2', [corrupt, `cloudflare-d1:${ACCOUNT}:${DATABASE}`]));
  const fetchImpl = vi.fn(exporting());
  expect(await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl })).toMatchObject({ state: 'failed', failure: 'artifact_unavailable' });
  expect(fetchImpl).not.toHaveBeenCalled();
  const [saved] = await env.STORE.read(tx => tx.query<{ payload: string }>('SELECT sites::text AS payload FROM noticeos.integration_leases WHERE lease_key = $1', [`cloudflare-d1:${ACCOUNT}:${DATABASE}`]));
  expect(JSON.parse(saved!.payload)).toEqual(JSON.parse(corrupt));
});
it('disconnect and reconnect with the same fields never revive a captured connection', async () => {
  await connected(); const held = await resolveCredential(env, 'cloudflare');
  await deleteCredential(env, 'cloudflare'); await connected();
  expect((await resolveCredential(env, 'cloudflare')).connectionId).not.toBe(held.connectionId);
  expect(await saveCloudflareSelection(env, held, selection())).toBe(false);
  const result = await exportD1Database(env, ACCOUNT, DATABASE, { fetchImpl: async (input, init) => {
    if (String(input) === DOWNLOAD) { await deleteCredential(env, 'cloudflare'); await connected(); }
    return exporting()(input, init);
  } });
  expect(result).toMatchObject({ state: 'failed', failure: 'connection_changed' });
  expect((await d1Status(env)).receipts[0]?.complete).toBeNull();
});
it('a late multipart completion cannot publish after its deadline', async () => {
  await connected(); let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let late: Promise<R2Object> | undefined;
  const bucket = new Proxy(env.RAW_SIGNALS, { get(target, key, receiver) {
    if (key === 'createMultipartUpload') return async (...args: Parameters<R2Bucket['createMultipartUpload']>) => {
      const upload = await target.createMultipartUpload(...args);
      return { ...upload, key: upload.key, uploadId: upload.uploadId,
        uploadPart: upload.uploadPart.bind(upload), abort: upload.abort.bind(upload),
        complete: (parts: R2UploadedPart[]) => { entered(); late = gate.then(() => upload.complete(parts)); return late; },
      };
    };
    const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const run = exportD1Database({ ...env, RAW_SIGNALS: bucket }, ACCOUNT, DATABASE, { fetchImpl: exporting(), deadlineMs: 1000 });
  try {
    await ready; expect(await run).toMatchObject({ state: 'failed', failure: 'timeout' });
    expect((await d1Status(env)).receipts[0]?.complete).toBeNull();
  } finally { release(); await late?.catch(() => undefined); }
  expect((await d1Status(env)).receipts[0]?.complete).toBeNull();
});

it('already-cancelled bounds consume rejections and never start API transport', async () => {
  const signal = AbortSignal.abort(); const fetchImpl = vi.fn(exporting());
  await expect(d1Bounded(Promise.reject(new Error('synthetic transport rejection')), signal)).rejects.toMatchObject({ code: 'timeout' });
  await expect(d1Api(ACCOUNT, token, `/${DATABASE}/export`, { signal, fetchImpl })).rejects.toMatchObject({ code: 'timeout' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
