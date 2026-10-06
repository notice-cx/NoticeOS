import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createWorkspaceAdmission, AdmissionRefused } from './workspace-admission.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const denied = error => error.code === '42501';

test('fixed service construction is lazy, snapshots IDs, and retires without a connection', async () => {
  let sockets = 0;
  const server = net.createServer(socket => { sockets++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { connectionString: `postgresql://noticeos_service_grant:generated@127.0.0.1:${server.address().port}/fixture`,
      principalId: randomUUID(), workspaceId: randomUUID() };
    const reader = openWorkspaceServiceGrant(options);
    options.workspaceId = 'mutated'; options.principalId = 'mutated';
    const closing = reader.close(); assert.equal(reader.close(), closing); await closing;
    await assert.rejects(reader.facts(), { name: 'ServiceGrantRefused', message: 'Service grant is closed' });
    assert.equal(sockets, 0);
    assert.throws(() => openWorkspaceServiceGrant({ ...options, workspaceId: randomUUID() }), { name: 'ServiceGrantRefused' });
    assert.throws(() => openWorkspaceServiceGrant({ connectionString: 'not-a-url', principalId: randomUUID(), workspaceId: randomUUID() }),
      { name: 'ServiceGrantRefused', message: 'Service grant requires an explicit PostgreSQL connection' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('established socket stalls retain the fixed deadline and retire on refusal', { timeout: 10000 }, async () => {
  const sockets = new Set(); let queried = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let startup = true;
    socket.on('data', bytes => {
      if (startup) {
        startup = false;
        const auth = Buffer.alloc(9); auth[0] = 82; auth.writeInt32BE(8, 1);
        socket.write(Buffer.concat([auth, Buffer.from([90, 0, 0, 0, 5, 73])]));
      } else if (bytes[0] === 81) queried = true;
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const reader = openWorkspaceServiceGrant({
    connectionString: `postgresql://noticeos_service_grant:generated@127.0.0.1:${server.address().port}/fixture?sslmode=disable&query_timeout=0&statement_timeout=0`,
    principalId: randomUUID(), workspaceId: randomUUID(),
  });
  try {
    const started = Date.now();
    await assert.rejects(reader.facts(), { name: 'ServiceGrantRefused', message: 'Service grant connection refused' });
    assert.ok(queried); assert.ok(Date.now() - started < 8000);
  } finally {
    await reader.close();
    for (const socket of sockets) await new Promise(resolve => socket.once('close', resolve));
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(sockets.size, 0);
});

test('service grant joins current lifecycle and only named scoped facts in native and Worker', { timeout: 90000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-service-'));
  let owner, admin; const clients = [], readers = [], runtimes = [];
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    applyMigrations(owner);
    const baseConnection = owner.applicationLogin().url();
    async function login(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN`);
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(baseConnection); url.username = role; url.password = password;
      const client = new Pool({ connectionString: url.href, max: 2 }); clients.push(client);
      assert.equal((await client.query('SELECT session_user')).rows[0].session_user, role);
      return { client, connectionString: url.href };
    }
    const platform = await login('noticeos_platform'), service = await login('noticeos_service_grant');
    const app = await login('noticeos_app'), identity = await login('noticeos_identity');
    const workspaces = [randomUUID(), randomUUID(), randomUUID()];
    const principals = workspaces.map(() => randomUUID());
    const insert = 'INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,$4)';
    const update = (index, actions) => platform.client.query('UPDATE noticeos_platform.workspace_service_grants SET actions=$2 WHERE service_id=$1', [principals[index], actions]);
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    for (const [index, workspace] of workspaces.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [workspace, `fixture-${workspace}`]);
      await platform.client.query(insert, [principals[index], workspace, index === 2 ? ['tasks.read'] : ['tasks.read', 'tasks.write'], expiresAt]);
      readers.push(openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[index], workspaceId: workspace }));
    }
    const request = new Request('https://service.example.test/run', { method: 'POST', headers: { 'x-service-id': principals[1], 'x-workspace-id': workspaces[1] } });
    let capabilities = 0;
    const admissions = readers.map(reader => createWorkspaceAdmission({ kind: 'service', profile: Symbol(), authority: () => reader.facts() }));
    const run = (index, action = 'tasks.write', workspace = workspaces[index]) => admissions[index].withAdmission(action,
      { requestedWorkspaceId: workspace, correlationId: 'same-generated-occurrence' }, request, async context => {
        capabilities++; admissions[index].assertContext(context, action); return context.workspaceId;
      });
    await t.test('server binding defeats header/selector collisions across two customers and demo', async () => {
      const facts = await readers[0].facts();
      assert.deepEqual(facts, { principalId: principals[0], workspaceId: workspaces[0], workspaceStatus: 'active', expiresAt, actions: ['tasks.read', 'tasks.write'] });
      assert.ok(Object.isFrozen(facts)); assert.ok(Object.isFrozen(facts.actions));
      assert.equal(await run(0), workspaces[0]); assert.equal(await run(1), workspaces[1]); assert.equal(await run(2, 'tasks.read'), workspaces[2]);
      const before = capabilities;
      await assert.rejects(run(0, 'tasks.write', workspaces[1]), AdmissionRefused);
      await assert.rejects(run(2), AdmissionRefused); assert.equal(capabilities, before);
      const foreign = openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[0], workspaceId: workspaces[1] }); readers.push(foreign);
      assert.equal(await foreign.facts(), null);
      await assert.rejects(platform.client.query(insert, [principals[0], workspaces[1], ['tasks.read'], expiresAt]), error => error.code === '23505');
    });
    await t.test('one observation cannot combine a new grant with an old active lifecycle', async () => {
      const transaction = await admin.connect();
      try {
        await transaction.query('BEGIN');
        await transaction.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspaces[0]]);
        await transaction.query('UPDATE noticeos_platform.workspace_service_grants SET actions=$2 WHERE service_id=$1', [principals[0], ['tasks.read']]);
        const prior = await readers[0].facts();
        assert.equal(prior.workspaceStatus, 'active'); assert.deepEqual(prior.actions, ['tasks.read', 'tasks.write']);
        await transaction.query('COMMIT');
        const current = await readers[0].facts();
        assert.equal(current.workspaceStatus, 'suspended'); assert.deepEqual(current.actions, ['tasks.read']);
        const before = capabilities; await assert.rejects(run(0, 'tasks.read'), AdmissionRefused); assert.equal(capabilities, before);
        await transaction.query('BEGIN');
        await transaction.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[0]]);
        await transaction.query('UPDATE noticeos_platform.workspace_service_grants SET actions=$2 WHERE service_id=$1', [principals[0], ['tasks.read', 'tasks.write']]);
        await transaction.query('COMMIT');
      } finally { await transaction.query('ROLLBACK'); transaction.release(); }
    });
    await t.test('narrowing, unknown and prohibited entire grants refuse before capabilities', async () => {
      await update(0, ['tasks.read']); const before = capabilities;
      await assert.rejects(run(0), AdmissionRefused); assert.equal(capabilities, before);
      assert.equal(await run(0, 'tasks.read'), workspaces[0]);
      for (const actions of [['tasks.read', 'unknown.read'], ['tasks.read', 'memberships.manage'], ['tasks.read', 'platform.maintain'], ['tasks.read', 'measurement.write'], ['tasks.read', 'tasks.read'], ['BAD']]) {
        await update(0, actions); const current = capabilities;
        await assert.rejects(run(0, 'tasks.read'), AdmissionRefused); assert.equal(capabilities, current);
        if (actions[0] === 'BAD' || new Set(actions).size !== actions.length) await assert.rejects(readers[0].facts(), { name: 'ServiceGrantRefused', message: 'Service grant facts refused' });
      }
      await assert.rejects(update(0, []), error => error.code === '23514');
      await update(0, ['tasks.read', 'tasks.write']);
    });
    await t.test('canonical lifecycle and expiry are fresh, never cached facts', async () => {
      for (const status of ['suspended', 'provisioning']) {
        await admin.query('UPDATE noticeos.workspaces SET status=$2 WHERE workspace_id=$1', [workspaces[0], status]);
        const before = capabilities; await assert.rejects(run(0), AdmissionRefused); assert.equal(capabilities, before);
        assert.equal((await readers[0].facts()).workspaceStatus, status);
      }
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[0]]);
      await admin.query("UPDATE noticeos_platform.workspace_service_grants SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE service_id=$1", [principals[0]]);
      assert.equal(await readers[0].facts(), null); const before = capabilities;
      await assert.rejects(run(0), AdmissionRefused); assert.equal(capabilities, before);
      await platform.client.query('UPDATE noticeos_platform.workspace_service_grants SET expires_at=$2 WHERE service_id=$1', [principals[0], expiresAt]);
    });
    const bundle = await bundleWorkerFixture(root, 'service-grant', path.join(REPO_ROOT, 'scripts/test/service-grant-worker.fixture.mjs'));
    let outside = 0;
    for (const [index, workspace] of workspaces.entries()) runtimes.push(new Miniflare({ ...bundle,
      bindings: { FIXTURE_CONNECTION: service.connectionString, FIXTURE_SERVICE: principals[index], FIXTURE_WORKSPACE: workspace },
      outboundService: async () => { outside++; throw new Error('No outside HTTP'); } }));
    const worker = async (index, action, workspace = workspaces[index]) => {
      const response = await runtimes[index].dispatchFetch(`https://service.example.test/?action=${action}&workspace=${workspace}`, {
        headers: { 'x-service-id': principals[(index + 1) % 3] } });
      return { status: response.status, body: await response.json() };
    };
    await t.test('ordinary Worker uses fixed service identity for customer/customer/demo interleaving', async () => {
      for (const index of [0, 1, 2, 0, 2, 1]) assert.deepEqual(await worker(index, 'tasks.read'), { status: 200,
        body: { workspaceId: workspaces[index], principalId: principals[index], principalKind: 'workspace-service', action: 'tasks.read' } });
      assert.equal((await worker(0, 'tasks.read', workspaces[1])).status, 403);
      assert.equal((await worker(2, 'tasks.write')).status, 403);
      await update(0, ['tasks.read']); assert.equal((await worker(0, 'tasks.write')).status, 403);
      for (const forbidden of ['memberships.manage', 'platform.maintain', 'unknown.read']) {
        await update(0, ['tasks.read', forbidden]); assert.equal((await worker(0, 'tasks.read')).status, 403);
      }
      await update(0, ['tasks.read', 'tasks.write']);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspaces[0]]);
      assert.equal((await worker(0, 'tasks.read')).status, 403); assert.equal((await worker(1, 'tasks.read')).status, 200);
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspaces[0]]);
      await platform.client.query('UPDATE noticeos_platform.workspace_service_grants SET expires_at=clock_timestamp() WHERE service_id=$1', [principals[0]]);
      assert.equal((await worker(0, 'tasks.read')).status, 403);
      await platform.client.query('UPDATE noticeos_platform.workspace_service_grants SET expires_at=$2,revoked_at=clock_timestamp() WHERE service_id=$1', [principals[0], expiresAt]);
      assert.equal((await worker(0, 'tasks.read')).status, 403); assert.equal((await worker(1, 'tasks.read')).status, 200);
      const before = capabilities; await assert.rejects(run(0), AdmissionRefused); assert.equal(capabilities, before);
      assert.equal(outside, 0);
    });
    await t.test('separate runtime role and function ACL prohibit table, identity and customer authority', async () => {
      for (const client of [app.client, identity.client]) {
        await assert.rejects(client.query('SELECT * FROM noticeos_platform.resolve_workspace_service($1,$2)', [workspaces[1], principals[1]]), denied);
        await assert.rejects(client.query('SELECT * FROM noticeos_platform.workspace_service_grants'), denied);
      }
      await assert.rejects(service.client.query('SELECT * FROM noticeos_platform.workspace_service_grants'), denied);
      await assert.rejects(service.client.query('SELECT * FROM noticeos.assets'), denied);
      await assert.rejects(service.client.query('SELECT * FROM noticeos_identity.auth_session'), denied);
      await assert.rejects(service.client.query('CREATE TABLE noticeos_platform.refused(id int)'), denied);
      await assert.rejects(service.client.query('SET ROLE noticeos_owner'), denied);
      for (const column of ['workspace_id', 'service_id', 'created_at']) await assert.rejects(platform.client.query(`UPDATE noticeos_platform.workspace_service_grants SET ${column}=${column}`), denied);
      await assert.rejects(platform.client.query('DELETE FROM noticeos_platform.workspace_service_grants'), denied);
      const fn = (await admin.query("SELECT proconfig,provolatile,prosecdef FROM pg_proc WHERE oid='noticeos_platform.resolve_workspace_service(uuid,uuid)'::regprocedure")).rows[0];
      assert.deepEqual(fn, { proconfig: ['search_path=pg_catalog, pg_temp'], provolatile: 'v', prosecdef: true });
      assert.equal((await admin.query("SELECT has_function_privilege('public','noticeos_platform.resolve_workspace_service(uuid,uuid)','EXECUTE') allowed")).rows[0].allowed, false);
      for (const privilege of ['INSERT', 'UPDATE(revoked_at)']) {
        await admin.query(`GRANT ${privilege} ON noticeos_platform.workspace_service_grants TO noticeos_service_grant`);
        const drift = openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[1], workspaceId: workspaces[1] }); readers.push(drift);
        await assert.rejects(drift.facts(), { name: 'ServiceGrantRefused', message: 'Service grant connection refused' });
        await admin.query(`REVOKE ${privilege} ON noticeos_platform.workspace_service_grants FROM noticeos_service_grant`);
      }
      for (const schema of ['noticeos', 'noticeos_identity', 'noticeos_platform']) {
        await admin.query(`GRANT CREATE ON SCHEMA ${schema} TO noticeos_service_grant`);
        const drift = openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[1], workspaceId: workspaces[1] }); readers.push(drift);
        await assert.rejects(drift.facts(), { name: 'ServiceGrantRefused', message: 'Service grant connection refused' });
        await admin.query(`REVOKE CREATE ON SCHEMA ${schema} FROM noticeos_service_grant`);
      }
      await admin.query('GRANT EXECUTE ON FUNCTION noticeos_platform.resolve_task_project(uuid,uuid) TO noticeos_service_grant');
      const otherFunction = openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[1], workspaceId: workspaces[1] }); readers.push(otherFunction);
      await assert.rejects(otherFunction.facts(), { name: 'ServiceGrantRefused', message: 'Service grant connection refused' });
      await admin.query('REVOKE EXECUTE ON FUNCTION noticeos_platform.resolve_task_project(uuid,uuid) FROM noticeos_service_grant');
      await admin.query('CREATE ROLE unrelated_fixture NOLOGIN'); await admin.query('GRANT unrelated_fixture TO noticeos_service_grant');
      const drift = openWorkspaceServiceGrant({ connectionString: service.connectionString, principalId: principals[1], workspaceId: workspaces[1] }); readers.push(drift);
      await assert.rejects(drift.facts(), { name: 'ServiceGrantRefused', message: 'Service grant connection refused' });
      await admin.query('REVOKE unrelated_fixture FROM noticeos_service_grant');
    });
    await t.test('close joins pending facts exactly once and rejects further reads', async () => {
      const read = readers[1].facts(), close = readers[1].close(); assert.equal(readers[1].close(), close);
      assert.equal((await read).workspaceId, workspaces[1]); await close;
      await assert.rejects(readers[1].facts(), { name: 'ServiceGrantRefused', message: 'Service grant is closed' });
    });
  } finally {
    const closed = await Promise.allSettled([...runtimes.map(runtime => runtime.dispose()), ...readers.map(reader => reader.close()), ...clients.map(client => client.end()), admin?.end()]);
    await owner?.close(); assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
