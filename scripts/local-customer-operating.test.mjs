import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { localCustomerOutbound } from './local-customer-egress.mjs';
import { readCustomerOperating, openCustomerOperating } from './local-customer-operating.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { customerArchiveFixture } from './test-fixtures/customer-archive.mjs';

test('the operator chooses the one loopback database and only explicit providers', async t => {
  const root = testFixtureRoot('noticeos-operating-config-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = startPlan({ dir: path.join(root, 'runtime'), port: 11420 });
  const file = path.join(root, 'customer.json');
  const config = { format: 'noticeos-customer-operating/1', database: Object.fromEntries([
    ['app', 'noticeos_app'], ['identity', 'noticeos_identity'], ['grant', 'noticeos_service_grant'],
  ].map(([key, role]) => [key, `postgresql://${role}:fixture@127.0.0.1:11424/fixture?sslmode=disable`])),
  identitySecret: randomBytes(48).toString('base64url'), credentialsKey: randomBytes(32).toString('base64'),
  workspaces: [{ workspaceId: randomUUID(), serviceId: randomUUID() }], mailRecipients: ['person@example.test'] };
  const read = overrides => {
    writeFileSync(file, JSON.stringify({ ...config, ...overrides }), { mode: 0o600 });
    return readCustomerOperating(file, plan);
  };
  assert.equal(read().googleDaily, false);
  assert.equal(read().ntasksOrigin, null);
  assert.equal(read({ ntasksOrigin: 'https://tasks.example.test' }).ntasksOrigin, 'https://tasks.example.test');
  for (const override of [
    { database: { ...config.database, app: config.database.app.replace('127.0.0.1', 'db.example.test') } },
    { database: { ...config.database, grant: config.database.grant.replace('11424', '11425') } },
    { database: { ...config.database, identity: config.database.app } },
    { ntasksOrigin: 'http://127.0.0.1:11424' }, { ntasksOrigin: 'https://tasks.example.test/elsewhere' },
    { ntasksOrigin: 'http://tasks.example.test' }, { googleDaily: 'yes' },
  ]) assert.throws(() => read(override), /private customer config/u);
  const targets = [];
  const transport = async (url, init) => {
    targets.push({ url, method: init.method, redirect: init.redirect });
    return new Response(null, { status: 307, headers: { location: 'https://unexpected.example.test' } });
  };
  const token = new Request('https://oauth2.googleapis.com/token', { method: 'POST' });
  assert.equal((await localCustomerOutbound({ transport })(token)).status, 403);
  const scheduled = localCustomerOutbound({ googleDaily: true, transport });
  assert.equal((await scheduled(new Request('https://analyticsdata.googleapis.com/v1beta/properties/1:runRealtimeReport',
    { method: 'POST' }))).status, 403);
  const reporting = new Request('https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport', { method: 'POST' });
  assert.equal((await scheduled(reporting)).status, 502);
  assert.equal((await scheduled(token)).status, 502);
  const tasks = localCustomerOutbound({ ntasksOrigin: 'https://tasks.example.test', transport });
  assert.equal((await tasks(new Request('https://tasks.example.test/api/task-database'))).status, 403);
  assert.equal((await tasks(new Request('https://tasks.example.test/api/tasks'))).status, 502);
  assert.deepEqual(targets, [
    { url: reporting.url, method: 'POST', redirect: 'manual' },
    { url: 'https://oauth2.googleapis.com/token', method: 'POST', redirect: 'manual' },
    { url: 'https://tasks.example.test/api/tasks', method: 'GET', redirect: 'manual' },
  ]);
});

function customerArgs(plan, configFile) {
  return [path.join(plan.root, 'scripts/start.mjs'), '--profile', 'hosted', '--customer-config', configFile,
    '--dir', plan.home, '--port', String(plan.port), '--no-open'];
}

async function assertNormalLauncher(plan, configFile) {
  const child = spawn(process.execPath, customerArgs(plan, configFile), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
    child.once('error', () => resolve(1));
  });
  const ready = new Promise(resolve => {
    let stdout = '';
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.includes(`${plan.url}\n`)) resolve(true);
    });
    child.stderr.resume();
  });
  const timeout = AbortSignal.timeout(30000);
  let running = false;
  try {
    running = await Promise.race([ready, exited.then(() => false),
      new Promise(resolve => timeout.addEventListener('abort', () => resolve(false), { once: true }))]);
    assert.equal(running, true);
    assert.equal((await fetch(plan.url + 'wall', { signal: timeout })).status, 200);
  } finally {
    child.kill('SIGTERM');
    const code = await exited;
    if (running) assert.equal(code, 0);
  }
}

async function recordedGoogle(archive) {
  let calls = 0;
  const server = createServer(async (request, reply) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const sent = new Request(request.headers['x-fixture-destination'], { method: request.method,
        headers: { authorization: request.headers.authorization ?? '' }, body: Buffer.concat(chunks) });
      calls++;
      const response = await archive.fetch(sent);
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch { reply.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  return {
    async send(url, init) { return fetch(origin, { ...init, headers: { ...init.headers, 'x-fixture-destination': url } }); },
    calls: () => calls,
    close: async () => {
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    },
  };
}

test('an attached customer owns one scheduler and releases it on shutdown or database disconnect', { timeout: 180000 }, async t => {
  const root = testFixtureRoot('n-customer-operating-');
  const source = startPlan({ dir: path.join(root, 'prepared-store'), port: await availableCustomerPort() });
  const operator = startPlan({ dir: path.join(root, 'runtime'), port: source.port });
  const configFile = path.join(root, 'customer.json');
  let db, app, provider;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(source, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(source, db);
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const workspaces = app.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }));
    const archive = customerArchiveFixture(app);
    await archive.configure(db, credentialsKey);
    provider = await recordedGoogle(archive);
    const config = { format: 'noticeos-customer-operating/1', database: {
      app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString,
    }, identitySecret, credentialsKey, workspaces, mailRecipients: app.workspaces.map(row => row.email) };
    const save = googleDaily => writeFileSync(configFile, JSON.stringify({ ...config, googleDaily }), { mode: 0o600 });
    await app.close(); app = undefined;

    let resources;
    const launch = () => startAttachedCustomer(operator, configFile, { googleTransport: provider.send, startSchedules(options) {
      resources = options;
      const now = Date.now();
      return startLocalCustomerSchedules({ ...options, now: () => now });
    } });
    save(false);
    app = await launch();
    await app.whenIdle();
    assert.equal(provider.calls(), 0);
    assert.deepEqual(db.cluster.sql('SELECT 1 FROM noticeos.archive_runs'), []);
    const session = await fetch(app.publicOrigin + '/api/session');
    assert.equal((await session.json()).mode, 'hosted');
    assert.equal((await fetch(app.publicOrigin + '/api/mcp')).status, 401);
    const other = startPlan({ dir: path.join(root, 'second-runtime'), port: await availableCustomerPort() });
    await assert.rejects(promisify(execFile)(process.execPath, customerArgs(other, configFile)),
    error => /already owns this database/u.test(error.stdout + error.stderr));
    assert.equal(provider.calls(), 0);
    await app.close(); app = undefined;

    save(true);
    app = await launch();
    assert.equal(resources.resumeSince, undefined);
    await app.whenIdle();
    await archive.verify({ db, options: resources, t });
    const archived = provider.calls();
    const backend = db.cluster.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='noticeos-local-customer-scheduler'`);
    assert.equal(backend.length, 1);
    db.cluster.run(`SELECT pg_terminate_backend(:'pid'::int)`, { vars: backend[0] });
    assert.match((await app.whenLost).message, /lost its database lease/u);
    await app.close(); app = undefined;
    await assert.rejects(fetch(operator.url), /fetch failed/u);
    assert.equal(provider.calls(), archived);
    const resumed = await openCustomerOperating(operator, configFile);
    try { assert.ok(Number.isSafeInteger(resumed.resumeSince)); }
    finally { await resumed.close(); }
    save(false);
    await assertNormalLauncher(operator, configFile);
    assert.equal(provider.calls(), archived);
  } finally {
    try { await app?.close(); } finally { db?.close(); await provider?.close(); }
    if (!existsSync(path.join(source.home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
