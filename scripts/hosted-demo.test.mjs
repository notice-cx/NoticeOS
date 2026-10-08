import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedDemo } from './hosted-demo.mjs';
import { openHostedDemo, startHostedDemo } from './hosted-demo-runtime.mjs';
import { buildDemoWorkerHelpers } from './demo-evaluator.mjs';
import { generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { fillDemo } from './demo-store.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { proveHostedDemoBrowser } from './test-fixtures/hosted-demo-browser.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const scenario = generateDemoScenario({ seed: 'hosted-activity-proof', cutoff: '2026-09-21T12:00:00.000Z', release: 'a'.repeat(40) });
const workspace = scenario.manifest.workspaceId;
const customers = [randomUUID(), randomUUID()];
const assets = scenario.assets.filter(asset => !asset.isOs);
const allocations = [...customers.map(workspaceId => ({ workspaceId, projectId: randomUUID(), databaseId: randomUUID() })),
  ...assets.map(asset => ({ workspaceId: workspace, projectId: randomUUID(), databaseId: randomUUID(),
    ...(process.env.NOTICEOS_TEST_HOSTED_DEMO_BROWSER === '1' ? { prefix: asset.prefix } : {}) }))];
const projects = assets.map((asset, i) => ({ asset: asset.id, projectId: allocations[i + 2].projectId, prefix: allocations[i + 2].prefix ?? 'tt' }));

test('demo composition refuses a foreign workspace, changed seed and ambiguous task ownership before I/O', () => {
  const untouched = new Proxy({}, { get() { throw new Error('unexpected I/O'); } });
  const options = { workspaceId: workspace, serviceId: randomUUID(), scenario, projects,
    store: untouched, grant: untouched, tasks: { execute() {} }, writer: { write() {}, collect() {}, snapshot() {} } };
  assert.throws(() => createHostedDemo({ ...options, workspaceId: customers[0] }), /demo activity refused/);
  const changed = structuredClone(scenario); changed.daily[0].sessions++;
  assert.throws(() => createHostedDemo({ ...options, scenario: changed }), /demo activity refused/);
  assert.throws(() => createHostedDemo({ ...options, projects: projects.map(row => ({ ...row, projectId: projects[0].projectId })) }), /demo activity refused/);
});

test('persistent demo uses ordinary Postgres writers and actual scoped Beads without changing either customer', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240000,
}, async t => {
  const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
  return withOwnedTaskProjects(async physical => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-pg-'));
  let owner, closeAdmin, directory;
  const demos = [], stores = [], grants = [];
  try {
    const tools = findPostgres(); owner = await openOnLoopbackPort(path.join(root, 'pg'), tools);
    applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 2 });
    closeAdmin = trackFixturePool(admin);
    const appUrl = owner.applicationLogin().url();
    async function connection(role) {
      const password = randomBytes(32).toString('base64url');
      await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
      appendFileSync(path.join(owner.root, LOOPBACK_HBA), `host all ${role} 127.0.0.1/32 scram-sha-256\n`);
      execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
      const url = new URL(appUrl); url.username = role; url.password = password; return url.href;
    }
    const grantUrl = await connection('noticeos_service_grant'), taskUrl = await connection('noticeos_task_directory');
    directory = openTaskDirectory({ connectionString: taskUrl });
    const serviceId = randomUUID();
    for (const id of [...customers, workspace]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, 'generated-' + id]);
    }
    for (const mapping of physical.mappings) {
      await admin.query('INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key) VALUES($1,$2,$3,$4,$5)', Object.values(mapping));
    }
    await admin.query("INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [serviceId, workspace, ['workflows.run', 'tasks.read', 'tasks.write']]);
    for (const id of customers) {
      await admin.query("INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES($1,$2,'example.test','Customer control','live',1)", [id, assets[0].id]);
    }
    const openStore = () => { const store = openWorkspaceStore(appUrl, { workspaceId: workspace }); stores.push(store); return store; };
    const openGrant = () => { const grant = openWorkspaceServiceGrant({ connectionString: grantUrl, principalId: serviceId, workspaceId: workspace }); grants.push(grant); return grant; };
    const seedStore = openStore();
    await seedStore.write(async tx => {
      await tx.query("SELECT set_config('noticeos.test_demo','synthetic',true)");
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    const taskGrant = openGrant();
    const admission = createWorkspaceAdmission({ kind: 'service', profile: Symbol('synthetic simulator'), authority: () => taskGrant.facts() });
    const tasks = createHostedTaskExecutor({ admission, directory, resolveTarget: physical.resolveTarget,
      binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot });
    const proof = new Request('https://noticeos.internal/demo', { method: 'POST' });
    const readTasks = project => tasks.execute(proof, workspace, { projectId: project.projectId, operation: { kind: 'active-board', statuses: ['open', 'in_progress', 'blocked', 'deferred'] } });
    const runtimeOptions = async (now) => ({ sourceRoot: REPO_ROOT, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config'),
      scenario: structuredClone(scenario), workspaceId: workspace, serviceId,
      connectionString: appUrl, grantConnectionString: grantUrl, directoryConnectionString: taskUrl,
      projects: await Promise.all(projects.map(async project => {
        const mapping = physical.mappings.find(row => row.projectId === project.projectId);
        assert.ok(mapping);
        const target = await physical.resolveTarget(mapping); assert.ok(target);
        return { asset: project.asset, prefix: project.prefix, mapping: { ...mapping }, target: { ...target } };
      })), binary: physical.pinnedBinary, doltBinary: physical.pinnedDoltBinary, scratchRoot: physical.scratchRoot,
      ...(now ? { now } : {}) });
    let clock = Date.parse('2026-09-22T12:00:00Z'), failDatabase = true, failSnapshot = true, lostEffect = false;
    let escapedStore, createdTaskId;
    const make = (over = {}) => {
      const demo = createHostedDemo({ workspaceId: workspace, serviceId, scenario, projects,
        store: openStore(), grant: openGrant(), now: () => clock,
        writer: { collect: helpers.writeDemoCollection, async snapshot(store, snapshot) {
          const result = await helpers.writeDemoTaskSnapshot(store, snapshot);
          if (failSnapshot) { failSnapshot = false; throw new Error('Controlled rollback after task summary write'); }
          return result;
        }, async write(store, day) {
          escapedStore = store;
          const result = await helpers.writeDemoActivity(store, day);
          if (failDatabase) { failDatabase = false; throw new Error('Controlled rollback after ordinary writes'); }
          return result;
        } }, tasks, ...over });
      demos.push(demo); return demo;
    };
    let demo = make();
    const counts = async id => (await admin.query(`SELECT
      (SELECT count(*)::int FROM noticeos.pulses WHERE workspace_id=$1) pulses,
      (SELECT count(*)::int FROM noticeos.signal_runs WHERE workspace_id=$1) signals,
      (SELECT count(*)::int FROM noticeos.ledger_entries WHERE workspace_id=$1) ledger,
      (SELECT count(*)::int FROM noticeos.task_snapshots WHERE workspace_id=$1) snapshots,
      (SELECT count(*)::int FROM noticeos.hosted_job_occurrences WHERE workspace_id=$1) jobs`, [id])).rows[0];
    const latestSnapshot = async () => (await admin.query('SELECT payload FROM noticeos.task_snapshots WHERE workspace_id=$1 ORDER BY captured_at DESC,snapshot_id DESC LIMIT 1', [workspace])).rows[0]?.payload;
    const history = async () => (await admin.query(`SELECT md5(string_agg(envelope::text,'|' ORDER BY pulse_id)) hash
      FROM noticeos.pulses WHERE workspace_id=$1 AND generated_at<$2::timestamptz`, [workspace, scenario.manifest.cutoff])).rows[0].hash;
    const before = await counts(workspace), originalHistory = await history(), customerBefore = await Promise.all(customers.map(counts));
    if (process.env.NOTICEOS_TEST_HOSTED_DEMO_BROWSER === '1') {
      await proveHostedDemoBrowser(t, { root, admin, connection, appUrl, physical, tasks, runtimeOptions,
        scenario, workspace, customers, serviceId, projects, counts, directoryConnectionString: taskUrl });
      return;
    }
    await t.test('ordinary rows and the journal checkpoint roll back together', async () => {
      const failed = await demo.tick(); assert.equal(failed.days[0].receipt.state, 'retryable');
      const after = await counts(workspace); assert.deepEqual({ ...after, jobs: before.jobs }, before);
      await assert.rejects(escapedStore.read(tx => tx.query('SELECT 1')), /demo activity refused/);
      const summaryFailed = await demo.tick(); assert.equal(summaryFailed.days[0].receipt.state, 'retryable');
      assert.equal(summaryFailed.days[0].receipt.attempt, 2); assert.equal((await counts(workspace)).snapshots, 0);
      const inputsWritten = await counts(workspace);
      const passed = await demo.tick(); assert.equal(passed.days[0].receipt.state, 'succeeded'); assert.equal(passed.days[0].receipt.attempt, 3);
      assert.deepEqual({ ...await counts(workspace), snapshots: inputsWritten.snapshots }, inputsWritten);
      const tasks = await readTasks(projects[0]);
      const created = tasks.filter(row => row.labels?.includes('synthetic-demo'));
      assert.equal(created.length, 1); assert.equal(created[0].created_by, serviceId); assert.equal(created[0].status, 'open');
      createdTaskId = created[0].id;
      const snapshot = await latestSnapshot();
      assert.equal(snapshot.projects.length, 3); assert.ok(snapshot.projects.every(project => project.ok));
      assert.equal(snapshot.projects.find(project => project.asset === projects[0].asset).counts.open, 2);
      const held = await counts(workspace); assert.deepEqual((await demo.tick()).days, []); assert.deepEqual(await counts(workspace), held);
    });
    await t.test('a restarted service resumes retained checkpoints and cannot select a customer task project', async () => {
      const held = await counts(workspace);
      await demo.close(); demo = make();
      assert.deepEqual((await demo.tick()).days, []); assert.deepEqual(await counts(workspace), held);
      for (let i = 0; i < customers.length; i++) {
        await assert.rejects(tasks.execute(proof, workspace, { projectId: allocations[i].projectId,
          operation: { kind: 'active-board', statuses: ['open'] } }));
        await assert.rejects(tasks.execute(proof, customers[i], { projectId: allocations[i].projectId,
          operation: { kind: 'create', title: 'Forbidden foreign task' } }));
      }
      assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
    });
    await t.test('the actual deployment factory advances two due days with captured bindings and ordinary writers', async () => {
      const options = await runtimeOptions(() => Date.parse('2026-09-24T12:00:00Z'));
      const runtime = await openHostedDemo(options), retained = await counts(workspace);
      options.workspaceId = customers[0]; options.now = () => { throw new Error('Caller clock changed after capture'); };
      options.projects[0].mapping.workspaceId = customers[0]; options.projects[0].target.cwd = '/not-an-authorized-project';
      options.scenario.daily[0].sessions++;
      try {
        const result = await runtime.tick();
        assert.deepEqual(result.days.map(day => day.date), ['2026-09-22', '2026-09-23']);
        assert.ok(result.days.every(day => day.receipt.state === 'succeeded'));
        const current = await counts(workspace);
        // Each day records three asset reports and one actual OS observation.
        assert.equal(current.pulses, retained.pulses + 8);
        // The unchanged first board is touched; only the claimed board inserts.
        assert.equal(current.snapshots, retained.snapshots + 1);
        assert.ok(result.days.every(day => day.receipt.steps['task-summary'].state === 'succeeded'));
        const task = (await readTasks(projects[0])).find(row => row.id === createdTaskId);
        assert.equal(task.status, 'in_progress'); assert.equal(task.assignee, serviceId);
        assert.equal((await latestSnapshot()).projects.find(project => project.asset === projects[0].asset).counts.inProgress, 1);
        assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
      } finally { await runtime.close(); }
    });
    await t.test('concurrent instances advance each completed day once and Beads progresses the same task', async () => {
      clock = Date.parse('2026-09-26T12:00:00Z');
      const other = make();
      const results = await Promise.allSettled([demo.tick(), other.tick()]);
      assert.ok(results.some(result => result.status === 'fulfilled'));
      await demo.tick();
      const state = (await admin.query("SELECT occurrence,state FROM noticeos.hosted_job_occurrences WHERE workspace_id=$1 ORDER BY occurrence", [workspace])).rows;
      assert.equal(state.length, 5); assert.ok(state.every(row => row.state === 'succeeded'));
      for (let i = 0; i < 5; i++) {
        const day = shiftDemoDay(scenario.manifest.referenceDate, i);
        const pulseCount = (await admin.query('SELECT count(*)::int n FROM noticeos.pulses WHERE workspace_id=$1 AND pulse_date=$2', [workspace, day])).rows[0].n;
        assert.equal(pulseCount, 3);
      }
      const closed = await tasks.execute(proof, workspace, { projectId: projects[0].projectId,
        operation: { kind: 'show', taskId: createdTaskId } });
      assert.equal(closed.length, 1); assert.equal(closed[0].status, 'closed');
      assert.equal(closed[0].assignee, serviceId); assert.ok(closed[0].close_reason.includes('No live deployment'));
      const project = (await latestSnapshot()).projects.find(project => project.asset === projects[0].asset);
      assert.equal(project.counts.open, 1); assert.equal(project.counts.inProgress, 0); assert.equal(project.counts.closedRecent, 1);
      assert.ok(project.recentlyClosed.some(task => task.id === createdTaskId));
      assert.equal(await history(), originalHistory);
      assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
    });
    await t.test('fresh revocation and workspace suspension prevent the next date', async () => {
      clock = Date.parse('2026-09-27T12:00:00Z'); const held = await counts(workspace);
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [serviceId]);
      await assert.rejects(demo.tick()); assert.deepEqual(await counts(workspace), held);
      await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=NULL WHERE service_id=$1', [serviceId]);
      await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [workspace]);
      await assert.rejects(demo.tick()); assert.deepEqual(await counts(workspace), held);
      await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [workspace]);
    });
    await t.test('catch-up is bounded and a lost actual task acknowledgement never repeats its effect', async () => {
      clock = Date.parse('2026-10-08T12:00:00Z');
      const limited = await demo.tick(); assert.equal(limited.days.length, 7);
      assert.ok(limited.days.every(day => day.receipt.state === 'succeeded'));
      const uncertain = make({ tasks: { async execute(...args) {
        const result = await tasks.execute(...args);
        if (args[2].operation.kind === 'create' && !lostEffect) { lostEffect = true; throw new Error('Controlled lost task acknowledgement'); }
        return result;
      } } });
      const failed = await uncertain.tick(); assert.equal(failed.days.at(-1).receipt.state, 'uncertain');
      assert.ok(lostEffect);
      const before = await Promise.all(projects.map(readTasks));
      const again = await uncertain.tick(); assert.equal(again.days.length, 1); assert.equal(again.days[0].receipt.state, 'uncertain');
      assert.deepEqual(await Promise.all(projects.map(readTasks)), before);
      assert.equal(await history(), originalHistory);
      assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
    });
    await t.test('closing is idempotent and rejects later work', async () => {
      const closing = demo.close(); assert.equal(demo.close(), closing); await closing;
      await assert.rejects(demo.tick());
    });
    await t.test('deployment factories await their owned handles on refusal and shutdown', async () => {
      const options = await runtimeOptions();
      await assert.rejects(openHostedDemo({ ...options, directoryConnectionString: 'not-a-postgres-connection' }));
      const retained = await counts(workspace), runtime = await openHostedDemo(options);
      try {
        const result = await runtime.tick();
        assert.ok(result.synthetic); assert.ok(result.days.every(day => day.receipt.state === 'uncertain'));
        assert.deepEqual(await counts(workspace), retained);
        await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=now() WHERE service_id=$1', [serviceId]);
        await assert.rejects(runtime.tick());
        const service = await startHostedDemo(options);
        try {
          assert.deepEqual(service.status(), { running: true, last: null, error: 'activity-unavailable' });
          const closing = service.close(); assert.equal(service.close(), closing); await closing;
          assert.equal(service.status().running, false);
        } finally { await service.close(); }
        assert.deepEqual(await counts(workspace), retained);
      } finally {
        const closing = runtime.close(); assert.equal(runtime.close(), closing); await closing;
        await admin.query('UPDATE noticeos_platform.workspace_service_grants SET revoked_at=NULL WHERE service_id=$1', [serviceId]);
      }
      await assert.rejects(runtime.tick());
    });
    await t.test('shutdown finishes while the next-date selection is blocked by an owned database lock', async () => {
      const locker = await admin.connect(), scoped = openStore();
      let queried, pending, timeout;
      const selected = new Promise(resolve => { queried = resolve; });
      const held = make({ store: { ...scoped, read: work => scoped.read(tx => work({ ...tx, query(sql, values) {
        const result = tx.query(sql, values);
        if (sql.includes('generate_series')) queried();
        return result;
      } })) } });
      try {
        await locker.query('BEGIN');
        await locker.query('LOCK TABLE noticeos.hosted_job_occurrences IN ACCESS EXCLUSIVE MODE');
        pending = held.tick().then(() => null, error => error);
        await Promise.race([selected, pending.then(() => { throw new Error('Demo selection ended before acquiring the owned lock'); })]);
        const began = performance.now();
        await Promise.race([held.close(), new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Demo shutdown exceeded its bounded selection')), 6000);
        })]);
        assert.ok(performance.now() - began < 6000);
        assert.ok(await pending instanceof Error);
      } finally {
        clearTimeout(timeout); await locker.query('ROLLBACK'); locker.release();
        await held.close(); await pending;
      }
    });
  } finally {
    await Promise.all(demos.map(demo => demo.close()));
    await Promise.all([...stores.map(store => store.close()), ...grants.map(grant => grant.close())]);
    await directory?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
  }, { projects: allocations });
});
