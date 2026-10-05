import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureDemoTasks, createDemoTasks, demoHandoffIssues, demoHistoricalProject } from './demo-tasks.mjs';
import { demoStoreCapability } from './demo-evaluator.mjs';
import { generateDemoScenario } from './demo-scenario.mjs';
import { demoTaskIssuesAt } from './demo-task-facts.mjs';
import { validateSchemaAndSafety } from './config-documents.mjs';
import { readStoredSchedules } from './scheduled-job-runner.mjs';

const scenario = generateDemoScenario({ seed: 'task-boundary', cutoff: '2025-10-16T12:00:00.000Z', release: '1'.repeat(40) });

test('the own project map uses the ordinary register apply and version guard; failures cannot create host exports', async t => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'noticeos-demo-config-boundary-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const defect of [null, 'held-config', 'held-constants', 'missing-constants', 'stale', 'existing-export']) {
    const home = path.join(base, defect ?? 'valid'); mkdirSync(home);
    const root = path.join(home, 'public'); mkdirSync(root); mkdirSync(path.join(root, 'config'));
    writeFileSync(path.join(root, 'config/beads.json'), '{"spokes":[]}');
    writeFileSync(path.join(root, 'config/integrations.json'), '{"assets":{}}');
    const constants = JSON.parse(readFileSync(new URL('../packages/contract/test/fixture-config/constants.json', import.meta.url), 'utf8'));
    if (defect !== 'missing-constants') writeFileSync(path.join(root, 'config/constants.json'), JSON.stringify(constants));
    const installation = path.join(home, 'installation');
    if (defect === 'existing-export') { mkdirSync(installation); writeFileSync(path.join(installation, 'beads.json'), 'unchanged'); }
    let seeded = false; const calls = [];
    const helpers = {
      getConfigDocuments: async () => {
        calls.push('read');
        return ['config/beads.json', 'config/integrations.json', 'config/constants.json'].map(file => {
          const held = seeded || defect === 'held-config' || (defect === 'held-constants' && file.endsWith('constants.json'));
          return { file, version: held ? 1 : null, source: held ? 'store' : 'file', body: file.endsWith('beads.json') ? { spokes: [] } : file.endsWith('constants.json') ? constants : { assets: {} } };
        });
      },
      seedConfigDocuments: async (_capability, input) => {
        calls.push('seed'); assert.equal(input.actor, 'synthetic-demo-seeder');
        assert.deepEqual(Object.keys(input.documents['config/integrations.json'].assets), scenario.assets.map(asset => asset.id));
        assert.deepEqual(input.documents['config/beads.json'].spokes, []);
        // The schedule reader needs this physical generic document. Copying it
        // into the store must not rewrite schedules or measurement thresholds.
        assert.deepEqual(input.documents['config/constants.json'], constants);
        seeded = true; return { ok: true, skipped: [], seeded: Object.keys(input.documents).map(file => ({ file, version: 1 })) };
      },
      applyConfigOps: async (_capability, input) => {
        calls.push('apply'); assert.deepEqual(input.expectVersions, { 'config/beads.json': 1 });
        validateSchemaAndSafety({ version: 1, slug: input.slug, createdAt: scenario.manifest.cutoff, ops: input.ops });
        assert.deepEqual(input.ops.map(op => op.value), scenario.manifest.taskProjects);
        return defect === 'stale' ? { ok: false, error: 'version_mismatch' } : { ok: true, applied: 4, documents: [{ file: 'config/beads.json', version: 2, body: { spokes: scenario.manifest.taskProjects } }] };
      },
    };
    const receipt = { projects: scenario.manifest.taskProjects.map(project => ({ ...project, repo: path.join(home, 'tasks', project.prefix) })) };
    const execute = () => configureDemoTasks({ plan: { root, home, installation }, scenario, receipt, capability: {}, helpers });
    if (defect) {
      await assert.rejects(execute());
      assert.equal(existsSync(path.join(installation, 'task-host.json')), false);
      if (['held-config', 'held-constants', 'missing-constants'].includes(defect)) assert.deepEqual(calls, ['read']);
      if (defect === 'existing-export') { assert.deepEqual(calls, []); assert.equal(readFileSync(path.join(installation, 'beads.json'), 'utf8'), 'unchanged'); }
    } else {
      await assert.rejects(readStoredSchedules(async () => ({ status: 200, body: { ready: true, documents: [] } })), /Saved schedules could not be read/);
      await execute(); assert.deepEqual(calls, ['read', 'seed', 'read', 'apply']);
      assert.deepEqual(await readStoredSchedules(async () => ({ status: 200, body: { ready: true, documents: await helpers.getConfigDocuments() } })), constants.schedules ?? null);
      assert.deepEqual(JSON.parse(readFileSync(path.join(installation, 'task-host.json'), 'utf8')).repositories, receipt.projects);
      assert.deepEqual(JSON.parse(readFileSync(path.join(installation, 'beads.json'), 'utf8')).spokes, scenario.manifest.taskProjects);
    }
  }
});
test('task custody cannot adopt prior task folders, symlinks or an unproven store', async t => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'noticeos-demo-tasks-boundary-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  let effects = 0;
  const options = { check: async () => { effects++; throw new Error('Unexpected executable probe'); } };
  const good = { created: true, schema: { frozenSha256: 'a'.repeat(64) } };
  for (const defect of ['missing-proof', 'existing-tasks', 'existing-dolt', 'receipt', 'link']) {
    const home = path.join(base, defect); mkdirSync(home);
    if (defect === 'existing-tasks') mkdirSync(path.join(home, 'tasks'));
    if (defect === 'existing-dolt') mkdirSync(path.join(home, 'dolt'));
    if (defect === 'receipt') writeFileSync(path.join(home, 'demo-tasks.json'), 'held');
    const target = defect === 'link' ? path.join(base, 'linked-home') : home;
    if (defect === 'link') symlinkSync(home, target);
    await assert.rejects(createDemoTasks({ plan: { home: target }, scenario, createdPostgres: defect === 'missing-proof' ? { created: false } : good, capability: { STORE: {} }, writeSnapshot: async () => {}, env: {} }, options));
  }
  assert.equal(effects, 0);
});

test('the demo capability exposes only the exact application workspace and refuses every other binding', async () => {
  const calls = [];
  const store = { inWorkspace: async (workspace, work, options) => { calls.push({ workspace, options }); return work({ own: true }); } };
  const capability = demoStoreCapability(store, scenario.manifest.workspaceId);
  assert.equal(await capability.STORE.workspaceId(), scenario.manifest.workspaceId);
  assert.match(capability.STORE.where, /^synthetic-demo:[a-f0-9-]{36}$/u);
  assert.notEqual(demoStoreCapability(store, scenario.manifest.workspaceId).STORE.where, capability.STORE.where);
  assert.equal(await capability.STORE.read(tx => tx.own), true);
  assert.equal(await capability.STORE.write(tx => tx.own), true);
  assert.deepEqual(calls, [{ workspace: scenario.manifest.workspaceId, options: { readOnly: true } }, { workspace: scenario.manifest.workspaceId, options: undefined }]);
  for (const binding of ['POSTGRES', 'SIGNAL_RAW', 'INGEST', 'OPERATOR_API_TOKEN', 'DATABASE_URL']) assert.throws(() => capability[binding], /Unexpected demo binding/u);
});

test('handoff identity uses the real public flag key without changing other tasks or dependencies', () => {
  const rows = demoTaskIssuesAt(scenario.tasks, scenario.manifest.cutoff);
  const story = scenario.manifest.stories.problem;
  const output = demoHandoffIssues(rows, [{ task: story.ref, asset: story.asset, rule: 'poisson-drop', key: '37' }]);
  const task = output.find(row => row.id === story.ref);
  assert.equal(task.metadata.noticeos_key, '37');
  assert.equal(task.metadata.noticeos_kind, 'alert');
  assert.equal(task.metadata.noticeos_asset, story.asset);
  assert.ok(task.labels.includes('noticeos-handoff'));
  assert.deepEqual(task.dependencies, rows.find(row => row.id === story.ref).dependencies);
  assert.deepEqual(output.filter(row => row.id !== story.ref), rows.filter(row => row.id !== story.ref));
});

test('historical summaries window actual closed timestamps while preserving native blocker and epic semantics', () => {
  const result = rows => ({ code: 0, stdout: JSON.stringify(rows) });
  const epic = { id: 'gw-epic', title: 'Operating work', issue_type: 'epic', status: 'open', priority: 2 };
  const work = { id: 'gw-work', title: 'Ready work', issue_type: 'task', status: 'open', priority: 1 };
  const gate = { id: 'gw-gate', title: 'Approve headings', issue_type: 'gate', await_type: 'human', status: 'open', priority: 2 };
  const parked = { id: 'gw-parked', title: 'Parked work', issue_type: 'task', status: 'deferred', priority: 2 };
  const reads = { active: result([epic, work]), ready: result([epic, work]), blocked: result([]), closed: result([
    { ...work, id: 'gw-old', status: 'closed', closed_at: '2025-09-01T12:00:00Z' },
    { ...work, id: 'gw-recent', status: 'closed', closed_at: '2025-10-15T12:00:00Z' },
  ]), epics: result([]), human: result([]), gates: result([gate]), deferred: result([parked]) };
  const project = demoHistoricalProject({ asset: scenario.assets[0].id, prefix: 'gw' }, reads, scenario.manifest.cutoff);
  assert.equal(project.ok, true);
  assert.deepEqual(project.counts, { open: 1, highPriority: 1, ready: 1, inProgress: 0, blocked: 0, closedRecent: 1, deferred: 1, waiting: 1 });
  assert.equal(project.waitingUrgent, 1);
  assert.deepEqual(project.recentlyClosed.map(row => row.id), ['gw-recent']);
  assert.deepEqual(JSON.parse(reads.closed.stdout).map(row => row.id), ['gw-old', 'gw-recent']);
});
