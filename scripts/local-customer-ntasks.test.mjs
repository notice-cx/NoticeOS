import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableCustomerPort as availablePort } from './test/customer-ports.mjs';
import path from 'node:path';
import test from 'node:test';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { configDocumentKey } from './config-documents.mjs';
import { applyDemoNtasksProvision, demoNtasks, demoNtasksWorker } from './demo-ntasks.mjs';
import { hostedTaskAuthorization } from './hosted-task-request.mjs';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS } from './identity-protocol.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { assertSameStoreHandoff } from './test/customer-runtime-handoff.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { assertCustomerShadowTarget } from './test/customer-shadow-target.mjs';
import { assertAnalysisAssignment } from './test-fixtures/customer-analysis-assignment.mjs';
import { assertNtasksShadowActivation } from './test/customer-shadow-activation.mjs';

const tools = process.env.NOTICEOS_NTASKS_ROOT;

test('the local customer Tower reads and writes to distinct workspaces in a separate Ntasks', {
  skip: !tools, timeout: 240_000,
}, async t => {
  const root = testFixtureRoot('n-local-ntasks-');
  const home = path.join(root, 'customer');
  mkdirSync(home, { mode: 0o700 });
  let postgres, app, ntasks;
  const seedActors = ['oak', 'elm', 'pine'].map(prefix => ({ prefix, workspaceId: randomUUID(), projectId: randomUUID() }));
  const cli = (...args) => execFileSync(process.execPath, [path.join(tools, 'tools/migrate/src/cli.ts'), ...args]);
  try {
    const plan = startPlan({ dir: home, port: await availablePort() });
    postgres = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!postgres) return;
    const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
    const { Miniflare } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
    const worker = demoNtasksWorker({ bundleRoot: path.join(tools, 'dist'), workspaceId: seedActors[0].workspaceId,
      authSecret: randomBytes(48).toString('base64url') });
    const { PUBLIC_WORKSPACE_ID: _publicWorkspace, ...privateBindings } = worker.bindings;
    ntasks = new Miniflare({ ...worker, bindings: privateBindings, host: '127.0.0.1', port: 0, cf: false,
      resourcePersistencePath: path.join(root, 'ntasks') });
    const ntasksOrigin = (await ntasks.ready).origin;
    const database = await ntasks.getD1Database('DB');
    const actors = [];
    for (const [index, seed] of seedActors.entries()) {
      const prefix = path.join(root, seed.prefix), request = `${prefix}-provision-request.json`, out = `${prefix}-provision.json`;
      writeFileSync(request, JSON.stringify({ format: 'ntasks-provision-request-v1', workspace: { id: seed.workspaceId, name: seed.prefix },
        owner: { name: 'Fixture owner' }, credentials: [{ name: 'loader', backup: true, restore: true },
          { name: 'tower', grants: [{ projectId: seed.projectId, access: 'write' }] },
          { name: 'readonly', grants: [{ projectId: seed.projectId, access: 'read' }] }] }));
      cli('provision', '--from', request, '--out', out);
      const provision = JSON.parse(readFileSync(out, 'utf8'));
      if (index > 0) provision.statements = provision.statements.filter(row =>
        /^INSERT INTO (?:auth_user|workspaces|workspace_members|access_service_credentials|access_service_grants)\s*\(/u.test(row.sql));
      await applyDemoNtasksProvision(database, provision);
      const source = `${prefix}-seed.json`, backup = `${prefix}-backup.json`, token = `${prefix}.token`;
      writeFileSync(source, JSON.stringify({ format: 'ntasks-seed-v1', projects: [{ id: seed.projectId, prefix: seed.prefix,
        key: seed.prefix, name: seed.prefix, createdAt: new Date().toISOString() }], tasks: [] }));
      writeFileSync(token, `${provision.tokens.loader}\n`, { mode: 0o600 });
      cli('seed', '--from', source, '--out', backup);
      cli('load', '--api', ntasksOrigin, '--token-file', token, '--from', backup);
      actors.push({ ...seed, token: provision.tokens.tower, readonlyToken: provision.tokens.readonly });
    }
    app = await startLocalCustomer(plan, postgres, { ntasksOrigin });
    const origin = app.publicOrigin;
    const http = (route, { body, headers = {} } = {}) => fetch(origin + route, {
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, signal: AbortSignal.timeout(30000),
    });
    const signUp = async ({ email, url }) => {
      const invitationId = new URL(url).hash.slice('#invitation='.length);
      const headers = { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId };
      assert.equal((await http(EMAIL_CODE_PATHS.request, { body: { email }, headers })).status, 202);
      const message = readdirSync(app.outbox).map(file => JSON.parse(readFileSync(path.join(app.outbox, file), 'utf8')))
        .find(item => item.to === email && /[0-9]{6}\.$/u.test(item.text));
      assert.ok(message);
      const otp = message.text.match(/\b([0-9]{6})\.$/u)[1];
      const login = await http(EMAIL_CODE_PATHS.verify, { body: { email, otp }, headers });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      const { session } = await (await http('/api/session', { headers: { cookie } })).json();
      const bound = { cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId };
      assert.equal((await http(ACCEPT_INVITATION_PATH, { body: { invitationId }, headers: bound })).status, 200);
      return bound;
    };
    for (const [i, actor] of actors.slice(0, 2).entries()) {
      const workspace = app.workspaces[i], binding = await signUp(workspace);
      const asset = `${actor.prefix}.example`;
      postgres.cluster.run(`UPDATE noticeos.config_documents SET body=:'body'::jsonb WHERE workspace_id=:'workspace'::uuid AND document_key=:'key';
        INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,list_position)
        VALUES (:'workspace'::uuid, :'asset', :'asset', 'live', 1)`, { vars: { workspace: workspace.workspaceId, asset,
        key: configDocumentKey('config/beads.json'), body: JSON.stringify({ spokes: [{ asset, prefix: actor.prefix, database: actor.prefix }] }) } });
      const headers = { ...binding, [WORKSPACE_SELECTION_HEADER]: workspace.workspaceId };
      const connected = await http('/api/integrations/ntasks/connect', { headers, body: { fields: {
        NTASKS_URL: ntasksOrigin, NTASKS_WORKSPACE_ID: actor.workspaceId, NTASKS_TOKEN: actor.token,
      } } });
      assert.equal(connected.status, 200);
      assert.equal((await connected.json()).verdict, 'accepted');
      actor.headers = headers;
      actor.board = { cookie: binding.cookie,
        authorization: `Bearer ${hostedTaskAuthorization(workspace.workspaceId, binding[WORKSPACE_SESSION_HEADER], null)}` };
      const catalog = await http('/api/tasks/projects', { headers: actor.board });
      assert.equal(catalog.status, 200);
      assert.deepEqual((await catalog.json()).projects.map(project => project.projectId), [actor.projectId]);
    }
    const [oak, elm] = actors;
    assert.equal((await http(`/api/tasks?project=${elm.projectId}`, { headers: oak.board })).status, 404);
    const saved = await http('/api/tasks', { headers: { ...elm.board, 'idempotency-key': 'fixture-customer-work' },
      body: { projectId: elm.projectId, title: 'Check the signup report' } });
    assert.equal(saved.status, 200, await saved.clone().text());
    const { id } = await saved.json();
    const client = actor => demoNtasks({ workspaceId: actor.workspaceId, origin: ntasksOrigin, token: actor.token });
    assert.equal((await client(elm).tool('get_task', { task: id })).task.title, 'Check the signup report');
    await assert.rejects(client(oak).tool('get_task', { task: id }));
    const summary = await http('/api/work', { headers: elm.headers });
    assert.equal(summary.status, 200);
    const work = await summary.json();
    assert.ok(work.capturedAt);
    assert.ok(JSON.stringify(work.projects).includes(id));
    const firstWall = await http('/api/wall', { headers: oak.headers });
    assert.equal(firstWall.status, 200, await firstWall.clone().text());
    const wall = await firstWall.json();
    assert.equal(wall.workProjects.length, 1);
    assert.ok(wall.workProjects[0]?.capturedAt);
    assert.equal(wall.workProjects[0].open, 0);
    assert.equal((await http(`/api/tasks/${id}/respond`, { headers: elm.board, body: { projectId: elm.projectId, response: 'A fixture answer' } })).status, 401);
    await t.test('one analysis handoff and one explicitly consented result stay in the selected workspace', () =>
      assertAnalysisAssignment({ origin, http, owner: elm, otherOwner: oak, ntasks: client(elm), cluster: postgres.cluster }));
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(postgres.customer, 'settings.json'), 'utf8'));
    const attachedConfig = path.join(root, 'attached.json');
    writeFileSync(attachedConfig, JSON.stringify({ format: 'noticeos-customer-operating/1', database: {
      app: postgres.address, identity: postgres.identityDatabase, grant: postgres.grantConnectionString,
    }, identitySecret, credentialsKey, ntasksOrigin, mailRecipients: app.workspaces.map(workspace => workspace.email),
    workspaces: app.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })) }), { mode: 0o600 });
    await app.close(); app = undefined;
    app = await startAttachedCustomer(startPlan({ dir: path.join(root, 'attached'), port: plan.port }), attachedConfig);
    const reopened = await http('/api/tasks/projects', { headers: elm.board });
    assert.equal(reopened.status, 200);
    assert.deepEqual((await reopened.json()).projects.map(project => project.projectId), [elm.projectId]);
    assert.equal((await http(`/api/tasks?project=${elm.projectId}`, { headers: oak.board })).status, 404);
    const mcp = await http('/api/mcp', { headers: elm.headers,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(mcp.status, 200);
    assert.ok((await mcp.json()).result.tools.some(tool => tool.name === 'property_report'));
    await app.close(); app = undefined;
    await t.test('switch both profiles over the same isolated stores and retain the hosted writes on return', t =>
      assertSameStoreHandoff({ root, postgres, ownerOrigin: origin, ntasksOrigin, actor: actors[2], t }));
    await t.test('first-owner activation, dated shadow evidence, and rollback use the normal access boundary', t =>
      assertNtasksShadowActivation({ root, cluster: postgres.cluster, ntasksOrigin, ntasks: actors[2], t }));
    await t.test('the operator commands prepare and import a separate private target for signed-in Tower', targetTest =>
      assertCustomerShadowTarget({ root, cluster: postgres.cluster, ntasksOrigin, ntasks: actors[2], availablePort, targetTest }));
  } finally {
    try { await app?.close(); } finally { postgres?.close(); }
    await ntasks?.dispose();
    if (!existsSync(path.join(home, '.local', 'customer-postgres', 'data', 'postmaster.pid'))) rmSync(root, { recursive: true, force: true });
  }
});
