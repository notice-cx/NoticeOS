import assert from 'node:assert/strict';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
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
    const exchanges = [];
    app = await startLocalCustomer(plan, db, { async fixtureProvider(request) {
      assert.equal(request.url, 'https://oauth2.googleapis.com/token');
      assert.equal(request.method, 'POST');
      const form = new URLSearchParams(await request.text());
      const provider = new URL(form.get('redirect_uri')).pathname.split('/')[3];
      exchanges.push({ provider, code: form.get('code') });
      const scopes = provider === 'adsense' ? ['adsense.readonly'] : ['analytics.readonly', 'webmasters.readonly'];
      return Response.json({ refresh_token: 'synthetic-refresh', scope: scopes.map(scope => `https://www.googleapis.com/auth/${scope}`).join(' ') });
    } });
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
    await t.test('provider consent returns only the authenticated workspace’s recorded report', async subtest => {
      const source = 'source.example.test', other = 'other.example.test';
      subtest.after(() => db.cluster.run(`DELETE FROM noticeos.integration_connections
        WHERE workspace_id=:'east'::uuid AND provider IN ('google','adsense','google-oauth-app','adsense-oauth-app');
        DELETE FROM noticeos.assets WHERE (workspace_id, asset_id) IN ((:'east'::uuid, :'source'), (:'west'::uuid, :'other'));`,
      { vars: { east: east.workspaceId, west: west.workspaceId, source, other } }));
      for (const [workspace, asset] of [[east, source], [west, other]]) {
        db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
          VALUES (:'workspace'::uuid, :'asset', :'asset', 'live', 1)`, { vars: { workspace: workspace.workspaceId, asset } });
      }
      const headers = { cookie: ownEast.cookie, [WORKSPACE_SESSION_HEADER]: ownEast.sessionId, [WORKSPACE_SELECTION_HEADER]: east.workspaceId };
      async function issue(provider, from = '') {
        const response = await http(`/api/integrations/${provider}/oauth/start${from}`, { method: 'POST', headers });
        assert.equal(response.status, 200, await response.clone().text());
        const target = new URL((await response.json()).authorizeUrl);
        assert.equal(target.origin, 'https://accounts.google.com');
        assert.equal(target.searchParams.has('asset'), false);
        const state = target.searchParams.get('state');
        assert.match(state, /^[a-z0-9_-]{43}$/iu);
        return state;
      }
      async function callback(provider, state, outcome, cookie = ownEast.cookie) {
        const response = await fetch(`${origin}/api/integrations/${provider}/oauth/callback?state=${state}&${outcome}`, {
          headers: { cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
          redirect: 'manual', signal: AbortSignal.timeout(30_000),
        });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        const target = new URL(response.headers.get('location'));
        assert.equal(target.origin + target.pathname, origin + '/integrations');
        assert.equal(target.searchParams.get('connect'), provider);
        assert.equal(target.searchParams.has('code'), false);
        assert.equal(target.searchParams.has('state'), false);
        return Object.fromEntries(target.searchParams);
      }
      const returnQuery = (asset, tab) => `?asset=${asset}&fromReport=${tab}&range=90`;
      for (const [provider, report, prefix] of [['google', 'journeys', 'GOOGLE'], ['adsense', 'financials', 'ADSENSE']]) {
        const saved = await http(`/api/integrations/${provider}-oauth-app/credential`, { headers, method: 'PUT', body: { fields: {
          [`${prefix}_OAUTH_CLIENT_ID`]: 'generated.apps.googleusercontent.com', [`${prefix}_OAUTH_CLIENT_SECRET`]: 'generated-credential',
        } } });
        assert.equal(saved.status, 204, await saved.clone().text());
        const state = await issue(provider, returnQuery(source, report));
        assert.deepEqual(await callback(provider, state, 'code=synthetic-wrong-session', ownWest.cookie), { connect: provider, google: 'state_invalid' });
        assert.deepEqual(await callback(provider, state, 'code=synthetic-consent'), {
          connect: provider, google: 'connected', asset: source, fromReport: report, range: '90', reportWorkspace: east.workspaceId,
        });
        assert.deepEqual(await callback(provider, state, 'code=synthetic-replay'), { connect: provider, google: 'state_invalid' });
        const cancelled = await issue(provider, returnQuery(source, report));
        assert.deepEqual(await callback(provider, cancelled, 'error=access_denied'), {
          connect: provider, google: 'denied', asset: source, fromReport: report, range: '90', reportWorkspace: east.workspaceId,
        });
      }
      const foreign = await issue('google', returnQuery(other, 'search'));
      assert.deepEqual(await callback('google', foreign, 'error=access_denied'), { connect: 'google', google: 'denied' });
      const ordinary = await issue('google');
      assert.deepEqual(await callback('google', ordinary, 'error=access_denied'), { connect: 'google', google: 'denied' });
      for (const suffix of ['?asset=source.example.test&fromReport=%2F%2Felsewhere.invalid', `${returnQuery(source, 'search')}&range=7`, `${returnQuery(source, 'search')}&redirect=/other`]) {
        assert.equal((await http(`/api/integrations/google/oauth/start${suffix}`, { method: 'POST', headers })).status, 403);
      }
      assert.deepEqual(exchanges, ['google', 'adsense'].map(provider => ({ provider, code: 'synthetic-consent' })));
    });
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

    const eastHeaders = { cookie: ownEast.cookie, [WORKSPACE_SESSION_HEADER]: ownEast.sessionId,
      [WORKSPACE_SELECTION_HEADER]: east.workspaceId };
    const westHeaders = { cookie: ownWest.cookie, [WORKSPACE_SESSION_HEADER]: ownWest.sessionId,
      [WORKSPACE_SELECTION_HEADER]: west.workspaceId };
    prepareCustomerSchedule({ db, app });
    const analysis = '/api/analysis-workflows';
    const site = 'fixture-app';
    const requestHeaders = { ...eastHeaders, 'Idempotency-Key': 'new-analysis-workflow' };
    const weeklySlot = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const input = { name: 'Review search', template: 'weekly-search-review', assetIds: [site],
      trigger: { kind: 'weekly', weekday: weeklySlot.getUTCDay(), hour: weeklySlot.getUTCHours(), minute: weeklySlot.getUTCMinutes(), timeZone: 'UTC' } };
    assert.equal((await http(analysis, { headers: { ...headers, 'Idempotency-Key': 'wrong-viewer-workflow' }, body: input })).status, 403);
    assert.equal((await http(analysis, { headers: { ...requestHeaders, origin: 'https://untrusted.example' }, body: input })).status, 403);
    assert.equal((await http(analysis, { headers: { ...westHeaders, 'Idempotency-Key': 'unknown-asset-workflow' },
      body: { ...input, assetIds: ['unknown.example'] } })).status, 409);
    const created = await http(analysis, { headers: requestHeaders, body: input });
    assert.equal(created.status, 201, await created.clone().text());
    const { workflow } = await created.json();
    const workflowPath = `${analysis}/${workflow.id}`;
    assert.equal((await (await http(analysis, { headers: requestHeaders, body: input })).json()).workflow.id, workflow.id);
    assert.equal((await http(analysis, { headers: requestHeaders, body: { ...input, name: 'Different' } })).status, 409);
    assert.equal((await http(workflowPath, { headers: westHeaders })).status, 404);
    assert.deepEqual((await (await http(analysis, { headers })).json()).workflows, []);
    const start = key => http(workflowPath + '/runs', { headers: { ...eastHeaders, 'Idempotency-Key': key }, body: {} });
    const runs = await Promise.all([start('manual-analysis-run'), start('manual-analysis-run')]);
    for (const response of runs) assert.equal(response.status, 201, await response.clone().text());
    const [first, replay] = await Promise.all(runs.map(async response => (await response.json()).run));
    assert.equal(replay.id, first.id);
    assert.equal(first.workflow.version, 1);
    assert.deepEqual(first.workflow.assetIds, [site]);
    assert.ok(first.runbook.steps.length);
    const complete = workflowPath + '/runs/' + first.id + '/complete';
    assert.equal((await http(complete, { headers: eastHeaders, body: { outcome: 'findings', summary: 'Validate citation',
      findings: [{ title: 'Unsupported result', detail: 'Foreign evidence', citationIds: ['another-workspace'] }] } })).status, 400);
    const result = { outcome: 'no-action', summary: 'Review the next complete week', findings: [] };
    const completed = await http(complete, { headers: eastHeaders, body: result });
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.deepEqual((await completed.json()).run.result, result);
    assert.equal((await http(complete, { headers: eastHeaders, body: result })).status, 200);
    assert.equal((await http(complete, { headers: eastHeaders, body: { ...result, summary: 'Different' } })).status, 409);
    const pause = (enabled, expectedVersion) => http(workflowPath + '/pause', { headers: eastHeaders, body: { enabled, expectedVersion } });
    assert.equal((await pause(false, 1)).status, 200);
    assert.equal((await start('after-pause-analysis')).status, 409);
    assert.equal((await pause(true, 1)).status, 409);
    assert.equal((await pause(true, 2)).status, 200);
    const retried = await http(workflowPath + '/runs', { headers: { ...eastHeaders, 'Idempotency-Key': 'retry-analysis-result' },
      body: { retryOf: first.id } });
    assert.equal(retried.status, 201, await retried.clone().text());
    const { run: retry } = await retried.json();
    assert.equal(retry.retryOf, first.id);
    assert.equal(retry.source, 'retry');
    assert.equal(retry.workflow.version, 1);
    assert.deepEqual(retry.evidence, first.evidence);
    const insufficient = await http(workflowPath + '/runs/' + retry.id + '/complete', { headers: eastHeaders,
      body: { outcome: 'insufficient-evidence', summary: 'The comparison is incomplete', findings: [] } });
    assert.equal(insufficient.status, 200, await insufficient.clone().text());
    assert.equal((await insufficient.json()).run.outcome, 'insufficient-evidence');
    db.cluster.run(`UPDATE noticeos.analysis_workflows SET updated_at=:'available'::timestamptz
      WHERE workspace_id=:'workspace'::uuid AND workflow_id=:'workflow'::uuid;`, { vars: {
      workspace: east.workspaceId, workflow: workflow.id, available: new Date(weeklySlot.getTime() - 60_000).toISOString(),
    } });

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
    const detail = await http(workflowPath, { headers: eastHeaders });
    assert.equal(detail.status, 200, await detail.clone().text());
    const receipts = (await detail.json()).runs;
    assert.equal(receipts.length, 3);
    const weekly = receipts.find(receipt => receipt.source === 'weekly');
    assert.equal(Date.parse(weekly.scheduledAt), weeklySlot.getTime());
    assert.equal(weekly.outcome, null);
    const weeklyPath = workflowPath + '/runs/' + weekly.id;
    const due = await http(weeklyPath, { headers: eastHeaders });
    assert.equal(due.status, 200, await due.clone().text());
    const { run: dueRun } = await due.json();
    const measured = dueRun.evidence.citations.find(citation => citation.source === 'Measurement periods');
    assert.equal(measured.readings[0].value, 0);
    const finding = { title: 'No open periods', detail: 'The asset had no open measurement periods at the scheduled review.',
      citationIds: [measured.id] };
    const published = await http(weeklyPath + '/complete', { headers: eastHeaders,
      body: { outcome: 'findings', summary: 'Recorded the measurement-period count', findings: [finding] } });
    assert.equal(published.status, 200, await published.clone().text());
    assert.deepEqual((await published.json()).run.result.findings, [finding]);
    const replayStore = openWorkspaceStore(resources.connectionString, { workspaceId: east.workspaceId });
    try {
      await resources.analysis.run({ store: replayStore,
        principalId: resources.workspaces.find(binding => binding.workspaceId === east.workspaceId).serviceId,
        workflowId: workflow.id, scheduledAt: weeklySlot.toISOString() });
    } finally { await replayStore.close(); }
    assert.equal((await (await http(workflowPath, { headers: eastHeaders })).json()).runs.length, 3);
    assertCustomerSchedule({ db, app });
    assert.equal(warning.mock.calls.filter(call => /report settings/u.test(String(call.arguments[0]))).length, 1);
    assert.equal(cold?.objectReads, reportObjects.length);
    await verifyCustomerReports({ db, app, resources, cold, t });
    const collected = await archive.verify({ db, options: resources, t });
    const property = await http('/api/assets/fixture-app', { headers: eastHeaders });
    assert.equal(property.status, 200);
    const towerReport = (await property.json()).executive;
    assert.equal(towerReport.sourceArchiveCount, reportObjects.length);
    const otherProperty = await http('/api/assets/fixture-app', { headers });
    assert.equal(otherProperty.status, 200);
    assert.equal((await otherProperty.json()).executive, null);
    const mcp = await http('/api/mcp', { headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(mcp.status, 200, await mcp.clone().text());
    assert.ok((await mcp.json()).result.tools.some(tool => tool.name === 'list_properties'));
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
