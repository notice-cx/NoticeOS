import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { availableCustomerPort as availablePort } from './test/customer-ports.mjs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS, MEMBERSHIP_PATH, PERSONAL_PROFILE_PATH } from './identity-protocol.mjs';
import { PROTECTED_RESOURCE_METADATA_PATH } from './agent-access.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { localNtasksOrigin, startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { startPlan } from './start.mjs';
import { PostgresUnavailable } from './postgres-dev.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { assertCustomerSchedule, prepareCustomerSchedule } from './test-fixtures/customer-schedule.mjs';
import { prepareCustomerReports, prepareReportObjects, verifyCustomerReports } from './test-fixtures/customer-report.mjs';
import { customerArchiveFixture } from './test-fixtures/customer-archive.mjs';
import { useCustomerProfileBrowser } from './test-fixtures/customer-profile-browser.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';


function messages(directory) {
  return readdirSync(directory).map(file => JSON.parse(readFileSync(path.join(directory, file), 'utf8')));
}

test('a customer fixture accepts only an explicit local Ntasks origin', () => {
  assert.equal(localNtasksOrigin('http://127.0.0.1:17399'), 'http://127.0.0.1:17399');
  for (const origin of ['https://example.test', 'http://localhost:17399', 'http://127.0.0.1:17399/path', 'http://127.0.0.1:17399?provider=other']) {
    assert.throws(() => localNtasksOrigin(origin));
  }
});

test('local customer startup can retry before initialization and renews just the expired first invitation', { timeout: 120_000 }, async t => {
  const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'noticeos-customer-first-'));
  const plan = startPlan({ dir: home, port: await availablePort() });
  const postgres = path.join(home, '.local', 'customer-postgres');
  let db, app;
  try {
    assert.throws(() => openDevelopmentStart(plan, { profile: 'hosted', tools: null }), PostgresUnavailable);
    assert.deepEqual(readdirSync(postgres), []);
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(plan, db);
    const [expired, active] = app.workspaces;
    const expiredId = new URL(expired.url).hash.slice('#invitation='.length);
    db.cluster.run(`UPDATE noticeos_identity.auth_invitation SET expires_at = now() - interval '1 hour'
      WHERE id = :'id'::uuid;
      INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
      VALUES (:'workspace'::uuid, 'saved-example', 'Saved example', 'live', 1);`,
    { vars: { id: expiredId, workspace: expired.workspaceId } });
    const invitations = () => db.cluster.sql(`SELECT id, expires_at::text, expires_at > now() AS usable
      FROM noticeos_identity.auth_invitation ORDER BY id`);
    const original = invitations();
    assert.equal(original.find(row => row.id === expiredId).usable, 'f');
    const settingsFile = path.join(db.customer, 'settings.json');
    const settings = readFileSync(settingsFile, 'utf8');
    await app.close(); app = undefined;
    db.close(); db = undefined;

    db = openDevelopmentStart(plan, { profile: 'hosted' });
    app = await startLocalCustomer(plan, db);
    const renewed = invitations();
    assert.equal(renewed.find(row => row.id === expiredId).usable, 't');
    assert.deepEqual(renewed.filter(row => row.id !== expiredId), original.filter(row => row.id !== expiredId));
    assert.equal(readFileSync(settingsFile, 'utf8'), settings);
    assert.deepEqual(db.cluster.sql(`SELECT asset_id FROM noticeos.assets WHERE asset_id = 'saved-example'`), [{ asset_id: 'saved-example' }]);
    for (const [workspace, count] of [[expired, 2], [active, 1]]) {
      assert.equal(messages(app.outbox).filter(message => message.to === workspace.email && message.text.endsWith(workspace.url)).length, count);
    }
    const response = await fetch(app.publicOrigin + EMAIL_CODE_PATHS.request, { method: 'POST',
      headers: { origin: app.publicOrigin, 'content-type': 'application/json',
        [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: expiredId },
      body: JSON.stringify({ email: expired.email }), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 202);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    assert.equal(existsSync(path.join(postgres, 'data', 'postmaster.pid')), false);
    rmSync(home, { recursive: true, force: true });
  }
});

test('local customer Tower uses real invitations, workspace selection and durable sessions', { timeout: 180_000 }, async t => {
  const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'noticeos-customer-'));
  const port = await availablePort();
  const plan = startPlan({ dir: home, port });
  let db, app;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(plan, db);
    const origin = app.publicOrigin;
    const http = (route, { body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(origin + route, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    const readSession = (cookie, workspace) => http('/api/session', { headers: { cookie,
      ...(workspace ? { [WORKSPACE_SELECTION_HEADER]: workspace } : {}),
    } });
    const member = (session, workspace, body) => http(MEMBERSHIP_PATH, { body, headers: { cookie: session.cookie,
      [WORKSPACE_SESSION_HEADER]: session.sessionId, [WORKSPACE_SELECTION_HEADER]: workspace,
    } });
    const accept = (session, invitationId) => http(ACCEPT_INVITATION_PATH, { body: { invitationId },
      headers: { cookie: session.cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId },
    });
    const signUp = async workspace => {
      const { email, url } = workspace;
      const invitationId = new URL(url).hash.slice('#invitation='.length);
      const enrollment = { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId };
      const sent = await http(EMAIL_CODE_PATHS.request, { body: { email }, headers: enrollment });
      assert.equal(sent.status, 202);
      const mail = messages(app.outbox).find(item => item.to === email && /[0-9]{6}\.$/u.test(item.text));
      assert.ok(mail);
      const otp = mail.text.match(/\b([0-9]{6})\.$/u)[1];
      const response = await http(EMAIL_CODE_PATHS.verify, { body: { email, otp }, headers: enrollment });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      const before = await (await readSession(cookie)).json();
      assert.deepEqual(before.workspaces, []);
      const session = { ...before.session, cookie };
      assert.equal((await accept(session, invitationId)).status, 200);
      assert.equal((await accept(session, invitationId)).status, 403);
      return session;
    };

    const bootstrap = await http('/api/session');
    assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
    assert.equal((await bootstrap.json()).mode, 'hosted');
    for (const page of ['/', '/wall', '/sign-in', '/agent-access']) {
      const response = await http(page);
      assert.equal(response.status, 200, page);
      assert.match(response.headers.get('content-type'), /text\/html/u);
    }
    assert.equal((await http('/api/mcp')).status, 401);
    const metadata = await http(PROTECTED_RESOURCE_METADATA_PATH);
    assert.equal(metadata.status, 200, await metadata.clone().text());
    const resource = await metadata.json();
    assert.equal(resource.resource, `${origin}/api/mcp`);

    const [east, west] = app.workspaces;
    const ownEast = await signUp(east), ownWest = await signUp(west);
    const profileHeaders = (session, workspaceId) => ({ cookie: session.cookie,
      [WORKSPACE_SESSION_HEADER]: session.sessionId, [WORKSPACE_SELECTION_HEADER]: workspaceId });
    const profile = (headers, body) => http(PERSONAL_PROFILE_PATH, body === undefined
      ? { headers } : { headers, method: 'PATCH', body });
    const reader = profileHeaders(ownEast, west.workspaceId);
    const westOwner = profileHeaders(ownWest, west.workspaceId);
    const eastOwner = profileHeaders(ownEast, east.workspaceId);
    const displayName = 'Cora Example';
    const renamedPerson = { displayName, email: east.email, editable: true };
    const ownBefore = await profile(eastOwner);
    assert.equal(ownBefore.status, 200, await ownBefore.clone().text());
    assert.equal(ownBefore.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ownBefore.json(), { displayName: '', email: east.email, editable: true });
    assert.equal((await profile(reader, { displayName })).status, 403);
    assert.equal((await profile({ ...eastOwner, [WORKSPACE_SESSION_HEADER]: ownWest.sessionId })).status, 403);
    assert.equal((await profile({ ...eastOwner, origin: 'https://other.example.test' }, { displayName })).status, 403);
    assert.equal((await http(PERSONAL_PROFILE_PATH + '?userId=' + ownWest.principalId, { headers: eastOwner })).status, 403);
    assert.equal((await profile(eastOwner, { displayName, email: west.email })).status, 400);
    assert.equal((await profile(eastOwner, { displayName: ' ' })).status, 400);
    assert.equal((await profile(eastOwner, { displayName: 'X'.repeat(121) })).status, 400);
    assert.equal((await http('/api/auth/update-user', { headers: eastOwner, body: { name: displayName } })).status, 403);
    assert.equal((await readSession(ownEast.cookie, west.workspaceId)).status, 403);
    const invitation = await member(ownWest, west.workspaceId, { kind: 'invite', email: east.email, role: 'viewer' });
    assert.equal(invitation.status, 200);
    const { invitationId } = await invitation.json();
    assert.ok(messages(app.outbox).some(item => item.to === east.email && item.text.endsWith(invitationId)));
    assert.equal((await accept(ownEast, invitationId)).status, 200);
    const switched = await (await readSession(ownEast.cookie, west.workspaceId)).json();
    assert.equal(switched.selectedWorkspace.role, 'viewer');
    assert.equal((await (await readSession(ownEast.cookie, east.workspaceId)).json()).selectedWorkspace.role, 'owner');
    assert.equal((await member(ownEast, west.workspaceId, { kind: 'list', collection: 'members' })).status, 403);
    const saved = await profile(reader, { displayName: ` ${displayName} ` });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await saved.json(), renamedPerson);
    assert.deepEqual(await (await profile(eastOwner)).json(), renamedPerson);
    assert.deepEqual(await (await profile(westOwner)).json(), { displayName: '', email: west.email, editable: true });
    const headers = { cookie: ownEast.cookie, [WORKSPACE_SESSION_HEADER]: ownEast.sessionId,
      [WORKSPACE_SELECTION_HEADER]: west.workspaceId };
    const wall = await http('/api/wall', { headers });
    assert.equal(wall.status, 200, await wall.clone().text());
    const mcp = await http('/api/mcp', { headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(mcp.status, 200, await mcp.clone().text());
    assert.ok((await mcp.json()).result.tools.some(tool => tool.name === 'list_properties'));

    prepareCustomerSchedule({ db, app });
    const reportObjects = prepareCustomerReports({ db, app });
    db.cluster.run(`DELETE FROM noticeos.config_documents
      WHERE workspace_id=:'workspace'::uuid AND document_key='value-events';`, { vars: { workspace: west.workspaceId } });
    const archive = customerArchiveFixture(app);
    await app.close(); app = undefined;
    db.close(); db = undefined;
    assert.equal(existsSync(path.join(home, '.local', 'customer-postgres', 'data', 'postmaster.pid')), false);
    db = openDevelopmentStart(plan, { profile: 'hosted' });
    let resources, cold;
    const warning = t.mock.method(console, 'warn', () => {});
    app = await startLocalCustomer(plan, db, { fixtureProvider: archive.fetch, async startSchedules(options) {
      resources = options;
      await prepareReportObjects(options.bucket, reportObjects);
      await archive.configure(db, options.credentialsKey);
      const started = Date.now();
      return startLocalCustomerSchedules({ ...options, now: () => started, reports: { ...options.reports, async run(input) {
        cold = await options.reports.run(input);
        return cold;
      } } });
    } });
    await app.whenIdle();
    assertCustomerSchedule({ db, app });
    assert.equal(warning.mock.calls.filter(call => /report settings/u.test(String(call.arguments[0]))).length, 1);
    assert.equal(cold?.objectReads, reportObjects.length);
    await verifyCustomerReports({ db, app, resources, cold, t });
    const collected = await archive.verify({ db, options: resources, t });
    const eastHeaders = { cookie: ownEast.cookie, [WORKSPACE_SESSION_HEADER]: ownEast.sessionId,
      [WORKSPACE_SELECTION_HEADER]: east.workspaceId };
    const property = await http('/api/assets/fixture-app', { headers: eastHeaders });
    assert.equal(property.status, 200);
    const towerReport = (await property.json()).executive;
    assert.equal(towerReport.sourceArchiveCount, reportObjects.length);
    const otherProperty = await http('/api/assets/fixture-app', { headers });
    assert.equal(otherProperty.status, 200);
    assert.equal((await otherProperty.json()).executive, null);
    const agentReport = await http('/api/mcp', { headers: eastHeaders,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'property_report', arguments: { asset: 'fixture-app' } } } });
    assert.equal(agentReport.status, 200);
    assert.deepEqual((await agentReport.json()).result.structuredContent.executive, towerReport);
    const fresh = await http(`/api/assets/${collected.asset}`, { headers: eastHeaders });
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json()).executive.sourceArchiveCount, collected.archives);
    const unpublished = await http(`/api/assets/${collected.asset}`, { headers });
    assert.equal(unpublished.status, 200);
    assert.equal((await unpublished.json()).executive, null);
    const resumed = await (await readSession(ownEast.cookie, west.workspaceId)).json();
    assert.equal(resumed.session.sessionId, ownEast.sessionId);
    assert.equal(resumed.selectedWorkspace.role, 'viewer');
    assert.deepEqual(await (await profile(reader)).json(), renamedPerson);
    if (process.env.NOTICEOS_TEST_CUSTOMER_PROFILE === '1') {
      const newName = 'Cora Browser';
      await useCustomerProfileBrowser({ origin, outbox: app.outbox, email: east.email, workspaceLabel: 'West workspace',
        role: 'viewer', initialName: displayName, newName, otherWorkspace: { label: 'East workspace', role: 'owner' } });
      renamedPerson.displayName = newName;
    }
    const members = await (await member(ownWest, west.workspaceId, { kind: 'list', collection: 'members' })).json();
    const memberId = members.items.find(item => item.email === east.email).id;
    assert.equal((await member(ownWest, west.workspaceId, { kind: 'remove', memberId })).status, 200);
    assert.equal((await readSession(ownEast.cookie, west.workspaceId)).status, 403);
    assert.equal((await profile(reader, { displayName: 'Stale browser' })).status, 403);
    assert.deepEqual(await (await profile(eastOwner)).json(), renamedPerson);
    assert.equal((await readSession(ownEast.cookie, east.workspaceId)).status, 200);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    assert.equal(existsSync(path.join(home, '.local', 'customer-postgres', 'data', 'postmaster.pid')), false);
    rmSync(home, { recursive: true, force: true });
  }
});
