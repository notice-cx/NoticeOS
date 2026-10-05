// Owned synthetic composition only. The outer task fixture retains teardown
// authority; this fixture owns only a fresh Postgres cluster and Worker runtime.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { openOnLoopbackPort } from '../postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from '../postgres-dev.mjs';
import { applyMigrations } from '../postgres-migrate.mjs';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { stopLocalSecretReads } from '../worker-config-folder.mjs';
import { createWorkspaceAdmission } from '../workspace-admission.mjs';
import { createHostedTaskExecutor } from '../hosted-task-executor.mjs';
import { openTaskDirectory } from '../../packages/postgres/src/task-directory.mjs';
import { openPlatformProvisioning, PlatformProvisioningRefused } from '../../packages/postgres/src/platform-provisioning.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../../packages/postgres/src/identity.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const origin = 'https://provision.example.test';
const email = 'first-owner@example.test';
const original = (action, body) => new Request(origin + EMAIL_CODE_PATHS[action], {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export async function provePlatformActivation(t, physical) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-activation-'));
  const clients = [], modules = [];
  let owner, admin, directory, worker;
  try {
    const tools = findPostgres();
    owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    applyMigrations(owner);
    const base = owner.applicationLogin().url();
    async function connection(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(base); url.username = role; url.password = password;
      const pool = new Pool({ connectionString: url.href, max: 1 }); clients.push(pool);
      return { url: url.href, pool };
    }
    const platform = await connection('noticeos_platform');
    const identity = await connection('noticeos_identity');
    const taskRole = await connection('noticeos_task_directory');
    const sessionSecret = randomBytes(48).toString('base64url');
    directory = openTaskDirectory({ connectionString: taskRole.url });
    const executor = createHostedTaskExecutor({
      // Verification is a platform-only method, not tenant dispatch. No fixture
      // admission can authorize a task effect through this instance.
      admission: createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, membership: async () => null }),
      directory, resolveTarget: physical.resolveTarget, binary: physical.pinnedBinary,
      doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot,
    });
    let nativeChecks = 0, workerChecks = 0;
    const options = { platformConnectionString: platform.url, identityConnectionString: identity.url, trustedOrigin: origin, sessionSecret,
      verifyProject: async (mapping, budget) => {
        nativeChecks++;
        const result = await executor.verifyProject(mapping, budget);
        executor.assertVerifiedProject(result, mapping);
      } };
    const provisioning = openPlatformProvisioning(options); modules.push(provisioning);
    const prepared = [];
    for (const mapping of physical.mappings) {
      prepared.push(await provisioning.prepare({ workspaceId: mapping.workspaceId, slug: `platform-${mapping.workspaceId}`,
        displayName: 'Canonical workspace', intendedEmail: email, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
      await platform.pool.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)',
        [mapping.workspaceId, mapping.projectId, mapping.executorRef, mapping.credentialRef, mapping.databaseKey]);
    }
    const reader = await openIdentity({ connectionString: identity.url, trustedOrigin: origin, sessionSecret }); modules.push(reader);
    let personId;
    await t.test('new verified person stays unadmitted until one concurrent real native activation commits', async () => {
      const messages = [];
      const login = openEmailCodeLogin({ connectionString: identity.url, trustedOrigin: origin, sessionSecret,
        peerAddress: '192.0.2.210', deliver: async message => { messages.push(message); } }); modules.push(login);
      const selector = { kind: 'platform', id: prepared[0].enrollmentId };
      const requested = await login.requestCode(original('request', { email }), selector);
      assert.equal(requested.status, 202); assert.deepEqual(await requested.json(), { ok: true });
      assert.equal(messages.length, 1);
      const verified = await login.verifyCode(original('verify', { email, otp: messages[0].code }), selector);
      assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { ok: true });
      const headers = new Headers({ cookie: verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
      const session = await reader.session(headers); assert.ok(session); personId = session.principalId;
      assert.equal(await reader.membership(headers, prepared[0].workspaceId), null);
      const command = { ...prepared[0], projectId: physical.mappings[0].projectId };
      const results = await Promise.allSettled([provisioning.activate(command), provisioning.activate(command)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected'); assert.ok(rejected.reason instanceof PlatformProvisioningRefused);
      assert.equal(nativeChecks, 1);
      assert.deepEqual((await admin.query('SELECT user_id,role FROM noticeos_identity.auth_member WHERE organization_id=$1', [prepared[0].workspaceId])).rows,
        [{ user_id: personId, role: 'owner' }]);
      assert.equal((await reader.admissionMembership(headers, prepared[0].workspaceId)).workspaceStatus, 'active');
      await assert.rejects(provisioning.activate(command), PlatformProvisioningRefused);
    });

    const workerRequire = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
    const wranglerPath = workerRequire.resolve('wrangler/package.json');
    const metadata = JSON.parse(readFileSync(wranglerPath, 'utf8'));
    const build = path.join(root, 'build'); mkdirSync(build);
    const config = path.join(root, 'wrangler.json');
    writeFileSync(config, JSON.stringify({ name: 'noticeos-platform-activation-proof', main: path.join(REPO_ROOT, 'scripts/platform-provisioning-worker.fixture.mjs'),
      compatibility_date: '2026-07-06', compatibility_flags: ['nodejs_compat'], send_metrics: false }));
    const home = path.join(root, 'worker-client'); mkdirSync(home);
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root,
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
      NODE_OPTIONS: `--import=${path.join(REPO_ROOT, 'scripts/script-tests-setup.mjs')}`,
      WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', DO_NOT_TRACK: '1', NO_COLOR: '1' };
    stopLocalSecretReads(env);
    const compiled = spawnSync(process.execPath, [path.join(path.dirname(wranglerPath), metadata.bin.wrangler), 'deploy', '--dry-run', '--config', config, '--outdir', build],
      { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
    const { Miniflare } = workerRequire('miniflare');
    const messages = []; let outside = 0, entered, release;
    const verificationEntered = new Promise(resolve => { entered = resolve; });
    const continueActivation = new Promise(resolve => { release = resolve; });
    worker = new Miniflare({ modules: true, modulesRoot: build, scriptPath: path.join(build, 'platform-provisioning-worker.fixture.js'),
      compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'], bindings: {
        FIXTURE_PLATFORM_CONNECTION: platform.url, FIXTURE_IDENTITY_CONNECTION: identity.url,
        FIXTURE_SESSION_SECRET: sessionSecret, FIXTURE_ENROLLMENT_ID: prepared[1].enrollmentId,
      }, serviceBindings: {
        FIXTURE_MAIL: async request => { messages.push(await request.json()); return new Response(null, { status: 204 }); },
        FIXTURE_VERIFIER: async request => {
          const { mapping, deadline } = await request.json();
          assert.deepEqual(mapping, physical.mappings[1]); assert.equal(typeof deadline, 'number');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(30000, deadline - Date.now())));
          try {
            workerChecks++;
            const result = await executor.verifyProject(mapping, { signal: controller.signal, deadline });
            executor.assertVerifiedProject(result, mapping);
            entered(); await continueActivation;
            assert.equal(controller.signal.aborted, false);
            return new Response(null, { status: 204 });
          } finally { clearTimeout(timer); }
        },
      }, outboundService: async () => { outside++; throw new Error('No outside HTTP'); } });
    await t.test('ordinary Worker verifies the existing person and awaits actual Node custody before activation', async () => {
      const dispatchLogin = (action, body) => worker.dispatchFetch(origin + EMAIL_CODE_PATHS[action], {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const requested = await dispatchLogin('request', { email });
      assert.equal(requested.status, 202); assert.deepEqual(await requested.json(), { ok: true }); assert.equal(messages.length, 1);
      const verified = await dispatchLogin('verify', { email, otp: messages[0].code });
      assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { ok: true });
      const headers = new Headers({ cookie: verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
      assert.equal((await reader.session(headers)).principalId, personId);
      assert.equal(await reader.membership(headers, prepared[1].workspaceId), null);
      const command = { ...prepared[1], projectId: physical.mappings[1].projectId };
      const activate = () => worker.dispatchFetch(origin + '/activate', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(command) });
      for (const change of ["UPDATE noticeos_identity.auth_user SET email='changed@example.test' WHERE id=$1",
        'UPDATE noticeos_identity.auth_user SET email_verified=false WHERE id=$1']) {
        await admin.query(change, [personId]);
        const refused = await activate(); assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { refused: true });
        await admin.query('UPDATE noticeos_identity.auth_user SET email=$1,email_verified=true WHERE id=$2', [email, personId]);
      }
      assert.equal(workerChecks, 0);
      const activation = activate();
      const competitor = await admin.connect();
      let activated;
      try {
        await Promise.race([verificationEntered, activation.then(() => assert.fail('Expected mapping-held verifier'))]);
        await competitor.query("SET lock_timeout='100ms'");
        for (const [query, values] of [
          ["UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [prepared[1].workspaceId]],
          ['UPDATE noticeos_identity.platform_enrollment SET revoked_at=now() WHERE id=$1', [prepared[1].enrollmentId]],
          ['UPDATE noticeos_identity.auth_user SET email_verified=false WHERE id=$1', [personId]],
          ['UPDATE noticeos_platform.task_project_directory SET revoked_at=now() WHERE workspace_id=$1 AND project_id=$2', [prepared[1].workspaceId, physical.mappings[1].projectId]],
        ]) await assert.rejects(competitor.query(query, values), error => error.code === '55P03');
      } finally { release(); competitor.release(); activated = await activation; }
      assert.equal(activated.status, 200); assert.deepEqual(await activated.json(), prepared[1]);
      assert.equal(workerChecks, 1); assert.equal(nativeChecks, 1);
      assert.deepEqual((await admin.query('SELECT user_id,role FROM noticeos_identity.auth_member WHERE organization_id=$1', [prepared[1].workspaceId])).rows,
        [{ user_id: personId, role: 'owner' }]);
      assert.equal((await reader.admissionMembership(headers, prepared[1].workspaceId)).workspaceStatus, 'active');
      assert.deepEqual((await admin.query('SELECT verified_person_id,activated_at IS NOT NULL AS activated FROM noticeos_identity.platform_enrollment WHERE id=$1', [prepared[1].enrollmentId])).rows,
        [{ verified_person_id: personId, activated: true }]);
      assert.equal(outside, 0);
    });
  } finally {
    const workerClosed = await Promise.allSettled([worker?.dispose()]);
    const closed = await Promise.allSettled([...modules.map(value => value.close()), directory?.close(), ...clients.map(pool => pool.end()), admin?.end()]);
    await owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    for (const result of workerClosed) if (result.status === 'rejected') throw result.reason;
    rmSync(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}
