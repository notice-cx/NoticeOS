import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, MEMBERSHIP_PATH, ACCEPT_INVITATION_PATH,
  parseEmailEnrollmentLanding } from './identity-protocol.mjs';
import { WORKSPACE_SESSION_HEADER, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';

const { Pool } = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'))('pg');

test('ordinary Tower email-code entry preserves invitation, delivery and session boundaries', { timeout: 120000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-auth-entry-'));
  let owner, admin, runtime, identity;
  try {
    const tower = await bundleWorkerFixture(root, 'tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts'));
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return; applyMigrations(owner);
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    const appUrl = owner.applicationLogin().url(), password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const identityUrl = new URL(appUrl); identityUrl.username = 'noticeos_identity'; identityUrl.password = password;
    const origin = 'https://auth.example.test', secret = randomBytes(48).toString('base64url');
    const options = { connectionString: identityUrl.href, trustedOrigin: origin, sessionSecret: secret };
    identity = await openIdentity(options);
    const bindings = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
      NOTICEOS_IDENTITY_DATABASE_URL: identityUrl.href, NOTICEOS_IDENTITY_SESSION_SECRET: secret,
      NOTICEOS_IDENTITY_EDGE: 'cloudflare', NOTICEOS_IDENTITY_EMAIL_FROM: 'hello@example.test' };
    const messages = []; let outside = 0, failDelivery = false;
    const outboundService = async () => { outside++; throw new Error('No outside HTTP in auth entry fixture'); };
    // The local runtime supplies fixed edge metadata. This tests the deployed
    // handler, not whether the real Cloudflare edge overwrites client headers.
    // Mail is a private captured RPC; no provider/account exists in this proof.
    runtime = new Miniflare({ cf: { colo: 'SJC' }, workers: [
      { name: 'tower', ...tower, bindings, serviceBindings: { NOTICEOS_IDENTITY_EMAIL: 'mail' }, outboundService },
      { name: 'demo', ...tower, bindings: { ...bindings, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, outboundService },
      { name: 'standalone', ...tower, bindings: { ...bindings, NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, outboundService },
      { name: 'no-edge', ...tower, bindings: { ...bindings, NOTICEOS_IDENTITY_EDGE: '' }, outboundService },
      { name: 'mail', modules: true, compatibilityDate: '2026-07-06',
        script: `import {WorkerEntrypoint} from 'cloudflare:workers';export default class extends WorkerEntrypoint {
          async send(message){const reply=await this.env.CAPTURE.fetch('https://mail.fixture/',{method:'POST',body:JSON.stringify(message)});
            if(!reply.ok)throw new Error('Captured delivery refused');return {messageId:'fixture'};}
        }`, serviceBindings: { CAPTURE: async request => {
          const message = await request.json();
          if (message.subject === 'Join your NoticeOS workspace') {
            const landing = parseEmailEnrollmentLanding(message.text.slice('Join your workspace: '.length));
            assert.equal(landing.kind, 'enrollment'); assert.equal(landing.enrollment.kind, 'invitation');
            const saved = (await admin.query('SELECT email,status FROM noticeos_identity.auth_invitation WHERE id=$1', [landing.enrollment.id])).rows[0];
            assert.equal(saved.email, message.to); assert.equal(saved.status, 'pending', 'invitation delivery follows commit');
            if (failDelivery) return new Response(null, { status: 503 });
            messages.push({ ...message, invitationId: landing.enrollment.id }); return new Response(null, { status: 204 });
          }
          const saved = (await admin.query('SELECT value FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${message.to}`])).rows;
          assert.equal(saved.length, 1, 'mail is dispatched only after code commit');
          const code = message.text.match(/\b[0-9]{6}\b/u)?.[0]; assert.ok(code); assert.ok(!saved[0].value.includes(code));
          if (failDelivery) return new Response(null, { status: 503 });
          messages.push({ ...message, code }); return new Response(null, { status: 204 });
        } }, outboundService },
    ] });
    // A hang guard for one call, not a speed check: a cold call on a loaded
    // runner took over 10 s (as in workspace-oauth-worker.test.mjs).
    const http = (action, body = {}, headers = {}, pathname = EMAIL_CODE_PATHS[action]) => runtime.dispatchFetch(origin + pathname, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.24', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const selector = id => ({ [EMAIL_ENROLLMENT_HEADERS.kind]: 'platform', [EMAIL_ENROLLMENT_HEADERS.id]: id });
    const enroll = async email => {
      const workspace = randomUUID(), id = randomUUID();
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'provisioning')", [workspace, `fixture-${workspace}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [workspace, `fixture-${workspace}`]);
      await admin.query("INSERT INTO noticeos_identity.platform_enrollment(id,workspace_id,email,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [id, workspace, email]);
      return { email, id, workspace };
    };
    const count = async table => Number((await admin.query(`SELECT count(*) AS n FROM noticeos_identity.${table}`)).rows[0].n);
    const assertReply = async (response, status, ok) => {
      assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.clone().json(), { ok });
    };
    await t.test('unknown paths, profiles, browser evidence and enrollment headers fail before identity writes', async () => {
      for (const pathname of ['/api/auth/sign-up/email', '/api/auth/admin/create-user', `${EMAIL_CODE_PATHS.request}?profile=standalone`]) {
        await assertReply(await http('request', { email: 'unknown@example.test' }, {}, pathname), 403, false);
      }
      for (const headers of [{ origin: 'https://foreign.example.test' }, { 'sec-fetch-site': 'cross-site' }, { 'cf-worker': 'subrequest.example.test' },
        { 'cf-connecting-ip': 'invalid' }, { 'cf-connecting-ip': '2a06:98c0:3600::103' }, { 'content-type': 'text/plain' },
        { [EMAIL_ENROLLMENT_HEADERS.id]: randomUUID() }, { [EMAIL_ENROLLMENT_HEADERS.kind]: 'owner', [EMAIL_ENROLLMENT_HEADERS.id]: randomUUID() }]) {
        await assertReply(await http('request', { email: 'unknown@example.test' }, headers), 403, false);
      }
      for (const name of ['demo', 'standalone', 'no-edge']) {
        const worker = await runtime.getWorker(name);
        // Miniflare's Node RPC proxy forbids an Origin header before calling
        // the Worker. Fetch Metadata supplies the same-origin browser proof.
        await assertReply(await worker.fetch(origin + EMAIL_CODE_PATHS.request, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.24' }, body: JSON.stringify({ email: 'unknown@example.test' }) }), 403, false);
      }
      assert.equal(await count('auth_rate_limit'), 0); assert.equal(await count('auth_user'), 0); assert.equal(messages.length, 0);
    });
    let cookie, session;
    const person = await enroll('invited@example.test');
    await t.test('stored recipient alone may verify; the real signed cookie grants no unprovisioned workspace', async () => {
      await assertReply(await http('request', { email: 'other@example.test' }, selector(person.id)), 202, true);
      assert.equal(messages.length, 0); assert.equal(await count('auth_user'), 0);
      const sent = await http('request', { email: person.email }, selector(person.id)); await assertReply(sent, 202, true);
      assert.equal(sent.headers.has('set-cookie'), false); assert.equal(messages.length, 1);
      assert.equal(messages[0].from, 'hello@example.test'); assert.equal(messages[0].to, person.email);
      const verified = await http('verify', { email: person.email, otp: messages[0].code }, selector(person.id));
      await assertReply(verified, 200, true);
      const cookies = verified.headers.getSetCookie(); assert.ok(cookies.length);
      assert.ok(cookies.every(value => /HttpOnly/iu.test(value) && /Secure/iu.test(value) && /SameSite=Lax/iu.test(value)));
      cookie = cookies.map(value => value.split(';')[0]).join('; ');
      session = await identity.session(new Headers({ cookie })); assert.ok(session);
      assert.equal(await identity.membership(new Headers({ cookie }), person.workspace), null);
      assert.equal(await count('auth_member'), 0);
      const boot = await runtime.dispatchFetch(origin + '/api/session', { headers: { cookie } });
      assert.equal(boot.status, 200); const state = await boot.json();
      assert.equal(state.session.sessionId, session.sessionId); assert.deepEqual(state.workspaces, []);
      await assertReply(await http('verify', { email: person.email, otp: messages[0].code }, selector(person.id)), 400, false);
    });
    await t.test('sign-out binds the captured session and never clears a later login cookie', async () => {
      for (const expected of [undefined, randomUUID()]) {
        const headers = { cookie, ...(expected ? { [WORKSPACE_SESSION_HEADER]: expected } : {}) };
        await assertReply(await http('logout', {}, headers), 403, false);
        assert.equal((await identity.session(new Headers({ cookie }))).sessionId, session.sessionId);
      }
      const response = await http('logout', {}, { cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId });
      await assertReply(response, 200, true); assert.equal(response.headers.has('set-cookie'), false);
      assert.equal(await identity.session(new Headers({ cookie })), null);
    });
    await t.test('mail refusal preserves committed counters and exposes no code or provider details', async () => {
      const person = await enroll('delivery@example.test'); failDelivery = true;
      const response = await http('request', { email: person.email }, { ...selector(person.id), 'cf-connecting-ip': '192.0.2.25' });
      await assertReply(response, 503, false); assert.equal(response.headers.has('set-cookie'), false);
      assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_verification WHERE identifier=$1', [`sign-in-otp-${person.email}`])).rows[0].n, 1);
      failDelivery = false;
    });
    await t.test('forged forwarded addresses cannot evade the durable edge-peer request limit', async () => {
      const statuses = [];
      for (let i = 0; i < 6; i++) statuses.push((await http('request', { email: `absent-${i}@example.test` }, {
        'cf-connecting-ip': '192.0.2.26', 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-real-ip': `198.51.100.${i + 10}`, 'x-noticeos-trusted-peer': `198.51.100.${i + 20}`,
      })).status);
      assert.deepEqual(statuses, [202, 202, 202, 429, 429, 429]);
      assert.equal(messages.length, 1); assert.equal(await count('auth_user'), 1); assert.equal(outside, 0);
    });
    await t.test('actual owner routes and recipient acceptance preserve workspace and session ownership', async () => {
      const a = person.workspace, b = randomUUID();
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [a]);
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [b, `fixture-${b}`]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [b, `fixture-${b}`]);
      const otherId = randomUUID();
      await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified) VALUES($1,$2,$3,true)', [otherId, 'Other owner', 'other-owner@example.test']);
      const ownerMember = randomUUID(), otherMember = randomUUID();
      for (const [member, workspace, user] of [[ownerMember, a, session.principalId], [otherMember, b, otherId]]) {
        await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'owner',now())", [member, workspace, user]);
      }
      let peer = 40;
      const login = async (email, invitationId) => {
        const headers = { 'cf-connecting-ip': `192.0.2.${peer++}`, ...(invitationId ? {
          [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId,
        } : {}) };
        await assertReply(await http('request', { email }, headers), 202, true);
        const response = await http('verify', { email, otp: messages.at(-1).code }, headers);
        await assertReply(response, 200, true);
        const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        return { cookie, ...(await identity.session(new Headers({ cookie }))) };
      };
      const own = await login(person.email), other = await login('other-owner@example.test');
      const members = (who, workspace, command, extra = {}) => http('request', command, { cookie: who.cookie,
        [WORKSPACE_SESSION_HEADER]: who.sessionId, [WORKSPACE_SELECTION_HEADER]: workspace, ...extra }, MEMBERSHIP_PATH);
      const accept = (who, invitationId, extra = {}) => http('request', { invitationId }, {
        cookie: who.cookie, [WORKSPACE_SESSION_HEADER]: who.sessionId, ...extra,
      }, ACCEPT_INVITATION_PATH);
      for (const who of [other, { ...own, sessionId: randomUUID() }]) await assertReply(await members(who, a, { kind: 'list', collection: 'members' }), 403, false);
      for (const extra of [{ actor: own.principalId }, { workspaceId: b }, { role: 'owner' }]) {
        await assertReply(await members(own, a, { kind: 'list', collection: 'members', ...extra }), 403, false);
      }
      const sent = await members(own, a, { kind: 'invite', email: 'new-member@example.test', role: 'viewer' });
      assert.equal(sent.status, 200); const invitationId = (await sent.json()).invitationId;
      assert.equal(messages.at(-1).invitationId, invitationId);
      assert.equal(messages.at(-1).text, `Join your workspace: ${origin}/sign-in#invitation=${invitationId}`);
      const pending = await (await members(own, a, { kind: 'list', collection: 'invitations' })).json();
      assert.deepEqual(pending.items.map(item => item.id), [invitationId]); assert.equal(pending.nextCursor, null);
      const recipient = await login('new-member@example.test', invitationId);
      assert.equal(await identity.membership(new Headers({ cookie: recipient.cookie }), a), null);
      for (const who of [own, other, { ...recipient, sessionId: randomUUID() }]) await assertReply(await accept(who, invitationId), 403, false);
      await assertReply(await accept(recipient, invitationId, { [WORKSPACE_SELECTION_HEADER]: a }), 403, false);
      const joined = await accept(recipient, invitationId); assert.equal(joined.status, 200); assert.equal(joined.headers.has('set-cookie'), false);
      assert.equal((await identity.membership(new Headers({ cookie: recipient.cookie }), a)).role, 'viewer');
      await assertReply(await accept(recipient, invitationId), 403, false);
      await assertReply(await members(recipient, a, { kind: 'list', collection: 'members' }), 403, false);
      const listed = await (await members(own, a, { kind: 'list', collection: 'members' })).json();
      assert.deepEqual(listed.items.map(item => item.email).sort(), [person.email, 'new-member@example.test'].sort());
      const recipientMember = listed.items.find(item => item.email === 'new-member@example.test').id;
      await assertReply(await members(other, b, { kind: 'remove', memberId: recipientMember }), 403, false);
      await assertReply(await members(own, a, { kind: 'remove', memberId: otherMember }), 403, false);
      await assertReply(await members(own, a, { kind: 'remove', memberId: ownerMember }), 403, false);
      await assertReply(await members(own, a, { kind: 'change-role', memberId: ownerMember, role: 'viewer' }), 403, false);
      await assertReply(await members(own, a, { kind: 'change-role', memberId: recipientMember, role: 'operator' }), 200, true);
      await assertReply(await members(own, a, { kind: 'remove', memberId: recipientMember }), 200, true);
      assert.equal(await identity.membership(new Headers({ cookie: recipient.cookie }), a), null);
      const resend = await members(own, a, { kind: 'invite', email: 'resend@example.test', role: 'operator' });
      const retryId = (await resend.json()).invitationId;
      assert.equal((await members(own, a, { kind: 'resend', invitationId: retryId })).status, 200);
      assert.equal(messages.at(-1).invitationId, retryId);
      assert.equal((await members(own, a, { kind: 'cancel', invitationId: retryId })).status, 200);
      failDelivery = true;
      const failed = await members(own, a, { kind: 'invite', email: 'undelivered@example.test', role: 'viewer' });
      assert.equal(failed.status, 503); assert.equal(failed.headers.get('cache-control'), 'no-store');
      const failure = await failed.json(); assert.equal(failure.code, 'delivery_failed'); assert.ok(UUID(failure.invitationId));
      assert.equal((await admin.query('SELECT status FROM noticeos_identity.auth_invitation WHERE id=$1', [failure.invitationId])).rows[0].status, 'pending');
      failDelivery = false;
      await assertReply(await members(own, a, { kind: 'invite', email: 'x'.repeat(5000), role: 'viewer' }), 403, false);
      await assertReply(await members(own, a, { kind: 'invite', email: 'bad-origin@example.test', role: 'viewer' }, { origin: 'https://foreign.example.test' }), 403, false);
      for (const name of ['demo', 'standalone']) {
        const worker = await runtime.getWorker(name);
        await assertReply(await worker.fetch(origin + MEMBERSHIP_PATH, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', cookie: own.cookie, [WORKSPACE_SESSION_HEADER]: own.sessionId,
          [WORKSPACE_SELECTION_HEADER]: a }, body: JSON.stringify({ kind: 'list', collection: 'members' }) }), 403, false);
      }
      await admin.query('DELETE FROM noticeos_identity.auth_session WHERE id=$1', [own.sessionId]);
      await assertReply(await members(own, a, { kind: 'list', collection: 'members' }), 403, false);
      assert.equal(outside, 0);
    });
  } finally {
    const cleanup = await Promise.allSettled([runtime?.dispose(), identity?.close(), admin?.end()].filter(Boolean));
    owner?.close(); assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});

function UUID(value) { return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value); }
