import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createCloudflareD1BackupClient, copyCloudflareD1 } from './cloudflare-d1-backup.mjs';
import { readBackupClient } from './container-backup-channel.mjs';
import { serviceBackupRequest } from './container-backup-worker.mjs';
import { createCustomerBackup } from './customer-backup.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startCustomerRuntime } from './local-customer.mjs';
import { localD1BackupOutbound } from './local-customer-egress.mjs';
import { buildHostedApp } from './hosted-demo-build.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { demoNtasks } from './demo-ntasks.mjs';
import { openBackupNtasks, privateJson, sealedProviderSql } from './test-fixtures/customer-backup.mjs';

const pinned = process.env.NOTICEOS_NTASKS_ROOT;

test('customer nightly and manual backup need independently scoped Ntasks custody', { skip: !pinned, timeout: 90_000 }, async t => {
  const root = testFixtureRoot('n-cust-backup-');
  let db, tasks, scheduler, restored;
  try {
    const home = path.join(root, 'customer');
    fs.mkdirSync(home, { mode: 0o700 });
    db = await skipWithoutPostgres(t, async () => openDevelopmentStart(startPlan({ dir: home, port: await availableCustomerPort() }), { profile: 'hosted' }));
    if (!db) return;
    tasks = await openBackupNtasks(path.join(root, 'tasks'), pinned);
    const workspaceId = randomUUID(), serviceId = randomUUID();
    db.cluster.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES ('${workspaceId}','fixture','Fixture','active');
      INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
      VALUES ('${serviceId}','${workspaceId}',ARRAY['workflows.run'],now()+interval '1 day');`);
    const key = randomBytes(32).toString('base64');
    const connectionId = randomUUID();
    const connect = (backupToken, version) => db.cluster.run(sealedProviderSql(workspaceId, key, 'ntasks', { NTASKS_URL: tasks.origin,
      NTASKS_WORKSPACE_ID: tasks.workspaceId, NTASKS_TOKEN: tasks.token, NTASKS_BACKUP_TOKEN: backupToken }, connectionId, version));
    connect(tasks.backupToken, 1);
    const handed = [], file = path.join(root, 'received-backup.json');
    const backup = createCustomerBackup({ address: db.address, workspaceId, credentialsKey: key,
      ntasksOrigin: tasks.origin, client: '/fixture/request', staging: path.join(root, 'staging'),
      backupStatus: async () => ({ available: true }), async requestBackup(client, request) {
        assert.equal(client, '/fixture/request');
        assert.equal(request.customer, true);
        assert.equal(request.tasks, 'ntasks');
        assert.equal(fs.statSync(request.tasksExport).mode & 0o777, 0o600);
        const payload = JSON.parse(fs.readFileSync(request.tasksExport));
        assert.ok(payload.tables.tasks.some(task => task.id === tasks.task.id && task.title === tasks.task.title));
        fs.copyFileSync(request.tasksExport, file);
        handed.push(payload);
        return { ok: true };
      } });
    assert.equal(await backup.check(), null);
    assert.equal(await backup.inventory(), null);
    scheduler = await startLocalCustomerSchedules({ workspaces: [{ workspaceId, serviceId }], connectionString: db.address,
      grantConnectionString: db.grantConnectionString, backup, now: () => Date.parse('2026-11-17T04:00:00Z') });
    await scheduler.whenIdle();
    assert.equal(handed.length, 1);
    assert.equal((await scheduler.manualBackup()).ok, true);
    assert.equal(handed.length, 2);
    const outcomes = () => db.cluster.sql(`SELECT occurrence,state FROM noticeos.hosted_job_occurrences
      WHERE workspace_id='${workspaceId}' AND lane='backup' ORDER BY occurrence`);
    assert.deepEqual(outcomes().map(row => row.state), ['succeeded', 'succeeded']);
    assert.equal(outcomes()[0].occurrence, '2026-11-17T04:00:00.000Z/workspace');
    assert.match(outcomes()[1].occurrence, /^manual\//u);
    restored = await openBackupNtasks(path.join(root, 'restored-tasks'), pinned, { restore: file });
    const client = demoNtasks({ origin: restored.origin, workspaceId: restored.workspaceId, token: restored.token });
    assert.equal((await client.tool('get_task', { task: tasks.task.id })).task.title, tasks.task.title);
    assert.notEqual(restored.workspaceId, tasks.workspaceId);
    assert.equal((await client.call('GET', '/api/backup')).status, 403);
    const saved = fs.readFileSync(file);
    for (const [token, version] of [[tasks.overScopedToken, 2], [tasks.token, 3]]) {
      connect(token, version);
      assert.equal((await scheduler.manualBackup()).stage, 'taskHub');
      assert.equal(backup.healthy(), false);
      assert.equal(handed.length, 2);
      assert.deepEqual(fs.readFileSync(file), saved);
    }
    connect(tasks.backupToken, 4);
    await tasks.revokeBackup();
    assert.equal((await scheduler.manualBackup()).stage, 'taskHub');
    assert.equal(backup.healthy(), false);
    assert.equal(handed.length, 2);
    assert.deepEqual(fs.readFileSync(file), saved);
  } finally {
    try { await scheduler?.close(); } finally { db?.close(); }
    try { await restored?.close(); } finally { await tasks?.close(); }
    if (!fs.existsSync(path.join(root, 'customer/.local/customer-postgres/data/postmaster.pid'))) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the private D1 backup transport admits only signed downloads and exact exports', async () => {
  const account = 'a'.repeat(32), database = randomUUID(), download = `https://${account}.r2.cloudflarestorage.com/dump?X-Amz-Signature=fixture`;
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/export`;
  const calls = [];
  const transport = localD1BackupOutbound({ async transport(url, options) {
    calls.push({ url, ...options });
    return new Response(null, { status: 307, headers: { location: 'https://other.example.test/' } });
  } });
  for (const [url, method] of [[api, 'GET'], [api + '?foreign=1', 'POST'], [api.replace('/export', ''), 'POST'],
    [download, 'POST'], [download.replace('.com/', '.com.other.example.test/'), 'GET'], [download.replace('https:', 'http:'), 'GET']]) {
    assert.equal((await transport(new Request(url, { method }))).status, 403);
  }
  const token = randomUUID();
  assert.equal((await transport(new Request(api, { method: 'POST', headers: { authorization: `Bearer ${token}`, cookie: 'outside' },
    body: '{}' }))).status, 502);
  assert.equal((await transport(new Request(download, { headers: { authorization: `Bearer ${token}`, cookie: 'outside' } }))).status, 502);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ url, redirect, headers }) => ({ url, redirect, token: headers.authorization, cookie: headers.cookie })), [
    { url: api, redirect: 'manual', token: `Bearer ${token}`, cookie: undefined },
    { url: download, redirect: 'manual', token: undefined, cookie: undefined },
  ]);
});

test('the native customer gateway backs up only selected D1 and streams the verified SQL to its sidecar', {
  skip: process.env.NOTICEOS_TEST_CUSTOMER_D1_BACKUP !== '1', timeout: 120_000,
}, async t => {
  const root = testFixtureRoot('n-cust-d1-backup-');
  let db, runtime, sidecar;
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const plan = startPlan({ dir: home, port: await availableCustomerPort() });
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    const workspaceId = randomUUID(), serviceId = randomUUID(), databaseId = randomUUID(), accountId = 'a'.repeat(32);
    const credentialsKey = randomBytes(32).toString('base64');
    const cloudflareKey = randomBytes(24).toString('base64url');
    const operatorToken = randomBytes(32).toString('base64url');
    const asset = 'fixture.example';
    const bindings = [{ workspaceId, serviceId }];
    const demoPg = db.cluster;
    demoPg.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES ('${workspaceId}','fixture','Fixture','active');
      INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
      VALUES ('${serviceId}','${workspaceId}',ARRAY['workflows.run'],now()+interval '1 day');
      INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position) VALUES ('${workspaceId}','${asset}','Fixture','live',1);`);
    demoPg.run(sealedProviderSql(workspaceId, credentialsKey, 'cloudflare', { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: cloudflareKey,
      CLOUDFLARE_D1_TARGETS: JSON.stringify({ version: 1, accountId, targets: [{ databaseId, asset }] }) }));
    for (const name of ['runtime', 'mail', 'workerd', 'transport']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const transportDir = path.join(root, 'transport'), client = path.join(root, 'backup-client.json');
    privateJson(client, { format: 'noticeos-backup-client-v1', transportDir });
    privateJson(path.join(transportDir, 'worker-health.json'), { format: 'noticeos-backup-worker-health-v1', ready: true,
      namespace: 'a'.repeat(64), updatedAt: new Date().toISOString() });
    const backup = { ...createCustomerBackup({ address: db.address, workspaceId, credentialsKey, client, staging: root,
      backupStatus: async () => ({ available: true }) }), operatorToken, client };
    assert.equal(await backup.check(), null);
    const artifactRoot = path.join(root, 'app');
    await buildHostedApp({ out: artifactRoot, profile: 'hosted' });
    const seen = [];
    const sql = `CREATE TABLE fixture (name TEXT); INSERT INTO fixture VALUES ('restored');\n`;
    const sha = createHash('sha256').update(sql).digest('hex');
    const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/export`;
    const download = `https://${accountId}.r2.cloudflarestorage.com/export?X-Amz-Signature=fixture`;
    runtime = await startCustomerRuntime(plan, { customer: path.join(root, 'runtime'), outbox: path.join(root, 'mail'),
      workerState: path.join(root, 'workerd'), deliver: async () => { throw new Error('Email unavailable.'); }, connectionString: db.address,
      identityDatabase: db.identityDatabase, identitySecret: randomBytes(48).toString('base64url'), credentialsKey,
      workspaces: bindings, grantConnectionString: db.grantConnectionString, startSchedules: fields => startLocalCustomerSchedules({
        ...fields, now: () => Date.parse('2026-11-17T10:30:00Z'),
      }), operating: { signal: new AbortController().signal },
      deployment: { artifactRoot, backup, backupD1Transport: async (url, init) => {
        if (url === api && init.method === 'POST' && init.headers.authorization === `Bearer ${cloudflareKey}`) {
          seen.push('export');
          return Response.json({ success: true, result: { type: 'export', status: 'complete', result: { signed_url: download } } });
        }
        if (url === download && init.method === 'GET' && !init.headers.authorization) {
          seen.push('download'); return new Response(sql);
        }
        assert.fail('Only the selected database may reach the fake provider.');
      } } });
    const publicOrigin = new URL(plan.url).origin;
    const throughGateway = (input, init = {}) => {
      const url = new URL(input);
      assert.equal(url.origin, 'http://noticeos:5173');
      return new Promise((resolve, reject) => {
        const request = httpRequest(publicOrigin + url.pathname + url.search, { method: init.method, signal: init.signal,
          headers: { ...init.headers, host: url.host }, agent: false }, response => resolve(new Response(Readable.toWeb(response),
          { status: response.statusCode, headers: response.headers })));
        request.once('error', reject);
        request.end(init.body);
      });
    };
    const direct = await throughGateway('http://noticeos:5173/api/backup/cloudflare-d1', { headers: { authorization: `Bearer ${operatorToken}` } });
    assert.equal(direct.status, 403);
    const profile = await readBackupClient(client);
    const target = path.join(root, 'exported');
    const run = fetch(`${publicOrigin}/_noticeos/backup`, { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${operatorToken}` } });
    const errors = [];
    sidecar = (async () => {
      for (let tries = 0; tries < 80; tries++) {
        const perform = async request => {
          const d1 = createCloudflareD1BackupClient({ repoRoot: '/state', transport: 'container', readBootstrap: () => ({ OPERATOR_TOKEN: operatorToken }),
            requestId: request.id, fetchImpl: throughGateway });
          const selection = await d1.inventory();
          assert.deepEqual(selection.targets, [{ databaseId, asset }]);
          const denied = await throughGateway('http://noticeos:5173/api/backup/cloudflare-d1', { method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}`, 'x-noticeos-backup-request': request.id },
            body: JSON.stringify({ accountId, databaseId: randomUUID() }) });
          assert.equal(denied.status, 409);
          assert.deepEqual(seen, []);
          const copied = await copyCloudflareD1({ client: d1, selection, target: selection.targets[0], output: target });
          assert.equal(copied.receipt.sha256, sha);
          assert.deepEqual(await d1.inventory(), selection);
          demoPg.run(sealedProviderSql(workspaceId, credentialsKey, 'ntasks', { NTASKS_URL: 'http://127.0.0.1:17971' }));
          try { await assert.rejects(d1.inventory(), /answered 409 connection_changed/u); }
          finally { demoPg.run(`DELETE FROM noticeos.integration_connections WHERE provider='ntasks' AND workspace_id='${workspaceId}'`); }
          demoPg.run(`DELETE FROM noticeos_platform.workspace_service_grants WHERE service_id='${serviceId}'`);
          try { await assert.rejects(d1.inventory(), /answered 403/u); }
          finally { demoPg.run(`INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
            VALUES ('${serviceId}','${workspaceId}',ARRAY['workflows.run'],now()+interval '1 day');`); }
          return { ok: true, detail: 'Complete test backup' };
        };
        if (await serviceBackupRequest(profile, request => perform(request).catch(error => {
          errors.push(error);
          throw error;
        }))) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error('The private app did not issue a backup request.');
    })();
    await sidecar;
    const answer = await run;
    assert.equal(errors.length, 0, errors.map(error => String(error.stack)).join('\n'));
    assert.equal(answer.status, 200, await answer.clone().text());
    const recovered = gunzipSync(fs.readFileSync(path.join(target, 'export.sql.gz'))).toString();
    assert.equal(recovered, sql);
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(recovered);
      assert.equal(sqlite.prepare('SELECT name FROM fixture').get().name, 'restored');
    } finally { sqlite.close(); }
    assert.deepEqual(seen, ['export', 'download']);
  } finally {
    await sidecar?.catch(() => {});
    try { await runtime?.close(); } finally { db?.close(); }
    if (!fs.existsSync(path.join(root, 'home/.local/customer-postgres/data/postmaster.pid'))) fs.rmSync(root, { recursive: true, force: true });
  }
});
