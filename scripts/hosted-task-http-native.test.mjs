import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { openIdentity, IDENTITY_NAMES } from '../packages/postgres/src/identity.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedTaskHttp } from './hosted-task-http.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const { betterAuth } = await import(require.resolve('better-auth/minimal'));
const { organization } = await import(require.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(require.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));

// No ordinary test invocation selects Docker, installed stores or live auth.
test('native HTTP binds seven task operations to fresh maintained session and private directory', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240000,
}, async t => withOwnedTaskProjects(async physical => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-task-http-pg-'));
  const pools = []; let owner, identity, directory, database, server;
  let handler;
  const sockets = new Set(), closedSockets = [];
  try {
    const tools = findPostgres(); owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 }); pools.push(admin);
    applyMigrations(owner);
    async function connection(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(owner.applicationLogin().url()); url.username = role; url.password = password;
      return url.href;
    }
    const identityUrl = await connection('noticeos_identity'), taskUrl = await connection('noticeos_task_directory');
    directory = openTaskDirectory({ connectionString: taskUrl });
    for (const mapping of physical.mappings) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [mapping.workspaceId, 'tenant-' + mapping.workspaceId]);
      await admin.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
    }
    // This fixture adapter binds the real incoming target/headers/body to a Web
    // Request; it is not a production Workerd transport or Vite registration.
    server = http.createServer(async (incoming, outgoing) => {
      try {
        const target = new URL(incoming.url, `http://${incoming.headers.host}`);
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const proof = new Request(target, { method: incoming.method, headers,
          ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' }) });
        const response = await handler(proof);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
      } catch { outgoing.writeHead(500); outgoing.end('fixture_refused'); }
    });
    server.on('connection', socket => {
      sockets.add(socket);
      closedSockets.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve(); })));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(6448, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:6448', sessionSecret = randomBytes(48).toString('base64url');
    const pool = new Pool({ connectionString: identityUrl, max: 1 });
    database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const engine = betterAuth({ database: kyselyAdapter(database.withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret: sessionSecret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } }, plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })] });
    const signup = await engine.handler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic person', email: 'person@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(signup.status, 200); const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    for (const mapping of physical.mappings) {
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [mapping.workspaceId, 'identity-' + mapping.workspaceId]);
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now())", [randomUUID(), mapping.workspaceId, person.id]);
    }
    identity = await openIdentity({ connectionString: identityUrl, trustedOrigin: origin, sessionSecret });
    const session = await identity.session(new Headers({ cookie })); assert.ok(session);
    let authorityCalls = 0, targetCalls = 0, recheck;
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async (headers, workspaceId) => {
        authorityCalls++; if (recheck && authorityCalls % 2 === 0) await recheck();
        return identity.admissionMembership(headers, workspaceId);
      } });
    const executor = createHostedTaskExecutor({ admission, directory, resolveTarget: async mapping => { targetCalls++; return physical.resolveTarget(mapping); },
      binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot });
    handler = createHostedTaskHttp({ profile: 'hosted', trustedOrigin: origin, executor });
    async function call(mapping, method, route, body, patch = {}) {
      const headers = { cookie, origin, 'sec-fetch-site': 'same-origin', [WORKSPACE_SELECTION_HEADER]: mapping.workspaceId,
        [WORKSPACE_SESSION_HEADER]: session.sessionId, ...(body ? { 'content-type': 'application/json' } : {}), ...patch };
      const response = await fetch(origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      const serialized = JSON.stringify(payload); assert.equal(serialized.includes(physical.scratchRoot), false);
      assert.equal(serialized.includes('credentialsFile'), false); assert.equal(serialized.includes('grantVerifierProfile'), false);
      return { response, payload };
    }
    const [a, b] = physical.mappings;
    await t.test('both physical projects execute every operation through HTTP with server actor', async () => {
      for (const mapping of [a, b]) {
        const collision = await call(mapping, 'GET', `/api/tasks/tt-collision?project=${mapping.projectId}`);
        assert.equal(collision.response.status, 200);
        const own = mapping === a ? 'task0' : 'task1', other = mapping === a ? 'task1' : 'task0';
        assert.ok(JSON.stringify(collision.payload).includes('Private ' + own));
        assert.equal(JSON.stringify(collision.payload).includes('Private ' + other), false);
        const created = await call(mapping, 'POST', '/api/tasks', { projectId: mapping.projectId, title: '--file=literal title', description: 'Synthetic owned work' });
        assert.equal(created.response.status, 200); const id = created.payload.id; assert.equal(typeof id, 'string');
        assert.equal(created.payload.created_by, person.id);
        for (const [method, route, body] of [
          ['GET', `/api/tasks?project=${mapping.projectId}&limit=10`],
          ['GET', `/api/tasks/${id}?project=${mapping.projectId}`],
          ['GET', `/api/tasks/${id}/history?project=${mapping.projectId}&limit=5`],
          ['PATCH', `/api/tasks/${id}`, { projectId: mapping.projectId, status: 'in_progress' }],
          ['POST', `/api/tasks/${id}/comments`, { projectId: mapping.projectId, text: '--sql=literal comment' }],
          ['POST', `/api/tasks/${id}/close`, { projectId: mapping.projectId, reason: 'Synthetic outcome recorded' }],
        ]) assert.equal((await call(mapping, method, route, body)).response.status, 200, route);
      }
    });
    await t.test('bad selectors, foreign project, viewer/demo and stale session refuse before task dispatch', async () => {
      const before = targetCalls;
      for (const [route, body] of [['/api/tasks', { projectId: a.projectId, title: 'refused', actor: 'root' }],
        ['/api/tasks', { projectId: randomUUID(), title: 'foreign' }]]) {
        assert.ok((await call(a, 'POST', route, body)).response.status >= 400);
      }
      await admin.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1", [a.workspaceId]);
      assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'viewer refused' })).response.status, 403);
      assert.equal((await call(a, 'GET', `/api/tasks?project=${a.projectId}`, undefined, { [WORKSPACE_SESSION_HEADER]: randomUUID() })).response.status, 403);
      assert.equal(targetCalls, before);
      await admin.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1", [a.workspaceId]);
      for (const patch of [{ origin: 'https://foreign.example.test' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'foreign proof refused' }, patch)).response.status, 403);
      }
      assert.equal(targetCalls, before);
      const demoAdmission = createWorkspaceAdmission({ kind: 'demo', profile: Symbol(), workspaceId: a.workspaceId, workspaceStatus: async () => 'active' });
      const demoExecutor = createHostedTaskExecutor({ admission: demoAdmission, directory, resolveTarget: physical.resolveTarget, binary: physical.pinnedBinary,
        doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot });
      handler = createHostedTaskHttp({ profile: 'demo', trustedOrigin: origin, demoWorkspaceId: a.workspaceId, executor: demoExecutor });
      assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'demo refused' })).response.status, 403);
      handler = createHostedTaskHttp({ profile: 'hosted', trustedOrigin: origin, executor });
    });
    await t.test('effect-time membership and directory revocation deny after real readiness', async () => {
      const before = (await call(a, 'GET', `/api/tasks?project=${a.projectId}`)).payload;
      authorityCalls = 0;
      recheck = () => admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a.workspaceId, person.id]);
      assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'revoked before dispatch' })).response.status, 403);
      recheck = undefined;
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now())", [randomUUID(), a.workspaceId, person.id]);
      authorityCalls = 0;
      recheck = () => admin.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=now() WHERE workspace_id=$1', [a.workspaceId]);
      assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'mapping revoked before dispatch' })).response.status, 403);
      recheck = undefined;
      await admin.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=NULL WHERE workspace_id=$1', [a.workspaceId]);
      assert.deepEqual((await call(a, 'GET', `/api/tasks?project=${a.projectId}`)).payload, before, 'denied writes never dispatched');
      await admin.query('UPDATE noticeos_identity.auth_session SET expires_at=now()-interval \'1 minute\' WHERE id=$1', [session.sessionId]);
      assert.equal((await call(b, 'GET', `/api/tasks?project=${b.projectId}`)).response.status, 403);
    });
  } finally {
    const shutdownServer = async () => {
      if (server) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      await Promise.all(closedSockets);
    };
    const cleanup = await Promise.allSettled([shutdownServer(), identity?.close(), directory?.close(), database?.destroy(), ...pools.map(pool => pool.end())]);
    owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false, 'retain files if owned server absence is uncertain');
    rmSync(root, { recursive: true, force: true });
    assert.equal(sockets.size, 0);
    for (const outcome of cleanup) if (outcome.status === 'rejected') throw outcome.reason;
  }
}));
