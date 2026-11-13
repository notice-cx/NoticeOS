import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureDemoTasks, createDemoTasks } from './demo-tasks.mjs';
import { demoStoreCapability } from './demo-evaluator.mjs';
import { generateDemoScenario } from './demo-scenario.mjs';
import { demoNtasksProjectId, demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { demoTaskHistory } from './demo-task-history.mjs';
import { demoIntegrationAssets, demoSchedules } from './demo-display.mjs';
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
    writeFileSync(path.join(root, 'config/ga4-custom-dimensions.json'), '{"assets":{}}');
    writeFileSync(path.join(root, 'config/serp-panel.json'), '{"assets":{}}');
    const constants = JSON.parse(readFileSync(new URL('../packages/contract/test/fixture-config/constants.json', import.meta.url), 'utf8'));
    if (defect !== 'missing-constants') writeFileSync(path.join(root, 'config/constants.json'), JSON.stringify(constants));
    const installation = path.join(home, 'installation');
    if (defect === 'existing-export') { mkdirSync(installation); writeFileSync(path.join(installation, 'beads.json'), 'unchanged'); }
    let seeded = null; const calls = [];
    const helpers = {
      getConfigDocuments: async () => {
        calls.push('read');
        return ['config/beads.json', 'config/integrations.json', 'config/constants.json', 'config/ga4-custom-dimensions.json', 'config/serp-panel.json'].map(file => {
          const held = seeded || defect === 'held-config' || (defect === 'held-constants' && file.endsWith('constants.json'));
          return { file, version: held ? 1 : null, source: held ? 'store' : 'file', body: seeded?.[file] ?? (file.endsWith('beads.json') ? { spokes: [] } : file.endsWith('constants.json') ? constants : { assets: {} }) };
        });
      },
      seedConfigDocuments: async (_capability, input) => {
        calls.push('seed'); assert.equal(input.actor, 'synthetic-demo-seeder');
        // Only the sources the scenario collects are declared, from each site's first day.
        assert.deepEqual(input.documents['config/integrations.json'].assets, demoIntegrationAssets(scenario));
        // Every catalog source is declared on every site: collected, wanted,
        // skipped with its reason, or not applicable; the OS declares its own.
        for (const asset of scenario.assets) {
          const lanes = input.documents['config/integrations.json'].assets[asset.id];
          assert.deepEqual(Object.keys(lanes).sort(), asset.isOs ? ['discord-webhooks', 'github-app', 'uptime']
            : ['ad-network', 'affiliate-amazon', 'affiliate-cj', 'bing-webmaster', 'clarity', 'dataforseo', 'deploy-annotations', 'ga4', 'github-app', 'gsc', 'posthog', 'uptime']);
          assert.ok(Object.values(lanes).every(lane => lane.status !== 'skipped' || /reason/iu.test(lane.note)));
          if (!asset.isOs) assert.equal(lanes['ad-network'].status, asset.adRpm ? 'live' : 'not-applicable');
        }
        // The source inventory's other two documents are saved at their defaults.
        assert.deepEqual(input.documents['config/ga4-custom-dimensions.json'], { assets: {} });
        assert.deepEqual(input.documents['config/serp-panel.json'], { assets: {} });
        assert.deepEqual(input.documents['config/beads.json'].spokes, []);
        // The schedule reader needs this physical generic document. Copying it
        // into the store adds only the demo's saved run times; measurement
        // thresholds are unchanged.
        assert.deepEqual(input.documents['config/constants.json'], { ...constants, schedules: demoSchedules() });
        assert.deepEqual(input.documents['config/constants.json'].flag_defaults, constants.flag_defaults);
        seeded = input.documents; return { ok: true, skipped: [], seeded: Object.keys(input.documents).map(file => ({ file, version: 1 })) };
      },
      applyConfigOps: async (_capability, input) => {
        calls.push('apply'); assert.deepEqual(input.expectVersions, { 'config/beads.json': 1 });
        validateSchemaAndSafety({ version: 1, slug: input.slug, createdAt: scenario.manifest.cutoff, ops: input.ops });
        assert.deepEqual(input.ops.map(op => op.value), scenario.manifest.taskProjects);
        return defect === 'stale' ? { ok: false, error: 'version_mismatch' } : { ok: true, applied: scenario.manifest.taskProjects.length, documents: [{ file: 'config/beads.json', version: 2, body: { spokes: scenario.manifest.taskProjects } }] };
      },
    };
    const receipt = { projects: scenario.manifest.taskProjects.map(project => ({ ...project, projectId: demoNtasksProjectId(scenario.manifest.workspaceId, project.prefix) })) };
    const execute = () => configureDemoTasks({ plan: { root, home, installation }, scenario, receipt, capability: {}, helpers });
    if (defect) {
      await assert.rejects(execute());
      assert.equal(existsSync(path.join(installation, 'task-host.json')), false);
      if (['held-config', 'held-constants', 'missing-constants'].includes(defect)) assert.deepEqual(calls, ['read']);
      if (defect === 'existing-export') { assert.deepEqual(calls, []); assert.equal(readFileSync(path.join(installation, 'beads.json'), 'utf8'), 'unchanged'); }
    } else {
      await assert.rejects(readStoredSchedules(async () => ({ status: 200, body: { ready: true, documents: [] } })), /Saved schedules could not be read/);
      await execute(); assert.deepEqual(calls, ['read', 'seed', 'read', 'apply']);
      assert.deepEqual(await readStoredSchedules(async () => ({ status: 200, body: { ready: true, documents: await helpers.getConfigDocuments() } })), demoSchedules());
      assert.equal(existsSync(path.join(installation, 'task-host.json')), false);
      assert.deepEqual(JSON.parse(readFileSync(path.join(installation, 'beads.json'), 'utf8')).spokes, scenario.manifest.taskProjects);
    }
  }
});
test('the task history is the Ntasks seed\'s daily snapshots, written through the released writer, with each project\'s demo Ntasks id', async t => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'noticeos-demo-tasks-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const written = [];
  const writeSnapshot = async (_capability, snapshot, nowMs) => { written.push({ snapshot, nowMs }); return { ok: true }; };
  const story = scenario.manifest.stories.problem;
  const joins = [{ task: story.ref, asset: story.asset, rule: 'poisson-drop', key: '37' }];
  const receipt = await createDemoTasks({ plan: { home }, scenario, createdPostgres: { created: true, schema: {} }, capability: { STORE: {} }, writeSnapshot, joins });
  const history = demoTaskHistory(demoNtasksSeed(scenario, joins), scenario);
  assert.deepEqual(written.map(entry => entry.snapshot), history);
  assert.deepEqual(written.map(entry => entry.nowMs), history.map(snapshot => Date.parse(snapshot.capturedAt)));
  assert.deepEqual(receipt.projects, scenario.manifest.taskProjects.map(project => ({ ...project, projectId: demoNtasksProjectId(scenario.manifest.workspaceId, project.prefix) })));
  assert.equal(receipt.snapshots, history.length);
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, 'demo-tasks.json'), 'utf8')), receipt);
});
test('task custody refuses an unproven store, an existing receipt, a linked folder or a refused snapshot', async t => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'noticeos-demo-tasks-boundary-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const good = { created: true, schema: { frozenSha256: 'a'.repeat(64) } };
  for (const defect of ['missing-proof', 'receipt', 'link', 'refused']) {
    const home = path.join(base, defect); mkdirSync(home);
    if (defect === 'receipt') writeFileSync(path.join(home, 'demo-tasks.json'), 'held');
    const target = defect === 'link' ? path.join(base, 'linked-home') : home;
    if (defect === 'link') symlinkSync(home, target);
    let writes = 0;
    const writeSnapshot = async () => { writes++; return { ok: defect !== 'refused' }; };
    await assert.rejects(createDemoTasks({ plan: { home: target }, scenario, createdPostgres: defect === 'missing-proof' ? { created: false } : good, capability: { STORE: {} }, writeSnapshot }));
    assert.equal(writes, defect === 'refused' ? 1 : 0, defect);
    if (defect !== 'receipt') assert.equal(existsSync(path.join(home, 'demo-tasks.json')), false, defect);
  }
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
