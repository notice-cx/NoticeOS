import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateDemoScenario, demoScenarioHash } from './demo-scenario.mjs';
import { generateDemoWorkflows, writeDemoWorkflowHistory } from './demo-workflows.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { isWorkflowStepOutput } from './workflow-output.mjs';

function fixture(cutoff = '2026-09-15T12:00:00.000Z') {
  const scenario = generateDemoScenario({ seed: 'workflow-proof', cutoff, release: '1'.repeat(40) });
  const tasks = { synthetic: true, scenarioHash: demoScenarioHash(scenario), workspaceId: scenario.manifest.workspaceId, release: scenario.manifest.release,
    projects: scenario.assets.map(asset => ({ asset: asset.id })), tasks: 38, snapshots: 401 };
  const watch = { evaluatedAt: scenario.manifest.stories.repair.checkAt,
    result: { readings: 0, closed: [{ id: scenario.manifest.stories.repair.watchId, outcome: 'ship_confirmed' }], failed: [] },
    reading: { outcome: 'ship_confirmed', checked_at: scenario.manifest.stories.repair.checkAt, baseline: '{"days":28}', post: '{"days":28}' } };
  return { scenario, tasks, watch };
}

test('finished traces, coarse runs and the original missing report stay consistent at calendar boundaries', () => {
  for (const cutoff of ['2026-09-15T12:00:00.000Z', '2026-10-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z']) {
    const inputs = fixture(cutoff); const before = JSON.stringify(inputs.scenario);
    const history = generateDemoWorkflows(inputs);
    assert.deepEqual(generateDemoWorkflows(inputs), history);
    assert.equal(history.traces.length, 4);
    assert.equal(history.records.length, 4);
    assert.equal(history.runs.length, 4);
    for (const [index, trace] of history.traces.entries()) {
      const record = history.records[index]; const run = history.runs[index];
      assert.equal(trace.id, `${trace.workflowId}@${run.startedAt}`);
      assert.equal(record.at, trace.startedAt);
      assert.equal(record.outcome, trace.state === 'failed' ? 'failed' : 'ran');
      assert.equal(Date.parse(trace.finishedAt) - Date.parse(trace.startedAt), record.ms);
      assert.ok(trace.finishedAt <= cutoff);
      assert.deepEqual(trace.steps.map(step => step.id), WORKFLOW_DEFINITIONS.find(definition => definition.id === trace.workflowId).stages.map(step => step.id));
      let finished = trace.startedAt;
      for (const step of trace.steps) {
        assert.ok(step.startedAt >= finished);
        assert.ok(step.finishedAt >= step.startedAt && step.finishedAt <= trace.finishedAt);
        assert.match(step.summary, /^Synthetic: /);
        if (step.output) assert.equal(isWorkflowStepOutput(step.output), true);
        finished = step.finishedAt;
      }
      assert.ok(trace.steps.some(step => step.output));
    }
    const failed = history.traces.find(trace => trace.id === history.links.collectionFailure);
    const recovered = history.traces.find(trace => trace.id === history.links.collectionRecovery);
    assert.equal(failed.state, 'failed'); assert.equal(recovered.state, 'succeeded');
    assert.ok(failed.finishedAt < recovered.startedAt);
    assert.match(recovered.steps.find(step => step.id === 'google').summary, /earlier report remains missing/);
    assert.equal(history.traces.find(trace => trace.id === history.links.outcomeCheck).finishedAt, inputs.watch.evaluatedAt);
    assert.equal(JSON.stringify(inputs.scenario), before);
    assert.equal(inputs.scenario.daily.filter(day => day.reportMissing).length, 1);
  }
});

test('workflow outcomes require matching completed seed evidence', () => {
  for (const change of [
    input => { input.tasks.workspaceId = 'another-workspace'; },
    input => { input.tasks.scenarioHash = '0'.repeat(64); },
    input => { input.tasks.projects.pop(); },
    input => { input.watch.result.closed = []; },
    input => { input.watch.reading.outcome = 'inconclusive'; },
    input => { input.watch.evaluatedAt = input.scenario.manifest.cutoff; },
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => generateDemoWorkflows(input), /completed matching task seed|actual matching watch reading/);
  }
});

async function ownedHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-demo-workflows-test-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const input = fixture();
  await fs.writeFile(path.join(home, 'demo-tasks.json'), JSON.stringify(input.tasks), { flag: 'wx', mode: 0o600 });
  return { home, history: generateDemoWorkflows(input) };
}
test('new history files and the store mirror share exact facts; a repeat refuses before its writer', async t => {
  const { home, history } = await ownedHome(t); let calls = 0;
  const writeRuns = async (input, now) => {
    calls++; assert.deepEqual(input.runs, history.runs); assert.equal(now, Date.parse(history.cutoff));
    return { ok: true, created: 4, duplicate: 0, stale: 0, pruned: 0 };
  };
  const receipt = await writeDemoWorkflowHistory({ home, history, writeRuns });
  assert.equal(Object.keys(receipt.files).length, 2);
  const records = (await fs.readFile(path.join(home, '.local/logs/job-runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, history.records);
  await assert.rejects(writeDemoWorkflowHistory({ home, history, writeRuns }), /existing records/);
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(path.join(home, '.local/scheduled-jobs.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(home, '.local/workflow-active.json')), { code: 'ENOENT' });
});
test('redirected paths and mismatched installation receipts refuse before writes', async t => {
  const { home, history } = await ownedHome(t); let calls = 0;
  const writeRuns = async () => { calls++; return { ok: true }; };
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-demo-workflows-outside-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(home, '.local'));
  await assert.rejects(writeDemoWorkflowHistory({ home, history, writeRuns }), /redirected paths/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(home, '.local'));
  await fs.writeFile(path.join(home, 'demo-tasks.json'), JSON.stringify({ synthetic: true, workspaceId: 'another' }));
  await assert.rejects(writeDemoWorkflowHistory({ home, history, writeRuns }), /another demo/);
  assert.equal(calls, 0);
});
test('a rejected store mirror retains new history for review and never declares completion', async t => {
  const { home, history } = await ownedHome(t);
  await assert.rejects(writeDemoWorkflowHistory({ home, history, writeRuns: async () => ({ ok: false }) }), /preserve its files/);
  assert.ok((await fs.stat(path.join(home, '.local/logs/workflow-runs.jsonl'))).size > 0);
});
