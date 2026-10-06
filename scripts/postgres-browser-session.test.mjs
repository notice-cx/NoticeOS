import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:net';
import { readBrowserSession, WORKSPACE_CHOICES_PAGE_SIZE } from '../packages/postgres/src/browser-session.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { IdentityRefused } from '../packages/postgres/src/identity.mjs';
import { PRODUCT_ENV } from './product-env.mjs';
import { WORKSPACE_SELECTION_HEADER } from './workspace-entry.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture as bundle, Miniflare } from './worker-entry-test-fixture.mjs';

const identityRequire = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = identityRequire('pg');

test('browser bootstrap reads fresh choices through native identity and the ordinary Tower Worker', { timeout: 120000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-session-'));
  const clients = [];
  let owner, admin, runtime, sentinel;
  let outside = 0, operational = 0, databaseContacts = 0;
  try {
    const tower = await bundle(root, 'session-tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts'));
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    const postmaster = Number(readFileSync(path.join(owner.root, 'data/postmaster.pid'), 'utf8').split('\n')[0]);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(owner.applicationLogin().url()); url.username = 'noticeos_identity'; url.password = password;
    const origin = 'https://fixture.example.test';
    const options = { connectionString: url.href, trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url') };
    async function person(email) {
      const principalId = randomUUID();
      await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$2,true,now(),now())', [principalId, email]);
      const delivered = [];
      const login = openEmailCodeLogin({ ...options, peerAddress: `192.0.2.${clients.length + 1}`, deliver: async message => { delivered.push(message); } });
      clients.push(login);
      const request = action => new Request(`${origin}${EMAIL_CODE_PATHS[action]}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(action === 'request' ? { email } : { email, otp: delivered.at(-1)?.code }) });
      assert.equal((await login.requestCode(request('request'))).status, 202);
      assert.equal(delivered.length, 1);
      const response = await login.verifyCode(request('verify')); assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      assert.ok(cookie);
      const snapshot = await readBrowserSession(options, new Headers({ cookie }));
      assert.equal(snapshot.session.principalId, principalId);
      return { principalId, cookie, sessionId: snapshot.session.sessionId };
    }
    const personA = await person('person-a@example.test');
    const personB = await person('person-b@example.test');
    const expired = await person('expired@example.test');
    const revoked = await person('revoked@example.test');
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    const demoId = randomUUID(), foreignId = randomUUID();
    // Batch the page-boundary data, while using the real maintained login for
    // each person. Canonical workspaces and identity organizations share IDs.
    for (const target of [ids, [demoId, foreignId]]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) SELECT id,'fixture-'||id,'Workspace '||id,'active' FROM unnest($1::uuid[]) id", [target]);
      await admin.query("INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) SELECT id,'Workspace '||id,'fixture-'||id,now() FROM unnest($1::uuid[]) id", [target]);
    }
    await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) SELECT gen_random_uuid(),id,$2::uuid,'owner',now() FROM unnest($1::uuid[]) id", [ids, personA.principalId]);
    const first = ids[0], selected = ids.at(-1);
    const signedOut = { mode: 'hosted', session: null, workspaces: [], nextCursor: null, selectedWorkspace: null };
    const common = {
      [PRODUCT_ENV.workspaceProfile.name]: 'hosted', [PRODUCT_ENV.workspaceOrigin.name]: origin,
      [PRODUCT_ENV.identityDatabase.name]: options.connectionString, [PRODUCT_ENV.identitySecret.name]: options.sessionSecret,
    };
    const driver = `export default {async fetch(request, env) {
      const asked = await request.json();
      const response = await env[asked.target].fetch(new Request(asked.url, asked.init));
      return Response.json({status:response.status,headers:[...response.headers],body:await response.json()});
    }};`;
    const worker = (name, bindings) => ({ name, ...tower, bindings,
      serviceBindings: { INGEST: async () => { operational++; throw new Error('No operational store in session fixture'); } },
      outboundService: async () => { outside++; throw new Error('No outside HTTP in session fixture'); } });
    sentinel = createServer(socket => { databaseContacts++; socket.destroy(); });
    await new Promise((resolve, reject) => { sentinel.once('error', reject); sentinel.listen(0, '127.0.0.1', resolve); });
    const sentinelUrl = `postgresql://noticeos_identity@127.0.0.1:${sentinel.address().port}/not_contacted`;
    runtime = new Miniflare({ workers: [
      { name: 'driver', modules: true, script: driver, compatibilityDate: '2026-07-06', serviceBindings: { HOSTED: 'hosted', DEMO: 'demo', STANDALONE: 'standalone', INVALID: 'invalid' } },
      worker('hosted', common), worker('demo', { ...common, [PRODUCT_ENV.workspaceProfile.name]: 'demo', [PRODUCT_ENV.demoWorkspace.name]: demoId }),
      worker('standalone', { ...common, [PRODUCT_ENV.workspaceProfile.name]: 'standalone',
        [PRODUCT_ENV.identityDatabase.name]: sentinelUrl, POSTGRES: { connectionString: sentinelUrl } }),
      worker('invalid', { [PRODUCT_ENV.workspaceProfile.name]: 'not-a-profile' }),
    ] });
    const request = async (person, selectedId = null, after = null, target = 'HOSTED', extra = {}) => {
      const headers = { ...(person ? { cookie: person.cookie } : {}), ...(selectedId ? { [WORKSPACE_SELECTION_HEADER]: selectedId } : {}), ...extra };
      const response = await runtime.dispatchFetch('https://fixture-driver/', { method: 'POST', body: JSON.stringify({ target,
        url: `${origin}/api/session${after ? `?after=${after}` : ''}`, init: { headers } }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      const resultHeaders = new Headers(result.headers);
      assert.equal(resultHeaders.get('cache-control'), 'no-store'); assert.equal(resultHeaders.get('vary'), 'Cookie');
      assert.equal(resultHeaders.has('set-cookie'), false);
      const serialized = JSON.stringify(result.body);
      for (const secret of [options.sessionSecret, options.connectionString, password, person?.cookie].filter(Boolean)) assert.equal(serialized.includes(secret), false);
      return result;
    };
    const read = (person, selectedId = null, after = null) => readBrowserSession(options, new Headers({ cookie: person.cookie }), selectedId, after);

    await t.test('101 choices paginate deterministically and selection outside the page is independent', async () => {
      const native = await read(personA, selected);
      assert.equal(WORKSPACE_CHOICES_PAGE_SIZE, 100); assert.equal(native.workspaces.length, 100);
      assert.deepEqual(native.workspaces.map(row => row.workspaceId), ids.slice(0, 100));
      assert.equal(native.nextCursor, ids[99]); assert.equal(native.selectedWorkspace.workspaceId, selected);
      assert.equal(Object.isFrozen(native), true); assert.equal(Object.isFrozen(native.workspaces), true);
      assert.ok(native.workspaces.every(Object.isFrozen)); assert.equal(Object.isFrozen(native.session), true);
      const proof = new Headers({ cookie: personA.cookie });
      const pending = readBrowserSession(options, proof, selected); proof.set('cookie', personB.cookie);
      assert.equal((await pending).session.principalId, personA.principalId, 'request headers are copied before connection awaits');
      const response = await request(personA, selected); assert.equal(response.status, 200); assert.deepEqual(response.body, { mode: 'hosted', ...native });
      const last = await read(personA, first, native.nextCursor);
      assert.deepEqual(last.workspaces.map(row => row.workspaceId), [selected]); assert.equal(last.nextCursor, null); assert.equal(last.selectedWorkspace.workspaceId, first);
      assert.deepEqual((await request(personA, first, native.nextCursor)).body, { mode: 'hosted', ...last });
    });
    await t.test('each tab selects explicitly; sole membership and engine active organization never become a default', async () => {
      await admin.query('UPDATE noticeos_identity.auth_session SET active_organization_id=$1 WHERE id=$2', [selected, personA.sessionId]);
      assert.equal((await read(personA)).selectedWorkspace, null);
      const [a, b] = await Promise.all([request(personA, first), request(personA, selected)]);
      assert.equal(a.body.selectedWorkspace.workspaceId, first); assert.equal(b.body.selectedWorkspace.workspaceId, selected);
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'viewer',now())", [randomUUID(), first, personB.principalId]);
      const sole = await read(personB); assert.equal(sole.workspaces.length, 1); assert.equal(sole.selectedWorkspace, null);
      assert.equal((await request(personB)).body.selectedWorkspace, null);
    });
    await t.test('role, lifecycle and membership refresh without stale selection or foreign existence disclosure', async () => {
      for (const role of ['operator', 'viewer']) {
        await admin.query('UPDATE noticeos_identity.auth_member SET role=$1 WHERE organization_id=$2 AND user_id=$3', [role, first, personA.principalId]);
        assert.equal((await read(personA, first)).selectedWorkspace.role, role); assert.equal((await request(personA, first)).body.selectedWorkspace.role, role);
      }
      for (const status of ['provisioning', 'suspended']) {
        await admin.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', [status, first]);
        assert.equal((await read(personA)).workspaces[0].status, status);
        await assert.rejects(read(personA, first), IdentityRefused); assert.equal((await request(personA, first)).status, 403);
      }
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [first]);
      await admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [first, personA.principalId]);
      assert.equal((await read(personA)).workspaces.length, 100);
      for (const id of [first, foreignId, randomUUID()]) {
        await assert.rejects(read(personA, id), IdentityRefused);
        const result = await request(personA, id); assert.equal(result.status, 403); assert.deepEqual(result.body, { error: 'browser_session_unavailable' });
      }
    });
    await t.test('verified zero-membership, signed-out, expired, revoked and tampered sessions remain honest', async () => {
      await admin.query('DELETE FROM noticeos_identity.auth_member WHERE user_id=$1', [personB.principalId]);
      const empty = await read(personB); assert.equal(empty.session.principalId, personB.principalId); assert.deepEqual(empty.workspaces, []); assert.equal(empty.selectedWorkspace, null);
      assert.deepEqual((await request(personB)).body, { mode: 'hosted', ...empty });
      const before = (await admin.query('SELECT expires_at,updated_at FROM noticeos_identity.auth_session WHERE id=$1', [personA.sessionId])).rows[0];
      await read(personA); await request(personA);
      assert.deepEqual((await admin.query('SELECT expires_at,updated_at FROM noticeos_identity.auth_session WHERE id=$1', [personA.sessionId])).rows[0], before);
      await admin.query("UPDATE noticeos_identity.auth_session SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.sessionId]);
      await admin.query('DELETE FROM noticeos_identity.auth_session WHERE id=$1', [revoked.sessionId]);
      assert.equal(await read(expired), null);
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_session WHERE id=$1', [expired.sessionId])).rows[0].n, 1,
        'read-only bootstrap refuses expired identity without deleting the maintained session row');
      for (const person of [expired, revoked, { cookie: personA.cookie.replace(/=./u, '=!') }, null]) {
        if (person) assert.equal(await read(person), null);
        const result = await request(person); assert.equal(result.status, 200); assert.deepEqual(result.body, signedOut);
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_session WHERE id=$1', [expired.sessionId])).rows[0].n, 1);
    });
    await t.test('demo ignores customer identity and standalone never opens identity or operational storage', async () => {
      for (const person of [personA, personB, null]) {
        const result = await request(person, null, null, 'DEMO'); assert.equal(result.status, 200);
        assert.deepEqual(result.body, { mode: 'demo', workspace: { workspaceId: demoId, displayName: `Workspace ${demoId}` } });
      }
      assert.equal((await request(personA, first, null, 'DEMO')).status, 403);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [demoId]);
      assert.equal((await request(personA, null, null, 'DEMO')).status, 403);
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [demoId]);
      const standalone = await request(personA, null, null, 'STANDALONE'); assert.equal(standalone.status, 200); assert.deepEqual(standalone.body, { mode: 'standalone' });
      assert.equal((await request(null, null, null, 'INVALID')).status, 403);
      assert.equal(operational, 0); assert.equal(outside, 0); assert.equal(databaseContacts, 0);
      const connections = (await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND pid<>pg_backend_pid()")).rows[0].n;
      assert.equal(connections, 0, 'each bootstrap closes its request-owned identity pool');
    });
    await t.test('ordinary Worker refuses foreign browser proofs and unknown selection grammar', async () => {
      for (const extra of [{ origin: 'https://foreign.example.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await request(personA, first, null, 'HOSTED', extra)).status, 403);
      }
      for (const after of ['malformed', `${first}&unknown=1`, `${first}&after=${selected}`]) {
        assert.equal((await request(personA, null, after)).status, 403);
      }
      assert.equal((await request(personA, 'malformed')).status, 403);
      const response = await runtime.dispatchFetch('https://fixture-driver/', { method: 'POST', body: JSON.stringify({ target: 'HOSTED', url: `${origin}/api/session`, init: { method: 'POST' } }) });
      const result = await response.json(); assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'browser_session_unavailable' });
      assert.equal(new Headers(result.headers).get('cache-control'), 'no-store');
      assert.equal(outside, 0); assert.equal(operational, 0); assert.equal(databaseContacts, 0);
    });
    await runtime.dispose(); runtime = null;
    await Promise.all(clients.map(client => client.close())); clients.length = 0;
    await admin.end(); admin = null; owner.close(); owner = null;
    assert.throws(() => process.kill(postmaster, 0), { code: 'ESRCH' });
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
  } finally {
    await runtime?.dispose(); if (sentinel) await new Promise(resolve => sentinel.close(resolve));
    await Promise.all(clients.map(client => client.close()));
    await admin?.end(); owner?.close(); rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
