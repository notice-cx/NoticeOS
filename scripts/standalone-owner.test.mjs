import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { findPostgres, LOOPBACK_HBA, MIGRATIONS_DIR } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

const script = path.join(import.meta.dirname, 'standalone-owner.mjs');
const installationOrigin = 'https://portfolio.example.test';
const ownerEmail = 'owner@example.test';
const migration = '0035_standalone_owner_handoff.sql';

async function operator(plan, action, enrollmentId, code) {
  const child = spawn(process.execPath, [script, action, plan, ...(enrollmentId ? [enrollmentId] : [])], {
    stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30000),
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => undefined);
  child.stdin.end(code ?? '');
  const [status] = await once(child, 'close');
  return { status, stdout, stderr, data: status === 0 ? JSON.parse(stdout) : undefined };
}

test('operator enrollment preserves a populated standalone workspace through ownership and return to standalone', { timeout: 90000 }, async t => {
  const root = testFixtureRoot('n-adopt-owner-');
  const tools = findPostgres();
  const workspaceId = randomUUID(), projectId = randomUUID(), ntasksWorkspaceId = randomUUID();
  const serviceToken = 'ntasks_service.' + randomBytes(24).toString('base64url');
  const wrongToken = 'ntasks_service.' + randomBytes(24).toString('base64url');
  const planFile = path.join(root, 'plan.json');
  const inbox = path.join(root, 'recipient.txt');
  const transport = path.join(root, 'mail-fixture');
  const identitySecret = randomBytes(48).toString('base64url');
  let owner, server, releaseProject, observedProject;
  const calls = [];
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools));
    if (!owner) return;
    const old = path.join(root, 'previous-release');
    mkdirSync(old, { mode: 0o700 });
    for (const name of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql') && name < migration)) {
      copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(old, name));
    }
    applyMigrations(owner, { dir: old });
    bootstrapWorkspace(owner, { slug: 'portfolio', displayName: 'Existing portfolio', workspaceId, dir: old });
    owner.run(`INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_by,updated_at) VALUES
      (:'id'::uuid,'constants','{"os_time_zone":"Europe/Paris"}',4,'operator','2026-09-13T10:00:00Z');
      INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
      VALUES (:'id'::uuid,'portfolio.example','portfolio.example','Existing site','live',1);
      INSERT INTO noticeos.pulses(workspace_id,pulse_number,asset_id,pulse_date,generated_at,received_at,envelope)
      VALUES (:'id'::uuid,1,'portfolio.example','2026-09-13','2026-09-13T10:00:00Z','2026-09-13T10:01:00Z','{}');`,
    { vars: { id: workspaceId } });
    const app = owner.applicationLogin().url();
    function login(role) {
      const secret = randomBytes(24).toString('base64url');
      owner.run(`ALTER ROLE ${role} LOGIN PASSWORD '${scramVerifier(secret)}';`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host noticeos_dev ${role} 127.0.0.1/32 scram-sha-256\n`);
      const endpoint = new URL(app);
      endpoint.username = role;
      endpoint.password = secret;
      return endpoint.href;
    }
    const plan = { format: 'noticeos-standalone-owner/1', workspaceId, intendedEmail: ownerEmail, trustedOrigin: installationOrigin,
      platformDatabaseUrl: login('noticeos_platform'), identityDatabaseUrl: login('noticeos_identity'), identitySecret,
      ntasks: { origin: '', workspaceId: ntasksWorkspaceId, projectId },
      mail: { sendmail: transport, from: 'sender@example.test' } };
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'ignore' });
    writeFileSync(transport, `#!${process.execPath}\nconst {createWriteStream}=require('node:fs');\nprocess.stdin.pipe(createWriteStream(${JSON.stringify(inbox)},{mode:0o600}));\n`, { mode: 0o700 });

    server = createServer(async (request, reply) => {
      const good = request.headers.authorization === `Bearer ${serviceToken}` && request.headers['x-ntasks-workspace'] === ntasksWorkspaceId;
      calls.push([request.method, request.url, good]);
      if (!good) { reply.writeHead(403).end(); return; }
      if (request.url === '/api/access/me') {
        if (observedProject) await new Promise(resolve => { releaseProject = resolve; observedProject(); });
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify({ kind: 'service', projects: [{ workspaceId: ntasksWorkspaceId, projectId, access: 'write' }] }));
      } else if (request.url === '/api/tasks/projects') {
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify({ projects: [{ projectId }] }));
      } else reply.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    plan.ntasks.origin = `http://127.0.0.1:${server.address().port}`;
    const writePlan = (overrides = {}) => writeFileSync(planFile, JSON.stringify({ ...plan, ...overrides }), { mode: 0o600 });
    const cmd = (action, enrollmentId, secret = action === 'activate' ? serviceToken : undefined) =>
      operator(planFile, action, enrollmentId, secret);
    const must = async (...args) => {
      const result = await cmd(...args);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, new RegExp(serviceToken.replaceAll('.', '\\.'), 'u'));
      return result.data;
    };
    const counts = () => owner.sql(`SELECT (SELECT count(*) FROM noticeos_identity.auth_member)::int AS members,
      (SELECT count(*) FROM noticeos_platform.workspace_service_grants)::int AS grants`)[0];
    const evidence = async () => {
      const store = openWorkspaceStore(app);
      try {
        assert.equal(await store.workspaceId(), workspaceId);
        return await store.read(async tx => tx.query(`SELECT (SELECT status FROM noticeos.workspaces) AS status,
          (SELECT md5(row_to_json(c)::text) FROM noticeos.config_documents c) AS config,
          (SELECT md5(row_to_json(p)::text) FROM noticeos.pulses p) AS report`));
      } finally { await store.close(); }
    };
    const before = await evidence();
    assert.equal(before[0].status, 'active');
    assert.ok(before[0].config && before[0].report);
    writePlan();
    const oldSchema = await cmd('prepare');
    assert.equal(oldSchema.status, 1);
    assert.match(oldSchema.stderr, /handoff migration/i);
    assert.deepEqual(counts(), { members: '0', grants: '0' });
    assert.deepEqual(applyMigrations(owner).applied, [migration.replace('.sql', '')]);
    assert.deepEqual(counts(), { members: '0', grants: '0' });

    writePlan({ workspaceId: randomUUID() });
    assert.equal((await cmd('prepare')).status, 1);
    writePlan();
    const extraWorkspace = randomUUID();
    owner.run("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES(:'id'::uuid,'other','Other fixture','active');", { vars: { id: extraWorkspace } });
    assert.equal((await cmd('prepare')).status, 1);
    assert.equal(owner.sql('SELECT count(*) FROM noticeos_identity.auth_organization')[0].count, '0');
    owner.run("DELETE FROM noticeos.workspaces WHERE workspace_id=:'id'::uuid;", { vars: { id: extraWorkspace } });
    owner.run("UPDATE noticeos.workspaces SET status='suspended'");
    assert.equal((await cmd('prepare')).status, 1);
    owner.run("UPDATE noticeos.workspaces SET status='active'");
    const pending = await must('prepare');
    assert.equal(pending.workspaceId, workspaceId);
    assert.deepEqual(owner.sql('SELECT id,name,slug FROM noticeos_identity.auth_organization'),
      [{ id: workspaceId, name: 'Existing portfolio', slug: 'portfolio' }]);
    assert.equal((await must('prepare')).enrollmentId, pending.enrollmentId);
    writePlan({ ntasks: { ...plan.ntasks, projectId: randomUUID() } });
    assert.equal((await cmd('prepare')).status, 1);
    writePlan();
    assert.equal((await cmd('activate', pending.enrollmentId)).status, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(counts(), { members: '0', grants: '0' });

    owner.run("UPDATE noticeos_identity.platform_enrollment SET expires_at=now()-interval '1s'");
    const renewed = await must('prepare');
    assert.notEqual(renewed.enrollmentId, pending.enrollmentId);
    assert.equal((await cmd('activate', pending.enrollmentId)).status, 1);
    writePlan({ mail: undefined });
    const unavailableMail = await cmd('send-code', renewed.enrollmentId);
    assert.equal(unavailableMail.status, 1);
    assert.equal(existsSync(inbox), false);
    writePlan();
    await must('send-code', renewed.enrollmentId);
    const letter = readFileSync(inbox, 'utf8');
    assert.match(letter, /^To: owner@example\.test$/mu);
    const code = /\b(\d{6})\./u.exec(letter)?.[1];
    assert.match(code ?? '', /^\d{6}$/u);
    const proof = await must('verify-code', renewed.enrollmentId, code);
    assert.equal(proof.emailVerified, true);
    assert.deepEqual(counts(), { members: '0', grants: '0' });
    assert.deepEqual(await evidence(), before);

    owner.run("UPDATE noticeos.workspaces SET status='suspended'");
    assert.equal((await cmd('activate', renewed.enrollmentId)).status, 1);
    owner.run("UPDATE noticeos.workspaces SET status='active'");
    writePlan({ intendedEmail: 'unverified@example.test' });
    assert.equal((await cmd('activate', renewed.enrollmentId)).status, 1);
    assert.deepEqual(calls, []);
    writePlan();
    assert.equal((await cmd('activate', renewed.enrollmentId, wrongToken)).status, 1);
    assert.deepEqual(calls.splice(0), [['GET', '/api/access/me', false]]);
    assert.deepEqual(counts(), { members: '0', grants: '0' });
    const verifying = new Promise(resolve => { observedProject = resolve; });
    const first = cmd('activate', renewed.enrollmentId);
    let second;
    try {
      await Promise.race([verifying, first.then(result => assert.fail(result.stderr || 'Project verification did not start'))]);
      second = cmd('activate', renewed.enrollmentId);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = owner.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='noticeos_platform'
          AND wait_event_type='Lock' AND query LIKE '%lock_standalone_owner%') AS waiting`)[0].waiting === 't';
        if (!waiting) await delay(15);
      }
      assert.equal(waiting, true);
      assert.deepEqual(counts(), { members: '0', grants: '0' });
    } finally {
      observedProject = undefined;
      releaseProject?.();
      await Promise.allSettled([first, second]);
    }
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(a.data, b.data);
    assert.deepEqual(calls, [['GET', '/api/access/me', true], ['GET', '/api/tasks/projects', true]]);
    assert.deepEqual(counts(), { members: '1', grants: '1' });
    assert.deepEqual(owner.sql('SELECT service_id,workspace_id,actions::text FROM noticeos_platform.workspace_service_grants'),
      [{ service_id: a.data.serviceId, workspace_id: workspaceId, actions: '{workflows.run}' }]);
    assert.equal((await cmd('prepare')).status, 1);
    assert.deepEqual(await evidence(), before);

    let signInCode;
    const options = { connectionString: plan.identityDatabaseUrl, sessionSecret: identitySecret, trustedOrigin: installationOrigin };
    const loginFlow = openEmailCodeLogin({ ...options, peerAddress: '127.0.0.2', async deliver(message) {
      signInCode = message.code;
    } });
    const identity = await openIdentity(options);
    const request = (action, body) => new Request(installationOrigin + EMAIL_CODE_PATHS[action], { method: 'POST',
      headers: { origin: installationOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      assert.equal((await loginFlow.requestCode(request('request', { email: ownerEmail }))).status, 202);
      assert.match(signInCode ?? '', /^\d{6}$/u);
      const signedIn = await loginFlow.verifyCode(request('verify', { email: ownerEmail, otp: signInCode }));
      assert.equal(signedIn.status, 200);
      const headers = new Headers({ cookie: signedIn.headers.getSetCookie().map(header => header.split(';')[0]).join('; ') });
      const session = await identity.session(headers);
      assert.equal(await identity.isWorkspaceOwner(workspaceId, session.principalId), true);
    } finally { await loginFlow.close(); await identity.close(); }
    assert.deepEqual(await evidence(), before);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    owner?.close();
    if (!existsSync(path.join(root, 'pg/data/postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});
