import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { generateDemoDisplay } from './demo-display.mjs';
import { startDoltPlan } from './dolt-profile.mjs';
import { readDemoViewerInstallation, readDemoViewerLaunch } from './demo-viewer-installation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const release = '1'.repeat(40), tree = '2'.repeat(40), artifact = '3'.repeat(64);
const completedAt = '2025-10-17T12:00:00.000Z';
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-demo-viewer-custody-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'public'), home = path.join(base, 'synthetic');
  fs.mkdirSync(root); fs.mkdirSync(home, { mode: 0o700 });
  const write = (relative, value) => {
    const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const publicWrite = (relative, bytes) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  publicWrite('db/postgres/frozen-migrations.sha256', 'held public marker\n');
  publicWrite('workers/ingest/src/watch-windows.ts', 'export {};\n');
  const scenario = generateDemoScenario({ seed: 'viewer-custody', cutoff: '2025-10-16T12:00:00.000Z', release });
  const profile = startDoltPlan({ root, home, port: 6200 });
  const projects = scenario.manifest.taskProjects.map(project => {
    const repo = path.join(home, 'tasks', project.prefix); fs.mkdirSync(repo, { recursive: true }); return { ...project, repo };
  });
  write('dolt/profile.json', profile); write('dolt/secrets/root', `${'a'.repeat(64)}\n`);
  write('dolt/secrets/noticeos', `${'b'.repeat(64)}\n`); write('dolt/credentials', `[127.0.0.1:${profile.port}]\npassword=${'b'.repeat(64)}\n`);
  write('postgres/secrets/database.url', `postgresql://noticeos_app:own-synthetic-value@127.0.0.1:6202/noticeos?sslmode=disable\n`);
  write('installation/task-host.json', { version: 1, repositories: projects });
  write('installation/beads.json', { spokes: scenario.manifest.taskProjects });
  write('installation/integrations.json', { assets: Object.fromEntries(scenario.assets.map(asset => [asset.id, {}])) });
  const evaluator = { release, tree, artifacts: { 'rules.js': artifact, 'poisson.js': artifact }, workers: {
    compiler: 'synthetic-proof', inputs: { 'workers/ingest/src/watch-windows.ts': sha('export {};\n') }, artifacts: { watch: artifact, snapshots: artifact, configuration: artifact, jobs: artifact, reports: artifact } } };
  const tasks = { version: 1, synthetic: true, release, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId,
    project: profile.project, projects, tasks: scenario.tasks.length, snapshots: 400, client: { version: '1.3.1', sha256: artifact } };
  const manifest = { ...scenario.manifest, home, scenarioHash: tasks.scenarioHash, evaluator, schema: { frozenSha256: sha('held public marker\n') },
    counts: { tasks: tasks.tasks, taskSnapshots: 400, watchStatus: 'closed', pulses: scenario.pulses.length + 1 }, taskGeneration: tasks, postgresProject: profile.project,
    workflowHistory: { version: 1, synthetic: true, scenarioHash: tasks.scenarioHash, files: {
      '.local/logs/job-runs.jsonl': sha('{}\n'), '.local/logs/workflow-runs.jsonl': sha('{}\n') }, mirror: { ok: true, created: 7, duplicate: 0, stale: 0, pruned: 0 } } };
  const display = generateDemoDisplay(scenario);
  manifest.display = { files: Object.keys(display), documents: display };
  for (const [file, body] of Object.entries(display)) write(`installation/${path.basename(file)}`, body);
  const observed = ['pulsesReceived', 'ledgerRows', 'openFlagsError', 'openFlagsWarn', 'openFlagsInfo'];
  manifest.osReport = { synthetic: true, generatedAt: scenario.manifest.cutoff, asset: scenario.assets.find(asset => asset.isOs).id, capabilities: observed,
    metrics: Object.fromEntries(observed.map(metric => [metric, { last24h: 0, avg7d: 0, total: 0 }])) };
  write('.local/logs/job-runs.jsonl', '{}\n'); write('.local/logs/workflow-runs.jsonl', '{}\n');
  const seal = () => {
    write('demo-manifest.json', manifest); write('demo-tasks.json', tasks);
    write('demo-generation.json', { version: 1, synthetic: true, completedAt, release, tree, scenarioHash: tasks.scenarioHash,
      workspaceId: tasks.workspaceId, manifestSha256: sha(fs.readFileSync(path.join(home, 'demo-manifest.json'))),
      tasksSha256: sha(fs.readFileSync(path.join(home, 'demo-tasks.json'))), evaluator });
  };
  seal();
  const input = { root, home, release, tree, now: Date.parse('2025-10-18T12:00:00.000Z') };
  return { ...input, input, write, publicWrite, seal, scenario, manifest, tasks, evaluator, profile };
}

test('a completed generation gives one immutable descriptor and exact owned read targets without secret contents', t => {
  const f = fixture(t), result = readDemoViewerInstallation(f.input);
  assert.equal(result.viewer.generatedAt, completedAt); assert.notEqual(result.viewer.generatedAt, f.scenario.manifest.cutoff);
  assert.equal(result.postgresPort, 6202); assert.equal(result.dolt.port, 6203);
  assert.deepEqual(result.projects, f.tasks.projects);
  for (const value of [result, result.viewer, result.dolt, result.projects, ...result.projects, result.assetIds,
    result.display, ...Object.values(result.display), result.display['config/tower.json'].wall.layout,
    result.display['config/counters.json'].assets]) assert.equal(Object.isFrozen(value), true);
  assert.doesNotMatch(JSON.stringify(result), /own-synthetic-value|password=/u);
});
test('partial, altered, future or cross-release completion refuses without inventing a generation age', t => {
  const f = fixture(t); const file = path.join(f.home, 'demo-generation.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const edit of [{ completedAt: null }, { completedAt: '9999-10-17T12:00:00.000Z' }, { completedAt: '2024-10-17T12:00:00.000Z' },
    { tree: '4'.repeat(40) }, { release: '4'.repeat(40) }, { synthetic: false }, { manifestSha256: artifact }, { tasksSha256: artifact }, { extra: true }]) {
    f.write('demo-generation.json', { ...original, ...edit }); assert.throws(() => readDemoViewerInstallation(f.input));
  }
  fs.rmSync(file); assert.throws(() => readDemoViewerInstallation(f.input));
});
test('even resealed files cannot change scenario, component completion, task paths or provider roster', t => {
  for (const defect of ['scenario', 'count', 'watch', 'repo', 'profile', 'address', 'provider', 'evaluator', 'workflow', 'display', 'report', 'report-count', 'reports-artifact']) {
    const f = fixture(t);
    if (defect === 'scenario') f.manifest.identities = [];
    if (defect === 'count') f.manifest.counts.tasks++;
    if (defect === 'watch') f.manifest.counts.watchStatus = 'open';
    if (defect === 'repo') f.tasks.projects[0].repo = f.root;
    if (defect === 'profile') f.write('dolt/profile.json', { ...f.profile, composeFile: path.join(f.root, 'other.yaml') });
    if (defect === 'address') f.write('postgres/secrets/database.url', 'postgresql://noticeos_app:fixture@127.0.0.1:5432/noticeos?sslmode=disable');
    if (defect === 'provider') f.write('installation/integrations.json', { assets: { 'example.com': { provider: 'connected' } } });
    if (defect === 'evaluator') f.evaluator.workers.inputs['workers/ingest/src/watch-windows.ts'] = artifact;
    if (defect === 'workflow') f.write('.local/logs/workflow-runs.jsonl', 'changed\n');
    if (defect === 'display') f.write('installation/tower.json', { wall: null });
    if (defect === 'report') f.manifest.osReport.capabilities.push('cronRunSuccess');
    if (defect === 'report-count') f.manifest.counts.pulses--;
    if (defect === 'reports-artifact') delete f.evaluator.workers.artifacts.reports;
    f.seal(); assert.throws(() => readDemoViewerInstallation(f.input), undefined, defect);
  }
});
test('source marker changes, permissive custody, aliases, oversized files and symbolic task repos refuse', t => {
  for (const defect of ['marker', 'mode', 'alias', 'size', 'repo']) {
    const f = fixture(t);
    if (defect === 'marker') f.publicWrite('db/postgres/frozen-migrations.sha256', 'another marker');
    if (defect === 'mode') fs.chmodSync(path.join(f.home, 'demo-generation.json'), 0o644);
    if (defect === 'alias') { const target = path.join(f.home, 'demo-generation.json'); fs.renameSync(target, target + '.held'); fs.symlinkSync(target + '.held', target); }
    if (defect === 'size') f.write('demo-generation.json', ' '.repeat(2 * 1024 * 1024 + 1));
    if (defect === 'repo') { const repo = f.tasks.projects[0].repo; fs.rmSync(repo, { recursive: true }); fs.symlinkSync(f.root, repo); }
    assert.throws(() => readDemoViewerInstallation(f.input), undefined, defect);
  }
});

test('ordinary configuration has no custody reads; declared demo config binds every runtime selector', t => {
  assert.equal(readDemoViewerLaunch('/nonexistent-public-root', {}), null);
  const f = fixture(t), installation = readDemoViewerInstallation(f.input);
  const viewers = path.join(f.home, 'viewers'); fs.mkdirSync(viewers, { mode: 0o700 });
  const runtime = fs.mkdtempSync(path.join(viewers, 'viewer-'));
  const file = path.join(runtime, 'viewer.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, root: f.root, home: f.home, tree, viewer: installation.viewer,
    runtime, towerPort: 6200, doorPort: 6201 }), { mode: 0o600 });
  const env = { NOTICEOS_DEMO_VIEWER_FILE: file, NOTICEOS_HOME: f.home, NOTICEOS_DOLT_HOME: f.home,
    NOTICEOS_INSTALLATION_DIR: path.join(f.home, 'installation'), NOTICEOS_WORKER_CONFIG_ROOT: runtime,
    OS_UP_PERSIST_STATE: path.join(runtime, 'state'), OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: '6201',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES: fs.readFileSync(installation.databaseFile, 'utf8').trim() };
  const accepted = readDemoViewerLaunch(f.root, env);
  assert.equal(accepted.towerPort, 6200); assert.deepEqual(accepted.installation.viewer, installation.viewer);
  for (const [key, value] of [['NOTICEOS_HOME', f.root], ['NOTICEOS_DOLT_HOME', f.root], ['OS_UP_INGEST_DOOR_PORT', '8791'],
    ['OS_UP_INGEST_DOOR_HOST', '0.0.0.0'], ['OS_UP_PERSIST_STATE', f.root], ['NOTICEOS_WORKER_CONFIG_ROOT', f.root],
    ['CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES', 'another'], ['CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'true'],
    ['CLOUDFLARE_API_TOKEN', 'another'], ['NODE_OPTIONS', 'another']]) {
    assert.throws(() => readDemoViewerLaunch(f.root, { ...env, [key]: value }), /runtime bindings/u);
  }
});
