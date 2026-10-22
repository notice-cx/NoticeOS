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
const because = (reason, secret) => error => error.message.includes(`(${reason})`) && (secret === undefined || !error.message.includes(secret));
/** The app's backup route over real HTTP. `declaresLength: false` sends the SQL
 * chunked, as the Workers runtime does for a stored object relayed to the Tower. */
async function appFixture(t, { declaresLength }) {
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
      response.setHeader('content-type', 'application/sql'); response.setHeader('x-noticeos-sha256', saved.sha256);
      if (declaresLength) { response.setHeader('content-length', saved.bytes); response.end(sql); }
      else { response.write(sql.slice(0, 10)); response.end(sql.slice(10)); }
    } else response.end(JSON.stringify(status()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const native = createCloudflareD1BackupClient({ repoRoot: root, env: { OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: String(server.address().port) } });
  return { root, token, native, calls };
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
  const { root, token, native, calls } = await appFixture(t, { declaresLength: true });
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
test('a chunked SQL download without content-length is verified against its receipt and kept', async t => {
  const { root, native } = await appFixture(t, { declaresLength: false });
  const output = path.join(root, 'output');
  const custody = await copyCloudflareD1({ client: native, selection, target, output });
  assert.equal(gunzipSync(await fs.readFile(path.join(output, 'export.sql.gz'))).toString(), sql);
  assert.equal(custody.receipt.bytes, Buffer.byteLength(sql));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'receipt.json'), 'utf8')), custody);
});
test('only an explicitly disconnected connection skips; unknown, mismatched and unavailable inventory fail', async () => {
  assert.equal(await client(async () => Response.json({ error: 'not_connected' }, { status: 409 })).inventory(), null);
  for (const value of [null, {}, { ...status(), accountMismatch: true }, { ...status(), selection: { ...selection, accountId: 'b'.repeat(32) } }, { error: 'unreadable_connection' }]) {
    await assert.rejects(client(async () => Response.json(value)).inventory(), /Cloudflare D1 backup unavailable/);
  }
  const token = randomUUID();
  await assert.rejects(client(async () => { throw new Error(token); }).inventory(), error => !error.message.includes(token));
});
test('an unavailable inventory names its cause without forwarding response or error text', async () => {
  const secret = randomUUID();
  const cases = [
    [async () => new Response(`<html>${secret}</html>`, { status: 404 }), 'the app answered 404 without a selection'],
    [async () => Response.json({ error: 'unreadable_connection', detail: secret }, { status: 409 }), 'the app answered 409 unreadable_connection'],
    [async () => Response.json({ error: secret }, { status: 500 }), 'the app answered 500'],
    [async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(secret), { code: 'ECONNREFUSED' }) }); }, 'the app could not be reached: ECONNREFUSED'],
    [async () => Response.json({ ...status(), accountMismatch: true }), 'the saved selection names another Cloudflare account'],
    [async () => Response.json({ accountId: secret }), 'the app answered an unreadable selection'],
  ];
  for (const [fetchImpl, reason] of cases) {
    await assert.rejects(client(fetchImpl).inventory(), error => error.message.includes(`(${reason})`) && !error.message.includes(secret));
  }
  await assert.rejects(client(async () => assert.fail('no request'), { readBootstrap: () => { throw new Error(secret); } }).inventory(),
    error => error.message.includes('(the app access token could not be read)') && !error.message.includes(secret));
});
test('a refused or failed export names its cause without forwarding response text', async () => {
  const secret = randomUUID();
  const failed = { ...receipt(), state: 'failed', bytes: null, sha256: null, failure: 'access_denied' };
  const cases = [
    [async () => Response.json({ error: 'access_denied', detail: secret }, { status: 409 }), 'the export answered 409 access_denied'],
    [async () => new Response(secret, { status: 502 }), 'the export answered 502 without a receipt'],
    [async () => Response.json(failed), 'the export ended failed access_denied'],
    [async () => Response.json({ ...receipt(), asset: 'foreign.example' }), 'the export answered a receipt for another target'],
  ];
  for (const [fetchImpl, reason] of cases) {
    await assert.rejects(client(fetchImpl).exportTarget(selection, target), error => error.message.includes(`(${reason})`) && !error.message.includes(secret));
  }
  const output = path.join(os.tmpdir(), `native-d1-${randomUUID()}`);
  await assert.rejects(copyCloudflareD1({ client: client(async () => Response.json(failed)), selection, target, output }),
    error => error.message.includes('(the export ended failed access_denied)'));
  await assert.rejects(fs.stat(output), { code: 'ENOENT' });
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
test('each refused artifact download names its own cause without forwarding response or error text', async () => {
  const saved = receipt(), secret = randomUUID(), hash = { 'x-noticeos-sha256': saved.sha256 };
  const cases = [
    [async () => new Response(sql, { headers: { 'content-length': String(saved.bytes + 1), ...hash } }), 'the download length header differs from its receipt'],
    [async () => new Response(sql), 'the download hash header differs from its receipt'],
    [async () => new Response(sql, { headers: { 'x-noticeos-sha256': 'b'.repeat(64) } }), 'the download hash header differs from its receipt'],
    [async () => new Response(sql, { headers: { ...hash, 'content-encoding': 'gzip' } }), 'the download arrived encoded'],
    [async () => new Response(null, { status: 302, headers: hash }), 'the download answered 302'],
    [async () => Response.json({ error: 'artifact_unavailable', detail: secret }, { status: 409 }), 'the download answered 409'],
    [async () => new Response(null, { headers: hash }), 'the download had no body'],
    [async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) }); }, 'the app could not be reached: ECONNRESET'],
  ];
  for (const [fetchImpl, reason] of cases) await assert.rejects(client(fetchImpl).artifact(saved), because(reason, secret));
  await assert.rejects(client(async () => assert.fail('no request')).artifact({ ...saved, state: 'failed' }), because('the receipt is not complete'));
});
test('each refused SQL copy names its own cause and leaves no receipt', async t => {
  const root = await fixture(t), saved = receipt(), secret = randomUUID();
  const cases = [
    [async () => new Response(sql.replace('7', '8')), 'the download hash differs from its receipt'],
    [async () => new Response(sql.slice(0, -1)), 'the download is shorter than its receipt'],
    [async () => new Response(`${sql} `), 'the download is longer than its receipt'],
    [async () => new Response(''), 'the download was empty'],
    [async () => new Response(null), 'the download had no body'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } })), 'the copy failed'],
  ];
  for (const [index, [artifact, reason]] of cases.entries()) {
    const output = path.join(root, `case-${index}`);
    await assert.rejects(copyCloudflareD1({ client: { exportTarget: async () => saved, artifact }, selection, target, output }), because(reason, secret));
    await assert.rejects(fs.stat(path.join(output, 'receipt.json')), { code: 'ENOENT' });
  }
  const foreign = { exportTarget: async () => ({ ...saved, asset: 'foreign.example' }), artifact: async () => assert.fail('no download') };
  await assert.rejects(copyCloudflareD1({ client: foreign, selection, target, output: path.join(root, 'foreign') }),
    because('the export answered a receipt for another target'));
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
