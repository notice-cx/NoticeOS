import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, MEMBERSHIP_PATH } from './identity-protocol.mjs';
import { localCustomerOutbound } from './local-customer-egress.mjs';
import { readCustomerOperating, openCustomerOperating } from './local-customer-operating.mjs';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { customerArchiveFixture } from './test-fixtures/customer-archive.mjs';
import { identitySmtpFixture } from './test-fixtures/identity-smtp.mjs';

test('the operator chooses the one loopback database and only explicit providers', async t => {
  const root = testFixtureRoot('noticeos-operating-config-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = startPlan({ dir: path.join(root, 'runtime'), port: 11420 });
  const file = path.join(root, 'customer.json');
  const config = { format: 'noticeos-customer-operating/1', database: Object.fromEntries([
    ['app', 'noticeos_app'], ['identity', 'noticeos_identity'], ['grant', 'noticeos_service_grant'],
  ].map(([key, role]) => [key, `postgresql://${role}:fixture@127.0.0.1:11424/fixture?sslmode=disable`])),
  identitySecret: randomBytes(48).toString('base64url'), credentialsKey: randomBytes(32).toString('base64'),
  workspaces: [{ workspaceId: randomUUID(), serviceId: randomUUID() }], mailRecipients: ['person@example.test'] };
  const read = overrides => {
    writeFileSync(file, JSON.stringify({ ...config, ...overrides }), { mode: 0o600 });
    return readCustomerOperating(file, plan);
  };
  assert.equal(read().googleDaily, false);
  assert.equal(read().ntasksOrigin, null);
  assert.equal(read().siteReports, false);
  assert.equal(read({ ntasksOrigin: 'https://tasks.example.test' }).ntasksOrigin, 'https://tasks.example.test');
  for (const override of [
    { database: { ...config.database, app: config.database.app.replace('127.0.0.1', 'db.example.test') } },
    { database: { ...config.database, grant: config.database.grant.replace('11424', '11425') } },
    { database: { ...config.database, identity: config.database.app } },
    { ntasksOrigin: 'http://127.0.0.1:11424' }, { ntasksOrigin: 'https://tasks.example.test/elsewhere' },
    { ntasksOrigin: 'http://tasks.example.test' }, { googleDaily: 'yes' }, { siteReports: 'yes' },
  ]) assert.throws(() => read(override), /private customer config/u);
  const targets = [];
  const transport = async (url, init) => {
    targets.push({ url, method: init.method, redirect: init.redirect });
    return new Response(null, { status: 307, headers: { location: 'https://unexpected.example.test' } });
  };
  const token = new Request('https://oauth2.googleapis.com/token', { method: 'POST' });
  assert.equal((await localCustomerOutbound({ transport })(token)).status, 403);
  const scheduled = localCustomerOutbound({ googleDaily: true, transport });
  assert.equal((await scheduled(new Request('https://analyticsdata.googleapis.com/v1beta/properties/1:runRealtimeReport',
    { method: 'POST' }))).status, 403);
  const reporting = new Request('https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport', { method: 'POST' });
  assert.equal((await scheduled(reporting)).status, 502);
  assert.equal((await scheduled(token)).status, 502);
  const tasks = localCustomerOutbound({ ntasksOrigin: 'https://tasks.example.test', transport });
  assert.equal((await tasks(new Request('https://tasks.example.test/api/task-database'))).status, 403);
  assert.equal((await tasks(new Request('https://tasks.example.test/api/tasks'))).status, 502);
  assert.deepEqual(targets, [
    { url: reporting.url, method: 'POST', redirect: 'manual' },
    { url: 'https://oauth2.googleapis.com/token', method: 'POST', redirect: 'manual' },
    { url: 'https://tasks.example.test/api/tasks', method: 'GET', redirect: 'manual' },
  ]);
});

function customerArgs(plan, configFile) {
  return [path.join(plan.root, 'scripts/start.mjs'), '--profile', 'hosted', '--customer-config', configFile,
    '--dir', plan.home, '--port', String(plan.port), '--no-open'];
}

async function assertNormalLauncher(plan, configFile, exercise) {
  const child = spawn(process.execPath, customerArgs(plan, configFile), { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
    child.once('error', () => resolve(1));
  });
  const ready = new Promise(resolve => {
    let stdout = '';
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.includes(`${plan.url}\n`)) resolve(true);
    });
    child.stderr.resume();
  });
  const timeout = AbortSignal.timeout(30000);
  let running = false;
  try {
    running = await Promise.race([ready, exited.then(() => false),
      new Promise(resolve => timeout.addEventListener('abort', () => resolve(false), { once: true }))]);
    assert.equal(running, true);
    assert.equal((await fetch(plan.url + 'wall', { signal: timeout })).status, 200);
    await exercise();
  } finally {
    child.kill('SIGTERM');
    const code = await exited;
    if (running) assert.equal(code, 0);
  }
}

async function workspaceOwner(app, workspace = app.workspaces[0]) {
  const { email, url, workspaceId } = workspace;
  const origin = app.publicOrigin;
  const invitationId = new URL(url).hash.slice('#invitation='.length);
  const proof = { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId };
  const post = (route, body, headers) => fetch(origin + route, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(EMAIL_CODE_PATHS.request, { email }, proof)).status, 202);
  const message = readdirSync(app.outbox).map(file => JSON.parse(readFileSync(path.join(app.outbox, file), 'utf8')))
    .find(mail => mail.to === email && /\b\d{6}\.$/u.test(mail.text));
  assert.ok(message);
  const otp = message.text.match(/\b(\d{6})\.$/u)[1];
  const verified = await post(EMAIL_CODE_PATHS.verify, { email, otp }, proof);
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie().map(header => header.split(';')[0]).join('; ');
  const reader = await fetch(origin + '/api/session', { headers: { cookie } });
  const { session } = await reader.json();
  const headers = { cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId, origin };
  assert.equal((await post(ACCEPT_INVITATION_PATH, { invitationId }, headers)).status, 200);
  return { ...headers, [WORKSPACE_SELECTION_HEADER]: workspaceId };
}

async function exerciseSiteReports(origin, owner, db) {
  const asset = 'archive-app';
  const manage = (method, headers = owner) => fetch(origin + '/api/assets/' + asset + '/report-token', { method, headers });
  const send = (token, namedAsset = asset) => fetch(origin + '/api/pulse', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ asset: namedAsset, generatedAt: new Date().toISOString(),
      capabilities: ['signups'], metrics: { signups: { last24h: 9, avg7d: 3, total: 105 } } }),
  });
  assert.equal((await manage('POST', { ...owner, origin: 'http://127.0.0.1:19056' })).status, 403);
  const created = await manage('POST');
  assert.equal(created.status, 201);
  const { token } = await created.json();
  assert.equal((await send(token, 'unrelated-site')).status, 401);
  assert.equal((await send(token)).status, 201);
  assert.equal((await manage('DELETE')).status, 204);
  assert.equal((await send(token)).status, 401);
  assert.equal((await (await manage('GET')).json()).issued, false);
  assert.deepEqual(db.cluster.sql(`SELECT workspace_id,asset_id,envelope->'metrics'->'signups'->>'last24h' AS signups
    FROM noticeos.current_pulses WHERE asset_id='archive-app'`), [
    { workspace_id: owner[WORKSPACE_SELECTION_HEADER], asset_id: asset, signups: '9' },
  ]);
}

function resetCodeRate(db) {
  // These independent scenarios share the fixture's one trusted loopback peer.
  db.cluster.run(`DELETE FROM noticeos_identity.auth_rate_limit
    WHERE key LIKE '%|/email-otp/send-verification-otp' OR key LIKE '%|/sign-in/email-otp'`);
}

async function exerciseSignInDelivery(app, relay, email, workspaceId, db) {
  const origin = app.publicOrigin;
  const post = (route, body) => fetch(origin + route, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const foreign = await post(EMAIL_CODE_PATHS.request, { email: 'unregistered@example.test' });
  assert.equal(foreign.status, 202);
  assert.equal(foreign.headers.has('set-cookie'), false);
  assert.deepEqual(relay.recipients, []);
  const request = await post(EMAIL_CODE_PATHS.request, { email });
  assert.equal(request.status, 202);
  assert.equal(request.headers.has('set-cookie'), false);
  assert.deepEqual(await request.json(), { ok: true });
  assert.deepEqual(relay.recipients, [email]);
  assert.equal(relay.inbox[0]?.sender, relay.declaration.from);
  assert.deepEqual(relay.inbox[0]?.from, { name: 'NoticeOS', address: relay.declaration.from });
  const otp = relay.inbox[0]?.wire.match(/\b(\d{6})\./u)?.[1];
  assert.ok(otp, 'the code is addressed to the configured owner');
  assert.equal(app.outbox, undefined);
  const signIn = await post(EMAIL_CODE_PATHS.verify, { email, otp });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const current = await fetch(origin + '/api/session', { headers: { cookie } });
  const { session, workspaces } = await current.json();
  assert.ok(session?.sessionId);
  assert.ok(workspaces.some(workspace => workspace.workspaceId === workspaceId && workspace.role === 'owner'));
  resetCodeRate(db);
  const sessions = () => db.cluster.sql('SELECT count(*) AS count FROM noticeos_identity.auth_session');
  const before = sessions();
  relay.reject();
  const failed = await post(EMAIL_CODE_PATHS.request, { email });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.has('set-cookie'), false);
  assert.deepEqual(await failed.json(), { ok: false });
  assert.equal(relay.inbox.length, 1);
  assert.deepEqual(sessions(), before);
  relay.reject(false);
}

async function exerciseMembershipMail(app, relay, db, { owner, otherOwner, otherEmail, identitySecret }) {
  const origin = app.publicOrigin;
  const workspaceId = owner[WORKSPACE_SELECTION_HEADER];
  const route = (pathname, body, headers) => fetch(origin + pathname, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const members = (body, actor = owner) => route(MEMBERSHIP_PATH, body, actor);
  const email = 'joining@example.test';
  const headers = id => id === undefined ? {} : { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: id };
  const request = (email, id) => route(EMAIL_CODE_PATHS.request, { email }, headers(id));
  const noCode = async (email, invitationId) => {
    const before = relay.recipients.length;
    const response = await request(email, invitationId);
    assert.equal(response.status, 202);
    assert.equal(response.headers.has('set-cookie'), false);
    assert.equal(relay.recipients.length, before);
  };
  const invite = async email => {
    const response = await members({ kind: 'invite', email, role: 'viewer' });
    assert.equal(response.status, 200);
    const { invitationId } = await response.json();
    const invitation = relay.inbox.at(-1);
    assert.equal(invitation?.recipient, email);
    assert.equal(invitation.sender, relay.declaration.from);
    assert.deepEqual(invitation.from, { name: 'NoticeOS', address: relay.declaration.from });
    assert.ok(invitation.wire.includes(`${origin}/sign-in#invitation=${invitationId}`));
    return invitationId;
  };

  resetCodeRate(db);
  const before = relay.recipients.length;
  await noCode('unregistered@example.test');
  await noCode(otherEmail);
  assert.equal((await members({ kind: 'invite', email, role: 'viewer' }, {})).status, 403);
  assert.equal((await members({ kind: 'invite', email, role: 'viewer' }, otherOwner)).status, 403);
  assert.equal(relay.recipients.length, before);
  const invitationId = await invite(email);
  await noCode('wrong-mailbox@example.test', invitationId);
  resetCodeRate(db);
  assert.equal((await request(email, invitationId)).status, 202);
  assert.equal(relay.inbox.at(-1).recipient, email);
  const otp = relay.inbox.at(-1).wire.match(/\b(\d{6})\./u)?.[1];
  assert.ok(otp);
  const verified = await route(EMAIL_CODE_PATHS.verify, { email, otp }, headers(invitationId));
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const session = async () => (await fetch(origin + '/api/session', { headers: { cookie } })).json();
  const prepared = await session();
  assert.deepEqual(prepared.workspaces, []);
  assert.equal((await route(ACCEPT_INVITATION_PATH, { invitationId }, { cookie,
    [WORKSPACE_SESSION_HEADER]: prepared.session.sessionId })).status, 200);
  assert.deepEqual((await session()).workspaces.map(({ workspaceId, role }) => ({ workspaceId, role })), [{ workspaceId, role: 'viewer' }]);
  assert.equal((await request(email.toUpperCase())).status, 202);
  assert.deepEqual(relay.recipients.slice(before), [email, email, email]);

  resetCodeRate(db);
  const { items } = await (await members({ kind: 'list', collection: 'members' })).json();
  assert.equal((await members({ kind: 'remove', memberId: items.find(item => item.email === email).id })).status, 200);
  await noCode(email);
  const cancelled = 'cancelled@example.test', expired = 'expired@example.test';
  const cancelledId = await invite(cancelled), expiredId = await invite(expired);
  assert.equal((await members({ kind: 'cancel', invitationId: cancelledId })).status, 200);
  db.cluster.run("UPDATE noticeos_identity.auth_invitation SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=:'id'::uuid", { vars: { id: expiredId } });
  await noCode(cancelled, cancelledId);
  await noCode(expired, expiredId);

  resetCodeRate(db);
  const [turkish] = db.cluster.sql(`SELECT 1 FROM pg_catalog.pg_collation WHERE oid=to_regcollation('pg_catalog."tr-x-icu"')`);
  if (turkish) db.cluster.run(`ALTER TABLE noticeos_identity.auth_user ALTER COLUMN email TYPE text COLLATE pg_catalog."tr-x-icu"`);
  const legacyEmail = 'Ipek@example.test', legacyId = randomUUID();
  db.cluster.run(`INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
    VALUES (:'user'::uuid,'Legacy member',:'email',true);
    INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at)
    VALUES (gen_random_uuid(),:'workspace'::uuid,:'user'::uuid,'viewer',now());`,
  { vars: { user: legacyId, email: legacyEmail, workspace: workspaceId } });
  if (turkish) assert.deepEqual(db.cluster.sql("SELECT lower(email) AS normalized FROM noticeos_identity.auth_user WHERE email='Ipek@example.test'"),
    [{ normalized: 'ıpek@example.test' }]);
  await noCode(legacyEmail);
  const legacyInvitation = await invite(legacyEmail.toLowerCase());
  await noCode(legacyEmail, legacyInvitation);
  let issuedCode;
  const prior = openEmailCodeLogin({ connectionString: db.identityDatabase, trustedOrigin: origin,
    sessionSecret: identitySecret, peerAddress: '192.0.2.17', deliver: async ({ code }) => { issuedCode = code; } });
  try {
    const pending = { kind: 'invitation', id: legacyInvitation };
    const request = new Request(origin + EMAIL_CODE_PATHS.request, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: legacyEmail }) });
    assert.equal((await prior.requestCode(request, pending)).status, 202);
    assert.ok(issuedCode, 'a code exists from before the membership-mail policy');
  } finally { await prior.close(); }
  const refused = await route(EMAIL_CODE_PATHS.verify, { email: legacyEmail, otp: issuedCode }, headers(legacyInvitation));
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.has('set-cookie'), false);
  assert.deepEqual(db.cluster.sql("SELECT id,email FROM noticeos_identity.auth_user WHERE email IN ('Ipek@example.test','ipek@example.test')"),
    [{ id: legacyId, email: legacyEmail }]);
}

async function recordedGoogle(archive) {
  let calls = 0;
  const server = createServer(async (request, reply) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const sent = new Request(request.headers['x-fixture-destination'], { method: request.method,
        headers: { authorization: request.headers.authorization ?? '' }, body: Buffer.concat(chunks) });
      calls++;
      const response = await archive.fetch(sent);
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    } catch { reply.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}/`;
  return {
    async send(url, init) { return fetch(origin, { ...init, headers: { ...init.headers, 'x-fixture-destination': url } }); },
    calls: () => calls,
    close: async () => {
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    },
  };
}

test('an attached customer owns one scheduler and releases it on shutdown or database disconnect', { timeout: 180000 }, async t => {
  const root = testFixtureRoot('n-customer-operating-');
  const source = startPlan({ dir: path.join(root, 'prepared-store'), port: await availableCustomerPort() });
  const operator = startPlan({ dir: path.join(root, 'runtime'), port: source.port });
  const configFile = path.join(root, 'customer.json');
  let db, app, provider, relay;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(source, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(source, db);
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const workspaces = app.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }));
    const email = app.workspaces[0].email;
    const owner = await workspaceOwner(app);
    const otherEmail = app.workspaces[1].email;
    const otherOwner = await workspaceOwner(app, app.workspaces[1]);
    const archive = customerArchiveFixture(app, { useServiceAccount: true });
    await archive.configure(db, credentialsKey);
    provider = await recordedGoogle(archive);
    const config = { format: 'noticeos-customer-operating/1', database: {
      app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString,
    }, identitySecret, credentialsKey, workspaces, mailRecipients: app.workspaces.map(row => row.email) };
    const save = (googleDaily, siteReports, mailDelivery, overrides) => writeFileSync(configFile,
      JSON.stringify({ ...config, googleDaily, siteReports, mailDelivery, ...overrides }), { mode: 0o600 });
    await app.close(); app = undefined;
    relay = await identitySmtpFixture(root);
    writeFileSync(path.join(root, 'mail.json'), JSON.stringify(relay.declaration), { mode: 0o600 });

    let resources;
    const launch = () => startAttachedCustomer(operator, configFile, { googleTransport: provider.send, smtpLaunch: relay.launch, startSchedules(options) {
      resources = options;
      const now = Date.now();
      return startLocalCustomerSchedules({ ...options, now: () => now });
    } });
    save(false, false, 'mail.json');
    app = await launch();
    await app.whenIdle();
    assert.equal(provider.calls(), 0);
    assert.deepEqual(db.cluster.sql('SELECT 1 FROM noticeos.archive_runs'), []);
    const session = await fetch(app.publicOrigin + '/api/session');
    assert.equal((await session.json()).mode, 'hosted');
    resetCodeRate(db);
    await exerciseSignInDelivery(app, relay, email, workspaces[0].workspaceId, db);
    const attempts = relay.recipients.length;
    const restricted = await fetch(app.publicOrigin + MEMBERSHIP_PATH, { method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'invite', email: 'restricted@example.test', role: 'viewer' }) });
    assert.equal(restricted.status, 503);
    assert.ok((await restricted.json()).invitationId);
    assert.equal(relay.recipients.length, attempts);
    assert.equal((await fetch(app.publicOrigin + '/api/mcp')).status, 401);
    assert.equal((await fetch(app.publicOrigin + '/api/assets/archive-app/report-token', { method: 'POST', headers: owner })).status, 404);
    const other = startPlan({ dir: path.join(root, 'second-runtime'), port: await availableCustomerPort() });
    await assert.rejects(promisify(execFile)(process.execPath, customerArgs(other, configFile)),
    error => /already owns this database/u.test(error.stdout + error.stderr));
    assert.equal(provider.calls(), 0);
    await app.close(); app = undefined;

    save(true, false, 'mail.json', { mailRecipients: undefined, workspaces: [workspaces[0]] });
    app = await launch();
    assert.equal(resources.resumeSince, undefined);
    await app.whenIdle();
    await archive.verify({ db, options: resources, t });
    await exerciseMembershipMail(app, relay, db, { owner, otherOwner, otherEmail, identitySecret });
    const archived = provider.calls();
    const backend = db.cluster.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='noticeos-local-customer-scheduler'`);
    assert.equal(backend.length, 1);
    db.cluster.run(`SELECT pg_terminate_backend(:'pid'::int)`, { vars: backend[0] });
    assert.match((await app.whenLost).message, /lost its database lease/u);
    await app.close(); app = undefined;
    await assert.rejects(fetch(operator.url), /fetch failed/u);
    assert.equal(provider.calls(), archived);
    const resumed = await openCustomerOperating(operator, configFile);
    try { assert.ok(Number.isSafeInteger(resumed.resumeSince)); }
    finally { await resumed.close(); }
    save(false, true);
    await assertNormalLauncher(operator, configFile, () => exerciseSiteReports(new URL(operator.url).origin, owner, db));
    assert.equal(provider.calls(), archived);
  } finally {
    try { await app?.close(); } finally { db?.close(); await Promise.all([provider?.close(), relay?.close()]); }
    if (!existsSync(path.join(source.home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
