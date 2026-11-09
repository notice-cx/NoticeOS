import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowRecorder } from './workflow-trace.mjs';
import { localLaneDiagnostics, runLocalLaneWithDiagnostics } from './runner/diagnostics.mjs';

test('local command diagnostics retain actual input, stdout, stderr and reported failures without changing results', async () => {
  const trace = createWorkflowRecorder();
  const result = { code: 1, stdout: 'Actual command progress', stderr: 'token=synthetic-private refused', timedOut: false, error: null };
  await trace.run('execute', async capture => {
    const observed = localLaneDiagnostics(capture, 'panel-refresh', { command: async () => result, emit: () => {} });
    assert.equal(await observed.runCommand('pnpm', ['signals:refresh'], { cwd: '/fixture', timeoutMs: 1000, env: { TOKEN: 'environment-private' } }), result);
    observed.emit('ERROR', 'Actual error detail');
    return { code: result.code };
  });
  const step = trace.steps[0];
  assert.equal(step.state, 'failed');
  assert.ok(step.diagnostics.input.text.includes('signals:refresh'));
  assert.ok(step.diagnostics.output.text.includes('Actual command progress'));
  assert.ok(step.diagnostics.error.text.includes('Actual error detail'));
  assert.ok(!JSON.stringify(step).includes('synthetic-private'));
  assert.ok(!JSON.stringify(step).includes('environment-private'));
});

test('local command throws retain actual errors and preserve the throw', async () => {
  const error = new Error('Actual command failed');
  const trace = createWorkflowRecorder();
  await assert.rejects(trace.run('execute', async capture => {
    const observed = localLaneDiagnostics(capture, 'panel-refresh', { command: async () => { throw error; }, emit: () => {} });
    await observed.runCommand('pnpm', ['signals:refresh']);
  }), caught => caught === error);
  assert.ok(trace.steps[0].diagnostics.input.text.includes('signals:refresh'));
  assert.ok(trace.steps[0].diagnostics.error.text.includes(error.message));
});


test('local final result survives alongside command diagnostics, including returned POST failures', async () => {
  const trace = createWorkflowRecorder();
  const result = { ok: false, response: { status: 503, body: 'Actual rejected POST response' } };
  await trace.run('execute', capture => runLocalLaneWithDiagnostics(capture, 'beads-snapshot', async observed => {
    await observed.runCommand('pnpm', ['signals:refresh'], { timeoutMs: 1000 }); return result;
  }, { command: async () => ({ code: 0, stdout: 'Actual command output', stderr: '' }), emit: () => {} }));
  const text = trace.steps[0].diagnostics.output.text;
  assert.ok(text.includes('Actual rejected POST response')); assert.ok(text.includes('Actual command output'));
  assert.equal(trace.steps[0].state, 'failed');
});

test('diagnostic callbacks cannot replace command return values or exceptions', async () => {
  const capture = { input() { throw new Error('capture failed'); }, output() { throw new Error('capture failed'); }, error() { throw new Error('capture failed'); } };
  const actual = { code: 1, stdout: 'Actual failure', stderr: '' };
  const observed = localLaneDiagnostics(capture, 'panel-refresh', { command: async () => actual, emit: () => {} });
  assert.equal(await observed.runCommand('pnpm', ['signals:refresh']), actual);
  const error = new Error('Actual spawn failure');
  const thrown = localLaneDiagnostics(capture, 'panel-refresh', { command: async () => { throw error; }, emit: () => {} });
  await assert.rejects(thrown.runCommand('pnpm', ['signals:refresh']), caught => caught === error);
});


test('local command aggregation retains upstream redaction flags even when the final text fits', async () => {
  const trace = createWorkflowRecorder();
  await trace.run('execute', capture => runLocalLaneWithDiagnostics(capture, 'beads-snapshot', async observed => {
    await observed.runCommand('pnpm', ['signals:refresh']);
    return { response: { body: 'Observed shortened body', truncated: true, redacted: true } };
  }, { command: async () => ({ code: 0, stdout: 'Actual output', password: 'synthetic-private' }), emit: () => {}, resultMetadata: result => result.response }));
  assert.equal(trace.steps[0].diagnostics.output.redacted, true);
  assert.equal(trace.steps[0].diagnostics.output.truncated, true);
  assert.ok(!JSON.stringify(trace.steps).includes('synthetic-private'));
});


test('real raw command captures retain redaction and byte truncation metadata through the recorder', async () => {
  const trace = createWorkflowRecorder();
  await trace.run('execute', capture => runLocalLaneWithDiagnostics(capture, 'panel-refresh', async observed => {
    await observed.runCommand('pnpm', ['signals:refresh']); return { code: 0 };
  }, { command: async () => ({ code: 0, stdout: 'x'.repeat(30_000), api_token: 'synthetic-private' }), emit: () => {} }));
  const output = trace.steps[0].diagnostics.output;
  assert.equal(output.redacted, true); assert.equal(output.truncated, true);
  assert.ok(!JSON.stringify(trace.steps).includes('synthetic-private'));
});
