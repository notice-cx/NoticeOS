import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { captureHostedDemoSetupRequest, readHostedDemoSetupRequest, setupHostedDemo } from './hosted-demo-setup.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { prepareFreshDolt, startDoltPlan, doltComposeArgs, readDoltCredentials } from './dolt-host.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { runCommand } from './run-command.mjs';
import { openHostedTaskRuntime } from './hosted-task-runtime.mjs';
import { openHostedDemo } from './hosted-demo-runtime.mjs';
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
    dolt: { host: '127.0.0.1', port: 13383, adminUser: 'noticeos_owner', adminPassword: randomBytes(32).toString('hex'), tls: false },
    binary: { path: '/not-a-tool/bd', sha256: 'b'.repeat(64) }, doltBinary: { path: '/not-a-tool/dolt', sha256: 'c'.repeat(64) } };
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
  const held = captureHostedDemoSetupRequest(input); input.dolt.port = 3308;
  assert.equal(held.dolt.port, 13383);
  for (const changed of [
    { ...held, unknown: true }, { ...held, publicOrigin: 'http://demo.example.test' },
    { ...held, workerStateRoot: '/other-state' }, { ...held, postgres: { adminUrl: 'postgresql://postgres@db.example.test/noticeos?sslmode=disable' } },
    { ...held, dolt: { ...held.dolt, host: 'dolt.example.test' } },
    { ...held, serviceExpiresAt: new Date(Date.now() + 400 * 86400000).toISOString() },
  ]) assert.throws(() => captureHostedDemoSetupRequest(changed));
});
test('foreign/partial/nonprivate state and unsafe request files refuse before tool/database work', async () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'n-setup-refusal-'));
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
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'n-setup-phase-'));
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
    assert.equal(result.stderr.includes(input.dolt.adminPassword), false);
    assert.equal(result.stderr.includes(input.postgres.adminUrl), false);
    assert.deepEqual(fs.readdirSync(home).sort(), ['.setup-pending.json','runtime','scratch','setup-home','setup-tmp','tasks']);
  } finally { fs.rmSync(own, { recursive: true, force: true }); }
});

test('durable task receipt lets the ordinary workflow writer proceed and cannot be overwritten', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'n-demo-receipt-'));
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

test('fresh PostgreSQL18 and Dolt create the complete scoped demo, reuse without reseed, and power real readers/activity', {
  skip: process.env.NOTICEOS_TEST_HOSTED_DEMO_SETUP !== '1', timeout: 780000,
}, async t => {
  const evidence = process.env.NOTICEOS_TEST_HOSTED_TASK_EVIDENCE;
  assert.ok(path.isAbsolute(evidence ?? ''));
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'n-demo-setup-'));
  fs.chmodSync(base, 0o700);
  const disk = fs.statfsSync(base); assert.ok(disk.bavail * disk.bsize >= 8 * 1024 ** 3 + 1024 ** 3);
  const home = path.join(base, 'state'), hub = path.join(base, 'hub');
  for (const dir of ['home','tmp','docker-config','cleanup']) fs.mkdirSync(path.join(base, dir), { mode: 0o700 });
  const profile = startDoltPlan({ root, home: hub, port: 13380 }), compose = doltComposeArgs(profile);
  const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), TMPDIR: path.join(base, 'tmp'),
    DOCKER_CONFIG: path.join(base, 'docker-config'), DOCKER_HOST: process.env.DOCKER_HOST,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1' };
  const docker = async (args, options = {}) => runCommand('docker', args.includes('up') ? [...args, '--pull', 'never'] : args,
    { env, timeoutMs: 30000, ...options });
  let pg, cleanup, fresh = false, tasks, activity, store;
  const proof = { freeBefore: disk.bavail * disk.bsize, expectedPeakAdditionalBytes: 1024 ** 3, base, stages: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'setup-proof.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  try {
    save(); cleanup = containerProofCleanup({ base: path.join(base, 'cleanup'), project: profile.project, image: '', mounts: [], runDocker: docker });
    await cleanup.proveFresh();
    const absent = await docker(['volume','inspect',`${profile.project}_dolt-data`]); assert.notEqual(absent.code, 0); assert.match(absent.stderr, /no such volume/iu);
    fresh = true;
    const tools = findPostgres(); pg = await openOnLoopbackPort(path.join(base, 'pg'), tools);
    const secret = randomBytes(32).toString('hex'); pg.onDatabase('postgres').run(`ALTER ROLE postgres PASSWORD '${secret}';`);
    fs.appendFileSync(path.join(pg.root, LOOPBACK_HBA), 'host all postgres 127.0.0.1/32 scram-sha-256\n' +
      ['noticeos_app','noticeos_identity','noticeos_platform','noticeos_task_directory','noticeos_service_grant'].map(role => `host all ${role} 127.0.0.1/32 scram-sha-256\n`).join(''));
    execFileSync(tools.pgCtl, ['reload','-D',path.join(pg.root,'data')], { stdio: 'pipe' });
    const started = await prepareFreshDolt({ root, home: hub, port: 13380 }, { fresh: true, env, run: (_binary,args,options) => docker(args, options) });
    assert.equal(started.ok, true, started.line);
    const input = request(home); input.postgres.adminUrl = `postgresql://postgres:${secret}@127.0.0.1:${pg.loopbackPort}/noticeos_dev?sslmode=disable`;
    input.artifactRoot = artifact(base);
    input.dolt.port = profile.port;
    input.dolt.adminPassword = readDoltCredentials(profile).root.trim();
    input.binary = { path: process.env.NOTICEOS_TEST_BEADS_NEW_BIN, sha256: process.env.NOTICEOS_TEST_BEADS_SHA256 };
    input.doltBinary = { path: process.env.NOTICEOS_TEST_DOLT_CLIENT_BIN, sha256: process.env.NOTICEOS_TEST_DOLT_CLIENT_SHA256 };
    const result = await setupHostedDemo(input); assert.equal(result.created, true);
    const bytes = fs.readFileSync(result.runtimeFile), configuration = JSON.parse(bytes);
    assert.equal(fs.statSync(result.runtimeFile).mode & 0o777, 0o600); assert.equal(fs.existsSync(path.join(home, '.setup-pending.json')), false);
    assert.equal(configuration.tasks.targets.length, 4); assert.equal(configuration.activity.projects.length, 3);
    assert.equal(bytes.includes(Buffer.from(secret)), false); assert.equal(bytes.includes(Buffer.from(input.dolt.adminPassword)), false);
    assert.equal(configuration.workspaceDatabaseUrl.includes('noticeos_app:'), true);
    assert.equal(configuration.activity.grantConnectionString.includes('noticeos_service_grant:'), true);
    const receiptHash = hash(fs.readFileSync(path.join(home, 'setup.json')));
    const reused = await setupHostedDemo({ ...input, release: 'd'.repeat(40) });
    assert.equal(reused.created, false); assert.equal(hash(fs.readFileSync(path.join(home, 'setup.json'))), receiptHash);
    assert.equal(hash(fs.readFileSync(result.runtimeFile)), hash(bytes));
    for (const changed of [{ ...input, publicOrigin: 'https://other.example.test' }, { ...input, binary: { ...input.binary, sha256: 'f'.repeat(64) } }]) {
      await assert.rejects(setupHostedDemo(changed));
    }
    proof.stages.push('fresh-schema-scenario-scoped-identities','repeat-no-reseed','changed-topology-refused'); save();
    tasks = await openHostedTaskRuntime(configuration.tasks);
    const catalog = await tasks.handle(new Request(input.publicOrigin + '/api/tasks/projects')); assert.equal(catalog.status, 200);
    const projects = await catalog.json(); assert.ok(JSON.stringify(projects).includes('Light Brief'));
    const denied = await tasks.handle(new Request(input.publicOrigin + '/api/tasks', { method: 'POST', headers: { origin: input.publicOrigin }, body: '{}' })); assert.ok(denied.status >= 400);
    store = openWorkspaceStore(configuration.workspaceDatabaseUrl, { workspaceId: result.workspaceId });
    const rows = () => store.read(tx => tx.query('SELECT (SELECT count(*)::int FROM noticeos.pulses) AS pulses,(SELECT count(*)::int FROM noticeos.task_snapshots) AS snapshots'));
    const before = await rows();
    activity = await openHostedDemo({ ...configuration.activity, now: () => Date.parse('2026-10-03T12:00:00Z') });
    const tick = await activity.tick(); assert.equal(tick.days.length, 1); assert.equal(tick.days[0].receipt.state, 'succeeded');
    const after = await rows(); assert.ok(after[0].pulses > before[0].pulses);
    proof.stages.push('real-task-catalog-read','visitor-write-refused','ordinary-simulator-tick-succeeded'); save();
  } finally {
    await Promise.allSettled([activity?.close(), tasks?.close(), store?.close()]);
    if (pg) pg.close();
    if (cleanup && fresh) { proof.cleanup = await cleanup.finish([() => docker([...compose,'down','--volumes'], { timeoutMs: 90000 })]); }
    save();
    if ((!fresh || proof.cleanup?.complete) && (!pg || !fs.existsSync(path.join(pg.root, 'data/postmaster.pid')))) {
      fs.rmSync(base, { recursive: true, force: true }); proof.ownedFixtureAbsent = !fs.existsSync(base); save();
    }
  }
});
