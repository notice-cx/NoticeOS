import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { openIdentity, IdentityRefused } from '../packages/postgres/src/identity.mjs';
import { identityEngine } from '../packages/postgres/src/identity-engine.mjs';
import { findPostgres, PostgresUnavailable, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { stopLocalSecretReads } from './worker-config-folder.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const origin = 'https://fixture.example.test';
const original = (action, body, headers = { origin }) => new Request(`${origin}${EMAIL_CODE_PATHS[action]}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('email entry refuses unsafe requests before connection and exposes only fixed actions', async () => {
  const login = openEmailCodeLogin({ connectionString: 'postgresql://noticeos_identity@127.0.0.1:1/not_contacted',
    trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url'), peerAddress: '192.0.2.1', deliver: async () => {} });
  try {
    for (const headers of [{}, { origin: 'null' }, { origin: 'https://foreign.example.test' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      await assert.rejects(login.requestCode(original('request', { email: 'person@example.test' }, headers)), IdentityRefused);
    }
    await assert.rejects(login.requestCode(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin } })), IdentityRefused);
    assert.deepEqual(Object.keys(login).sort(), ['close', 'logout', 'requestCode', 'verifyCode']);
    await assert.rejects(login.requestCode(original('request', { email: 'person@example.test' }), { kind: 'platform', id: 'bad' }), IdentityRefused);
    await assert.rejects(login.requestCode(original('request', { email: 'x'.repeat(3000) })), IdentityRefused);
  } finally { await login.close(); }
  for (const peerAddress of ['', 'forwarded unknown', undefined]) assert.throws(() => openEmailCodeLogin({ connectionString: 'postgresql://noticeos_identity@127.0.0.1:1/db',
    trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url'), peerAddress, deliver: async () => {} }), IdentityRefused);
});

test('whole-body deadline and oversized tee refuse without identity connection or hanging close', { timeout: 8000 }, async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const login = openEmailCodeLogin({ connectionString: `postgresql://noticeos_identity@127.0.0.1:${server.address().port}/not_contacted`,
    trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url'), peerAddress: '192.0.2.1', deliver: async () => { assert.fail('no captured delivery'); } });
  const requests = [];
  try {
    const stalled = new Request(`${origin}${EMAIL_CODE_PATHS.request}`, { method: 'POST', headers: { origin }, duplex: 'half', body: new ReadableStream({ pull() { return new Promise(() => {}); } }) });
    requests.push(stalled);
    const started = performance.now();
    await assert.rejects(login.requestCode(stalled), IdentityRefused);
    assert.ok(performance.now() - started < 6500, 'whole-body deadline retires the action even when tee cancellation cannot settle');
    const oversized = new Request(`${origin}${EMAIL_CODE_PATHS.request}`, { method: 'POST', headers: { origin }, duplex: 'half', body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2049)); }, cancel() { return new Promise(() => {}); } }) });
    requests.push(oversized);
    await assert.rejects(login.requestCode(oversized), IdentityRefused);
    await login.close();
    assert.equal(connections, 0);
  } finally {
    for (const request of requests) void request.body.cancel().catch(() => undefined);
    await login.close(); await new Promise(resolve => server.close(resolve));
  }
});

test('owned email-code transactions preserve eligibility, attempts, cookies and narrow grants', { timeout: 60000 }, async (t) => {
  let tools;
  try { tools = findPostgres(); } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') return t.skip(error.message);
    throw error;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-login-'));
  const clients = [];
  let owner, admin, observer, runtime;
  let maintainedRateDdl;
  try {
    owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    observer = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));
    const { getMigrations } = await import(require.resolve('better-auth/db/migration'));
    const generationOptions = { connectionString: 'postgresql://noticeos_identity@127.0.0.1/fixture', trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url') };
    const context = await identityEngine(new Kysely({ dialect: new PostgresDialect({ pool: admin }) }), generationOptions, { transaction: true, emailCode: true, validateSchema: true }).$context;
    const generation = await getMigrations({ ...context.options, database: { dialect: new PostgresDialect({ pool: admin }), type: 'postgres', schemaName: 'noticeos_identity', transaction: true } });
    maintainedRateDdl = (await generation.compileMigrations()).match(/create table "noticeos_identity"\."auth_rate_limit"[^;]+;/u)?.[0];
    applyMigrations(owner);
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(owner.applicationLogin().url()); url.username = 'noticeos_identity'; url.password = password;
    const options = { connectionString: url.href, trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url') };
    runtime = new Pool({ connectionString: url.href, max: 1 });
    const delivered = [];
    let peer = 1;
    const client = (deliver = async message => { delivered.push(message); }, peerAddress = `192.0.2.${peer++}`) => {
      const login = openEmailCodeLogin({ ...options, peerAddress, deliver }); clients.push(login); return login;
    };
    const query = async (text, values = []) => (await admin.query(text, values)).rows;
    async function enrollment(email, status = 'provisioning') {
      const workspace = randomUUID(), id = randomUUID();
      await admin.query('INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,$3)', [workspace, `fixture-${workspace}`, status]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [workspace, `fixture-${workspace}`]);
      await admin.query("INSERT INTO noticeos_identity.platform_enrollment(id,workspace_id,email,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, workspace, email]);
      return { selector: { kind: 'platform', id }, workspace, email };
    }
    async function send(login, person, headers) {
      const before = delivered.length;
      const response = await login.requestCode(original('request', { email: person.email }, headers), person.selector);
      return { response, code: delivered[before]?.code };
    }
    const cookieFrom = response => response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const people = async email => (await query('SELECT count(*)::int n FROM noticeos_identity.auth_user WHERE email=$1', [email]))[0].n;

    await t.test('schema grants permit only verification facts and preserve canonical constraints', async () => {
      const committed = readFileSync(path.join(REPO_ROOT, 'db/postgres/migrations/0004_email_code.sql'), 'utf8').match(/CREATE TABLE noticeos_identity\.auth_rate_limit[^;]+;/u)?.[0];
      const shape = value => value?.toLowerCase().replaceAll('"', '').replace(/\s+/gu, '').replaceAll('pg_catalog.', '');
      assert.ok(maintainedRateDdl); assert.equal(shape(committed), shape(maintainedRateDdl));
      const person = await enrollment('constraints@example.test');
      await assert.rejects(runtime.query('INSERT INTO noticeos_identity.platform_enrollment(workspace_id,email,expires_at) VALUES($1,$2,now())', [person.workspace, person.email]), { code: '42501' });
      await assert.rejects(runtime.query('UPDATE noticeos_identity.platform_enrollment SET revoked_at=now() WHERE id=$1', [person.selector.id]), { code: '42501' });
      await assert.rejects(runtime.query('DELETE FROM noticeos_identity.platform_enrollment WHERE id=$1', [person.selector.id]), { code: '42501' });
      await assert.rejects(runtime.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', ['active', person.workspace]), { code: '42501' });
      await assert.rejects(admin.query("INSERT INTO noticeos_identity.platform_enrollment(workspace_id,email,expires_at) VALUES($1,$2,now())", [person.workspace, 'second@example.test']), { code: '23505' });
      await assert.rejects(admin.query("UPDATE noticeos_identity.platform_enrollment SET email='UPPER@example.test' WHERE id=$1", [person.selector.id]), { code: '23514' });
      await assert.rejects(runtime.query('UPDATE noticeos_identity.platform_enrollment SET verified_at=now() WHERE id=$1', [person.selector.id]), { code: '23514' });
      assert.equal((await runtime.query('SELECT status FROM noticeos_identity.lock_login_workspace($1)', [person.workspace])).rows[0].status, 'provisioning');
      assert.equal((await runtime.query("SELECT nullif(current_setting('noticeos.workspace_id',true),'') AS workspace")).rows[0].workspace, null);
      const prior = randomUUID();
      const scoped = await runtime.connect();
      try {
      await scoped.query('BEGIN');
      await scoped.query("SELECT set_config('noticeos.workspace_id',$1,true)", [prior]);
      await scoped.query('SELECT status FROM noticeos_identity.lock_login_workspace($1)', [person.workspace]);
      assert.equal((await scoped.query("SELECT current_setting('noticeos.workspace_id',true) AS workspace")).rows[0].workspace, prior);
      await assert.rejects(scoped.query('SELECT * FROM noticeos.assets'), { code: '42501' });
      await scoped.query('ROLLBACK');
      await assert.rejects(scoped.query('UPDATE noticeos.assets SET display_name=$1', ['Invalid']), { code: '42501' });
      await admin.query('BEGIN');
      await admin.query('SELECT workspace_id FROM noticeos.workspaces WHERE workspace_id=$1 FOR UPDATE', [person.workspace]);
      try {
        await scoped.query('BEGIN');
        await scoped.query("SELECT set_config('noticeos.workspace_id',$1,true)", [prior]);
        await scoped.query("SET LOCAL lock_timeout='50ms'");
        await scoped.query('SAVEPOINT owned_lock_refusal');
        await assert.rejects(scoped.query('SELECT status FROM noticeos_identity.lock_login_workspace($1)', [person.workspace]), { code: '55P03' });
        await scoped.query('ROLLBACK TO SAVEPOINT owned_lock_refusal');
        assert.equal((await scoped.query("SELECT current_setting('noticeos.workspace_id',true) AS workspace")).rows[0].workspace, prior);
      } finally { await scoped.query('ROLLBACK'); await admin.query('ROLLBACK'); }
      } finally { await scoped.query('ROLLBACK'); scoped.release(); }
    });
    await t.test('unknown people receive generic replies counted across independent clients', async () => {
      const a = client(undefined, '192.0.2.20'), b = client(undefined, '192.0.2.20');
      const replies = await Promise.all(Array.from({ length: 5 }, (_, i) => (i % 2 ? a : b).requestCode(original('request', { email: `unknown-${i}@example.test` }))));
      assert.deepEqual(replies.map(r => r.status).sort(), [202, 202, 202, 429, 429]);
      for (const reply of replies) { assert.equal(reply.headers.has('set-cookie'), false); assert.deepEqual(await reply.json(), { ok: reply.status === 202 }); }
      assert.equal((await query("SELECT count FROM noticeos_identity.auth_rate_limit WHERE key='192.0.2.20|/email-otp/send-verification-otp'"))[0].count, 3);
      assert.equal(delivered.length, 0);
    });
    const first = await enrollment('first@example.test');
    let firstCookie, firstPerson;
    await t.test('original headers and enrollment are snapshotted before an awaited body', async () => {
      const person = await enrollment('snapshot@example.test'), login = client();
      const selector = { ...person.selector }; let release;
      const stream = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ email: person.email }))); controller.close(); }; } });
      const request = new Request(`${origin}${EMAIL_CODE_PATHS.request}`, { method: 'POST', headers: { origin }, duplex: 'half', body: stream });
      const before = delivered.length, action = login.requestCode(request, selector);
      request.headers.set('origin', 'https://foreign.example.test'); selector.id = randomUUID(); release();
      assert.equal((await action).status, 202); assert.equal(delivered.length, before + 1);
    });
    await t.test('new invited person receives a maintained signed session only after commit', async () => {
      const login = client(async message => {
        const stored = await query('SELECT value FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${message.email}`]);
        assert.equal(stored.length, 1, 'delivery observes committed code'); assert.ok(!stored[0].value.includes(message.code));
        delivered.push(message);
      });
      const { response, code } = await send(login, first, { referer: `${origin}/login`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }); assert.equal(response.status, 202); assert.ok(code);
      assert.deepEqual(await response.json(), { ok: true });
      const verified = await login.verifyCode(original('verify', { email: first.email, otp: code }), first.selector);
      assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { ok: true });
      firstCookie = cookieFrom(verified); assert.ok(firstCookie);
      const identity = await openIdentity(options); clients.push(identity);
      const facts = await identity.session(new Headers({ cookie: firstCookie })); firstPerson = facts.principalId;
      const intent = (await query('SELECT verified_person_id,verified_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [first.selector.id]))[0];
      assert.equal(intent.verified_person_id, firstPerson); assert.ok(intent.verified_at);
      await assert.rejects(admin.query("INSERT INTO noticeos_identity.platform_enrollment(workspace_id,email,expires_at) VALUES($1,$2,now()+interval '1 hour')", [first.workspace, 'another@example.test']), { code: '23505' });
      assert.equal(await identity.membership(new Headers({ cookie: firstCookie }), first.workspace), null);
      assert.equal((await query('SELECT count(*)::int n FROM noticeos_identity.auth_member'))[0].n, 0);
      const replay = await login.verifyCode(original('verify', { email: first.email, otp: code }), first.selector);
      assert.equal(replay.status, 400); assert.equal(replay.headers.has('set-cookie'), false);
    });
    await t.test('existing zero-membership person may login without enrollment; explicit enrollment is still checked and recorded', async () => {
      const login = client(), existing = { email: first.email };
      const { code } = await send(login, existing);
      const reply = await login.verifyCode(original('verify', { email: existing.email, otp: code })); assert.equal(reply.status, 200);
      assert.equal(await people(first.email), 1);
      const target = await enrollment(first.email);
      const { code: nextCode } = await send(login, target);
      assert.equal((await login.verifyCode(original('verify', { email: first.email, otp: nextCode }), target.selector)).status, 200);
      assert.equal((await query('SELECT verified_person_id FROM noticeos_identity.platform_enrollment WHERE id=$1', [target.selector.id]))[0].verified_person_id, firstPerson);
      const invalid = { kind: 'platform', id: randomUUID() };
      const before = delivered.length;
      assert.equal((await login.requestCode(original('request', { email: first.email }), invalid)).status, 202); assert.equal(delivered.length, before);
    });
    await t.test('logout deletes the current server session; no-cookie logout is harmless', async () => {
      const login = client();
      const identity = await openIdentity(options); clients.push(identity);
      const current = await identity.session(new Headers({ cookie: firstCookie }));
      const bound = { origin, cookie: firstCookie, [WORKSPACE_SESSION_HEADER]: current.sessionId };
      for (const headers of [{ origin, cookie: firstCookie }, { ...bound, [WORKSPACE_SESSION_HEADER]: randomUUID() }]) {
        await assert.rejects(login.logout(original('logout', {}, headers)));
        assert.equal((await identity.session(new Headers({ cookie: firstCookie }))).sessionId, current.sessionId);
      }
      const response = await login.logout(original('logout', {}, bound)); assert.equal(response.status, 200);
      assert.equal(response.headers.has('set-cookie'), false, 'late logout cannot erase a newer login cookie');
      assert.equal(await identity.session(new Headers({ cookie: firstCookie })), null);
      assert.equal((await login.logout(original('logout', {}, { origin, [WORKSPACE_SESSION_HEADER]: current.sessionId }))).status, 200);
    });
    await t.test('no-cookie logout retains maintained durable rate accounting', async () => {
      const login = client(undefined, '192.0.2.199');
      const headers = { origin, [WORKSPACE_SESSION_HEADER]: randomUUID() };
      assert.equal((await login.logout(original('logout', {}, headers))).status, 200);
      const bucket = (await query("SELECT key,count FROM noticeos_identity.auth_rate_limit WHERE key LIKE '192.0.2.199|%'"))[0];
      assert.ok(bucket); assert.equal(bucket.count, 1);
      await admin.query('UPDATE noticeos_identity.auth_rate_limit SET count=10000 WHERE key=$1', [bucket.key]);
      const limited = await login.logout(original('logout', {}, headers));
      assert.equal(limited.status, 429); assert.equal(limited.headers.has('set-cookie'), false);
    });
    await t.test('pending membership invitation admits the verified recipient but creates no membership or consumed invite', async () => {
      const target = await enrollment('anchor@example.test', 'active');
      const inviteId = randomUUID(), email = 'member@example.test';
      await admin.query("INSERT INTO noticeos_identity.auth_invitation(id,organization_id,email,role,status,expires_at,inviter_id) VALUES($1,$2,$3,'viewer','pending',now()+interval '1 hour',$4)", [inviteId, target.workspace, email, firstPerson]);
      const person = { email, selector: { kind: 'invitation', id: inviteId } }, login = client();
      const { code } = await send(login, person);
      assert.equal((await login.verifyCode(original('verify', { email, otp: code }), person.selector)).status, 200);
      assert.equal((await query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1', [inviteId]))[0].status, 'pending');
      assert.equal((await query('SELECT count(*)::int n FROM noticeos_identity.auth_member'))[0].n, 0);
      const invalidRole = randomUUID(), invalidEmail = 'invalid-role@example.test';
      await admin.query("INSERT INTO noticeos_identity.auth_invitation(id,organization_id,email,role,status,expires_at,inviter_id) VALUES($1,$2,$3,'admin','pending',now()+interval '1 hour',$4)", [invalidRole, target.workspace, invalidEmail, firstPerson]);
      const before = delivered.length;
      assert.equal((await login.requestCode(original('request', { email: invalidEmail }), { kind: 'invitation', id: invalidRole })).status, 202);
      assert.equal(delivered.length, before); assert.equal(await people(invalidEmail), 0);
    });
    await t.test('expired, revoked, wrong-recipient and suspended enrollment never create a person', async () => {
      for (const mode of ['expired', 'revoked', 'recipient', 'suspended']) {
        const person = await enrollment(`${mode}@example.test`), login = client();
        const { code } = await send(login, person);
        if (mode === 'expired') await admin.query("UPDATE noticeos_identity.platform_enrollment SET expires_at=now()-interval '1 second' WHERE id=$1", [person.selector.id]);
        if (mode === 'revoked') await admin.query('UPDATE noticeos_identity.platform_enrollment SET revoked_at=now() WHERE id=$1', [person.selector.id]);
        if (mode === 'suspended') await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [person.workspace]);
        const email = mode === 'recipient' ? 'other@example.test' : person.email;
        const response = await login.verifyCode(original('verify', { email, otp: code }), person.selector);
        assert.equal(response.status, 400); assert.equal(response.headers.has('set-cookie'), false);
        assert.equal(await people(person.email), 0);
      }
    });
    await t.test('simultaneous verification consumes one platform enrollment on independent connections', async () => {
      const person = await enrollment('concurrent@example.test'), a = client(), b = client();
      const { code } = await send(a, person);
      const replies = await Promise.all([a, b].map(login => login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector)));
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 400]); assert.equal(await people(person.email), 1);
    });
    await t.test('earlier concurrent canonical suspension serializes and refuses verification', async () => {
      const person = await enrollment('lifecycle@example.test'), login = client(); const { code } = await send(login, person);
      await admin.query('BEGIN');
      await admin.query('SELECT id FROM noticeos_identity.auth_organization WHERE id=$1 FOR UPDATE', [person.workspace]);
      const attempt = login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector);
      let waiting = false;
      try {
        for (let i = 0; i < 100; i++) if ((await observer.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND wait_event_type='Lock'")).rows[0].n) { waiting = true; break; }
        assert.equal(waiting, true);
        await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [person.workspace]);
      } finally { await admin.query('COMMIT'); }
      assert.equal((await attempt).status, 400); assert.equal(await people(person.email), 0);
    });
    await t.test('canonical transition and revocation cannot cross verification commit', async () => {
      for (const transition of ['workspace', 'enrollment']) {
        const person = await enrollment(`locked-${transition}@example.test`), login = client();
        const { code } = await send(login, person);
        const gate = transition === 'workspace' ? 41001 : 41002;
        await admin.query(`CREATE FUNCTION noticeos_identity.fixture_pause_creation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$;
          CREATE TRIGGER fixture_pause_creation BEFORE INSERT ON noticeos_identity.auth_user FOR EACH ROW EXECUTE FUNCTION noticeos_identity.fixture_pause_creation()`);
        await admin.query('BEGIN'); await admin.query('SELECT pg_advisory_xact_lock($1)', [gate]);
        const verifying = login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector);
        let changing;
        try {
          let waiting = false;
          for (let i = 0; i < 100; i++) if ((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND wait_event_type='Lock'")).rows[0].n) { waiting = true; break; }
          assert.equal(waiting, true, 'verification reached the fixture barrier after acquiring eligibility locks');
          changing = transition === 'workspace'
            ? observer.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [person.workspace])
            : observer.query('UPDATE noticeos_identity.platform_enrollment SET revoked_at=now() WHERE id=$1', [person.selector.id]);
          let transitionWaiting = false;
          for (let i = 0; i < 100; i++) if ((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND usename='postgres' AND wait_event_type='Lock'")).rows[0].n) { transitionWaiting = true; break; }
          assert.equal(transitionWaiting, true, 'canonical mutation waits on the exact row until verification commit');
        } finally { await admin.query('COMMIT'); }
        assert.equal((await verifying).status, 200); await changing;
        assert.ok((await query('SELECT verified_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [person.selector.id]))[0].verified_at);
        await admin.query('DROP TRIGGER fixture_pause_creation ON noticeos_identity.auth_user');
        await admin.query('DROP FUNCTION noticeos_identity.fixture_pause_creation()');
      }
    });
    await t.test('wrong attempts, expiry and resend remain maintained and durable', async () => {
      const person = await enrollment('attempts@example.test'), login = client(); const { code } = await send(login, person);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 1; i <= 3; i++) {
        assert.equal((await login.verifyCode(original('verify', { email: person.email, otp: wrong }), person.selector)).status, 400);
        assert.equal((await query('SELECT value FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${person.email}`]))[0].value.split(':').at(-1), String(i));
      }
      assert.equal((await login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector)).status, 429);
      await admin.query("UPDATE noticeos_identity.auth_rate_limit SET last_request=last_request-61000 WHERE key LIKE '%|/sign-in/email-otp'");
      assert.equal((await login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector)).status, 403);
      const second = await enrollment('resend@example.test'), fresh = client();
      const oldCode = (await send(fresh, second)).code, newCode = (await send(fresh, second)).code;
      assert.equal((await fresh.verifyCode(original('verify', { email: second.email, otp: oldCode }), second.selector)).status, 400);
      await admin.query("UPDATE noticeos_identity.auth_verification SET expires_at=now()-interval '1 second' WHERE identifier=$1", [`sign-in-otp-${second.email}`]);
      assert.equal((await fresh.verifyCode(original('verify', { email: second.email, otp: newCode }), second.selector)).status, 400);
    });
    await t.test('real COMMIT failure rolls back code/person/counters and returns no secret', async () => {
      const person = await enrollment('rollback@example.test'), login = client(); const { code } = await send(login, person);
      await admin.query(`CREATE FUNCTION noticeos_identity.fixture_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
        CREATE CONSTRAINT TRIGGER fixture_commit_failure AFTER INSERT ON noticeos_identity.auth_user DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION noticeos_identity.fixture_commit_failure()`);
      try {
        await assert.rejects(login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector), error => error instanceof IdentityRefused && error.message === 'Identity operation refused');
        assert.equal(await people(person.email), 0);
        assert.equal((await query('SELECT verified_at FROM noticeos_identity.platform_enrollment WHERE id=$1', [person.selector.id]))[0].verified_at, null);
      } finally { await admin.query('DROP TRIGGER fixture_commit_failure ON noticeos_identity.auth_user'); await admin.query('DROP FUNCTION noticeos_identity.fixture_commit_failure()'); }
      assert.equal((await login.verifyCode(original('verify', { email: person.email, otp: code }), person.selector)).status, 200);
    });
    await t.test('post-commit delivery failure preserves truthful committed state and never returns the code', async () => {
      const person = await enrollment('delivery@example.test'), login = client(async () => { throw new Error('Captured delivery refusal'); });
      const reply = await login.requestCode(original('request', { email: person.email }), person.selector);
      assert.equal(reply.status, 503); assert.deepEqual(await reply.json(), { ok: false }); assert.equal(reply.headers.has('set-cookie'), false);
      assert.equal((await query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${person.email}`]))[0].n, 1);
    });
    await t.test('ordinary Worker bundle reuses the same product factory across independent runtimes', async () => {
      const wranglerRequire = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
      const wranglerPath = wranglerRequire.resolve('wrangler/package.json');
      const metadata = JSON.parse(readFileSync(wranglerPath, 'utf8'));
      const build = path.join(root, 'build'); mkdirSync(build);
      const config = path.join(root, 'wrangler.json');
      writeFileSync(config, JSON.stringify({ name: 'noticeos-login-fixture', main: path.join(REPO_ROOT, 'scripts/email-code-worker.fixture.mjs'), compatibility_date: '2026-07-06', compatibility_flags: ['nodejs_compat'], send_metrics: false }));
      const home = path.join(root, 'build-client'); mkdirSync(home);
      const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root,
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
        NODE_OPTIONS: `--import=${path.join(REPO_ROOT, 'scripts/script-tests-setup.mjs')}`,
        WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', BETTER_AUTH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
      stopLocalSecretReads(env);
      const compiled = spawnSync(process.execPath, [path.join(path.dirname(wranglerPath), metadata.bin.wrangler), 'deploy', '--dry-run', '--config', config, '--outdir', build], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
      assert.equal(compiled.error, undefined); assert.equal(compiled.status, 0, compiled.stderr);
      const bundle = path.join(build, 'email-code-worker.fixture.js'); assert.ok(!readFileSync(bundle, 'utf8').includes('node:sqlite'));
      const { Miniflare } = wranglerRequire('miniflare');
      const messages = [], runtimes = []; let outside = 0;
      try {
        for (let i = 0; i < 2; i++) runtimes.push(new Miniflare({ modules: true, modulesRoot: build, scriptPath: bundle,
          compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'],
          bindings: { FIXTURE_CONNECTION: options.connectionString, FIXTURE_ORIGIN: origin, FIXTURE_SECRET: options.sessionSecret, FIXTURE_PEER: '192.0.2.60' },
          serviceBindings: { CAPTURE_MAIL: async (request) => {
            const message = await request.json();
            assert.equal((await query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${message.email}`]))[0].n, 1, 'captured Worker delivery follows commit');
            messages.push(message); return new Response(null, { status: 204 });
          } }, outboundService: async () => { outside++; throw new Error('No outside HTTP in login fixture'); } }));
        const dispatch = (index, action, body, enrollmentId, headers = { origin }) => runtimes[index].dispatchFetch(`${origin}${EMAIL_CODE_PATHS[action]}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...(enrollmentId ? { 'x-fixture-enrollment': enrollmentId } : {}) }, body: JSON.stringify(body),
        });
        for (const headers of [{}, { origin: 'null' }, { origin, 'sec-fetch-site': 'cross-site' }]) assert.equal((await dispatch(0, 'request', { email: 'csrf-worker@example.test' }, undefined, headers)).status, 403);
        assert.equal((await query("SELECT count(*)::int n FROM noticeos_identity.auth_rate_limit WHERE key LIKE '192.0.2.60|%'"))[0].n, 0);
        const person = await enrollment('worker@example.test');
        assert.equal((await dispatch(0, 'request', { email: person.email }, person.selector.id)).status, 202);
        const responses = await Promise.all(runtimes.map((_, i) => dispatch(i, 'verify', { email: person.email, otp: messages[0].code }, person.selector.id)));
        assert.deepEqual(responses.map(reply => reply.status).sort(), [200, 400]);
        const cookie = cookieFrom(responses.find(reply => reply.status === 200));
        const identity = await openIdentity(options); clients.push(identity);
        assert.equal((await identity.session(new Headers({ cookie }))).principalId, (await query('SELECT verified_person_id FROM noticeos_identity.platform_enrollment WHERE id=$1', [person.selector.id]))[0].verified_person_id);
        const session = await identity.session(new Headers({ cookie }));
        assert.equal((await dispatch(1, 'logout', {}, undefined, { origin, cookie, [WORKSPACE_SESSION_HEADER]: randomUUID() })).status, 403);
        assert.equal((await identity.session(new Headers({ cookie }))).sessionId, session.sessionId);
        assert.equal((await dispatch(1, 'logout', {}, undefined, { origin, cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId })).status, 200);
        assert.equal(await identity.session(new Headers({ cookie })), null);
        const unknown = await Promise.all(Array.from({ length: 4 }, (_, i) => dispatch(i % 2, 'request', { email: `worker-unknown-${i}@example.test` })));
        assert.deepEqual(unknown.map(reply => reply.status).sort(), [202, 202, 429, 429]);
        assert.equal(messages.length, 1); assert.equal(outside, 0);
        assert.equal((await query('SELECT count(*)::int n FROM noticeos_identity.auth_member'))[0].n, 0);
      } finally {
        const disposed = await Promise.allSettled(runtimes.map(runtime => runtime.dispose()));
        for (const result of disposed) if (result.status === 'rejected') throw result.reason;
      }
    });
    await Promise.all(clients.map(login => login.close()));
    await runtime.end(); runtime = null;
    assert.equal((await query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND pid<>pg_backend_pid()"))[0].n, 0);
  } finally {
    const closed = await Promise.allSettled([...clients.map(login => login.close()), runtime?.end(), admin?.end(), observer?.end()].filter(Boolean));
    owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false, 'retain fixture when process absence is uncertain');
    rmSync(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
