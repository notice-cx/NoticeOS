import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { stopLocalSecretReads } from './worker-config-folder.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';
import { openPlatformProvisioning } from '../packages/postgres/src/platform-provisioning.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const refused = { name: 'PlatformProvisioningRefused', message: 'Platform provisioning refused' };
const trustedOrigin = 'https://provision.example.test';

test('real initialized task ownership gates native and ordinary Worker activation', {
  skip: process.env.NOTICEOS_TEST_PLATFORM_ACTIVATION !== '1', timeout: 240000,
}, async t => {
  const { withOwnedTaskProjects } = await import('./test-fixtures/hosted-task-projects.mjs');
  const { provePlatformActivation } = await import('./test/platform-activation-fixture.mjs');
  await withOwnedTaskProjects(async (physical, controls) => {
    await provePlatformActivation(t, physical);
    await controls.assertUnchangedPhysicalRoots();
  });
});

async function workerPreparation(root, options, admin) {
  const workerRequire = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
  const wranglerPath = workerRequire.resolve('wrangler/package.json');
  const metadata = JSON.parse(readFileSync(wranglerPath, 'utf8'));
  const build = path.join(root, 'build'); mkdirSync(build);
  const config = path.join(root, 'wrangler.json');
  writeFileSync(config, JSON.stringify({ name: 'noticeos-platform-proof', main: path.join(REPO_ROOT, 'scripts/platform-provisioning-worker.fixture.mjs'),
    compatibility_date: '2026-07-06', compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  const home = path.join(root, 'build-client'); mkdirSync(home);
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    NODE_OPTIONS: `--import=${path.join(REPO_ROOT, 'scripts/script-tests-setup.mjs')}`,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', DO_NOT_TRACK: '1', NO_COLOR: '1' };
  stopLocalSecretReads(env);
  const compiled = spawnSync(process.execPath, [path.join(path.dirname(wranglerPath), metadata.bin.wrangler), 'deploy', '--dry-run', '--config', config, '--outdir', build],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
  const { Miniflare } = workerRequire('miniflare'); let outside = 0, verification = 0;
  const runtime = new Miniflare({ modules: true, modulesRoot: build, scriptPath: path.join(build, 'platform-provisioning-worker.fixture.js'),
    compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'], bindings: {
      FIXTURE_PLATFORM_CONNECTION: options.platformConnectionString, FIXTURE_IDENTITY_CONNECTION: options.identityConnectionString,
      FIXTURE_SESSION_SECRET: options.sessionSecret,
    }, serviceBindings: { FIXTURE_VERIFIER: async () => { verification++; return new Response(null, { status: 403 }); } },
    outboundService: async () => { outside++; throw new Error('No outside HTTP'); } });
  try {
    const workspaceId = randomUUID();
    const response = await runtime.dispatchFetch(trustedOrigin + '/prepare', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, slug: `worker-${workspaceId}`, displayName: 'Worker fixture', intendedEmail: 'worker@example.test', expiresAt: new Date(Date.now() + 3600000).toISOString() }) });
    assert.equal(response.status, 200); const prepared = await response.json();
    assert.equal(prepared.workspaceId, workspaceId); assert.match(prepared.enrollmentId, /^[a-f0-9-]{36}$/u);
    const refused = await runtime.dispatchFetch(trustedOrigin + '/activate', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...prepared, projectId: randomUUID() }) });
    assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { refused: true });
    assert.equal((await admin.query('SELECT status FROM noticeos.workspaces WHERE workspace_id=$1', [workspaceId])).rows[0].status, 'provisioning');
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1', [workspaceId])).rows[0].n, 0);
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.config_documents WHERE workspace_id=$1', [workspaceId])).rows[0].n, releasedDefaultDocuments().length);
    assert.equal(outside, 0); assert.equal(verification, 0);
  } finally { await runtime.dispose(); }
}

test('malformed platform commands open no connection and accept no caller readiness', async () => {
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const module = openPlatformProvisioning({ platformConnectionString: `postgresql://noticeos_platform:generated@127.0.0.1:${port}/fixture`,
    identityConnectionString: `postgresql://noticeos_identity:generated@127.0.0.1:${port}/fixture`,
    trustedOrigin, sessionSecret: randomBytes(48).toString('base64url'), verifyProject: async () => assert.fail('No malformed verifier call') });
  try {
    const base = { workspaceId: randomUUID(), slug: 'fixture', displayName: 'Fixture', intendedEmail: 'first@example.test', expiresAt: new Date(Date.now() + 60000).toISOString() };
    for (const command of [{ ...base, workspaceId: 'invalid' }, { ...base, slug: '../path' },
      { ...base, displayName: ' bad' }, { ...base, intendedEmail: 'invalid' },
      { ...base, expiresAt: 'invalid' }, { ...base, ready: true },
      Object.defineProperty({ ...base }, '__proto__', { value: {}, enumerable: true })]) {
      await assert.rejects(module.prepare(command), refused);
    }
    await assert.rejects(module.activate({ workspaceId: base.workspaceId, enrollmentId: randomUUID(), projectId: randomUUID(), personId: randomUUID() }), refused);
    await module.close();
    assert.equal(connections, 0);
    await assert.rejects(module.prepare(base), refused);
  } finally { await module.close(); await new Promise(resolve => server.close(resolve)); }
});

test('platform preparation is inactive and activation checks locked current evidence', { timeout: 60000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-provision-'));
  let owner, admin;
  const clients = [], modules = [];
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 3 });
    applyMigrations(owner);
    const baseConnection = owner.applicationLogin().url();
    async function runtime(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN`);
      await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(baseConnection); url.username = role; url.password = password;
      const pool = new Pool({ connectionString: url.href, max: 2 }); clients.push(pool);
      return { pool, url: url.href };
    }
    const platform = await runtime('noticeos_platform'), identity = await runtime('noticeos_identity'), app = await runtime('noticeos_app');
    const sessionSecret = randomBytes(48).toString('base64url');
    let verificationCalls = 0;
    const options = { platformConnectionString: platform.url, identityConnectionString: identity.url, trustedOrigin, sessionSecret,
      verifyProject: async () => { verificationCalls++; throw new Error('Real executor qualification remains required'); } };
    const module = openPlatformProvisioning(options); modules.push(module);
    const documents = releasedDefaultDocuments();
    const expected = JSON.stringify(documents);
    async function prepare(name = randomUUID()) {
      const workspaceId = randomUUID();
      const result = await module.prepare({ workspaceId, slug: `fixture-${name}`, displayName: 'Canonical fixture', intendedEmail: 'FIRST@EXAMPLE.TEST', expiresAt: new Date(Date.now() + 3600000).toISOString() });
      assert.ok(Object.isFrozen(result)); return result;
    }
    async function eligible(prepared) {
      // Generated SQL facts qualify lock/refusal behavior only. Successful login
      // and real-executor activation are separate native/Worker acceptance.
      const personId = randomUUID(), projectId = randomUUID();
      await admin.query("INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Fixture','first@example.test',true,now(),now())", [personId]);
      await admin.query('UPDATE noticeos_identity.platform_enrollment SET verified_person_id=$1,verified_at=now() WHERE id=$2', [personId, prepared.enrollmentId]);
      const mapping = { workspaceId: prepared.workspaceId, projectId, executorRef: randomUUID(), credentialRef: randomUUID(), databaseKey: 'n_' + randomUUID().replaceAll('-', '') };
      await platform.pool.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
      return { ...prepared, ...mapping, personId };
    }
    let prepared;
    await t.test('complete generic documents and seed audits commit without membership', async () => {
      prepared = await prepare();
      assert.deepEqual((await admin.query('SELECT workspace_id,display_name,status FROM noticeos.workspaces WHERE workspace_id=$1', [prepared.workspaceId])).rows,
        [{ workspace_id: prepared.workspaceId, display_name: 'Canonical fixture', status: 'provisioning' }]);
      const stored = (await admin.query('SELECT document_key,body,version,updated_by FROM noticeos.config_documents WHERE workspace_id=$1 ORDER BY document_key', [prepared.workspaceId])).rows;
      assert.deepEqual(stored, documents.map(row => ({ document_key: row.key, body: JSON.parse(row.body), version: 1, updated_by: 'platform-provisioning' })));
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.config_changes WHERE workspace_id=$1', [prepared.workspaceId])).rows[0].n, documents.length);
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1', [prepared.workspaceId])).rows[0].n, 0);
      assert.equal((await admin.query('SELECT email,activated_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [prepared.enrollmentId])).rows[0].email, 'first@example.test');
      assert.equal(verificationCalls, 0);
    });
    await t.test('collisions and malformed envelopes roll back the entire preparation', async () => {
      await assert.rejects(module.prepare({ workspaceId: prepared.workspaceId, slug: 'other', displayName: 'Other', intendedEmail: 'first@example.test', expiresAt: new Date(Date.now() + 3600000).toISOString() }), refused);
      const absent = randomUUID();
      const call = 'SELECT noticeos_platform.prepare_workspace($1::uuid,$2,$3,$4,$5::timestamptz,$6::jsonb)';
      for (const envelope of [[], [{ key: 'tower', file: 'config/tower.json', body: '{}', extra: true }],
        [{ key: 'tower', file: 'config/tower.json', body: '{}' }, { key: 'tower', file: 'config/tower.json', body: '{}' }], [{ key: 'tower', file: 'config/tower.json', body: 'null' }]]) {
        await assert.rejects(platform.pool.query(call, [absent, `fixture-${absent}`, 'Fixture', 'first@example.test', new Date(Date.now() + 3600000).toISOString(), JSON.stringify(envelope)]));
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos.workspaces WHERE workspace_id=$1', [absent])).rows[0].n, 0);
    });
    await t.test('customer and identity roles cannot invoke platform functions or read protocol data as platform', async () => {
      for (const runtime of [identity, app]) {
        await assert.rejects(runtime.pool.query('SELECT noticeos_platform.lock_workspace_activation($1::uuid,$2::uuid,$3::uuid,$4::jsonb)', [prepared.workspaceId, prepared.enrollmentId, randomUUID(), expected]), error => error.code === '42501');
      }
      for (const table of ['auth_session', 'auth_account', 'auth_verification', 'auth_rate_limit'])
        await assert.rejects(platform.pool.query(`SELECT * FROM noticeos_identity.${table}`), error => error.code === '42501');
      await assert.rejects(platform.pool.query('UPDATE noticeos_identity.auth_user SET email=email'), error => error.code === '42501');
      await assert.rejects(platform.pool.query('SELECT * FROM noticeos.config_documents'), error => error.code === '42501');
    });
    await t.test('unverified enrollment and missing directory refuse before the real verifier', async () => {
      await assert.rejects(module.activate({ ...prepared, projectId: randomUUID() }), refused);
      assert.equal(verificationCalls, 0);
    });
    const facts = await eligible(prepared);
    const command = { workspaceId: facts.workspaceId, enrollmentId: facts.enrollmentId, projectId: facts.projectId };
    await t.test('default body/version/audit and current recipient drift refuse before verification', async () => {
      const original = documents.find(row => row.key === 'tower');
      for (const change of ["UPDATE noticeos.config_documents SET body='{}' WHERE document_key='tower'", 'UPDATE noticeos.config_documents SET version=2 WHERE document_key=\'tower\'']) {
        await admin.query(change + ' AND workspace_id=$1', [prepared.workspaceId]);
        await assert.rejects(module.activate(command), refused);
        await admin.query('UPDATE noticeos.config_documents SET body=$1::json,version=1 WHERE workspace_id=$2 AND document_key=$3', [original.body, prepared.workspaceId, 'tower']);
      }
      await admin.query("UPDATE noticeos.config_changes SET actor='changed' WHERE workspace_id=$1 AND document_key='tower'", [prepared.workspaceId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query("UPDATE noticeos.config_changes SET actor='platform-provisioning' WHERE workspace_id=$1 AND document_key='tower'", [prepared.workspaceId]);
      await admin.query("UPDATE noticeos_identity.auth_user SET email='changed@example.test' WHERE id=$1", [facts.personId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query("UPDATE noticeos_identity.auth_user SET email='first@example.test' WHERE id=$1", [facts.personId]);
      assert.equal(verificationCalls, 0);
    });
    await t.test('missing or extra defaults and missing seed coverage refuse before verification', async () => {
      const saved = (await admin.query("SELECT row_to_json(c) doc FROM noticeos.config_documents c WHERE workspace_id=$1 AND document_key='tower'", [prepared.workspaceId])).rows[0].doc;
      await admin.query("DELETE FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key='tower'", [prepared.workspaceId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query('INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,$2,$3::json,$4,$5::timestamptz,$6)',
        [saved.workspace_id, saved.document_key, JSON.stringify(saved.body), saved.version, saved.updated_at, saved.updated_by]);
      await admin.query("INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,'extra','{}',1,now(),'platform-provisioning')", [prepared.workspaceId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query("DELETE FROM noticeos.config_documents WHERE workspace_id=$1 AND document_key='extra'", [prepared.workspaceId]);
      const audit = (await admin.query("SELECT row_to_json(c) doc FROM noticeos.config_changes c WHERE workspace_id=$1 AND document_key='tower'", [prepared.workspaceId])).rows[0].doc;
      await admin.query('DELETE FROM noticeos.config_changes WHERE workspace_id=$1 AND change_id=$2', [prepared.workspaceId, audit.change_id]);
      await assert.rejects(module.activate(command), refused);
      await admin.query('INSERT INTO noticeos.config_changes(workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8::timestamptz)',
        [audit.workspace_id, audit.document_key, JSON.stringify(audit.ops), audit.reason, audit.actor, audit.version_before, audit.version_after, audit.changed_at]);
      assert.equal(verificationCalls, 0);
    });
    await t.test('a verification callback refusal cannot create an owner or activate the workspace', async () => {
      await assert.rejects(module.activate(command), refused);
      assert.equal(verificationCalls, 1);
      assert.equal((await admin.query('SELECT status FROM noticeos.workspaces WHERE workspace_id=$1', [prepared.workspaceId])).rows[0].status, 'provisioning');
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1', [prepared.workspaceId])).rows[0].n, 0);
      assert.equal((await admin.query('SELECT activated_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [prepared.enrollmentId])).rows[0].activated_at, null);
    });
    await t.test('expiry, revocation and canonical lifecycle refuse before verification', async () => {
      const until = (await admin.query('SELECT expires_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [prepared.enrollmentId])).rows[0].expires_at;
      await admin.query("UPDATE noticeos_identity.platform_enrollment SET expires_at=now()-interval '1 minute' WHERE id=$1", [prepared.enrollmentId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query('UPDATE noticeos_identity.platform_enrollment SET expires_at=$1,revoked_at=now() WHERE id=$2', [until, prepared.enrollmentId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query('UPDATE noticeos_identity.platform_enrollment SET revoked_at=NULL WHERE id=$1', [prepared.enrollmentId]);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [prepared.workspaceId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query("UPDATE noticeos.workspaces SET status='provisioning' WHERE workspace_id=$1", [prepared.workspaceId]);
      await platform.pool.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=now() WHERE workspace_id=$1 AND project_id=$2', [prepared.workspaceId, facts.projectId]);
      await assert.rejects(module.activate(command), refused);
      await admin.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=NULL WHERE workspace_id=$1 AND project_id=$2', [prepared.workspaceId, facts.projectId]);
      assert.equal(verificationCalls, 1);
    });
    await t.test('all current facts stay locked until a rejected verifier has finished cleanup', async () => {
      let reached, release;
      const entering = new Promise(resolve => { reached = resolve; });
      const cleanup = new Promise(resolve => { release = resolve; });
      const held = openPlatformProvisioning({ ...options, verifyProject: async (mapping, budget) => {
        assert.ok(Object.isFrozen(mapping)); assert.ok(Object.isFrozen(budget));
        assert.deepEqual(mapping, { workspaceId: facts.workspaceId, projectId: facts.projectId,
          executorRef: facts.executorRef, credentialRef: facts.credentialRef, databaseKey: facts.databaseKey });
        assert.ok(budget.deadline <= Date.now() + 30000); assert.equal(budget.signal.aborted, false);
        reached(); await cleanup; throw new Error('Synthetic verifier refused after cleanup');
      } });
      modules.push(held);
      const activation = held.activate(command);
      const rejected = assert.rejects(activation, refused);
      const competitor = await admin.connect();
      try {
        await Promise.race([entering, activation.then(() => assert.fail('Expected held verifier'), () => assert.fail('Verifier did not acquire the expected locks'))]);
        for (const [query, values] of [
          ["UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [facts.workspaceId]],
          ['UPDATE noticeos_platform.task_project_directory SET revoked_at=now() WHERE workspace_id=$1 AND project_id=$2', [facts.workspaceId, facts.projectId]],
          ["UPDATE noticeos_identity.auth_user SET email='changed@example.test' WHERE id=$1", [facts.personId]],
          ['UPDATE noticeos_identity.platform_enrollment SET revoked_at=now() WHERE id=$1', [facts.enrollmentId]],
          ["UPDATE noticeos.config_documents SET version=2 WHERE workspace_id=$1 AND document_key='tower'", [facts.workspaceId]],
        ]) {
          await competitor.query('BEGIN'); await competitor.query("SET LOCAL lock_timeout='100ms'");
          await assert.rejects(competitor.query(query, values), error => error.code === '55P03');
          await competitor.query('ROLLBACK');
        }
      } finally {
        release(); await rejected; await held.close();
        await competitor.query('ROLLBACK'); competitor.release();
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE organization_id=$1', [facts.workspaceId])).rows[0].n, 0);
      await platform.pool.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=now() WHERE workspace_id=$1 AND project_id=$2', [facts.workspaceId, facts.projectId]);
      await admin.query('UPDATE noticeos_platform.task_project_directory SET revoked_at=NULL WHERE workspace_id=$1 AND project_id=$2', [facts.workspaceId, facts.projectId]);
    });
    await t.test('excess column-update permission is refused by the platform preflight', async () => {
      await admin.query('GRANT UPDATE(email) ON noticeos_identity.auth_user TO noticeos_platform');
      const drifted = openPlatformProvisioning(options); modules.push(drifted);
      await assert.rejects(drifted.prepare({ workspaceId: randomUUID(), slug: 'new', displayName: 'Fixture', intendedEmail: 'first@example.test', expiresAt: new Date(Date.now() + 60000).toISOString() }), refused);
      await drifted.close();
      await admin.query('REVOKE UPDATE(email) ON noticeos_identity.auth_user FROM noticeos_platform');
    });
    await t.test('ordinary production Worker build prepares defaults and closes after denied activation', async () => {
      await workerPreparation(root, options, admin);
    });
    await t.test('maintained email verification binds new and existing people without granting membership', async () => {
      const email = 'verified-platform@example.test';
      let principalId;
      for (let attempt = 0; attempt < 2; attempt++) {
        const workspaceId = randomUUID();
        const prepared = await module.prepare({ workspaceId, slug: `verified-${workspaceId}`, displayName: 'Verified fixture',
          intendedEmail: email, expiresAt: new Date(Date.now() + 3600000).toISOString() });
        const messages = [];
        const login = openEmailCodeLogin({ connectionString: identity.url, trustedOrigin, sessionSecret,
          peerAddress: `192.0.2.${100 + attempt}`, deliver: async message => { messages.push(message); } });
        let facts;
        try {
          const original = (action, body) => new Request(trustedOrigin + EMAIL_CODE_PATHS[action], {
            method: 'POST', headers: { origin: trustedOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
          });
          const selector = { kind: 'platform', id: prepared.enrollmentId };
          const requested = await login.requestCode(original('request', { email }), selector);
          assert.equal(requested.status, 202); assert.deepEqual(await requested.json(), { ok: true });
          assert.equal(messages.length, 1); assert.equal(messages[0].email, email);
          const verified = await login.verifyCode(original('verify', { email, otp: messages[0].code }), selector);
          assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { ok: true });
          const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
          assert.ok(cookie);
          facts = await openIdentity({ connectionString: identity.url, trustedOrigin, sessionSecret });
          const session = await facts.session(new Headers({ cookie }));
          assert.ok(session);
          if (attempt === 0) principalId = session.principalId;
          else assert.equal(session.principalId, principalId, 'existing-person enrollment reuses the maintained identity');
          assert.equal(await facts.membership(new Headers({ cookie }), workspaceId), null);
          assert.deepEqual((await admin.query('SELECT verified_person_id,verified_at IS NOT NULL AS verified,activated_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [prepared.enrollmentId])).rows,
            [{ verified_person_id: principalId, verified: true, activated_at: null }]);
          assert.equal((await admin.query('SELECT status FROM noticeos.workspaces WHERE workspace_id=$1', [workspaceId])).rows[0].status, 'provisioning');
        } finally { await facts?.close(); await login.close(); }
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_user WHERE email=$1', [email])).rows[0].n, 1);
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_member WHERE user_id=$1', [principalId])).rows[0].n, 0);
    });
  } finally {
    const closed = await Promise.allSettled([...modules.map(module => module.close()), ...clients.map(pool => pool.end()), admin?.end()]);
    await owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
