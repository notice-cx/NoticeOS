import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createCloudflareD1BackupClient, copyCloudflareD1, cloudflareD1InventoryKey } from './cloudflare-d1-backup.mjs';

const accountId = 'a'.repeat(32), databaseId = '11111111-1111-4111-8111-111111111111';
const target = { databaseId, asset: 'example.com' };
const selection = { version: 1, accountId, targets: [target] };
const sql = 'CREATE TABLE fixture(id INTEGER); INSERT INTO fixture VALUES(7);';
const digest = value => createHash('sha256').update(value).digest('hex');
const receipt = () => ({ version: 1, accountId, databaseId, asset: target.asset, runId: randomUUID(),
  startedAt: '2026-10-05T00:00:00Z', finishedAt: '2026-10-05T00:00:01Z', state: 'complete', bytes: Buffer.byteLength(sql), sha256: digest(sql), failure: null });
const status = () => ({ accountId, selection, accountMismatch: false, receipts: [] });
function client(fetchImpl, options = {}) {
  return createCloudflareD1BackupClient({ repoRoot: '/synthetic/installation', env: {},
    readBootstrap: () => ({ OPERATOR_TOKEN: randomUUID() }), fetchImpl, ...options });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-d1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('only the selected loopback or fixed protected Compose service receives the bootstrap bearer', async () => {
  let reads = 0;
  for (const host of ['remote.example', 'user@localhost', 'localhost/path', 'localhost?destination=remote']) {
    assert.throws(() => client(async () => assert.fail('no transport'), { env: { OS_UP_INGEST_DOOR_HOST: host }, readBootstrap: () => { reads++; return {}; } }));
  }
  assert.equal(reads, 0);
  assert.throws(() => client(fetch, { transport: 'container' }));
  const token = randomUUID();
  const native = client(async (url, init) => {
    assert.equal(url, 'http://noticeos:5173/api/backup/cloudflare-d1');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.origin, undefined);
    return Response.json(status());
  }, { repoRoot: '/state', transport: 'container', readBootstrap: file => { assert.equal(file, '/state/workers/ingest/.dev.secrets.json'); return { OPERATOR_TOKEN: token }; } });
  assert.deepEqual(await native.inventory(), selection);
});
test('an owned HTTP fixture streams hashed gzip with recoverable SQL and exact private custody', async t => {
  const root = await fixture(t), token = randomUUID(), saved = receipt(); const calls = [];
  const secrets = path.join(root, 'workers/ingest/.dev.secrets.json');
  await fs.mkdir(path.dirname(secrets), { recursive: true }); await fs.writeFile(secrets, JSON.stringify({ OPERATOR_TOKEN: token }), { mode: 0o600 });
  const server = http.createServer(async (request, response) => {
    calls.push(request.url); assert.equal(request.headers.authorization, `Bearer ${token}`);
    const url = new URL(request.url, 'http://fixture'); assert.equal(url.pathname, '/api/backup/cloudflare-d1');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { accountId, databaseId }); response.end(JSON.stringify(saved));
    } else if (url.searchParams.get('view') === 'artifact') {
      assert.equal(url.searchParams.get('runId'), saved.runId);
      response.setHeader('content-type', 'application/sql'); response.setHeader('content-length', saved.bytes);
      response.setHeader('x-noticeos-sha256', saved.sha256); response.end(sql);
    } else response.end(JSON.stringify(status()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const native = createCloudflareD1BackupClient({ repoRoot: root, env: { OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: String(server.address().port) } });
  assert.deepEqual(await native.inventory(), selection);
  const output = path.join(root, 'output');
  const custody = await copyCloudflareD1({ client: native, selection, target, output });
  const gzip = await fs.readFile(path.join(output, 'export.sql.gz'));
  assert.equal(gunzipSync(gzip).toString(), sql); assert.equal(custody.gzip.sha256, digest(gzip)); assert.equal(custody.gzip.bytes, gzip.length);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'receipt.json'), 'utf8')), custody);
  assert.equal((await fs.stat(path.join(output, 'export.sql.gz'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(output, 'receipt.json'))).mode & 0o777, 0o600);
  assert.match(custody.restore.endpoint, new RegExp(`/accounts/${accountId}/d1/database/${databaseId}/import$`));
  assert.equal(JSON.stringify(custody).includes(token), false);
  const recovered = new DatabaseSync(':memory:');
  try { recovered.exec(gunzipSync(gzip).toString()); assert.equal(recovered.prepare('SELECT id FROM fixture').get().id, 7); }
  finally { recovered.close(); }
  assert.equal(calls.length, 3);
});
test('only an explicitly disconnected connection skips; unknown, mismatched and unavailable inventory fail', async () => {
  assert.equal(await client(async () => Response.json({ error: 'not_connected' }, { status: 409 })).inventory(), null);
  for (const value of [null, {}, { ...status(), accountMismatch: true }, { ...status(), selection: { ...selection, accountId: 'b'.repeat(32) } }, { error: 'unreadable_connection' }]) {
    await assert.rejects(client(async () => Response.json(value)).inventory(), /Cloudflare D1 backup unavailable/);
  }
  const token = randomUUID();
  await assert.rejects(client(async () => { throw new Error(token); }).inventory(), error => !error.message.includes(token));
});
test('missing or public bootstrap files fail without making a request', async t => {
  const root = await fixture(t); let calls = 0;
  const native = createCloudflareD1BackupClient({ repoRoot: root, env: {}, fetchImpl: async () => { calls++; return Response.json(status()); } });
  await assert.rejects(native.inventory());
  const file = path.join(root, 'workers/ingest/.dev.secrets.json');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ OPERATOR_TOKEN: randomUUID() }), { mode: 0o644 });
  await assert.rejects(native.inventory()); assert.equal(calls, 0);
});
test('foreign account, database, asset or malformed export receipts are refused before artifact requests', async () => {
  for (const patch of [{ accountId: 'b'.repeat(32) }, { databaseId: randomUUID() }, { asset: 'foreign.example' }, { runId: '../run' }, { bytes: 0 }, { signed_url: 'https://remote.example' }]) {
    const native = client(async () => Response.json({ ...receipt(), ...patch }));
    await assert.rejects(native.exportTarget(selection, target));
  }
});
test('artifact redirects, changed headers, encoded bodies and wrong actual hashes cannot complete a gzip item', async t => {
  const root = await fixture(t), saved = receipt();
  for (const headers of [{}, { 'content-length': String(saved.bytes), 'x-noticeos-sha256': 'b'.repeat(64) },
    { 'content-length': String(saved.bytes), 'x-noticeos-sha256': saved.sha256, 'content-encoding': 'gzip' }]) {
    await assert.rejects(client(async () => new Response(sql, { headers })).artifact(saved));
  }
  await assert.rejects(client(async () => new Response(null, { status: 302 })).artifact(saved));
  const native = { exportTarget: async () => saved, artifact: async () => new Response(sql.replace('7', '8')) };
  await assert.rejects(copyCloudflareD1({ client: native, selection, target, output: path.join(root, 'wrong') }));
  await assert.rejects(fs.stat(path.join(root, 'wrong/receipt.json')), { code: 'ENOENT' });
});
test('JSON response limits and empty-stream limits terminate without forwarding error contents', async () => {
  await assert.rejects(client(async () => new Response('x'.repeat(1024 ** 2 + 1))).inventory());
  let chunks = 0;
  await assert.rejects(client(async () => new Response(new ReadableStream({ pull(controller) { chunks++; controller.enqueue(new Uint8Array()); } }))).inventory());
  assert.ok(chunks < 70);
});
test('a stalled SQL stream with stuck cancellation respects its deadline plus bounded cleanup', { timeout: 20_000 }, async t => {
  const root = await fixture(t), output = path.join(root, 'stalled');
  const saved = receipt(); let cancelled = false;
  const native = { exportTarget: async () => saved, artifact: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) };
  let opened; const io = { ...fs, open: async (...args) => { opened = await fs.open(...args); return opened; } };
  const started = performance.now();
  await assert.rejects(copyCloudflareD1({ client: native, selection, target, output, io, deadlineMs: 25 }));
  // The stuck cancel is given its 2 s bound and no more: a lower bound, and a
  // hang guard a loaded runner cannot fail (issue #12).
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1_990, `cleanup ended after ${elapsed} ms, before its bound`);
  assert.ok(elapsed < 10_000, `cleanup still waiting after ${elapsed} ms`);
  assert.equal(cancelled, true); assert.equal(opened.fd, -1);
  await assert.rejects(fs.stat(path.join(output, 'receipt.json')), { code: 'ENOENT' });
});
test('inventory comparison ignores ordering but catches changed assets and removed targets', () => {
  const other = { databaseId: randomUUID(), asset: 'other.example' };
  assert.equal(cloudflareD1InventoryKey({ ...selection, targets: [target, other] }), cloudflareD1InventoryKey({ ...selection, targets: [other, target] }));
  assert.notEqual(cloudflareD1InventoryKey(selection), cloudflareD1InventoryKey({ ...selection, targets: [] }));
  assert.notEqual(cloudflareD1InventoryKey(selection), cloudflareD1InventoryKey({ ...selection, targets: [{ ...target, asset: 'changed.example' }] }));
});
