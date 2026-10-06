import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openIntegrationOAuthCustody, retireExpiredGoogleOAuth, GOOGLE_INTEGRATION_START, GOOGLE_INTEGRATION_CALLBACK } from '../packages/postgres/src/integration-oauth-custody.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { openIdentity, IdentityRefused } from '../packages/postgres/src/identity.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const origin = 'https://fixture.example.test';
const start = (workspace, cookie, extra = {}) => new Request(`${origin}${GOOGLE_INTEGRATION_START}`, {
  method: 'POST', headers: { origin, cookie, 'x-noticeos-workspace-id': workspace, ...extra },
});
const callback = (state, cookie, tail = '&code=generated-code', extra = {}) => new Request(`${origin}${GOOGLE_INTEGRATION_CALLBACK}?state=${state}${tail}`, {
  headers: { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...extra },
});

test('custody has only fixed actions and rejects malformed original proof before connecting', async () => {
  const custody = openIntegrationOAuthCustody({ connectionString: 'postgresql://noticeos_identity@127.0.0.1:1/not_contacted',
    trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url') });
  const workspace = randomUUID(), state = randomBytes(32).toString('base64url');
  const authorize = () => assert.fail('malformed proof cannot reach authority');
  try {
    assert.deepEqual(Object.keys(custody).sort(), ['claimGoogleCallback', 'close', 'issueGoogle']);
    for (const request of [new Request(`${origin}${GOOGLE_INTEGRATION_START}`), start(workspace, '', { origin: 'https://foreign.example.test' }),
      start(workspace, '', { 'sec-fetch-site': 'cross-site' }), start(workspace, '', { 'x-noticeos-workspace-id': `${workspace}, ${workspace}` }),
      new Request(`${origin}${GOOGLE_INTEGRATION_START}`, { method: 'POST', headers: { origin, 'x-noticeos-workspace-id': workspace }, body: '{"actor":"owner"}' })]) {
      await assert.rejects(custody.issueGoogle(request, workspace, authorize), IdentityRefused);
    }
    for (const request of [callback(state, '', '&code=one&code=two'), callback(state, '', '&error=access_denied&code=one'),
      callback(state, '', '&code=one&actor=owner'), callback(state, '', '&code='), callback('bad', ''),
      callback(state, '', '&code=one', { 'x-noticeos-workspace-id': workspace }),
      new Request(`https://foreign.example.test${GOOGLE_INTEGRATION_CALLBACK}?state=${state}&code=one`)]) {
      await assert.rejects(custody.claimGoogleCallback(request, authorize), IdentityRefused);
    }
  } finally { await custody.close(); }
  await assert.rejects(custody.issueGoogle(start(workspace, ''), workspace, authorize), IdentityRefused);
});

test('transaction custody uses maintained cookies, fresh authority and committed single use', { timeout: 60000 }, async t => {
  const tools = findPostgres();
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'noticeos-google-custody-'));
  const opened = new Set(); let owner, admin;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(fixture, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(owner.applicationLogin().url()); url.username = 'noticeos_identity'; url.password = password;
    const options = { connectionString: url.href, trustedOrigin: origin, sessionSecret: randomBytes(48).toString('base64url') };
    const [a, b] = [randomUUID(), randomUUID()];
    for (const id of [a, b]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, `fixture-${id}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, `fixture-${id}`]);
    }
    let peer = 1;
    async function person(email, workspaces = [a, b]) {
      const id = randomUUID();
      await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Generated person', email]);
      for (const workspace of workspaces) await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [randomUUID(), workspace, id]);
      return { id, email };
    }
    async function signIn(person) {
      let message;
      const login = openEmailCodeLogin({ ...options, peerAddress: `192.0.2.${peer++}`, deliver: async value => { message = value; } });
      try {
        const request = (action, body) => new Request(`${origin}${EMAIL_CODE_PATHS[action]}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal((await login.requestCode(request('request', { email: person.email }))).status, 202);
        assert.ok(message);
        const response = await login.verifyCode(request('verify', { email: person.email, otp: message.code }));
        assert.equal(response.status, 200); await response.arrayBuffer();
        return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      } finally { await login.close(); }
    }
    const one = await person('first@example.test'), two = await person('second@example.test');
    const cookie = await signIn(one), otherCookie = await signIn(two), secondSession = await signIn(one);
    const custody = () => { const value = openIntegrationOAuthCustody(options); opened.add(value); return value; };
    const admission = (owned) => createWorkspaceAdmission({ kind: 'hosted', profile: Symbol('fixture'), trustedOrigin: origin,
      membership: async () => assert.fail('fixed OAuth custody supplies fresh transaction facts'),
      googleOAuth: { issue: (request, workspace, authorize) => owned.issueGoogle(request, workspace, authorize),
        claim: (request, authorize) => owned.claimGoogleCallback(request, authorize) } });
    const own = custody(), gate = admission(own);
    const identity = await openIdentity(options);
    let expectedSession;
    try { expectedSession = (await identity.session(new Headers({ cookie }))).sessionId; } finally { await identity.close(); }
    const issue = workspace => gate.withGoogleStart('fixture-start', start(workspace, cookie, { [WORKSPACE_SESSION_HEADER]: expectedSession }), async (_context, state) => state);
    const claim = (state, selectedCookie = cookie, tail, work = async context => context) => gate.withGoogleCallback('fixture-callback', callback(state, selectedCookie, tail), work);
    const count = async state => (await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier=$1', [`noticeos:integration-google:v1:${state}`])).rows[0].n;

    await t.test('stale expected session cannot issue custody for another maintained cookie', async () => {
      const before = (await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n;
      for (const selectedCookie of [otherCookie, secondSession])
        await assert.rejects(gate.withGoogleStart('stale-start', start(a, selectedCookie, { [WORKSPACE_SESSION_HEADER]: expectedSession }), async () => assert.fail()));
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n, before);
    });
    await t.test('state is opaque, bound to the exact session/workspace and survives reopening', async () => {
      const state = await issue(a); assert.match(state, /^[A-Za-z0-9_-]{43}$/);
      const row = (await admin.query('SELECT value FROM noticeos_identity.auth_verification WHERE identifier=$1', [`noticeos:integration-google:v1:${state}`])).rows[0];
      const held = JSON.parse(row.value); assert.equal(held.workspaceId, a); assert.equal(held.principalId, one.id);
      assert.equal(held.redirectUri, `${origin}${GOOGLE_INTEGRATION_CALLBACK}`);
      const reopened = custody(); const context = await admission(reopened).withGoogleCallback('fixture-reopen', callback(state, cookie), async value => value);
      assert.equal(context.sessionId, held.sessionId); assert.equal(context.workspaceId, a); assert.equal(await count(state), 0);
      await assert.rejects(claim(state));
    });
    await t.test('different person/session and conflicting workspace do not consume', async () => {
      const state = await issue(a);
      await assert.rejects(claim(state, otherCookie)); await assert.rejects(claim(state, secondSession));
      await assert.rejects(gate.withGoogleCallback('override', callback(state, cookie, '&code=one', { 'x-noticeos-workspace-id': b }), async () => assert.fail()));
      assert.equal(await count(state), 1); await claim(state); assert.equal(await count(state), 0);
    });
    await t.test('role revocation and lifecycle changes refuse before consume or capability', async () => {
      const state = await issue(a); let effects = 0;
      await admin.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [a, one.id]);
      await assert.rejects(claim(state, cookie, undefined, async () => { effects++; }));
      await admin.query("UPDATE noticeos_identity.auth_member SET role='owner' WHERE organization_id=$1 AND user_id=$2", [a, one.id]);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [a]);
      await assert.rejects(claim(state, cookie, undefined, async () => { effects++; }));
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]);
      assert.equal(effects, 0); assert.equal(await count(state), 1); await claim(state);
    });
    await t.test('independent custody instances have exactly one successful callback', async () => {
      const state = await issue(a); let effects = 0;
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => admission(custody()).withGoogleCallback('race', callback(state, cookie), async () => { effects++; })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(effects, 1); assert.equal(await count(state), 0);
    });
    await t.test('cancellation spends valid custody without a provider; failure stays spent', async () => {
      const state = await issue(a); let providers = 0;
      await claim(state, cookie, '&error=access_denied', async () => undefined);
      await assert.rejects(claim(state, cookie, undefined, async () => { providers++; }));
      const next = await issue(a);
      await assert.rejects(claim(next, cookie, undefined, async () => { providers++; throw new Error('generated-provider-refusal'); }), /generated-provider-refusal/);
      await assert.rejects(claim(next, cookie, undefined, async () => { providers++; }));
      assert.equal(providers, 1); assert.equal(await count(next), 0);
    });
    await t.test('authorizer failure rolls back and leaves the state unclaimed', async () => {
      const state = await issue(b);
      await assert.rejects(own.claimGoogleCallback(callback(state, cookie), () => { throw new Error('generated-policy-refusal'); }), IdentityRefused);
      assert.equal(await count(state), 1); await claim(state);
    });
    await t.test('rejecting async authorization cannot commit issuance or consumption', async () => {
      const before = (await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n;
      const reject = async () => { await Promise.resolve(); throw new Error('generated-async-policy-refusal'); };
      await assert.rejects(own.issueGoogle(start(b, cookie), b, reject), IdentityRefused);
      assert.equal((await admin.query("SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier LIKE 'noticeos:integration-google:v1:%'")).rows[0].n, before);
      const held = await issue(b);
      await assert.rejects(own.claimGoogleCallback(callback(held, cookie), reject), IdentityRefused);
      assert.equal(await count(held), 1); await claim(held);
    });
    await t.test('expired custody is spent, while corrupt binding and removed membership cannot claim', async () => {
      const expired = await issue(a);
      const old = Date.now() - 600001;
      await admin.query(`UPDATE noticeos_identity.auth_verification SET value=jsonb_set(jsonb_set(value::jsonb,
        '{issuedAt}',to_jsonb($2::bigint)),'{expiresAt}',to_jsonb($3::bigint))::text,
        expires_at=to_timestamp($3::double precision/1000) WHERE identifier=$1`,
        [`noticeos:integration-google:v1:${expired}`, old, old + 600000]);
      await assert.rejects(claim(expired)); assert.equal(await count(expired), 0);
      const corrupt = await issue(a);
      await admin.query(`UPDATE noticeos_identity.auth_verification SET value=jsonb_set(value::jsonb,
        '{redirectUri}',to_jsonb($2::text))::text WHERE identifier=$1`,
        [`noticeos:integration-google:v1:${corrupt}`, 'https://foreign.example.test/callback']);
      await assert.rejects(claim(corrupt)); assert.equal(await count(corrupt), 1);
      const removed = await issue(a);
      const held = (await admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2 RETURNING *', [a, one.id])).rows[0];
      await assert.rejects(claim(removed)); assert.equal(await count(removed), 1);
      await admin.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,$5)',
        [held.id, held.organization_id, held.user_id, held.role, held.created_at]);
      await claim(removed);
    });
    await t.test('platform retirement is exact, batched, lock-safe and leaves current custody usable', async () => {
      const insert = async (identifier, expired) => {
        const id = randomUUID();
        await admin.query(`INSERT INTO noticeos_identity.auth_verification(id,identifier,value,expires_at)
          VALUES($1,$2,'generated-retirement-fixture',clock_timestamp()+$3::interval)`,
          [id,identifier,expired?'-1 hour':'1 hour']);
        return id;
      };
      const preserved = await Promise.all([
        insert('noticeos:integration-google:v1:future',false),
        insert('email-otp:generated@example.test',true),
        insert('noticeos:integration-google:v2:expired',true),
        insert('prefix:noticeos:integration-google:v1:expired',true),
      ]);
      const expired = await insert('noticeos:integration-google:v1:locked',true);
      const locker = await admin.connect();
      try {
        await locker.query('BEGIN'); await locker.query('SELECT id FROM noticeos_identity.auth_verification WHERE id=$1 FOR UPDATE',[expired]);
        for(let index=0;index<105;index++) await insert(`noticeos:integration-google:v1:batch-${index}`,true);
        const selected = new URL(options.connectionString);
        selected.searchParams.set('options','-c role=postgres');
        assert.equal(await retireExpiredGoogleOAuth({...options,connectionString:selected.href}),100);
        assert.equal(await retireExpiredGoogleOAuth(options),5);
        assert.equal(await retireExpiredGoogleOAuth(options),0,'locked row must be skipped');
        await locker.query('ROLLBACK');
      } finally {await locker.query('ROLLBACK');locker.release();}
      assert.equal(await retireExpiredGoogleOAuth(options),1);
      assert.equal(await retireExpiredGoogleOAuth(options),0,'retry is idempotent');
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE id=ANY($1::uuid[])',[preserved])).rows[0].n,4);
      const state=await issue(a);
      const [retired] = await Promise.all([retireExpiredGoogleOAuth(options),claim(state)]);
      assert.equal(retired,0); assert.equal(await count(state),0);
      await admin.query('DELETE FROM noticeos_identity.auth_verification WHERE id=ANY($1::uuid[])',[preserved]);
    });
    await t.test('maintenance refuses elevated roles and bounds database lock failure without raw diagnostics', async () => {
      const ownerUrl = new URL(options.connectionString); ownerUrl.username='postgres';
      await assert.rejects(retireExpiredGoogleOAuth({...options,connectionString:ownerUrl.href}),error=>error instanceof IdentityRefused && error.message==='Integration OAuth maintenance refused');
      const locker=await admin.connect();const started=performance.now();
      try {
        await locker.query('BEGIN');await locker.query('LOCK TABLE noticeos_identity.auth_verification IN ACCESS EXCLUSIVE MODE');
        await assert.rejects(retireExpiredGoogleOAuth(options),error=>error instanceof IdentityRefused && error.message==='Integration OAuth maintenance refused');
        assert.ok(performance.now()-started<8000,'one local lock failure is bounded');
      } finally {await locker.query('ROLLBACK');locker.release();}
      assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity' AND state<>'idle'")).rows[0].n,0);
    });
    await t.test('a stalled established role-check transport times out and awaits owned socket cleanup', async () => {
      const sockets=new Set(), closed=[];let blocked=false;
      const proxy=createServer(downstream=>{
        const upstream=createConnection({host:'127.0.0.1',port:owner.loopbackPort});
        for(const socket of [downstream,upstream]){
          sockets.add(socket);socket.on('error',()=>socket.destroy());
          closed.push(new Promise(resolve=>socket.on('close',()=>{sockets.delete(socket);resolve();})));
        }
        downstream.on('data',data=>upstream.write(data));
        downstream.on('close',()=>upstream.destroy());upstream.on('close',()=>downstream.destroy());
        let buffered=Buffer.alloc(0);
        upstream.on('data',data=>{
          buffered=Buffer.concat([buffered,data]);
          while(buffered.length>=5){
            const length=buffered.readInt32BE(1)+1;
            if(buffered.length<length)return;
            const packet=buffered.subarray(0,length);buffered=buffered.subarray(length);
            if(!blocked){downstream.write(packet);if(packet[0]===90)blocked=true;}
          }
        });
      });
      // This proxy is not a Postgres fixture. The kernel owns its independent
      // port; an adjacent configured PG port may belong to another test file.
      await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
      assert.notEqual(proxy.address().port, owner.loopbackPort);
      try {
        const selected=new URL(options.connectionString);selected.port=String(proxy.address().port);
        selected.searchParams.set('query_timeout','0');
        const started=performance.now();
        await assert.rejects(retireExpiredGoogleOAuth({...options,connectionString:selected.href}),error=>error instanceof IdentityRefused && error.message==='Integration OAuth maintenance refused');
        assert.equal(blocked,true,'the connection completed authentication before dropping only query replies');
        assert.ok(performance.now()-started>=5500);assert.ok(performance.now()-started<10000);
      } finally {
        for(const socket of sockets)socket.destroy();
        await new Promise((resolve,reject)=>proxy.close(error=>error?reject(error):resolve()));
        await Promise.all(closed);
      }
      assert.equal(sockets.size,0);
      assert.equal(proxy.address(),null,'the owned proxy listener is closed');
    });
    await t.test('awaited close rejects later work and leaves no identity connections', async () => {
      const state = await issue(a);
      const pending = claim(state); const closing = own.close(); await pending; await closing; await own.close();
      await assert.rejects(own.issueGoogle(start(a, cookie), a, () => {}), IdentityRefused);
      for (const value of opened) await value.close(); opened.clear();
      assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity'")).rows[0].n, 0);
    });
  } finally {
    const cleanup = await Promise.allSettled([...opened].map(value => value.close()));
    await admin?.end(); owner?.close();
    assert.equal(existsSync(path.join(fixture, 'pg/data/postmaster.pid')), false);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    rmSync(fixture, { recursive: true, force: true }); assert.equal(existsSync(fixture), false);
  }
});
