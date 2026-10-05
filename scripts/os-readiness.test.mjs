import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { localDoorFetch } from './ingest-door.mjs';
import { runCommand } from './run-command.mjs';
import { inspectDependencies, probeDoltReadiness, probePostgresReadiness } from './os-readiness.mjs';

const profile = { project: 'noticeos-fixture', composeFile: '/owned/compose.yaml',
  secretsDir: '/owned/dolt/secrets', credentialsFile: '/owned/dolt/credentials', port: 6503 };
const plistFile = '/owned/service.plist';
const json = (body, status = 200) => Response.json(body, { status });
const pg = (fetchImpl) => probePostgresReadiness({ readToken: async () => 'fixture-bearer', fetchImpl });
function commands({ sql = { code: 0, stdout: '{"rows":[{"ready":1}]}' }, context = { code: 0, stdout: 'unix:///owned/docker.sock' }, selected = { code: 0, stdout: '/owned\n' } } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/plutil') return selected;
    if (args[0] === 'context') return context;
    return sql;
  };
  return { calls, run };
}
const dolt = (fake, overrides = {}) => probeDoltReadiness({ plistFile, run: fake.run,
  env: { PATH: '/owned/bin', HOME: '/owned/operator', NOTICEOS_DOLT_HOME: '/wrong/ambient' },
  readProfile: (home) => { assert.equal(home, '/owned'); return profile; }, ...overrides });

test('PostgreSQL readiness uses only the authenticated managed config GET, without bodies', async () => {
  const result = await pg(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8791/api/config-documents');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.authorization, 'Bearer fixture-bearer');
    assert.equal(options.body, undefined);
    return json({ ready: true, documents: [{ private: 'discarded response' }] });
  });
  assert.deepEqual(result, { state: 'ready' });
});

test('PostgreSQL refusal, malformed replies, and missing authorization never imply health or expose data', async () => {
  for (const [response, state] of [
    [json({ ready: true, detail: 'fixture credential' }, 500), 'unavailable'],
    [json({ ready: false }), 'unavailable'], [json({}), 'unavailable'],
    [new Response('fixture credential', { status: 503 }), 'unavailable'],
    [json({ detail: 'fixture credential' }, 401), 'unknown'],
  ]) assert.deepEqual(await pg(async () => response), { state });
  assert.deepEqual(await pg(async () => { throw new Error('fixture credential'); }), { state: 'unavailable' });
  assert.deepEqual(await probePostgresReadiness({ readToken: async () => { throw new Error('fixture credential'); },
    fetchImpl: async () => assert.fail('must not request without credentials') }), { state: 'unknown' });
});

test('PostgreSQL whole-read budget bounds missing token and response-body completion', async () => {
  assert.deepEqual(await probePostgresReadiness({ timeoutMs: 20,
    readToken: () => new Promise(() => {}), fetchImpl: () => assert.fail('no request after expiry') }), { state: 'timeout' });
  assert.deepEqual(await probePostgresReadiness({ timeoutMs: 20, readToken: async () => 'fixture-bearer',
    fetchImpl: async () => ({ status: 200, json: () => new Promise(() => {}) }) }), { state: 'timeout' });
});

test('actual owned loopback header/body stalls abort sockets, then a later read recovers', async () => {
  const sockets = new Set();
  let mode = 'headers';
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    if (mode === 'headers') return;
    if (mode === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
    response.end('{"ready":true}');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const fetchImpl = (_managedUrl, options) => localDoorFetch(`http://127.0.0.1:${server.address().port}/fixture`, options);
    for (const state of ['headers', 'body']) {
      mode = state;
      assert.deepEqual(await probePostgresReadiness({ fetchImpl, readToken: async () => 'fixture-bearer', timeoutMs: 50 }), { state: 'timeout' });
    }
    mode = 'ready';
    assert.deepEqual(await probePostgresReadiness({ fetchImpl, readToken: async () => 'fixture-bearer', timeoutMs: 500 }), { state: 'ready' });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(server.listening, false);
});

test('Dolt readiness resolves the installed selector and performs exactly one unprivileged SELECT', async () => {
  const fake = commands();
  assert.deepEqual(await dolt(fake), { state: 'ready' });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls[0].args, ['-extract', 'EnvironmentVariables.NOTICEOS_DOLT_HOME', 'raw', '-expect', 'string', '-o', '-', plistFile]);
  assert.deepEqual(fake.calls[2].args.slice(0, 12), ['compose', '-p', profile.project, '-f', profile.composeFile, '--env-file', os.devNull,
    'exec', '--no-TTY', 'dolt', '/usr/bin/timeout', '--kill-after=0.05s']);
  const sqlMs = Number(fake.calls[2].args[12].slice(0, -1)) * 1000;
  assert.ok(sqlMs > 0 && sqlMs <= 1_900);
  assert.ok(sqlMs + 50 < fake.calls[2].options.timeoutMs, 'forced kill fits inside the caller budget');
  assert.deepEqual(fake.calls[2].args.slice(13), ['/bin/bash', '/etc/noticeos/sql.sh', 'noticeos', 'SELECT 1 AS ready']);
  assert.equal(fake.calls[2].options.env.DOCKER_HOST, 'unix:///owned/docker.sock');
  assert.equal(fake.calls[2].options.env.NOTICEOS_DOLT_HOME, undefined);
  for (const call of fake.calls) assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 2_000);
  assert.ok(fake.calls[0].options.timeoutMs >= fake.calls[1].options.timeoutMs);
  assert.ok(fake.calls[1].options.timeoutMs >= fake.calls[2].options.timeoutMs, 'nested transports do not reset the budget');
});

test('Dolt accepts numeric or string one, without coercing other readiness values', async () => {
  for (const value of [1, '1']) {
    assert.deepEqual(await dolt(commands({ sql: { code: 0, stdout: JSON.stringify({ rows: [{ ready: value }] }) } })), { state: 'ready' });
  }
  for (const rows of [[{ ready: 0 }], [{ ready: '0' }], [{ ready: true }], [{ ready: '01' }],
    [{ ready: '1 ' }], [{ ready: null }], [{ ready: 1 }, { ready: 1 }], [], { 0: { ready: 1 }, length: 1 }]) {
    assert.deepEqual(await dolt(commands({ sql: { code: 0, stdout: JSON.stringify({ rows }) } })), { state: 'unavailable' });
  }
});

test('Dolt missing or unsafe declaration refuses before Docker; transport/SQL failures remain unavailable', async () => {
  for (const selected of [{ code: 1, stdout: 'fixture private text' }, { code: 0, stdout: 'relative' },
    { code: 0, stdout: '/owned\n/second\n' }]) {
    const fake = commands({ selected });
    assert.deepEqual(await dolt(fake), { state: 'unknown' });
    assert.equal(fake.calls.length, 1);
  }
  const missing = commands();
  assert.deepEqual(await dolt(missing, { readProfile: () => null }), { state: 'unknown' });
  assert.equal(missing.calls.length, 1);
  const remote = commands({ context: { code: 0, stdout: 'ssh://foreign.example' } });
  assert.deepEqual(await dolt(remote), { state: 'unavailable' });
  assert.equal(remote.calls.length, 2);
  for (const sql of [{ code: 1, stdout: '', stderr: 'fixture private text' }, { code: 0, stdout: 'not JSON' },
    { code: 0, stdout: '{"rows":[{"ready":0}]}' }, { code: 0, stdout: '{"rows":[]}' }]) {
    assert.deepEqual(await dolt(commands({ sql })), { state: 'unavailable' });
  }
});

test('Dolt command timeout is explicit and recovery uses a fresh read', async () => {
  for (const code of [124, 137]) {
    const fake = commands({ sql: { code, stderr: 'private timeout' } });
    assert.deepEqual(await dolt(fake), { state: 'timeout' });
  }
  assert.deepEqual(await dolt(commands()), { state: 'ready' });
});

test('installed plist extraction is typed, read-only, and decodes the declared path', {
  skip: process.platform !== 'darwin' ? 'managed launchd status is macOS-specific' : false,
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'noticeos-readiness-plist-'));
  const file = path.join(home, 'service.plist');
  const bytes = '<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict>'
    + '<key>NOTICEOS_DOLT_HOME</key><string>/owned/Tasks &amp; Work</string></dict></dict></plist>';
  await writeFile(file, bytes);
  const fake = commands();
  try {
    const result = await probeDoltReadiness({ plistFile: file,
      env: { PATH: '/usr/bin:/bin', HOME: home },
      readProfile: (selected) => { assert.equal(selected, '/owned/Tasks & Work'); return profile; },
      run: (command, args, options) => command === '/usr/bin/plutil'
        ? runCommand(command, args, options) : fake.run(command, args, options),
    });
    assert.deepEqual(result, { state: 'ready' });
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.equal(fake.calls.length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Dolt setup and query consume one shared deadline, with actual child cleanup', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'noticeos-readiness-'));
  let childResult;
  let profileRead = false;
  try {
    const result = await probeDoltReadiness({ plistFile, timeoutMs: 80,
      readProfile: () => { profileRead = true; return profile; },
      run: async (_command, _args, options) => {
        childResult = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          ...options, cwd: home, env: { PATH: path.dirname(process.execPath), HOME: home,
            ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) },
        });
        return childResult;
      },
    });
    assert.deepEqual(result, { state: 'timeout' });
    assert.equal(childResult.timedOut, true);
    assert.equal(profileRead, false, 'expiry prevents further setup or SQL');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('dependency reads are parallel and independently retain partial failure', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fake = commands();
  const run = async (...args) => { release(); return fake.run(...args); };
  const result = await inspectDependencies({
    postgres: { readToken: async () => { await pending; return 'fixture-bearer'; }, fetchImpl: async () => json({ ready: false }) },
    dolt: { plistFile, run, readProfile: () => profile, env: {} },
  });
  assert.deepEqual(result, { postgres: { state: 'unavailable' }, dolt: { state: 'ready' } });
});
