import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createHostedDemo } from './hosted-demo.mjs';
import { applyDemoNtasksProvision, createDemoTaskService, demoNtasks, demoNtasksProvisionRequest, demoNtasksWorker, DEMO_NTASKS_CREDENTIALS } from './demo-ntasks.mjs';
import { demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { openHostedDemo, startHostedDemo } from './hosted-demo-runtime.mjs';
import { buildDemoWorkerHelpers } from './demo-evaluator.mjs';
import { generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { createDemoActivity } from './demo-activity.mjs';
import { fillDemo } from './demo-store.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';

// The persistent demo against its real task store: the demo's own Ntasks, the
// pinned build (scripts/demo-ntasks-build.mjs) in Miniflare, provisioned as
// its ntasks service provisions it, with the sites' projects loaded empty. It
// needs a built Ntasks in NOTICEOS_NTASKS_ROOT, which the CI demo-ntasks job
// builds; the root suite skips it and runs the demo's other proofs in
// hosted-demo.test.mjs.

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const scenario = generateDemoScenario({ seed: 'hosted-activity-proof', cutoff: '2026-09-21T12:00:00.000Z', release: 'a'.repeat(40) });
const workspace = scenario.manifest.workspaceId;
const customers = [randomUUID(), randomUUID()];
const assets = scenario.assets.filter(asset => !asset.isOs);
const seededProjects = demoNtasksSeed(scenario).projects;
const projects = assets.map(asset => ({ asset: asset.id, projectId: seededProjects.find(project => project.prefix === asset.prefix).id, prefix: asset.prefix }));
const NTASKS = process.env.NOTICEOS_NTASKS_ROOT;

// About twenty demo days, each reading five task projects in the demo's own Ntasks.
test('persistent demo uses ordinary Postgres writers and the demo\'s own Ntasks without changing either customer', {
  skip: !NTASKS && 'needs a built Ntasks in NOTICEOS_NTASKS_ROOT (node scripts/demo-ntasks-build.mjs --out <folder>)', timeout: 600_000,
}, async t => {
  const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-pg-'));
  let owner, closeAdmin, miniflare;
  const demos = [], stores = [], grants = [];
  try {
    // The demo's own Ntasks, its sites' projects loaded with no task yet.
    const cli = (...args) => execFileSync(process.execPath, [path.join(NTASKS, 'tools/migrate/src/cli.ts'), ...args], { encoding: 'utf8' });
    writeFileSync(path.join(root, 'request.json'), JSON.stringify(demoNtasksProvisionRequest(scenario)));
    cli('provision', '--from', path.join(root, 'request.json'), '--out', path.join(root, 'provision.json'));
    const provision = JSON.parse(readFileSync(path.join(root, 'provision.json'), 'utf8'));
    const wrangler = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
    const { Miniflare, Log } = v4Miniflare(wrangler);
    miniflare = new Miniflare({ ...demoNtasksWorker({ bundleRoot: path.join(NTASKS, 'dist'), authSecret: randomBytes(32).toString('base64url'), workspaceId: workspace }),
      host: '127.0.0.1', port: 0, cf: false, resourcePersistencePath: path.join(root, 'ntasks'), log: new Log(0), handleStructuredLogs: () => undefined });
    const ntasksOrigin = (await miniflare.ready).origin;
    await applyDemoNtasksProvision(await miniflare.getD1Database('DB'), provision);
    writeFileSync(path.join(root, 'seed.json'), JSON.stringify({ format: 'ntasks-seed-v1', projects: seededProjects.filter(project => projects.some(row => row.projectId === project.id)), tasks: [] }));
    writeFileSync(path.join(root, 'seed.token'), `${provision.tokens[DEMO_NTASKS_CREDENTIALS.seed]}\n`, { mode: 0o600 });
    cli('seed', '--from', path.join(root, 'seed.json'), '--out', path.join(root, 'backup.json'));
    cli('load', '--api', ntasksOrigin, '--token-file', path.join(root, 'seed.token'), '--from', path.join(root, 'backup.json'));
    const activityToken = provision.tokens[DEMO_NTASKS_CREDENTIALS.activity];
    const tasks = createDemoTaskService({ ntasks: demoNtasks({ workspaceId: workspace, origin: ntasksOrigin, token: activityToken }) });
    const visitor = demoNtasks({ workspaceId: workspace, origin: ntasksOrigin });
    const readTasks = async project => (await visitor.call('GET', `/api/tasks?project=${project.projectId}&status=open,in_progress,blocked,deferred`)).body.tasks;
    const readTask = async (project, id) => (await visitor.call('GET', `/api/tasks/${id}?project=${project.projectId}`)).body.task;

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
    const grantUrl = await connection('noticeos_service_grant');
    const serviceId = randomUUID();
    for (const id of [...customers, workspace]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, 'generated-' + id]);
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
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    const runtimeOptions = async (now) => ({ sourceRoot: REPO_ROOT, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config'),
      scenario: structuredClone(scenario), workspaceId: workspace, serviceId,
      connectionString: appUrl, grantConnectionString: grantUrl, ntasks: { origin: ntasksOrigin, token: activityToken },
      projects: projects.map(project => ({ ...project })), ...(now ? { now } : {}) });
    let clock = Date.parse('2026-09-22T12:00:00Z'), failDatabase = true, failSnapshot = true, lostEffect = false;
    let escapedStore, createdTaskId;
    const make = (over = {}) => {
      const demo = createHostedDemo({ workspaceId: workspace, serviceId, scenario, projects,
        store: openStore(), grant: openGrant(), now: () => clock,
        writer: { banking: helpers.writeDemoBanking, collect: helpers.writeDemoCollection, revenue: helpers.writeDemoAdRevenue, outcomes: helpers.writeDemoOutcomeChecks, freshness: (store, at) => helpers.runFreshnessCheck({ STORE: store }, Date.parse(at)),
          notify: (store, at) => helpers.runNotifier({ STORE: store, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, { nowMs: Date.parse(at) }), readbacks: store => helpers.readPendingWatchReadbacks({ STORE: store }),
          stampReadbacks: (store, ids, at) => helpers.markWatchReadbacksPosted({ STORE: store }, [...ids], Date.parse(at)),
          uptime: (store, at, homePages) => helpers.runUptimeChecks({ STORE: store }, { nowMs: Date.parse(at), fetchImpl: homePages, confirmWaitMs: 0 }), async snapshot(store, snapshot) {
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
      assert.equal(created.length, 1); assert.equal(created[0].status, 'open');
      createdTaskId = created[0].id;
      const snapshot = await latestSnapshot();
      assert.equal(snapshot.projects.length, assets.length); assert.ok(snapshot.projects.every(project => project.ok));
      // The site's project held no task before the simulator filed this one.
      assert.equal(snapshot.projects.find(project => project.asset === projects[0].asset).counts.open, 1);
      const held = await counts(workspace); assert.deepEqual((await demo.tick()).days, []); assert.deepEqual(await counts(workspace), held);
    });
    await t.test('a restarted service resumes retained checkpoints and cannot select a customer task project', async () => {
      const held = await counts(workspace);
      await demo.close(); demo = make();
      assert.deepEqual((await demo.tick()).days, []); assert.deepEqual(await counts(workspace), held);
      // The demo's credential reaches only its own workspace's sites: any other project is none it knows.
      for (const foreign of [randomUUID(), seededProjects.find(project => !projects.some(row => row.projectId === project.id)).id]) {
        await assert.rejects(tasks.labelled(foreign, 'synthetic-demo', AbortSignal.timeout(10_000)));
        await assert.rejects(tasks.create(foreign, { title: 'Forbidden foreign task', description: '', acceptance: '', labels: [] }, 'forbidden', AbortSignal.timeout(10_000)));
      }
      assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
    });
    await t.test('the actual deployment factory advances two due days with captured bindings and ordinary writers', async () => {
      const options = await runtimeOptions(() => Date.parse('2026-09-24T12:00:00Z'));
      const runtime = await openHostedDemo(options), retained = await counts(workspace);
      options.workspaceId = customers[0]; options.now = () => { throw new Error('Caller clock changed after capture'); };
      options.projects[0].projectId = randomUUID(); options.ntasks.token = 'ntasks_service.changed-after-capture';
      options.scenario.daily[0].sessions++;
      try {
        const result = await runtime.tick();
        assert.deepEqual(result.days.map(day => day.date), ['2026-09-22', '2026-09-23']);
        assert.ok(result.days.every(day => day.receipt.state === 'succeeded'));
        const current = await counts(workspace);
        // Each day records one report per site and one actual OS observation.
        assert.equal(current.pulses, retained.pulses + 2 * (assets.length + 1));
        // Each site's weekly cycle starts a day after the site before it, so
        // both days change a board: one files a task, the next claims another.
        assert.equal(current.snapshots, retained.snapshots + 2);
        assert.ok(result.days.every(day => day.receipt.steps['task-summary'].state === 'succeeded'));
        const task = (await readTasks(projects[0])).find(row => row.id === createdTaskId);
        // The first cycle is a review: the verifier claims it by name, through the demo's credential.
        assert.equal(task.status, 'in_progress'); assert.equal(task.assignee, 'service:demo/codex');
        assert.equal((await latestSnapshot()).projects.find(project => project.asset === projects[0].asset).counts.inProgress, 1);
        assert.deepEqual(await Promise.all(customers.map(counts)), customerBefore);
      } finally { await runtime.close(); }
    });
    await t.test('concurrent instances advance each completed day once and Ntasks progresses the same task', async () => {
      clock = Date.parse('2026-09-26T12:00:00Z');
      const other = make();
      const results = await Promise.allSettled([demo.tick(), other.tick()]);
      assert.ok(results.some(result => result.status === 'fulfilled'));
      await demo.tick();
      const state = (await admin.query(`SELECT occurrence,state,attempt,effect_step,
        ARRAY(SELECT jsonb_object_keys(steps)) AS steps FROM noticeos.hosted_job_occurrences WHERE workspace_id=$1 ORDER BY occurrence`, [workspace])).rows;
      assert.equal(state.length, 5, JSON.stringify(state)); assert.ok(state.every(row => row.state === 'succeeded'), JSON.stringify(state));
      // Each completed day holds its sites' reports once.
      const activity = createDemoActivity(scenario);
      for (let i = 0; i < 5; i++) {
        const day = shiftDemoDay(scenario.manifest.referenceDate, i);
        const pulseCount = (await admin.query('SELECT count(*)::int n FROM noticeos.pulses WHERE workspace_id=$1 AND pulse_date=$2 AND asset_id=ANY($3::text[])',
          [workspace, day, assets.map(asset => asset.id)])).rows[0].n;
        assert.equal(pulseCount, activity.day(day).assets.filter(asset => asset.pulse !== null).length, day);
      }
      const closed = await readTask(projects[0], createdTaskId);
      assert.equal(closed.status, 'closed');
      assert.equal(closed.assignee, 'service:demo/codex'); assert.ok(closed.closeReason.includes('No live deployment'));
      assert.deepEqual([closed.closedBy, closed.closedModel], ['service:demo/codex', 'GPT-5-Codex']);
      const project = (await latestSnapshot()).projects.find(project => project.asset === projects[0].asset);
      assert.equal(project.counts.open, 0); assert.equal(project.counts.inProgress, 0); assert.equal(project.counts.closedRecent, 1);
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
      const uncertain = make({ tasks: { ...tasks, async create(...args) {
        const result = await tasks.create(...args);
        if (!lostEffect) { lostEffect = true; throw new Error('Controlled lost task acknowledgement'); }
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
      const revoke = revoked => admin.query(`UPDATE noticeos_platform.workspace_service_grants SET revoked_at=${revoked ? 'now()' : 'NULL'} WHERE service_id=$1`, [serviceId]);
      await assert.rejects(openHostedDemo({ ...options, ntasks: { ...options.ntasks, origin: 'https://ntasks.example.test' } }));
      // Without a clock each factory also starts the hosted scheduler, which
      // holds the workspace's schedule until it closes. This workspace saves
      // no schedule, so the scheduler arms no lane and runs none at start.
      const retained = await counts(workspace), runtime = await openHostedDemo(options);
      try {
        const result = await runtime.tick();
        assert.ok(result.synthetic); assert.ok(result.days.every(day => day.receipt.state === 'uncertain'));
        assert.deepEqual(await counts(workspace), retained);
        await revoke(true);
        await assert.rejects(runtime.tick());
      } finally {
        const closing = runtime.close(); assert.equal(runtime.close(), closing); await closing;
        await revoke(false);
      }
      await assert.rejects(runtime.tick());
      // A running service reports the uncertain day, never a healthy simulator.
      const service = await startHostedDemo(options);
      try {
        const status = service.status();
        assert.equal(status.running, true); assert.equal(status.error, 'activity-unavailable');
        assert.deepEqual(status.last?.days.map(day => day.receipt.state), ['uncertain']);
        const closing = service.close(); assert.equal(service.close(), closing); await closing;
        assert.equal(service.status().running, false);
      } finally { await service.close(); }
      // Without its grant a service cannot claim the schedule, so it never starts.
      await revoke(true);
      try { await assert.rejects(startHostedDemo(options)); } finally { await revoke(false); }
      assert.deepEqual(await counts(workspace), retained);
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
    await closeAdmin?.(); owner?.close(); await miniflare?.dispose();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
});
