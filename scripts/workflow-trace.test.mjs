import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkflowRecorder, stepResult, workflowResult, settleWorkflowSteps } from './workflow-trace.mjs';
import { readJsonLines } from './workflow-history.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';

test('step evidence preserves return values, observed timing and independent attempts', async () => {
  let now = 0;
  const changes = [];
  const trace = createWorkflowRecorder({ now: () => now, changed: (steps) => changes.push(structuredClone(steps)) });
  const value = { succeeded: 3 };
  assert.equal(await trace.run('collect', async () => { now = 20; return value; }), value);
  await trace.run('collect', async () => null);
  assert.deepEqual(trace.steps.map((s) => [s.attempt, s.state]), [[1, 'succeeded'], [2, 'skipped']]);
  assert.equal(trace.steps[0].finishedAt, '1970-01-01T00:00:00.020Z');
  assert.equal(changes[0][0].state, 'running');
});

test('a thrown step remains a throw while telemetry excludes the exception and payload', async () => {
  const trace = createWorkflowRecorder();
  const error = new Error('private provider response');
  await assert.rejects(trace.run('collect', async () => { throw error; }), (caught) => caught === error);
  assert.equal(trace.steps[0].state, 'failed');
  assert.ok(!JSON.stringify(trace.steps).includes(error.message));
  await trace.run('collect', async () => ({ succeeded: 2, response: 'private output' }));
  assert.ok(!JSON.stringify(trace.steps).includes('private output'));
});

test('each failed step hands its own error to the caller once, and a listener cannot change the throw', async () => {
  const heard = [];
  const trace = createWorkflowRecorder({ failed: (id, error) => { heard.push([id, error.message]); throw new Error('listener broke'); } });
  const first = new Error('first');
  const second = new Error('second');
  await assert.rejects(settleWorkflowSteps([
    trace.run('google', async () => { throw first; }),
    trace.run('counters', async () => { throw second; }),
    trace.run('fine', async () => ({ succeeded: 1 })),
  ]), (caught) => caught === first);
  assert.deepEqual(heard, [['google', 'first'], ['counters', 'second']]);
  assert.deepEqual(trace.steps.map((s) => s.state), ['failed', 'failed', 'succeeded']);
});

test('partial collection failure is visible without changing the collector result', () => {
  assert.equal(stepResult({ failed: 1, succeeded: 5 }).state, 'failed');
  assert.equal(stepResult({ failed: [{ property: 'example' }] }).state, 'failed');
  assert.equal(stepResult({ attempted: 0, failed: 0 }).state, 'skipped');
  assert.equal(stepResult({ outcome: 'skipped' }).state, 'skipped');
  assert.equal(stepResult({ ok: false }).state, 'failed');
  assert.equal(stepResult(undefined).state, 'succeeded');
});

test('a failed step names what failed: sites whose remote could not be read, else collections (ro-ujb9.233)', () => {
  // The unpublished-commit check (runPushStateFiler in scripts/os-up.mjs):
  // nothing was collected from these sites, so they are not "collections".
  const pushState = { checked: 2, filed: [], closed: [], failed: [
    { asset: 'one.example', reason: 'remote-sign-in-refused' },
    { asset: 'two.example', reason: 'remote-unreachable' },
    { asset: 'three.example', reason: 'git-read-failed' },
  ] };
  assert.deepEqual(stepResult(pushState), { state: 'failed', summary: '3 sites could not be read.' });
  assert.equal(stepResult({ ...pushState, failed: pushState.failed.slice(0, 1) }).summary, '1 site could not be read.');
  // Collection lanes keep their wording, counted or listed.
  assert.equal(stepResult({ failed: 2, succeeded: 5 }).summary, '2 collections failed.');
  assert.equal(stepResult({ failed: 1 }).summary, '1 collection failed.');
  assert.equal(stepResult({ failed: [{ property: 'example' }] }).summary, '1 collection failed.');
  // A list that is not wholly unread sites is not called sites.
  assert.equal(stepResult({ failed: [...pushState.failed, { asset: 'four.example', error: 'timeout' }] }).summary, '4 collections failed.');
});

test('parallel stages retain distinct start/end evidence', async () => {
  const trace = createWorkflowRecorder();
  let release;
  const slow = trace.run('slow', () => new Promise((resolve) => { release = resolve; }));
  await trace.run('fast', async () => 1);
  assert.equal(trace.steps[0].state, 'running');
  assert.equal(trace.steps[1].state, 'succeeded');
  release(2);
  await slow;
  assert.equal(trace.steps[0].state, 'succeeded');
});

test('real nonthrowing failures and no-work results never become green', () => {
  for (const result of [false, { code: 1 }, { skipped: 'delivery-failed' }, { skipped: 'store-unavailable' }, { projects: [{ ok: true }, { ok: false }] }]) {
    assert.equal(stepResult(result).state, 'failed');
  }
  assert.equal(stepResult({ skipped: 'nothing-to-say' }).state, 'skipped');
  assert.equal(stepResult({ skipped: 'no-credential' }).state, 'skipped');
  assert.equal(workflowResult([{ id: 'config', state: 'succeeded' }, { id: 'collect', state: 'skipped' }, { id: 'record', state: 'succeeded' }], 'ran'), 'skipped');
});

test('parallel failure waits for its sibling before the RPC takes a terminal snapshot', async () => {
  const trace = createWorkflowRecorder();
  let release;
  const slow = trace.run('slow', () => new Promise((resolve) => { release = resolve; }));
  const failure = new Error('failed branch');
  const done = settleWorkflowSteps([slow, trace.run('failed', async () => { throw failure; })]);
  let settled = false;
  const checked = assert.rejects(done, (error) => { settled = true; return error === failure; });
  await Promise.resolve();
  assert.equal(settled, false);
  release(1);
  await checked;
  assert.ok(trace.steps.every((step) => step.finishedAt && step.state !== 'running'));
});

test('workflow dependency definitions are complete, ordered and unique', () => {
  for (const workflow of WORKFLOW_DEFINITIONS) {
    const seen = new Set();
    for (const stage of workflow.stages) {
      assert.ok(!seen.has(stage.id));
      assert.ok(stage.after.every((id) => seen.has(id)));
      assert.ok(stage.description.length > 10);
      seen.add(stage.id);
    }
  }
  const pull = WORKFLOW_DEFINITIONS.find((w) => w.id === 'pull');
  assert.deepEqual(pull.stages.find((s) => s.id === 'pull').after, ['config']);
  assert.deepEqual(pull.stages.find((s) => s.id === 'bing').after, ['config']);
});

test('bounded history reader ignores torn lines and never reads an unbounded log', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-history-'));
  try {
    const file = path.join(dir, 'history.jsonl');
    await writeFile(file, '{"value":"old-long-record"}\n{"value":2}\n{"broken":');
    assert.deepEqual(await readJsonLines(file, 35), [{ value: 2 }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
