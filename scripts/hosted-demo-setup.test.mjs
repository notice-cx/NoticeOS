import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { captureHostedDemoSetupRequest, readHostedDemoSetupRequest, setupHostedDemo } from './hosted-demo-setup.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { generateDemoScenario } from './demo-scenario.mjs';
import { applyDemoNtasksProvision, demoNtasksProvisionRequest, demoNtasksWorker, openDemoTasks, DEMO_NTASKS_CREDENTIALS } from './demo-ntasks.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { openHostedDemo } from './hosted-demo-runtime.mjs';
import { readHostedDemoRuntimeFile } from './hosted-demo-server.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { writeDemoTaskReceipt } from './demo-tasks.mjs';
import { writeDemoWorkflowHistory } from './demo-workflows.mjs';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function request(home) {
  return { version: 1, stateRoot: home, sourceRoot: root, artifactRoot: path.join(home, 'artifacts'), workerStateRoot: path.join(home, 'worker'),
    publicOrigin: 'https://demo.example.test', listen: { host: '127.0.0.1', port: 6548 }, seed: 'portable-hosted-setup',
    cutoff: '2026-10-02T12:00:00.000Z', release: 'a'.repeat(40), serviceExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    postgres: { adminUrl: 'postgresql://postgres@127.0.0.1:6500/noticeos_dev?sslmode=disable' },
    ntasks: { origin: 'http://127.0.0.1:13383', provisionFile: path.join(home, 'no-provision.json'), toolRoot: '/not-a-tool/ntasks' } };
}
function artifact(base) {
  const folder = path.join(base, 'artifact'); fs.mkdirSync(folder);
  for (const part of ['client','tower','ingest']) fs.mkdirSync(path.join(folder, part));
  const files = { 'client/index.html': '<main>Fixture</main>', 'tower/main.js': 'export default {}', 'ingest/main.js': 'export default {}' };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(folder, name), body);
  const worker = name => ({ main: name + '/main.js', modulesRoot: name, compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'] });
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ version: 1, release: 'a'.repeat(64), client: 'client', tower: worker('tower'), ingest: worker('ingest'),
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, hash(body)])), publicFiles: ['client/index.html'] }));
  return folder;
}
test('fresh setup captures exact explicit configuration and refuses arbitrary inherited targets', () => {
  const input = request('/private/tmp/owned-demo');
  const held = captureHostedDemoSetupRequest(input); input.ntasks.origin = 'http://127.0.0.1:3308';
  assert.equal(held.ntasks.origin, 'http://127.0.0.1:13383');
  for (const changed of [
    { ...held, unknown: true }, { ...held, publicOrigin: 'http://demo.example.test' },
    { ...held, workerStateRoot: '/other-state' }, { ...held, postgres: { adminUrl: 'postgresql://postgres@db.example.test/noticeos?sslmode=disable' } },
    { ...held, ntasks: { ...held.ntasks, origin: 'https://ntasks.example.test' } },
    { ...held, ntasks: { ...held.ntasks, origin: 'http://ntasks.example.test:8787' } },
    { ...held, serviceExpiresAt: new Date(Date.now() + 400 * 86400000).toISOString() },
  ]) assert.throws(() => captureHostedDemoSetupRequest(changed));
});
test('foreign/partial/nonprivate state and unsafe request files refuse before tool/database work', async () => {
  const own = testFixtureRoot('n-setup-refusal-');
  try {
    const artifactRoot = artifact(own);
    const configured = home => ({ ...request(home), artifactRoot });
    const foreign = path.join(own, 'foreign'); fs.mkdirSync(foreign, { mode: 0o700 }); fs.writeFileSync(path.join(foreign, 'keep'), 'foreign');
    await assert.rejects(setupHostedDemo(configured(foreign))); assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'foreign');
    const partial = path.join(own, 'partial'); fs.mkdirSync(partial, { mode: 0o700 }); fs.writeFileSync(path.join(partial, '.setup-pending.json'), '{}');
    await assert.rejects(setupHostedDemo(configured(partial)));
    const shared = path.join(own, 'shared'); fs.mkdirSync(shared, { mode: 0o755 }); await assert.rejects(setupHostedDemo(configured(shared)));
    const file = path.join(own, 'request.json'); fs.writeFileSync(file, JSON.stringify(request(foreign)), { mode: 0o644 });
    assert.throws(() => readHostedDemoSetupRequest(file)); fs.chmodSync(file, 0o600);
    const link = path.join(own, 'link.json'); fs.symlinkSync(file, link); assert.throws(() => readHostedDemoSetupRequest(link));
    assert.deepEqual(fs.readdirSync(partial), ['.setup-pending.json']);
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});

test('artifact preflight and sanitized phase diagnostics refuse before database acquisition', async () => {
  const own = testFixtureRoot('n-setup-phase-');
  try {
    const artifactRoot = artifact(own), home = path.join(own, 'state'), input = { ...request(home), artifactRoot };
    fs.writeFileSync(path.join(artifactRoot, 'client/index.html'), 'changed bytes');
    await assert.rejects(setupHostedDemo(input), error => /\(artifact\)/u.test(error.message));
    assert.equal(fs.existsSync(home), false, 'broken artifacts cannot create state or acquire a pool');
    fs.writeFileSync(path.join(artifactRoot, 'client/index.html'), '<main>Fixture</main>');
    const file = path.join(own, 'request.json'); fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/hosted-demo-setup.mjs'), '--request', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Fresh hosted demo setup refused (tools); preserve partial state for explicit recovery.\n');
    assert.equal(result.stderr.includes(input.postgres.adminUrl), false);
    assert.deepEqual(fs.readdirSync(home).sort(), ['.setup-pending.json','runtime','setup-home','setup-tmp']);
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});

test('durable task receipt lets the ordinary workflow writer proceed and cannot be overwritten', async () => {
  const home = testFixtureRoot('n-demo-receipt-');
  try {
    const receipt = { synthetic: true, scenarioHash: 'a'.repeat(64), workspaceId: '11111111-1111-4111-8111-111111111111', release: 'b'.repeat(40) };
    const history = { ...receipt, cutoff: '2026-10-03T12:00:00.000Z', records: [], traces: [], runs: [], links: {} };
    let calls = 0;
    const writeRuns = async () => { calls++; return { ok: true, created: 0, duplicate: 0, stale: 0, pruned: 0 }; };
    await assert.rejects(writeDemoWorkflowHistory({ home, history, writeRuns }), error => error.code === 'ENOENT');
    assert.equal(calls, 0);
    writeDemoTaskReceipt(home, receipt);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'demo-tasks.json'), 'utf8')), receipt);
    assert.equal(fs.statSync(path.join(home, 'demo-tasks.json')).mode & 0o777, 0o600);
    assert.throws(() => writeDemoTaskReceipt(home, { ...receipt, synthetic: false }), error => error.code === 'EEXIST');
    await writeDemoWorkflowHistory({ home, history, writeRuns }); assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(home, '.local/logs/workflow-runs.jsonl')), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// The whole fresh setup against a new PostgreSQL 18 cluster and the stack's
// own Ntasks, the pinned build in Miniflare, provisioned as its service
// provisions it: opt in with NOTICEOS_TEST_HOSTED_DEMO_SETUP=1 and a built
// Ntasks in NOTICEOS_NTASKS_ROOT (node scripts/demo-ntasks-build.mjs --out <folder>).
test('fresh PostgreSQL18 and the demo\'s own Ntasks create the complete scoped demo, reuse without reseed, and power real readers/activity', {
  skip: process.env.NOTICEOS_TEST_HOSTED_DEMO_SETUP !== '1' || !process.env.NOTICEOS_NTASKS_ROOT, timeout: 780000,
}, async () => {
  const ntasksRoot = process.env.NOTICEOS_NTASKS_ROOT;
  const base = testFixtureRoot('n-demo-setup-');
  fs.chmodSync(base, 0o700);
  const disk = fs.statfsSync(base); assert.ok(disk.bavail * disk.bsize >= 8 * 1024 ** 3 + 1024 ** 3);
  const home = path.join(base, 'state'), bootstrap = path.join(base, 'bootstrap');
  fs.mkdirSync(bootstrap, { mode: 0o700 });
  let pg, miniflare, tasks, activity, store;
  try {
    const tools = findPostgres(); pg = await openOnLoopbackPort(path.join(base, 'pg'), tools);
    const secret = randomBytes(32).toString('hex'); pg.onDatabase('postgres').run(`ALTER ROLE postgres PASSWORD '${secret}';`);
    fs.appendFileSync(path.join(pg.root, LOOPBACK_HBA), 'host all postgres 127.0.0.1/32 scram-sha-256\n' +
      ['noticeos_app','noticeos_identity','noticeos_service_grant'].map(role => `host all ${role} 127.0.0.1/32 scram-sha-256\n`).join(''));
    execFileSync(tools.pgCtl, ['reload','-D',path.join(pg.root,'data')], { stdio: 'pipe' });
    const input = request(home); input.postgres.adminUrl = `postgresql://postgres:${secret}@127.0.0.1:${pg.loopbackPort}/noticeos_dev?sslmode=disable`;
    input.artifactRoot = artifact(base);
    // The stack's ntasks service, as preparation and its first start leave it.
    const scenario = generateDemoScenario({ seed: input.seed, cutoff: input.cutoff, release: input.release });
    fs.writeFileSync(path.join(bootstrap, 'request.json'), JSON.stringify(demoNtasksProvisionRequest(scenario)));
    const provisionFile = path.join(bootstrap, 'ntasks-provision.json');
    execFileSync(process.execPath, [path.join(ntasksRoot, 'tools/migrate/src/cli.ts'), 'provision', '--from', path.join(bootstrap, 'request.json'), '--out', provisionFile]);
    const provision = JSON.parse(fs.readFileSync(provisionFile, 'utf8'));
    const wrangler = createRequire(createRequire(new URL('../workers/ingest/package.json', import.meta.url)).resolve('wrangler/package.json'));
    const { Miniflare, Log } = v4Miniflare(wrangler);
    miniflare = new Miniflare({ ...demoNtasksWorker({ bundleRoot: path.join(ntasksRoot, 'dist'), authSecret: randomBytes(32).toString('base64url'),
      workspaceId: scenario.manifest.workspaceId }), host: '127.0.0.1', port: 0, cf: false, resourcePersistencePath: path.join(base, 'ntasks'),
      log: new Log(0), handleStructuredLogs: () => undefined });
    const origin = (await miniflare.ready).origin;
    await applyDemoNtasksProvision(await miniflare.getD1Database('DB'), provision);
    input.ntasks = { origin, provisionFile, toolRoot: ntasksRoot };
    const result = await setupHostedDemo(input); assert.equal(result.created, true);
    const bytes = fs.readFileSync(result.runtimeFile), configuration = readHostedDemoRuntimeFile(result.runtimeFile);
    assert.equal(fs.statSync(result.runtimeFile).mode & 0o777, 0o600); assert.equal(fs.existsSync(path.join(home, '.setup-pending.json')), false);
    assert.equal(configuration.activity.projects.length, 5);
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(bytes.includes(Buffer.from(provision.tokens[DEMO_NTASKS_CREDENTIALS.seed])), false, 'the seed credential stays in the bootstrap volume');
    assert.equal(fs.readdirSync(path.join(home, 'setup-tmp')).length, 0, 'the seed and its token are removed once loaded');
    assert.equal(configuration.workspaceDatabaseUrl.includes('noticeos_app:'), true);
    assert.equal(configuration.activity.grantConnectionString.includes('noticeos_service_grant:'), true);
    const receiptHash = hash(fs.readFileSync(path.join(home, 'setup.json')));
    const reused = await setupHostedDemo({ ...input, release: 'd'.repeat(40) });
    assert.equal(reused.created, false); assert.equal(hash(fs.readFileSync(path.join(home, 'setup.json'))), receiptHash);
    assert.equal(hash(fs.readFileSync(result.runtimeFile)), hash(bytes));
    for (const changed of [{ ...input, publicOrigin: 'https://other.example.test' }, { ...input, ntasks: { ...input.ntasks, origin: 'http://127.0.0.1:1' } }]) {
      await assert.rejects(setupHostedDemo(changed));
    }
    tasks = openDemoTasks(configuration.tasks);
    const catalog = await tasks.handle(new Request(input.publicOrigin + '/api/tasks/projects')); assert.equal(catalog.status, 200);
    const projects = await catalog.json(); assert.ok(JSON.stringify(projects).includes('Light Brief'));
    for (const request of scenario.tasks.filter(task => task.steps)) {
      const projectId = projects.projects.find(project => project.prefix === request.prefix).projectId;
      const reply = await tasks.handle(new Request(input.publicOrigin + '/api/tasks/' + request.id + '?project=' + projectId));
      assert.equal(reply.status, 200);
      assert.deepEqual((await reply.json()).task.steps.map(step => step.text), request.steps.map(step => step.text));
    }
    const denied = await tasks.handle(new Request(input.publicOrigin + '/api/tasks', { method: 'POST', headers: { origin: input.publicOrigin }, body: '{}' }));
    assert.equal(denied.status, 403);
    store = openWorkspaceStore(configuration.workspaceDatabaseUrl, { workspaceId: result.workspaceId });
    const rows = () => store.read(tx => tx.query('SELECT (SELECT count(*)::int FROM noticeos.pulses) AS pulses,(SELECT count(*)::int FROM noticeos.task_snapshots) AS snapshots'));
    const before = await rows();
    assert.ok(before[0].snapshots > 0, 'setup wrote the task history');
    activity = await openHostedDemo({ ...configuration.activity, now: () => Date.parse('2026-10-03T12:00:00Z') });
    const tick = await activity.tick(); assert.equal(tick.days.length, 1); assert.equal(tick.days[0].receipt.state, 'succeeded');
    const after = await rows(); assert.ok(after[0].pulses > before[0].pulses);
  } finally {
    await Promise.allSettled([activity?.close(), tasks?.close(), store?.close()]);
    await miniflare?.dispose();
    if (pg) pg.close();
    if (!pg || !fs.existsSync(path.join(pg.root, 'data/postmaster.pid'))) fs.rmSync(base, { recursive: true, force: true });
  }
});
