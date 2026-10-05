import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openIdentity, IDENTITY_NAMES } from '../packages/postgres/src/identity.mjs';
import { APP_RELEASE_HEADER, validAppRelease } from '../apps/tower/shared/app-release.ts';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { openTaskCatalogSetup } from '../packages/postgres/src/task-catalog.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { startHostedTaskServer } from './hosted-task-server.mjs';
import { secretFreeWorkerConfigs, stopLocalSecretReads } from './worker-config-folder.mjs';
import { configDocumentKey } from './config-documents.mjs';
import { TOWER_CONFIG_FILES } from '../packages/contract/src/configuration.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { startOfflineProxy, installOfflineGuard } from '../apps/tower/e2e/offline-guard.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const towerRequire = createRequire(path.join(REPO_ROOT, 'apps/tower/package.json'));
const { Pool } = require('pg');
const { betterAuth } = await import(require.resolve('better-auth/minimal'));
const { organization } = await import(require.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(require.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(require.resolve('kysely'));
const fixtureDir = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const fixture = file => path.basename(file) === 'beads.json' ? { hub: null, spokes: [] }
  : path.basename(file) === 'integrations.json' ? { catalog: [], assets: {} }
  : JSON.parse(readFileSync(path.join(fixtureDir, path.basename(file)), 'utf8'));

export { actualViteFactory } from './test-fixtures/hosted-vite.mjs';
import { actualViteFactory } from './test-fixtures/hosted-vite.mjs';

test('actual hosted Node/Vite Tasks binds browser project selection, payloads and current authority', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_BROWSER !== '1', timeout: 300000,
}, async t => withOwnedTaskProjects(async (physical, physicalControls) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-task-browser-'));
  const evidence = process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE;
  const before = Object.fromEntries(['NOTICEOS_WORKSPACE_PROFILE', 'NOTICEOS_WORKER_CONFIG_ROOT', 'NOTICEOS_VITE_CACHE_DIR', 'OS_UP_PERSIST_STATE', 'CLOUDFLARE_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV'].map(key => [key, process.env[key]]));
  const pools = [], extraDirectories = []; let owner, identity, directory, setup, entry, configs, browser, context, proxy, guard, db;
  const requests = [], pageErrors = [], checks = [];
  const origin = 'http://127.0.0.1:6448';
  let stage = 'postgres bootstrap';
  try {
    const tools = findPostgres(); owner = await openOnLoopbackPort(path.join(root, 'pg'), tools); applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 }); pools.push(admin);
    async function connection(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(owner.applicationLogin().url()); url.username = role; url.password = password; return url.href;
    }
    const identityUrl = await connection('noticeos_identity'), directoryUrl = await connection('noticeos_task_directory'), platformUrl = await connection('noticeos_platform');
    const secret = randomBytes(48).toString('base64url');
    const enginePool = new Pool({ connectionString: identityUrl, max: 1 });
    db = new Kysely({ dialect: new PostgresDialect({ pool: enginePool }) });
    const engine = betterAuth({ database: kyselyAdapter(db.withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } }, plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })] });
    const signup = await engine.handler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Synthetic operator', email: 'person@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(signup.status, 200); const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await admin.query('UPDATE noticeos_identity.auth_user SET email_verified=true WHERE id=$1', [person.id]);
    const workspacePeople = physical.mappings.map(() => randomUUID());
    for (const [index, mapping] of physical.mappings.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$3,'active')", [mapping.workspaceId, 'task-' + index, 'Workspace ' + index]);
      await admin.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [mapping.workspaceId, 'task-' + index]);
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now())", [randomUUID(), mapping.workspaceId, person.id]);
      await admin.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now())',
        [workspacePeople[index], `Workspace ${index} colleague`, `${workspacePeople[index]}@example.test`]);
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'viewer',now())", [randomUUID(), mapping.workspaceId, workspacePeople[index]]);
      await admin.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
      for (const file of Object.values(TOWER_CONFIG_FILES)) await admin.query('INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,$2,$3,1,now(),$4)',
        [mapping.workspaceId, configDocumentKey(file), JSON.stringify(fixture(file)), person.id]);
    }
    stage = 'identity facts';
    identity = await openIdentity({ connectionString: identityUrl, trustedOrigin: origin, sessionSecret: secret });
    const session = await identity.session(new Headers({ cookie })); assert.ok(session);
    directory = openTaskDirectory({ connectionString: directoryUrl });
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin, membership: (headers, workspace) => identity.admissionMembership(headers, workspace) });
    const executor = createHostedTaskExecutor({ admission, directory, resolveTarget: physical.resolveTarget, binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot });
    setup = openTaskCatalogSetup({ connectionString: platformUrl, verifyProject: async (mapping, controls) => {
      const result = await executor.verifyProject(mapping, controls); executor.assertVerifiedProject(result, mapping);
    } });
    stage = 'verified catalog setup';
    for (const mapping of physical.mappings) await setup.configure({ workspaceId: mapping.workspaceId, projectId: mapping.projectId, logicalKey: 'example', displayName: 'Example project', prefix: 'tt' });
    const targets = await Promise.all(physical.mappings.map(async mapping => ({ mapping, target: await physical.resolveTarget(mapping) })));
    const runtime = { profile: 'hosted', trustedOrigin: origin, identity: { connectionString: identityUrl, trustedOrigin: origin, sessionSecret: secret },
      directoryConnectionString: directoryUrl, targets, binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot };
    configs = secretFreeWorkerConfigs({ parent: root }); stopLocalSecretReads(); process.env.NOTICEOS_WORKSPACE_PROFILE = 'hosted';
    process.env.NOTICEOS_VITE_CACHE_DIR = path.join(root, 'vite-cache');
    for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
      const filename = configs.configPath(relative), config = JSON.parse(readFileSync(filename, 'utf8').slice(readFileSync(filename, 'utf8').indexOf('{')));
      // Hosted direct transport is explicit in this composition. It does not
      // emulate the standalone Hyperdrive binding or read its ambient URL.
      delete config.hyperdrive;
      Object.assign(config.vars ??= {}, { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
        NOTICEOS_IDENTITY_DATABASE_URL: identityUrl, NOTICEOS_IDENTITY_SESSION_SECRET: secret, NOTICEOS_WORKSPACE_DATABASE_URL: owner.applicationLogin().url(), NOTICEOS_IDENTITY_EDGE: 'cloudflare' });
      writeFileSync(filename, JSON.stringify(config));
    }
    stage = 'actual Vite configuration build';
    const factory = await actualViteFactory(root, requests);
    // Unknown prior Worker state is never adopted or overwritten. Refusal is
    // before runtime pools, Vite construction or listening.
    const persistBefore = process.env.OS_UP_PERSIST_STATE;
    process.env.OS_UP_PERSIST_STATE = path.join(root, 'unknown-prior-state');
    let refusedFactoryCalls = 0;
    await assert.rejects(startHostedTaskServer({ runtime, workerConfigRoot: configs.root, createViteServer: async () => {
      refusedFactoryCalls++; throw new Error('Must not construct');
    } }), /configuration refused/);
    assert.equal(refusedFactoryCalls, 0);
    assert.equal(process.env.OS_UP_PERSIST_STATE, path.join(root, 'unknown-prior-state'));
    if (persistBefore === undefined) delete process.env.OS_UP_PERSIST_STATE; else process.env.OS_UP_PERSIST_STATE = persistBefore;
    stage = 'actual server start';
    entry = await startHostedTaskServer({ runtime, workerConfigRoot: configs.root, createViteServer: async inline => {
      assert.equal(process.env.OS_UP_PERSIST_STATE, path.join(runtime.scratchRoot, 'worker-state'));
      stage = 'actual Vite factory'; const result = await factory(inline); stage = 'actual Vite listen'; return result;
    } });
    const headers = mapping => ({ cookie, origin, 'sec-fetch-site': 'same-origin', [WORKSPACE_SELECTION_HEADER]: mapping.workspaceId, [WORKSPACE_SESSION_HEADER]: session.sessionId });
    const [a, b] = physical.mappings;
    const { chromium, expect } = towerRequire('@playwright/test');
    const call = async (mapping, method, route, body, patch = {}) => {
      const response = await fetch(origin + route, { method, headers: { ...headers(mapping), ...patch, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), release: response.headers.get(APP_RELEASE_HEADER) };
    };
    await t.test('real board/detail/history and mutations retain Tower shapes across colliding tenant tasks', async () => {
      for (const [index, mapping] of physical.mappings.entries()) {
        const board = await call(mapping, 'GET', `/api/tasks?project=${mapping.projectId}`);
        assert.equal(board.status, 200); assert.equal(board.body.project, 'example'); assert.equal(board.body.tasks[0].title, 'Private task' + index);
        assert.ok(validAppRelease(board.release), 'native task responses carry the same server-owned release identity');
        if (index === 0) {
          const otherRelease = (board.release === '0'.repeat(64) ? '1' : '0').repeat(64);
          for (const release of ['malformed', otherRelease]) {
            const mismatch = await call(mapping, 'PATCH', '/api/tasks/tt-collision',
              { projectId: mapping.projectId, title: 'Version mismatch must not write' }, { [APP_RELEASE_HEADER]: release });
            assert.equal(mismatch.status, 409);
            assert.equal(mismatch.body.error, 'app_release_changed');
            assert.equal(mismatch.release, board.release);
          }
        }
        const detail = await call(mapping, 'GET', `/api/tasks/tt-collision?project=${mapping.projectId}`);
        assert.equal(detail.status, 200); assert.equal(detail.body.task.title, 'Private task' + index); assert.deepEqual(detail.body.comments, []);
        assert.ok(detail.body.actors.some(actor => actor.principalId === workspacePeople[index] && actor.displayName === `Workspace ${index} colleague`));
        assert.ok(!detail.body.actors.some(actor => actor.principalId === workspacePeople[1-index]));
        assert.ok(detail.body.actors.every(actor => Object.keys(actor).sort().join(',') === 'displayName,principalId'));
        assert.equal((await call(mapping, 'GET', `/api/tasks/tt-collision/history?project=${mapping.projectId}&limit=5`)).status, 200);
      }
      const epic = await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'Observed parent epic', type: 'epic' });
      assert.equal(epic.status, 200);
      const metadata = { noticeos_source: 'noticeos-handoff', noticeos_asset: 'example', noticeos_kind: 'finding', noticeos_key: '--file=literal handoff' };
      const created = await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: '--file=literal browser task', description: 'Observed task',
        parent: epic.body.id, labels: ['--file=literal-label', 'handoff'], acceptance: '--config=literal acceptance', metadata });
      assert.equal(created.status, 200); assert.equal(created.body.project, 'example');
      const id = created.body.id;
      const readCreated = await call(a, 'GET', `/api/tasks/${id}?project=${a.projectId}`);
      assert.equal(readCreated.status, 200); assert.equal(readCreated.body.task.parent, epic.body.id);
      assert.equal(readCreated.body.task.acceptance, '--config=literal acceptance');
      assert.deepEqual(readCreated.body.task.labels.toSorted(), ['--file=literal-label', 'handoff']);
      assert.deepEqual(readCreated.body.task.metadata, metadata);
      assert.equal((await call(a, 'PATCH', '/api/tasks/' + id, { projectId: a.projectId, priority: 1, assignee: '--file=literal-assignee',
        defer: '2030-01-02', acceptance: 'Updated acceptance', addLabels: ['observed'], removeLabels: ['handoff'] })).status, 200);
      const updated = (await call(a, 'GET', `/api/tasks/${id}?project=${a.projectId}`)).body.task;
      assert.equal(updated.assignee, '--file=literal-assignee'); assert.equal(updated.deferUntil.slice(0, 10), '2030-01-02');
      assert.equal(updated.acceptance, 'Updated acceptance'); assert.deepEqual(updated.labels.toSorted(), ['--file=literal-label', 'observed']);
      assert.equal((await call(a, 'PATCH', '/api/tasks/' + id, { projectId: a.projectId, assignee: '', parent: '', defer: '', acceptance: '' })).status, 200);
      const cleared = (await call(a, 'GET', `/api/tasks/${id}?project=${a.projectId}`)).body.task;
      assert.equal(cleared.assignee, null); assert.equal(cleared.parent, null); assert.equal(cleared.deferUntil, null); assert.equal(cleared.acceptance, '');
      assert.equal((await call(a, 'POST', '/api/tasks/' + id + '/comments', { projectId: a.projectId, text: 'HTTP observed outcome' })).status, 200);
      assert.equal((await call(a, 'POST', '/api/tasks/' + id + '/close', { projectId: a.projectId, reason: 'HTTP evidence' })).status, 200);
      checks.push('real Tower-compatible reads and writes, independent task databases');
    });
    await physicalControls.qualifyHumanDecisions();
    const decisionFixture=await physicalControls.prepareHumanDecisions();
    await t.test('independent executors serialize human-marker changes and closure with fresh admission', async()=>{
      const peerDirectory=openTaskDirectory({connectionString:directoryUrl});extraDirectories.push(peerDirectory);
      const token=randomBytes(24).toString('base64url');let serviceActive=true;
      const serviceAdmission=createWorkspaceAdmission({kind:'service',profile:Symbol(),authority:async proof=>
        serviceActive && proof.headers.get('authorization')===`Bearer ${token}` ? {
          principalId:'synthetic-task-service',workspaceId:a.workspaceId,workspaceStatus:'active',
          expiresAt:new Date(Date.now()+60000).toISOString(),actions:['tasks.write'],
        }:null});
      const create=()=>call(a,'POST','/api/tasks',{projectId:a.projectId,title:'Owned mutation coordination'});
      const pause=()=>{let reached,release;return {ready:new Promise(r=>{reached=r}),retired:new Promise(r=>{release=r}),
        entered:()=>reached(),release:()=>release()};};
      const makeService=gate=>createHostedTaskExecutor({admission:serviceAdmission,
        directory:{project:peerDirectory.project,withProjectMutation:(workspace,project,controls,work)=>
          peerDirectory.withProjectMutation(workspace,project,controls,async lease=>{
            gate.entered();await gate.retired;return work(lease);
          })},resolveTarget:physical.resolveTarget,binary:physical.pinnedBinary,
        doltBinary:physical.pinnedDoltBinary,scratchRoot:physical.scratchRoot});
      const serviceProof=()=>new Request(origin+'/api/tasks/synthetic',{method:'PATCH',headers:{authorization:`Bearer ${token}`}});
      const first=await create();assert.equal(first.status,200);const id=first.body.id;
      const gate=pause(),service=makeService(gate);
      const adding=service.execute(serviceProof(),a.workspaceId,{projectId:a.projectId,operation:{kind:'update',taskId:id,addLabels:['human']}});
      try {
        await gate.ready;
        assert.equal((await call(a,'POST',`/api/tasks/${id}/close`,{projectId:a.projectId,reason:'Must be busy'})).status,403);
        assert.equal((await call(a,'GET',`/api/tasks/${id}?project=${a.projectId}`)).body.task.status,'open');
      } finally {gate.release();}
      await adding;
      assert.ok((await call(a,'GET',`/api/tasks/${id}?project=${a.projectId}`)).body.task.labels.includes('human'));
      for(const [method,path,body] of [['POST',`/api/tasks/${id}/close`,{reason:'Not approval'}],
        ['PATCH',`/api/tasks/${id}`,{status:'closed'}],['PATCH',`/api/tasks/${id}`,{removeLabels:['human']}]]) {
        assert.equal((await call(a,method,path,{projectId:a.projectId,...body})).status,403);
      }
      await assert.rejects(service.execute(serviceProof(),a.workspaceId,{projectId:a.projectId,
        operation:{kind:'respond',taskId:id,response:'Service cannot decide'}}),{name:'HostedTaskRefused'});
      assert.equal((await call(a,'POST',`/api/tasks/${id}/respond`,{projectId:a.projectId,response:'Operator observed answer'})).status,200);
      // Revocation after busy refusal and before acquired callback must prevent
      // credentials/process acquisition, then release the lease on failure.
      const second=await create();assert.equal(second.status,200);const revokedGate=pause();
      const revoked=makeService(revokedGate).execute(serviceProof(),a.workspaceId,{projectId:a.projectId,
        operation:{kind:'update',taskId:second.body.id,addLabels:['human']}});
      const refused=assert.rejects(revoked,{name:'HostedTaskRefused'});
      try {
        await revokedGate.ready;
        assert.equal((await call(a,'POST',`/api/tasks/${second.body.id}/close`,{projectId:a.projectId,reason:'Busy refusal after acquisition'})).status,403);
        serviceActive=false;
      } finally {serviceActive=false;revokedGate.release();}
      await refused;
      const unchanged=(await call(a,'GET',`/api/tasks/${second.body.id}?project=${a.projectId}`)).body.task;
      assert.equal(unchanged.status,'open');assert.equal(unchanged.labels.includes('human'),false);
      assert.equal((await call(a,'POST',`/api/tasks/${second.body.id}/close`,{projectId:a.projectId,reason:'Released failed lease'})).status,200);
      checks.push('actual cross-factory mutation lease, service human filing, person-only decision, busy/revocation/failure release');
    });
    await t.test('real production browser binds Claim, acceptance Undo and comments to its selected workspace/project', async () => {
      proxy = await startOfflineProxy(origin);
      const binary = process.env.NOTICEOS_TEST_BROWSER_BIN;
      assert.ok(path.isAbsolute(binary ?? ''), 'Explicit qualified testing binary only');
      browser = await chromium.launch({ executablePath: binary, headless: true, proxy: proxy.proxy,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--no-first-run'] });
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', proxy: proxy.proxy });
      guard = await installOfflineGuard(context, origin, { transport: proxy });
      await context.addCookies(cookie.split('; ').map(item => ({ name: item.slice(0, item.indexOf('=')), value: item.slice(item.indexOf('=') + 1), url: origin, httpOnly: true, sameSite: 'Lax' })));
      const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message)); page.setDefaultTimeout(20000);
      await page.goto(origin + '/tasks/tt-collision?project=example');
      await page.getByRole('heading', { name: 'Choose a workspace', exact: true }).waitFor();
      await page.getByRole('button', { name: /Workspace 0 operator/ }).click();
      await expect(page.getByRole('heading', { name: 'Private task0 tt-collision', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Task project' })).toHaveValue('example');
      await expect(page.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Add a description', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Add acceptance criteria', exact: true }).click();
      const acceptance = page.locator('[data-task-field="Acceptance criteria"]');
      await acceptance.getByRole('textbox', { name: 'Acceptance criteria' }).fill('Browser observed acceptance');
      await acceptance.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Saved — the acceptance criteria', { exact: true })).toBeVisible();
      assert.equal((await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task.acceptance, 'Browser observed acceptance');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByText('Reverted — the acceptance criteria', { exact: true })).toBeVisible();
      assert.equal((await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task.acceptance, '');
      const assignee = page.getByRole('combobox', { name: 'Assignee', exact: true });
      await expect(assignee).toHaveValue('');
      await expect(assignee.getByRole('option', { name: 'Synthetic operator', exact: true })).toHaveAttribute('value', person.id);
      await expect(assignee.getByRole('option', { name: 'Workspace 1 colleague', exact: true })).toHaveCount(0);
      await assignee.selectOption(workspacePeople[0]);
      await page.getByRole('button', { name: 'Save Assignee', exact: true }).click();
      await expect.poll(async () => (await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task.assignee).toBe(workspacePeople[0]);
      await expect(page.getByText('Saved — assignee', { exact: true })).toBeVisible();
      await page.locator('[data-sonner-toast]').filter({ hasText: 'Saved — assignee' }).getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByText('Reverted — assignee', { exact: true })).toBeVisible();
      await expect.poll(async () => (await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task.assignee).toBeNull();
      await page.getByRole('button', { name: 'Claim', exact: true }).click();
      // Claim's own control unmounts after the fresh query changes its state;
      // the authoritative readback, not a component-scoped toast, is the proof.
      await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('in_progress');
      const claimed = (await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task;
      assert.equal(claimed.assignee, person.id); assert.equal(claimed.status, 'in_progress');
      await page.getByRole('textbox', { name: 'Add a comment' }).fill('Browser observed outcome');
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(page.getByText('Browser observed outcome', { exact: true })).toBeVisible();
      const actual = await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`);
      assert.equal(actual.body.comments.at(-1).text, 'Browser observed outcome');
      assert.equal(actual.body.comments.at(-1).author, person.id);
      await expect(page.locator('[data-task-comments]').getByText('Synthetic operator', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('Comment from Synthetic operator', { exact: true }).first()).toBeVisible();
      const other = await call(b, 'GET', `/api/tasks/tt-collision?project=${b.projectId}`);
      assert.deepEqual(other.body.comments, []);
      await page.goto(origin+`/tasks/${decisionFixture.gateId}?project=example`);
      await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'Approve',exact:true}).click();
      await expect(page.getByText('Approved',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Undo',exact:true}).click();
      assert.equal((await call(a,'GET',`/api/tasks/${decisionFixture.gateId}?project=${a.projectId}`)).body.task.status,'open');
      assert.equal(requests.some(row=>row.path===`/api/gates/${decisionFixture.gateId}/resolve`),false);
      await page.getByRole('button',{name:'Approve',exact:true}).click();
      await expect.poll(async()=>(await call(a,'GET',`/api/tasks/${decisionFixture.gateId}?project=${a.projectId}`)).body.task.status,
        {timeout:20000}).toBe('closed');
      const approval=requests.find(row=>row.path===`/api/gates/${decisionFixture.gateId}/resolve`);
      assert.equal(approval.workspace,a.workspaceId);assert.equal(approval.session,session.sessionId);
      await page.goto(origin+`/tasks/${decisionFixture.answerId}?project=example`);
      await page.getByRole('button',{name:'Answer',exact:true}).click();
      await page.getByRole('textbox',{name:`Your answer to ${decisionFixture.answerId}`}).fill('--file=browser literal answer');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await expect.poll(async()=>(await call(a,'GET',`/api/tasks/${decisionFixture.answerId}?project=${a.projectId}`)).body.task.status,
        {timeout:20000}).toBe('closed');
      const answered=(await call(a,'GET',`/api/tasks/${decisionFixture.answerId}?project=${a.projectId}`)).body;
      assert.equal(answered.comments.at(-1).author,person.id);assert.equal(answered.comments.at(-1).text,'Response: --file=browser literal answer');
      await expect(page.locator('[data-task-comments]').getByText('Synthetic operator',{exact:true}).first()).toBeVisible();
      // Actual testing browser drives the maintained owner runtime's explicit
      // keepalive flush. Real pagehide instead retires unissued work by design.
      const observed=await page.evaluate(async facts=>{
        const {createBrowserRuntime}=await import('/src/lib/browser-runtime.ts');
        const {sendInboxAnswer}=await import('/src/hooks/useTasks.ts');
        const calls=[];
        const runtime=createBrowserRuntime({mode:'hosted',principalId:facts.person,sessionId:facts.session,
          workspaceId:facts.workspace,clientGeneration:100},{origin:location.origin,
          fetch:(input,init)=>{calls.push({path:new URL(input).pathname,keepalive:init?.keepalive});return fetch(input,init)},
          sendAnswer:(api,answer,keepalive)=>sendInboxAnswer(answer,keepalive,api)});
        try {
          await runtime.api.fetchTasks('example');
          const done=new Promise((resolve,reject)=>runtime.answers.schedule({id:facts.id,
            answer:{kind:'dismiss',id:facts.id,title:'Owned browser dismiss',project:'example'},onSent:resolve,onFailed:reject}));
          runtime.answers.flush(true);await done;return calls;
        } finally {runtime.retire();}
      },{person:person.id,session:session.sessionId,workspace:a.workspaceId,id:decisionFixture.dismissId});
      assert.ok(observed.some(row=>row.path===`/api/tasks/${decisionFixture.dismissId}/dismiss`&&row.keepalive===true));
      assert.equal((await call(a,'GET',`/api/tasks/${decisionFixture.dismissId}?project=${a.projectId}`)).body.task.status,'closed');
      const blocked=(await call(a,'GET',`/api/tasks/${decisionFixture.blockedId}?project=${a.projectId}`)).body.task;
      assert.equal(blocked.status,'open');
      await page.goto(origin + '/tasks/tt-collision?project=example');
      const handoff = page.getByRole('combobox', { name: 'Assignee', exact: true });
      await expect(handoff).toHaveValue(person.id);
      await handoff.selectOption(workspacePeople[0]);
      await page.getByRole('button', { name: 'Save Assignee', exact: true }).click();
      const savedHandoff = page.locator('[data-sonner-toast]').filter({ hasText: 'Saved — assignee' });
      await expect(savedHandoff).toBeVisible();
      await expect(savedHandoff.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
      assert.equal((await call(a, 'GET', `/api/tasks/tt-collision?project=${a.projectId}`)).body.task.assignee, workspacePeople[0]);
      checks.push('open assignee edit and Undo retain IDs; claimed handoff saves without impossible Undo or force');
      checks.push('actual operator Answer/Approve Undo/readback, bound keepalive Dismiss, gate release records no protected execution');
      await page.screenshot({ path: path.join(evidence, 'hosted-task-desktop.png'), fullPage: true });
      assert.ok(requests.some(row => row.path.includes(a.projectId) && row.workspace === a.workspaceId && row.session === session.sessionId));
      assert.equal(pageErrors.length, 0); await guard.check();
      checks.push('actual Vite/Worker bootstrap and owner-bound production browser Tasks');
    });
    await t.test('current revocation and forged selector/actor bodies refuse; display permissions confer no authority', async () => {
      for (const patch of [{ [WORKSPACE_SESSION_HEADER]: randomUUID() }, { origin: 'https://foreign.example.test' }]) assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'Refused' }, patch)).status, 403);
      assert.equal((await call(a, 'POST', '/api/tasks', { projectId: a.projectId, title: 'Refused', actor: person.id })).status, 400);
      const cap = await call(a, 'GET', '/api/tasks/capabilities'); assert.equal(cap.body.writable, true);
      await admin.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1 AND user_id=$2", [a.workspaceId, person.id]);
      assert.equal((await call(a, 'GET', '/api/tasks/capabilities')).body.writable, false);
      assert.equal((await call(a, 'POST', '/api/tasks/tt-collision/comments', { projectId: a.projectId, text: 'Stale permission' })).status, 403);
      assert.equal((await call(a, 'PATCH', '/api/tasks/tt-collision', { projectId: a.projectId, acceptance: 'Stale displayed permission', claim: true })).status, 403);
      assert.equal((await call(a,'POST',`/api/tasks/${decisionFixture.answerId}/respond`,{projectId:a.projectId,response:'Viewer cannot decide'})).status,403);
      assert.equal((await call(a,'POST',`/api/gates/${decisionFixture.gateId}/resolve`,{projectId:a.projectId})).status,403);
      await admin.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [a.workspaceId, person.id]);
      assert.equal((await call(a, 'GET', '/api/tasks/projects')).status, 403);
      assert.equal((await call(b, 'GET', `/api/tasks/tt-collision?project=${b.projectId}`)).status, 200);
      checks.push('fresh role/session/membership proof, no actor or profile override');
    });
    await t.test('same actual server composition supports anonymous fixed demo reads and refuses visitor writes', async () => {
      // Each width has its own known membership, task and comment state;
      // the preceding revocation test must not become this test's setup.
      await admin.query("INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,'operator',now()) ON CONFLICT (organization_id,user_id) DO UPDATE SET role='operator'", [randomUUID(), a.workspaceId, person.id]);
      assert.equal((await call(a, 'PATCH', '/api/tasks/tt-collision', { projectId: a.projectId, status: 'open' })).status, 200);
      assert.equal((await call(a, 'PATCH', '/api/tasks/tt-collision', { projectId: a.projectId, assignee: person.id })).status, 200);
      assert.equal((await call(a, 'POST', '/api/tasks/tt-collision/comments', { projectId: a.projectId, text: 'Phone actor fixture' })).status, 200);
      await guard.close(); guard = undefined; context = undefined;
      await entry.close(); entry = undefined;
      process.env.NOTICEOS_WORKSPACE_PROFILE = 'demo';
      for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
        const filename = configs.configPath(relative), configuration = JSON.parse(readFileSync(filename, 'utf8'));
        Object.assign(configuration.vars, { NOTICEOS_WORKSPACE_PROFILE: 'demo', NOTICEOS_DEMO_WORKSPACE_ID: a.workspaceId });
        writeFileSync(filename, JSON.stringify(configuration));
      }
      entry = await startHostedTaskServer({ runtime: { ...runtime, profile: 'demo', demoWorkspaceId: a.workspaceId },
        workerConfigRoot: configs.root, createViteServer: factory });
      const anonymous = await fetch(origin + `/api/tasks/tt-collision?project=${a.projectId}`);
      assert.equal(anonymous.status, 200); assert.equal((await anonymous.json()).task.title, 'Private task0');
      assert.equal((await (await fetch(origin + '/api/tasks/capabilities')).json()).writable, false);
      const write = await fetch(origin + '/api/tasks/tt-collision/comments', { method: 'POST',
        headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: a.projectId, text: 'Visitor cannot write' }) });
      assert.equal(write.status, 403);
      const foreign = await fetch(origin + `/api/tasks/tt-collision?project=${b.projectId}`, {
        headers: { [WORKSPACE_SELECTION_HEADER]: b.workspaceId } });
      assert.equal(foreign.status, 400);
      context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', proxy: proxy.proxy });
      guard = await installOfflineGuard(context, origin, { transport: proxy });
      const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(origin + '/tasks/tt-collision?project=example');
      await expect(page.getByRole('heading', { name: 'Private task0 tt-collision', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add a description', exact: true })).toBeDisabled();
      await expect(page.getByRole('textbox', { name: 'Add a comment' })).toBeDisabled();
      await expect(page.getByRole('combobox', { name: 'Assignee', exact: true })).toBeDisabled();
      await expect(page.getByRole('combobox', { name: 'Assignee', exact: true }).getByRole('option', { name: 'Synthetic operator', exact: true })).toHaveAttribute('value', person.id);
      await expect(page.locator('[data-task-comments]').getByText('Synthetic operator',{exact:true}).first()).toBeVisible();
      await expect(page.getByText('Workspace 1 colleague',{exact:true})).toHaveCount(0);
      await page.screenshot({ path: path.join(evidence, 'demo-task-phone.png'), fullPage: true });
      await guard.check(); assert.equal(pageErrors.length, 0);
      checks.push('anonymous fixed demo production browser reads; no visitor write or foreign workspace');
    });
  } catch (error) {
    console.error('Owned task proof failed during:', stage);
    throw error;
  } finally {
    const cleanups = [];
    const attempt = async work => { try { await work(); } catch (error) { cleanups.push(error); } };
    await attempt(() => guard ? guard.close() : context?.close());
    await attempt(() => browser?.close()); await attempt(() => proxy?.close());
    let serverClosed = false;
    await attempt(async () => { await entry?.close(); serverClosed = true; });
    // Only this newly owned fixture's reserved state is retired, after its
    // real Vite/Worker close. Production server close retains operator state.
    if (serverClosed) rmSync(path.join(physical.scratchRoot, 'worker-state'), { recursive: true, force: true });
    for (const resource of [setup, directory, identity, ...extraDirectories]) await attempt(() => resource?.close());
    await attempt(() => db?.destroy()); for (const pool of pools) await attempt(() => pool.end());
    await attempt(() => owner?.close());
    if (configs) configs.remove();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    writeFileSync(path.join(evidence, 'browser-checks.json'), JSON.stringify({ checks, requests, pageErrors, foreignAttempts: proxy?.escapes() ?? [], root }, null, 2));
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
    if (cleanups.length) throw new AggregateError(cleanups, 'Owned Tasks fixture cleanup refused');
  }
}));
