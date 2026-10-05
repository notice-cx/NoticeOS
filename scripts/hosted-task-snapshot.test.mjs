import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostedTaskSnapshot } from './hosted-task-snapshot.mjs';
import { summarizeBeadsProject } from './task-snapshot-summary.mjs';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '33333333-3333-4333-8333-333333333333';
const project = { projectId, asset: 'example.test', prefix: 'tt' };
const issue = (id, status = 'open') => ({ id, title: 'Generated task', status, priority: 1, issue_type: 'task' });
const answer = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const required = { active: answer([issue('tt-open'), issue('tt-flight', 'in_progress')]), ready: answer([issue('tt-open')]),
  blocked: answer([]), closed: answer([issue('tt-done', 'closed')]) };
const request = () => new Request('https://noticeos.internal/task-snapshot', { method: 'POST', headers: { 'x-generated-proof': 'original' } });

test('server registry and original request are captured while ordinary summary preserves unknown optional facts', async () => {
  const projects = [{ ...project }], original = request();
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const reader = createHostedTaskSnapshot({ workspaceId, projects, executor: { async execute(proof, selected, asked, controls) {
    assert.equal(selected, workspaceId); assert.deepEqual(asked.operation.kind, 'snapshot');
    assert.equal(asked.projectId, projectId); assert.equal(controls.expectedPrefix, 'tt');
    assert.equal(proof.headers.get('x-generated-proof'), 'original'); entered(); await barrier;
    return required;
  } } });
  const pending = reader.snapshot(original); await started;
  projects[0].asset = 'foreign.test'; original.headers.set('x-generated-proof', 'changed'); release();
  const snapshot = await pending;
  assert.equal(snapshot.projects.length, 1); assert.equal(snapshot.projects[0].asset, 'example.test');
  assert.deepEqual(snapshot.projects[0], summarizeBeadsProject(project, required));
  assert.equal(Object.hasOwn(snapshot.projects[0].counts, 'waiting'), false);
  assert.equal(Object.hasOwn(snapshot.projects[0], 'handoffs'), false);
  assert.equal(Object.hasOwn(snapshot.projects[0], 'deferred'), false);
});

test('successful empty optional reads are zero; failed required reads are unavailable rather than empty', async () => {
  let results = { ...required, human: answer(null), gates: answer(null), deferred: answer([]), handoffs: answer([]) };
  const reader = createHostedTaskSnapshot({ workspaceId, projects: [project], executor: { execute: async () => results } });
  const good = (await reader.snapshot(request())).projects[0];
  assert.equal(good.ok, true); assert.equal(good.counts.waiting, 0); assert.equal(good.counts.deferred, 0); assert.deepEqual(good.handoffs, []);
  results = { ...required, active: { code: 1, stdout: '', stderr: 'Generated missing read' } };
  const failed = (await reader.snapshot(request())).projects[0];
  assert.equal(failed.ok, false); assert.equal(failed.error.includes('active'), true);
});

test('fixed reader refuses caller selectors, duplicate registry rows, expired or aborted lifetime and missing request', async () => {
  let calls = 0;
  const executor = { execute: async () => { calls++; return required; } };
  for (const projects of [[{ ...project, cwd: '/foreign' }], [project, project], [{ ...project, prefix: '--database=foreign' }]]) {
    assert.throws(() => createHostedTaskSnapshot({ workspaceId, projects, executor }));
  }
  const reader = createHostedTaskSnapshot({ workspaceId, projects: [project], executor });
  await assert.rejects(reader.snapshot(null));
  await assert.rejects(reader.snapshot(request(), { workspaceId }));
  await assert.rejects(reader.snapshot(request(), { deadline: 0 }));
  await assert.rejects(reader.snapshot(request(), { signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});
