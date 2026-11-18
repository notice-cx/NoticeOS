import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { createRequire } from 'node:module';
import { availableCustomerPort as availablePort } from './test/customer-ports.mjs';
import path from 'node:path';
import test from 'node:test';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { configDocumentKey } from './config-documents.mjs';
import { applyDemoNtasksProvision, demoNtasks, demoNtasksWorker } from './demo-ntasks.mjs';
import { hostedTaskAuthorization } from './hosted-task-request.mjs';
import { EMAIL_CODE_PATHS } from './identity-protocol.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { assertSameStoreHandoff } from './test/customer-runtime-handoff.mjs';
import { LOOPBACK_HBA } from './postgres-dev.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { assertCustomerShadowTarget } from './test/customer-shadow-target.mjs';
import { assertAnalysisAssignment } from './test-fixtures/customer-analysis-assignment.mjs';
import { assertNtasksShadowActivation } from './test/customer-shadow-activation.mjs';

const tools = process.env.NOTICEOS_NTASKS_ROOT;
const ownerScript = fileURLToPath(new URL('./local-workspace-owner.mjs', import.meta.url));
const ownerFixtureGuard = new URL('./test/local-workspace-owner-cli.mjs', import.meta.url).href;

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
      // All synthetic customers and shadow commands share one loopback address.
      ratelimits: { ...worker.ratelimits, SIGN_IN_LIMIT: { ...worker.ratelimits.SIGN_IN_LIMIT,
        simple: { ...worker.ratelimits.SIGN_IN_LIMIT.simple, limit: 120 } } },
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
    const origin = new URL(plan.url).origin;
    const identitySecret = randomBytes(36).toString('base64url'), credentialsKey = randomBytes(32).toString('base64');
    // Give the external provisioner its normal limited login on the disposable cluster.
    const platform = new URL(postgres.address);
    platform.username = 'noticeos_platform';
    const platformPassword = randomBytes(32).toString('base64url');
    platform.password = platformPassword;
    postgres.cluster.run(`ALTER ROLE noticeos_platform LOGIN PASSWORD '${scramVerifier(platformPassword)}'`);
    appendFileSync(path.join(postgres.cluster.root, LOOPBACK_HBA), 'host all noticeos_platform 127.0.0.1/32 scram-sha-256\n');
    execFileSync(postgres.cluster.tools.pgCtl, ['reload', '-D', path.join(postgres.cluster.root, 'data')], { stdio: 'pipe' });
    const mailbox = path.join(root, 'enrollment-mail');
    const sendmail = path.join(root, 'private-sendmail');
    writeFileSync(sendmail, '#!/bin/sh\numask 077\nexec /bin/cat > "${0%/*}/enrollment-mail"\n', { mode: 0o700 });
    const ownerPlan = (actor, slug) => ({
      format: 'noticeos-local-workspace-owner/1', workspaceId: randomUUID(), serviceId: randomUUID(), slug, displayName: slug,
      intendedEmail: `${slug}-owner@example.test`, trustedOrigin: origin, platformDatabaseUrl: platform.href,
      identityDatabaseUrl: postgres.identityDatabase, identitySecret,
      ntasks: { origin: ntasksOrigin, workspaceId: actor.workspaceId, projectId: actor.projectId },
      mail: { sendmail, from: 'noticeos@example.test' },
    });
    const prepareFile = (slug, data) => {
      const file = path.join(root, `${slug}-owner.json`);
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      return file;
    };
    const runOwner = async (action, file, { id, input, status = 0 } = {}) => {
      const result = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ['--import', ownerFixtureGuard, ownerScript, action, file, ...(id ? [id] : [])],
          { timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') reject(new Error(`Operator ${action} did not finish.`));
            else resolve({ status: error?.code ?? 0, stdout, stderr });
          });
        child.stdin.on('error', () => undefined);
        child.stdin.end(input);
      });
      assert.equal(result.status, status, `Operator ${action} returned an unexpected status.`);
      for (const secret of [identitySecret, platformPassword, input]) {
        if (secret) assert.equal((result.stdout + result.stderr).includes(secret), false);
      }
      assert.equal(/@example\.test/u.test(result.stdout + result.stderr), false);
      return status === 0 ? JSON.parse(result.stdout) : null;
    };
    const verifyOwner = async (file, id, email) => {
      await runOwner('send-code', file, { id });
      const mail = readFileSync(mailbox, 'utf8');
      assert.ok(mail.split('\n').includes(`To: ${email}`));
      const otp = /\b(\d{6})\.\s*$/u.exec(mail)?.[1];
      assert.ok(otp);
      assert.equal((await runOwner('verify-code', file, { id, input: otp })).emailVerified, true);
    };
    const [oak, elm] = actors;
    const firstOwner = ownerPlan(oak, 'oak');
    const firstFile = prepareFile('oak', firstOwner);
    const first = await runOwner('prepare', firstFile);
    // The preexisting owner's original enrollment had a different trusted peer.
    let firstCode;
    const firstLogin = openEmailCodeLogin({ connectionString: postgres.identityDatabase, trustedOrigin: origin,
      sessionSecret: identitySecret, peerAddress: '192.0.2.42', async deliver(message) { firstCode = message.code; } });
    try {
      const enrollment = { kind: 'platform', id: first.enrollmentId };
      const request = (action, body) => new Request(origin + EMAIL_CODE_PATHS[action], { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const email = firstOwner.intendedEmail;
      assert.equal((await firstLogin.requestCode(request('request', { email }), enrollment)).status, 202);
      assert.ok(firstCode);
      assert.equal((await firstLogin.verifyCode(request('verify', { email, otp: firstCode }), enrollment)).status, 200);
    } finally { await firstLogin.close(); }
    const activate = (file, prepared, input, status) => runOwner('activate', file, { id: prepared.enrollmentId, input, status });
    const activeFirst = await activate(firstFile, first, oak.token);
    assert.equal(activeFirst.serviceId, firstOwner.serviceId);
    const attachedConfig = path.join(root, 'attached.json');
    const attach = workspaces => {
      writeFileSync(attachedConfig, JSON.stringify({ format: 'noticeos-customer-operating/1', database: {
        app: postgres.address, identity: postgres.identityDatabase, grant: postgres.grantConnectionString,
      }, identitySecret, credentialsKey, ntasksOrigin, mailRecipients: workspaces.map(workspace => workspace.intendedEmail),
      workspaces: workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })) }), { mode: 0o600 });
      return startAttachedCustomer(startPlan({ dir: path.join(root, 'attached'), port: plan.port }), attachedConfig);
    };
    app = await attach([firstOwner]);
    const http = async (route, { body, headers = {} } = {}) => {
      try {
        return await fetch(origin + route, {
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
          // Restarts serve the same port. Do not carry pooled connections across them.
          headers: { origin, connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) { throw new Error(`Loopback Tower request to ${new URL(route, origin).pathname} failed.`, { cause: error }); }
    };
    const signIn = async ({ intendedEmail: email, workspaceId }) => {
      const previous = new Set(readdirSync(app.outbox));
      assert.equal((await http(EMAIL_CODE_PATHS.request, { body: { email } })).status, 202);
      const message = readdirSync(app.outbox).filter(file => !previous.has(file)).map(file => JSON.parse(readFileSync(path.join(app.outbox, file), 'utf8')))
        .find(item => item.to === email && /[0-9]{6}\.$/u.test(item.text));
      assert.ok(message);
      const otp = message.text.match(/\b([0-9]{6})\.$/u)[1];
      const login = await http(EMAIL_CODE_PATHS.verify, { body: { email, otp } });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
      const session = await (await http('/api/session', { headers: { cookie, [WORKSPACE_SELECTION_HEADER]: workspaceId } })).json();
      assert.equal(session.selectedWorkspace.workspaceId, workspaceId);
      assert.equal(session.selectedWorkspace.role, 'owner');
      assert.deepEqual(session.workspaces.map(workspace => workspace.workspaceId), [workspaceId]);
      return { cookie, [WORKSPACE_SESSION_HEADER]: session.session.sessionId };
    };
    const checkCatalog = async actor => {
      const catalog = await http('/api/tasks/projects', { headers: actor.board });
      assert.equal(catalog.status, 200);
      assert.deepEqual((await catalog.json()).projects.map(project => project.projectId), [actor.projectId]);
    };
    const connectNtasks = async (actor, workspace, binding) => {
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
      await checkCatalog(actor);
    };
    const firstSession = await signIn(firstOwner);
    await connectNtasks(oak, firstOwner, firstSession);
    const firstHeaders = { ...firstSession, [WORKSPACE_SELECTION_HEADER]: firstOwner.workspaceId };
    const firstStillOwnsWorkspace = async () => {
      const response = await http('/api/session', { headers: firstHeaders });
      assert.equal(response.status, 200);
      const { selectedWorkspace, workspaces } = await response.json();
      assert.equal(selectedWorkspace.role, 'owner');
      assert.deepEqual(workspaces.map(workspace => workspace.workspaceId), [firstOwner.workspaceId]);
    };
    const conflict = ownerPlan(oak, 'overlap');
    await runOwner('prepare', prepareFile('overlap', conflict), { status: 2 });
    let alternateRequests = 0;
    const alternate = createServer((_request, response) => { alternateRequests++; response.writeHead(503).end(); });
    t.after(() => new Promise(resolve => alternate.close(resolve)));
    await new Promise((resolve, reject) => alternate.once('error', reject).listen(0, '127.0.0.1', resolve));
    const alternateOrigin = `http://127.0.0.1:${alternate.address().port}`;
    await runOwner('prepare', prepareFile('alias-overlap', { ...conflict, ntasks: { ...conflict.ntasks, origin: alternateOrigin } }),
      { status: 2 });
    const secondOwner = ownerPlan(elm, 'elm');
    const secondFile = prepareFile('elm', secondOwner);
    await runOwner('prepare', prepareFile('invalid-address', { ...secondOwner, intendedEmail: '.alice@example.test' }), { status: 1 });
    await runOwner('prepare', prepareFile('reserved-port', { ...secondOwner, ntasks: { ...secondOwner.ntasks, origin: 'http://127.0.0.1:5173' } }),
      { status: 1 });
    const second = await runOwner('prepare', secondFile);
    await runOwner('prepare', secondFile, { status: 1 });
    assert.deepEqual(await runOwner('recover', secondFile), second);
    await activate(secondFile, second, elm.token, 1);
    await verifyOwner(secondFile, second.enrollmentId, secondOwner.intendedEmail);
    await activate(secondFile, { enrollmentId: first.enrollmentId }, elm.token, 1);
    await activate(secondFile, second, elm.readonlyToken, 1);
    await activate(secondFile, second, oak.token, 1);
    const otherOrigin = prepareFile('wrong-origin', { ...secondOwner, ntasks: { ...secondOwner.ntasks, origin: alternateOrigin } });
    await activate(otherOrigin, second, elm.token, 1);
    const editedEmail = prepareFile('wrong-recipient', { ...secondOwner, intendedEmail: firstOwner.intendedEmail });
    await runOwner('recover', editedEmail, { status: 1 });
    await runOwner('recover', otherOrigin, { status: 1 });
    await activate(editedEmail, second, elm.token, 1);
    postgres.cluster.run(`INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
      VALUES (:'service'::uuid,:'workspace'::uuid,ARRAY['workflows.run'],now()+interval '1 day')`,
    { vars: { service: secondOwner.serviceId, workspace: firstOwner.workspaceId } });
    await activate(secondFile, second, elm.token, 1);
    assert.deepEqual(postgres.cluster.script(`SELECT status,
      EXISTS(SELECT 1 FROM noticeos_identity.auth_member WHERE organization_id=:'workspace'::uuid) AS member,
      EXISTS(SELECT 1 FROM noticeos_platform.workspace_service_grants WHERE workspace_id=:'workspace'::uuid) AS granted
      FROM noticeos.workspaces WHERE workspace_id=:'workspace'::uuid`, { vars: { workspace: secondOwner.workspaceId } }),
    [{ status: 'provisioning', member: 'f', granted: 'f' }]);
    postgres.cluster.run('DELETE FROM noticeos_platform.workspace_service_grants WHERE service_id=:\'service\'::uuid',
      { vars: { service: secondOwner.serviceId } });
    await firstStillOwnsWorkspace();
    assert.equal((await activate(secondFile, second, elm.token)).serviceId, secondOwner.serviceId);
    await activate(secondFile, second, elm.token, 1);
    await runOwner('recover', secondFile, { status: 1 });
    assert.equal(alternateRequests, 0);
    await app.close(); app = undefined;
    app = await attach([firstOwner, secondOwner]);
    await firstStillOwnsWorkspace();
    assert.equal((await http('/api/wall', { headers: { ...firstHeaders, [WORKSPACE_SELECTION_HEADER]: secondOwner.workspaceId } })).status, 403);
    await checkCatalog(oak);
    await connectNtasks(elm, secondOwner, await signIn(secondOwner));
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
    await app.close(); app = undefined;
    app = await attach([firstOwner, secondOwner]);
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
