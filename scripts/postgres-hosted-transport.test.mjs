import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';
import { observeTransport, observeLock, tryLock } from '../packages/postgres/test/hosted-transport.fixture.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
async function waitAcquired(acquired, completed) {
  let timer;
  try { await Promise.race([acquired, completed.then(() => { throw new Error('lock transaction ended before acquisition'); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lock acquisition deadline')), 15000); })]); }
  finally { clearTimeout(timer); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('direct hosted PostgreSQL preserves actual transactions, fresh facts and locks in native and ordinary Worker', { timeout: 120000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-transport-'));
  let owner, admin, runtime, identity, login;
  const workspaces = [randomUUID(), randomUUID()], person = randomUUID();
  const origin = 'https://transport.example.test', secret = randomBytes(48).toString('base64url');
  const key = (randomBytes(8).readBigUInt64BE() & ((1n << 63n) - 1n)).toString();
  let barrier;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    applyMigrations(owner);
    const appConnection = owner.applicationLogin().url();
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const identityUrl = new URL(appConnection); identityUrl.username = 'noticeos_identity'; identityUrl.password = password;
    const options = { connectionString: identityUrl.href, trustedOrigin: origin, sessionSecret: secret };
    for (const [index, workspace] of workspaces.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [workspace, `transport-${index}`]);
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,'shared.example','shared.example',$2,'live',1)", [workspace, `Workspace ${index}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [workspace, `transport-${index}`]);
    }
    await admin.query("INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Generated person','person@example.test',true,now(),now())", [person]);
    await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now())", [randomUUID(), workspaces[0], person]);
    const mail = [];
    login = openEmailCodeLogin({ ...options, peerAddress: '192.0.2.1', deliver: async message => { mail.push(message); } });
    const original = (action, body) => new Request(origin + EMAIL_CODE_PATHS[action], { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await login.requestCode(original('request', { email: 'person@example.test' }))).status, 202);
    assert.equal(mail.length, 1);
    const signedIn = await login.verifyCode(original('verify', { email: 'person@example.test', otp: mail[0].code }));
    assert.equal(signedIn.status, 200);
    const headers = new Headers({ cookie: signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') });
    assert.ok(headers.get('cookie'));
    identity = await openIdentity(options);
    const config = await bundleWorkerFixture(root, 'direct-transport', path.join(REPO_ROOT, 'packages/postgres/test/hosted-transport.fixture.mjs'));
    runtime = new Miniflare({ ...config, bindings: { DATABASE: appConnection, IDENTITY: identityUrl.href, ORIGIN: origin, SECRET: secret, WORKSPACES: workspaces, LOCK: key },
      serviceBindings: { BARRIER: async () => { assert.ok(barrier); barrier.acquired.resolve(); await barrier.release.promise; return new Response(null, { status: 204 }); } } });
    const fetch = async route => { const reply = await runtime.dispatchFetch(origin + route, { headers }); assert.equal(reply.status, 200); return reply.json(); };
    const resetAssets = async () => { for (const [index, workspace] of workspaces.entries()) await admin.query('UPDATE noticeos.assets SET display_name=$2 WHERE workspace_id=$1', [workspace, `Workspace ${index}`]); };
    const check = result => {
      assert.equal(result.first.pid, result.second.pid, 'a single actual pooled connection is reused between A and B');
      assert.deepEqual([result.first.display_name, result.second.display_name], ['Workspace 0', 'Workspace 1']);
      assert.deepEqual(result.interleaved.map(row => row.display_name), ['Workspace 0', 'Workspace 1', 'Workspace 0', 'Workspace 1']);
      assert.ok(result.interleaved.every(row => row.pid === result.first.pid), 'concurrent callers serialize on the same actual connection');
      assert.equal(result.failed, true);
      assert.deepEqual(result.afterFailure.map(row => row.display_name), ['Workspace 0', 'Workspace 1']);
      assert.deepEqual(result.afterWrite.map(row => row.display_name), ['Fresh write', 'Workspace 1']);
      assert.equal(result.inside, workspaces[0]); assert.deepEqual(result.reset, { scope: null, visible: 0 });
      assert.equal(result.rawFailed, true);
      assert.deepEqual(result.rollbackReset, { scope: null, visible: 0 });
      assert.equal(result.reusedAfterRollback, 'Workspace 1');
      assert.equal(result.malformedRefused, true);
    };
    await t.test('native direct driver reuses one pool safely after failures and observes writes immediately', async () => { check(await observeTransport(appConnection, workspaces)); });
    await t.test('ordinary Worker bundle preserves identical SQL isolation, rollback and uncached write-read facts', async () => { await resetAssets(); check(await fetch('/probe')); });
    for (const hashed of [false, true]) for (const rollback of [false, true]) await t.test(`native ${hashed ? 'hashed' : 'bigint'} advisory transaction lock conflicts and releases on ${rollback ? 'rollback' : 'commit'}`, async () => {
      const acquired = deferred(), release = deferred();
      const held = observeLock(appConnection, workspaces[0], key, async () => { acquired.resolve(); await release.promise; if (rollback) throw new Error('fixture rollback'); }, hashed);
      const observed = held.then(value => ({ value }), error => ({ error }));
      let result;
      try { await waitAcquired(acquired.promise, observed); assert.equal(await tryLock(appConnection, workspaces[1], key, hashed), false); }
      finally { release.resolve(); result = await observed; }
      if (rollback) assert.equal(result.error?.message, 'fixture rollback'); else assert.equal(result.value, 'held');
      assert.equal(await tryLock(appConnection, workspaces[1], key, hashed), true);
    });
    for (const hashed of [false, true]) for (const rollback of [false, true]) await t.test(`ordinary Worker independent ${hashed ? 'hashed' : 'bigint'} transaction lock releases on ${rollback ? 'rollback' : 'commit'}`, async () => {
      barrier = { acquired: deferred(), release: deferred() };
      const suffix = hashed ? '?hashed=1' : '';
      const held = fetch((rollback ? '/rollback' : '/hold') + suffix).then(value => ({ value }), error => ({ error }));
      let result;
      try { await waitAcquired(barrier.acquired.promise, held); assert.equal(await fetch('/try' + suffix), false); }
      finally { barrier.release.resolve(); result = await held; }
      if (result.error) throw result.error;
      assert.deepEqual(result.value, rollback ? { rolledBack: true } : 'held');
      assert.equal(await fetch('/try' + suffix), true); barrier = undefined;
    });
    await t.test('fresh maintained signed session/member facts immediately reflect role, membership and session revocation', async () => {
      const session = await identity.session(headers); assert.equal(session.principalId, person);
      const current = await fetch('/facts'); assert.equal(current.session.sessionId, session.sessionId); assert.equal(current.membership.role, 'operator');
      await admin.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [workspaces[0], person]);
      assert.equal((await identity.membership(headers, workspaces[0])).role, 'viewer'); assert.equal((await fetch('/facts')).membership.role, 'viewer');
      await admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [workspaces[0], person]);
      assert.equal(await identity.membership(headers, workspaces[0]), null); assert.equal((await fetch('/facts')).membership, null);
      await admin.query('DELETE FROM noticeos_identity.auth_session WHERE id=$1', [session.sessionId]);
      assert.equal(await identity.session(headers), null); assert.deepEqual(await fetch('/facts'), { session: null, membership: null });
    });
  } finally {
    barrier?.release.resolve();
    const closed = await Promise.allSettled([runtime?.dispose(), identity?.close(), login?.close(), admin?.end()]);
    await owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false, 'owned PostgreSQL must be absent before removing fixture');
    rmSync(root, { recursive: true, force: true });
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
