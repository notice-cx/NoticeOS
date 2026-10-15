import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openStore, openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskExecutor } from './hosted-task-executor.mjs';
import { createHostedDemo } from './hosted-demo.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { openHostedDemo, startHostedDemo } from './hosted-demo-runtime.mjs';
import { startHostedScheduler } from './hosted-scheduler.mjs';
import { evaluateDemoWatch } from './demo-seed.mjs';
import { demoSchedules } from './demo-display.mjs';
import { buildDemoWorkerHelpers } from './demo-evaluator.mjs';
import { demoCodebaseReports, generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { createDemoActivity } from './demo-activity.mjs';
import { demoCodebaseVerdicts, fillDemo } from './demo-store.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { proveHostedDemoBrowser } from './test-fixtures/hosted-demo-browser.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { stepResult } from './workflow-trace.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const build = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'))('esbuild').build;
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
    store: untouched, grant: untouched, tasks: { execute() {} }, writer: { write() {}, collect() {}, revenue() {}, snapshot() {}, outcomes() {}, freshness() {}, uptime() {}, notify() {}, readbacks() {}, stampReadbacks() {} } };
  assert.throws(() => createHostedDemo({ ...options, workspaceId: customers[0] }), /demo activity refused/);
  const changed = structuredClone(scenario); changed.daily[0].sessions++;
  assert.throws(() => createHostedDemo({ ...options, scenario: changed }), /demo activity refused/);
  assert.throws(() => createHostedDemo({ ...options, projects: projects.map(row => ({ ...row, projectId: projects[0].projectId })) }), /demo activity refused/);
});

test("the demo's scheduled lanes are the release's own workflows and accept only the scheduler's minute", () => {
  const untouched = new Proxy({}, { get() { throw new Error('unexpected I/O'); } });
  const demo = createHostedDemo({ workspaceId: workspace, serviceId: randomUUID(), scenario, projects,
    store: untouched, grant: untouched, tasks: { execute() {} }, writer: { write() {}, collect() {}, revenue() {}, snapshot() {}, outcomes() {}, freshness() {}, uptime() {}, notify() {}, readbacks() {}, stampReadbacks() {} } });
  assert.deepEqual(demo.schedule.map(lane => lane.key), ['mediavine', 'counters', 'freshness', 'notifications', 'watch-windows', 'watch-readbacks', 'beads-snapshot']);
  // The Workflows page's lanes, each run once as the demo starts.
  assert.deepEqual(demo.startup, ['notifications', 'watch-windows', 'watch-readbacks']);
  assert.ok(demo.startup.every(key => WORKFLOW_DEFINITIONS.find(definition => definition.id === key).surface === 'workflow'));
  for (const lane of demo.schedule) {
    const stages = WORKFLOW_DEFINITIONS.find(definition => definition.id === lane.key)?.stages.map(stage => stage.id);
    assert.ok(lane.steps.every(step => stages?.includes(step.key)), lane.key);
    const minute = `${shiftDemoDay(scenario.manifest.referenceDate, 1)}T08:15:00.000Z`;
    assert.equal(lane.parseInput({ scheduledAt: minute }), minute);
    for (const input of [{ scheduledAt: minute.replace(':00.000Z', ':30.000Z') }, { scheduledAt: minute, extra: 1 }, { scheduledAt: '2000-01-01T00:00:00.000Z' }, 'today', null]) {
      assert.throws(() => lane.parseInput(input));
    }
  }
});

test("the demo's outcome check runs the release's evaluator over the demo's own windows", { timeout: 180000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-outcomes-'));
  let owner, closeAdmin, store;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    closeAdmin = trackFixturePool(admin);
    await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,'demo-outcomes','Demo outcomes','active')", [workspace]);
    const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
    store = openWorkspaceStore(owner.applicationLogin().url(), { workspaceId: workspace });
    await store.write(async tx => {
      await tx.query("SELECT set_config('noticeos.test_demo','synthetic',true)");
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    const untouched = new Proxy({}, { get() { throw new Error('unexpected I/O'); } });
    const demo = createHostedDemo({ workspaceId: workspace, serviceId: randomUUID(), scenario, projects, store: untouched, grant: untouched,
      tasks: { execute() {} }, writer: { write() {}, collect() {}, revenue() {}, snapshot() {}, outcomes: helpers.writeDemoOutcomeChecks, freshness() {}, uptime() {}, notify() {}, readbacks() {}, stampReadbacks() {} } });
    const lane = demo.schedule.find(entry => entry.key === 'watch-windows');
    const minute = `${shiftDemoDay(scenario.manifest.referenceDate, 1)}T03:30:00.000Z`;
    const run = () => store.write(tx => lane.steps[0].run({ input: minute, signal: new AbortController().signal }, tx));
    // The seeded repair and redesign windows are due; the ordinary sweep
    // closes each with what the scenario's sessions say. The recipe site's
    // shipped change is still counting, so its window stays open and is
    // scanned again, closed never.
    const first = await run();
    assert.deepEqual({ scanned: first.scanned, failed: first.failed, overdue: first.overdue, closed: first.closed.map(({ id, outcome }) => ({ id, outcome })).sort((a, b) => a.id.localeCompare(b.id)) },
      { scanned: 3, failed: [], overdue: [], closed: [{ id: scenario.manifest.stories.repair.watchId, outcome: 'ship_confirmed' }, { id: scenario.manifest.slide.watchId, outcome: 'kill_confirmed' }].sort((a, b) => a.id.localeCompare(b.id)) });
    const again = await run();
    assert.equal(again.scanned, 1);
    assert.deepEqual(again.closed, []);
    assert.equal(stepResult(again).state, 'succeeded');
  } finally {
    await store?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the demo's hourly lane reads each fictional home page with the release's own check, and the day's outage is down then back", { timeout: 180000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-uptime-'));
  let owner, closeAdmin, store;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    closeAdmin = trackFixturePool(admin);
    await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,'demo-uptime','Demo uptime','active')", [workspace]);
    const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
    store = openWorkspaceStore(owner.applicationLogin().url(), { workspaceId: workspace });
    await store.write(async tx => {
      await tx.query("SELECT set_config('noticeos.test_demo','synthetic',true)");
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    const untouched = new Proxy({}, { get() { throw new Error('unexpected I/O'); } });
    const demo = createHostedDemo({ workspaceId: workspace, serviceId: randomUUID(), scenario, projects, store: untouched, grant: untouched,
      tasks: { execute() {} }, writer: { write() {}, collect() {}, revenue() {}, snapshot() {}, outcomes() {}, freshness() {},
        uptime: (scoped, at, homePages) => helpers.runUptimeChecks({ STORE: scoped }, { nowMs: Date.parse(at), fetchImpl: homePages, confirmWaitMs: 0 }),
        notify() {}, readbacks() {}, stampReadbacks() {} } });
    const lane = demo.schedule.find(entry => entry.key === 'freshness');
    assert.deepEqual(lane.steps.map(step => step.key), ['freshness', 'uptime']);
    const uptime = lane.steps.find(step => step.key === 'uptime');
    const outage = createDemoActivity(scenario).homeOutage(shiftDemoDay(scenario.manifest.referenceDate, 1));
    const run = at => store.write(tx => uptime.run({ input: at, signal: new AbortController().signal }, tx));
    const open = () => store.read(tx => tx.query("SELECT asset_id AS asset, severity FROM noticeos.flags WHERE rule_id = 'hygiene-home-unreachable' AND resolved_at IS NULL"));
    // The check and its retry both meet the 503; every other site answers.
    const down = await run(outage.checkAt);
    assert.deepEqual({ checked: down.checked, retried: down.retried, fired: down.fired, failed: down.failed },
      { checked: assets.length, retried: 1, fired: 1, failed: [] });
    assert.deepEqual(await open(), [{ asset: outage.asset, severity: 'error' }]);
    // The next hour's check finds it back and closes the alert.
    const back = await run(new Date(Date.parse(outage.checkAt) + 3_600_000).toISOString());
    assert.deepEqual({ checked: back.checked, retried: back.retried, resolved: back.resolved }, { checked: assets.length, retried: 0, resolved: 1 });
    assert.deepEqual(await open(), []);
  } finally {
    await store?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the demo's codebase reports and alerts seed into the store, and the simulator's next week goes through the ordinary writer", { timeout: 300000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-codebase-'));
  let owner, closeAdmin, store;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    closeAdmin = trackFixturePool(admin);
    await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,'demo-codebase','Demo codebase','active')", [workspace]);
    const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
    store = openWorkspaceStore(owner.applicationLogin().url(), { workspaceId: workspace });
    await store.write(async tx => {
      await tx.query("SELECT set_config('noticeos.test_demo','synthetic',true)");
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    const seeded = demoCodebaseReports(scenario);
    const [stored] = await store.read(tx => tx.query(`SELECT (SELECT count(*)::int FROM noticeos.codebase_reports) AS reports,
      (SELECT count(*)::int FROM noticeos.current_codebase_reports) AS current, (SELECT min(report_number)::int FROM noticeos.codebase_reports) AS first,
      (SELECT count(*)::int FROM noticeos.flags WHERE rule_id LIKE 'codebase-%') AS flags,
      (SELECT count(*)::int FROM noticeos.flags WHERE rule_id LIKE 'codebase-%' AND resolved_at IS NULL) AS open`));
    // One stored report per seeded run, each the only revision of its day.
    assert.equal(stored.reports, seeded.length);
    assert.equal(stored.current, seeded.length);
    // The seeded alerts are the ones the released rules raise over those reports, in arrival order.
    const expected = demoCodebaseVerdicts(seeded, helpers.codebaseRules, seeded.map((_, i) => stored.first + i));
    assert.equal(stored.flags, expected.length);
    assert.equal(stored.open, expected.filter(flag => flag.resolvedAt === null).length);
    const [newest] = await store.read(tx => tx.query('SELECT envelope::text AS envelope FROM noticeos.codebase_reports ORDER BY report_number DESC LIMIT 1'));
    assert.deepEqual(JSON.parse(newest.envelope), seeded.at(-1).envelope);

    // The simulator's next eight days, written as the hosted demo writes them:
    // each weekly codebase report through the ingest's own writer and rules.
    const activity = createDemoActivity(scenario);
    const scoped = Object.freeze({ where: 'demo-codebase', workspaceId: async () => workspace, read: work => store.read(work), write: work => store.write(work) });
    let sent = 0;
    for (let i = 0; i < 8; i++) {
      const day = activity.day(shiftDemoDay(scenario.manifest.referenceDate, i));
      sent += day.codebase.length;
      await helpers.writeDemoActivity(scoped, day);
    }
    assert.ok(sent > 0);
    const [after] = await store.read(tx => tx.query(`SELECT count(*)::int AS reports, max(revision)::int AS revision,
      count(*) FILTER (WHERE envelope->>'asset' <> asset_id)::int AS mismatched FROM noticeos.codebase_reports`));
    assert.deepEqual(after, { reports: seeded.length + sent, revision: 1, mismatched: 0 });
    const open = await store.read(tx => tx.query("SELECT asset_id, rule_id FROM noticeos.flags WHERE rule_id LIKE 'codebase-%' AND resolved_at IS NULL ORDER BY asset_id, rule_id"));
    // A new report resolves its rule's earlier alert before raising another, so each site holds at most one per rule.
    assert.equal(new Set(open.map(row => `${row.asset_id}/${row.rule_id}`)).size, open.length);
    assert.ok(open.some(row => row.asset_id === 'weeknightpantry.example' && row.rule_id === 'codebase-duplication'));
    assert.ok(open.some(row => row.asset_id === 'trailnotes.example' && row.rule_id === 'codebase-unused'));
  } finally {
    await store?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new demo's Workflows page shows three workflows with real runs from its first minute", { timeout: 180000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-demo-workflows-'));
  let owner, closeAdmin, seedStore, reader, scheduler;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    applyMigrations(owner);
    const admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    closeAdmin = trackFixturePool(admin);
    const appUrl = owner.applicationLogin().url();
    const password = randomBytes(32).toString('base64url');
    await admin.query(`ALTER ROLE noticeos_service_grant LOGIN PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_service_grant 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const grantUrl = new URL(appUrl); grantUrl.username = 'noticeos_service_grant'; grantUrl.password = password;
    const serviceId = randomUUID();
    await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,'demo-workflows','Demo workflows','active')", [workspace]);
    await admin.query("INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [serviceId, workspace, ['workflows.run', 'tasks.read', 'tasks.write']]);
    // The setup's own steps: the scenario, then the evaluator closing the two
    // seeded comparisons, then the generic settings with the demo's run times.
    const helpers = await buildDemoWorkerHelpers(REPO_ROOT, { activity: true, configurationRoot: path.join(REPO_ROOT, 'workers/ingest/test/fixture-config') });
    seedStore = openStore(appUrl);
    await seedStore.inWorkspace(workspace, async tx => {
      await tx.query("SELECT set_config('noticeos.test_demo','synthetic',true)");
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
    });
    await evaluateDemoWatch(seedStore, scenario, helpers.runWatchWindows);
    const constants = JSON.parse(readFileSync(path.join(REPO_ROOT, 'workers/ingest/test/fixture-config/constants.json'), 'utf8'));
    await admin.query("INSERT INTO noticeos.config_documents(workspace_id,document_key,body,version,updated_at,updated_by) VALUES($1,'constants',$2,1,now(),'fixture')",
      [workspace, { ...constants, schedules: demoSchedules() }]);
    // The task service as the hosted executor answers it: each task's comments.
    const comments = new Map(), taskCalls = [];
    const tasks = { async execute(_proof, workspaceId, { projectId, operation }) {
      assert.equal(workspaceId, workspace);
      taskCalls.push({ projectId, kind: operation.kind, taskId: operation.taskId });
      const held = comments.get(operation.taskId) ?? [];
      if (operation.kind === 'comments') return held.map(row => ({ ...row }));
      if (operation.kind === 'comment') { comments.set(operation.taskId, [...held, { issue_id: operation.taskId, author: serviceId, text: operation.text }]); return { id: operation.taskId }; }
      throw new Error(`Unexpected task operation ${operation.kind}`);
    } };
    const untouched = new Proxy({}, { get() { throw new Error('unexpected I/O'); } });
    const demo = createHostedDemo({ workspaceId: workspace, serviceId, scenario, projects, store: untouched, grant: untouched, tasks,
      writer: { write() {}, collect() {}, revenue() {}, snapshot() {}, freshness() {}, uptime() {}, outcomes: helpers.writeDemoOutcomeChecks,
        notify: (scoped, at) => helpers.runNotifier({ STORE: scoped, NOTICEOS_WORKSPACE_PROFILE: 'demo' }, { nowMs: Date.parse(at), fetchImpl: () => { throw new Error('No notification is sent.'); } }),
        readbacks: scoped => helpers.readPendingWatchReadbacks({ STORE: scoped }),
        stampReadbacks: (scoped, ids, at) => helpers.markWatchReadbacksPosted({ STORE: scoped }, [...ids], Date.parse(at)) } });
    let clock = Date.parse(`${shiftDemoDay(scenario.manifest.referenceDate, 1)}T08:12:00.000Z`);
    const timers = [];
    const start = (startup = demo.startup) => startHostedScheduler([{ workspaceId: workspace, serviceId, startup,
      store: openWorkspaceStore(appUrl, { workspaceId: workspace }),
      grant: openWorkspaceServiceGrant({ connectionString: grantUrl.href, principalId: serviceId, workspaceId: workspace }), definitions: demo.schedule }],
    { now: () => clock, createTimer(cron, callback) {
      const timer = { cron, callback, stopped: false, stop() { this.stopped = true; }, nextRun: () => null }; timers.push(timer); return timer;
    } });
    const journal = async () => (await admin.query(`SELECT lane,occurrence,state,steps FROM noticeos.hosted_job_occurrences
      WHERE workspace_id=$1 ORDER BY lane,occurrence`, [workspace])).rows;
    const readerPath = path.join(root, 'workflow-read.mjs');
    await build({ entryPoints: [path.join(REPO_ROOT, 'apps/tower/worker/hosted-workflow-read.ts')], outfile: readerPath,
      bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    const { handleHostedWorkflowRead } = await import(pathToFileURL(readerPath).href);
    reader = openWorkspaceStore(appUrl, { workspaceId: workspace });
    const page = async () => {
      const payload = await (await handleHostedWorkflowRead(new Request('https://demo.example.com/api/workflows'), reader)).json();
      return payload.workflows.filter(workflow => WORKFLOW_DEFINITIONS.find(definition => definition.id === workflow.id).surface === 'workflow');
    };

    // Starting the scheduler runs each Workflows lane once, at that minute.
    await assert.rejects(start(['hygiene']), { name: 'HostedScheduleRefused' });
    scheduler = await start();
    const minute = new Date(clock).toISOString();
    const first = await journal();
    assert.deepEqual(first.map(row => [row.lane, row.occurrence, row.state]),
      [['notifications', minute, 'succeeded'], ['watch-readbacks', minute, 'succeeded'], ['watch-windows', minute, 'succeeded']]);
    const steps = Object.fromEntries(first.map(row => [row.lane, row.steps]));
    // The notifier finds what it would say, and no channel is connected to say it.
    assert.equal(steps.notifications.notify.state, 'skipped');
    assert.ok(['No new notifications', 'Notification account is not connected'].includes(steps.notifications.notify.output.fields.find(field => field.key === 'reason').value));
    // The outcome check reads the comparison still counting.
    assert.equal(steps['watch-windows'].outcomes.state, 'succeeded');
    assert.equal(steps['watch-windows'].outcomes.output.metrics.find(metric => metric.key === 'scanned').value, 1);
    // The two verdicts the seed's evaluator recorded reach their tasks, each
    // in its own site's project, and are stamped as delivered.
    assert.equal(steps['watch-readbacks'].execute.state, 'succeeded');
    const delivered = [scenario.manifest.stories.repair, scenario.manifest.slide];
    for (const story of delivered) {
      const posted = comments.get(story.readbackTaskId);
      assert.equal(posted?.length, 1, story.watchId);
      assert.ok(posted[0].text.startsWith(`Watch window ${story === scenario.manifest.slide ? 'kill_confirmed' : 'ship_confirmed'} — ${story.asset}`));
      assert.ok(posted[0].text.endsWith(`Window ${story.watchId}.`));
      assert.ok(taskCalls.some(call => call.kind === 'comment' && call.taskId === story.readbackTaskId
        && call.projectId === projects.find(project => project.asset === story.asset).projectId));
    }
    assert.deepEqual((await admin.query(`SELECT window_id FROM noticeos.watch_windows WHERE workspace_id=$1
      AND readback_posted_at IS NOT NULL ORDER BY window_id`, [workspace])).rows.map(row => row.window_id), delivered.map(story => story.watchId).sort());

    // The page lists three workflows, each with its run and stage evidence,
    // in more than one state.
    const workflows = await page();
    assert.deepEqual(workflows.map(workflow => workflow.id).sort(), ['notifications', 'watch-readbacks', 'watch-windows']);
    assert.ok(workflows.every(workflow => workflow.runs.length === 1 && workflow.latest));
    assert.deepEqual(Object.fromEntries(workflows.map(workflow => [workflow.id, workflow.latest.state])),
      { notifications: 'skipped', 'watch-readbacks': 'succeeded', 'watch-windows': 'succeeded' });
    assert.ok(workflows.every(workflow => workflow.history.some(bucket => bucket.succeeded + bucket.skipped === 1)));

    // A restart within the same minute finds those runs; it repeats nothing.
    await scheduler.close();
    scheduler = await start();
    assert.equal((await journal()).length, 3);
    assert.equal([...comments.values()].flat().length, 2);

    // The next hour's pass owes nothing and says so; no verdict is posted twice.
    clock += 3_600_000;
    await timers.findLast(timer => timer.cron === '50 * * * *' && !timer.stopped).callback();
    const later = (await journal()).filter(row => row.lane === 'watch-readbacks');
    assert.deepEqual(later.map(row => row.state), ['succeeded', 'succeeded']);
    assert.equal(later[1].steps.execute.state, 'skipped');
    assert.equal([...comments.values()].flat().length, 2);
    assert.equal((await page()).find(workflow => workflow.id === 'watch-readbacks').latest.state, 'skipped');
    // Outcome checks run each hour in the demo.
    assert.ok(timers.some(timer => timer.cron === '30 * * * *' && !timer.stopped));
  } finally {
    await scheduler?.close(); await reader?.close(); await seedStore?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

// About twenty demo days, each reading five task projects through the pinned
// task client against a real Dolt server: about four minutes in CI.
test('persistent demo uses ordinary Postgres writers and actual scoped Beads without changing either customer', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 600_000,
}, async t => {
  // The fixture keeps one receipt per evidence folder, and pnpm test:task-store
  // runs other suites over the same folder: this file keeps its own inside it.
  process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE = mkdtempSync(
    path.join(process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE, 'hosted-demo-'));
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
      await fillDemo(tx, scenario, { evaluatePulse: helpers.evaluatePulse, codebaseRules: helpers.codebaseRules, developmentProfile: { setting: 'noticeos.test_demo', value: 'synthetic' } });
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
        writer: { collect: helpers.writeDemoCollection, revenue: helpers.writeDemoAdRevenue, outcomes: helpers.writeDemoOutcomeChecks, freshness: (store, at) => helpers.runFreshnessCheck({ STORE: store }, Date.parse(at)),
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
      assert.equal(snapshot.projects.length, assets.length); assert.ok(snapshot.projects.every(project => project.ok));
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
        // Each day records one report per site and one actual OS observation.
        assert.equal(current.pulses, retained.pulses + 2 * (assets.length + 1));
        // Each site's weekly cycle starts a day after the site before it, so
        // both days change a board: one files a task, the next claims another.
        assert.equal(current.snapshots, retained.snapshots + 2);
        assert.ok(result.days.every(day => day.receipt.steps['task-summary'].state === 'succeeded'));
        const task = (await readTasks(projects[0])).find(row => row.id === createdTaskId);
        // The first cycle is a review: the verifier claims it by name.
        assert.equal(task.status, 'in_progress'); assert.equal(task.assignee, 'codex');
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
      const closed = await tasks.execute(proof, workspace, { projectId: projects[0].projectId,
        operation: { kind: 'show', taskId: createdTaskId } });
      assert.equal(closed.length, 1); assert.equal(closed[0].status, 'closed');
      assert.equal(closed[0].assignee, 'codex'); assert.ok(closed[0].close_reason.includes('No live deployment'));
      assert.deepEqual([closed[0].metadata?.noticeos_closed_by, closed[0].metadata?.noticeos_closed_model], ['codex', 'GPT-5-Codex']);
      assert.ok(Math.abs(Date.parse(closed[0].metadata?.noticeos_closed_at) - Date.parse(closed[0].closed_at)) <= 1000);
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
      const revoke = revoked => admin.query(`UPDATE noticeos_platform.workspace_service_grants SET revoked_at=${revoked ? 'now()' : 'NULL'} WHERE service_id=$1`, [serviceId]);
      await assert.rejects(openHostedDemo({ ...options, directoryConnectionString: 'not-a-postgres-connection' }));
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
    await directory?.close(); await closeAdmin?.(); owner?.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false);
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  }
  }, { projects: allocations });
});
