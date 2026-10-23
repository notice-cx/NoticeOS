import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { openStore, openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { openWorkspaceServiceGrant } from '../packages/postgres/src/service-grant.mjs';
import { createHostedDemo } from './hosted-demo.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { startHostedScheduler } from './hosted-scheduler.mjs';
import { evaluateDemoWatch } from './demo-seed.mjs';
import { demoSchedules } from './demo-display.mjs';
import { buildDemoWorkerHelpers } from './demo-evaluator.mjs';
import { demoCodebaseReports, generateDemoScenario, shiftDemoDay } from './demo-scenario.mjs';
import { createDemoActivity } from './demo-activity.mjs';
import { demoCodebaseVerdicts, fillDemo } from './demo-store.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { stepResult } from './workflow-trace.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const build = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'))('esbuild').build;
const scenario = generateDemoScenario({ seed: 'hosted-activity-proof', cutoff: '2026-09-21T12:00:00.000Z', release: 'a'.repeat(40) });
const workspace = scenario.manifest.workspaceId;
const customers = [randomUUID(), randomUUID()];
const assets = scenario.assets.filter(asset => !asset.isOs);
const projects = assets.map(asset => ({ asset: asset.id, projectId: randomUUID(), prefix: 'tt' }));

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
