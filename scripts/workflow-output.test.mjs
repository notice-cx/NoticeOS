import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureWorkflowOutput, isWorkflowStepOutput } from './workflow-output.mjs';
import { createWorkflowRecorder } from './workflow-trace.mjs';

test('captures actual collector counts and per-asset results, excluding raw responses', () => {
  const output = captureWorkflowOutput({ attempted: 2, succeeded: 1, failed: 1, response: { body: 'private response' }, outcomes: [
    { asset: 'meadow.example', ok: true, status: 200, written: 12 },
    { asset: 'northwind.example', ok: false, status: 503, error: 'private response' },
  ] });
  assert.ok(isWorkflowStepOutput(output));
  assert.deepEqual(output.metrics.map((m) => m.value), [2, 1, 1]);
  assert.deepEqual(output.items.map((i) => i.state), ['succeeded', 'failed']);
  assert.equal(output.items[0].fields.find((f) => f.key === 'written').value, 12);
  assert.ok(!JSON.stringify(output).includes('private response'));
});

test('captures project task counts and config provenance without task bodies or configuration values', () => {
  const tasks = captureWorkflowOutput({ projects: [{ asset: 'root-os', ok: true, counts: { open: 5, ready: 2 }, ready: [{ description: 'private task text' }] }] });
  assert.ok(isWorkflowStepOutput(tasks));
  assert.equal(tasks.items[0].fields.find((f) => f.key === 'open').value, 5);
  assert.ok(!JSON.stringify(tasks).includes('private task text'));
  const config = captureWorkflowOutput({ sources: { a: 'store', b: 'file' }, documents: { ignored: 'private configuration' } });
  assert.deepEqual(config.metrics.map((m) => m.value), [1, 1]);
  assert.ok(!JSON.stringify(config).includes('private configuration'));
});

test('keeps archive unchanged distinct from skipped and preserves exact measured cost', () => {
  const output = captureWorkflowOutput({ costUsd: 0.000153, outcomes: [{ asset: 'northwind.example', status: 'unchanged', providerRows: 10, costUsd: 0.000153 }] });
  assert.equal(output.items[0].state, 'succeeded');
  assert.equal(output.items[0].fields.find((f) => f.key === 'dataState').value, 'Unchanged');
  assert.equal(output.metrics[0].value, 0.000153);
});

test('separates health findings from check execution and retains failed checks', () => {
  const output = captureWorkflowOutput({ assets: 1, checks: 2, outcomes: [
    { asset: 'northwind.example', check: 'sitemap', status: 'ok', value: 25 },
    { asset: 'northwind.example', check: 'html-depth', status: 'warn', value: 120 },
    { asset: 'northwind.example', check: 'robots-ai-access', status: 'unreachable', value: null },
  ], failed: [{ asset: 'northwind.example', check: 'page-structure', error: 'private error' }] });
  assert.deepEqual(output.items.map((item) => item.state), ['succeeded', 'succeeded', 'succeeded', 'failed']);
  assert.equal(output.items[1].fields.find((field) => field.key === 'finding').value, 'warn');
  assert.equal(output.items[1].fields.find((field) => field.key === 'value').value, 120);
  assert.ok(!JSON.stringify(output).includes('private error'));
  assert.equal(captureWorkflowOutput({ closed: [], evaluated: 1 }).metrics.find((field) => field.key === 'closed').label, 'Closed');
});

test('bounds output records and fields, rejects unsupported or malformed values', () => {
  const output = captureWorkflowOutput({ attempted: Infinity, costUsd: NaN, outcomes: Array.from({ length: 80 }, () => ({ asset: 'a'.repeat(500), ok: true })) });
  assert.ok(isWorkflowStepOutput(output));
  assert.equal(output.items.length, 50);
  assert.equal(output.totalItems, 80);
  assert.equal(output.truncated, true);
  assert.equal(output.items[0].label, 'Item 1');
  assert.equal(output.metrics.length, 0);
  assert.equal(captureWorkflowOutput({ unknown: 'private data' }), undefined);
  assert.equal(captureWorkflowOutput(undefined), undefined);
  assert.equal(isWorkflowStepOutput({ ...output, items: [{ label: 'bad', state: 'whatever', fields: [] }] }), false);
  assert.equal(isWorkflowStepOutput({ ...output, rawResponse: { ignored: true } }), false);
  assert.equal(isWorkflowStepOutput({ ...output, fields: [{ key: 'providerBody', label: 'Body', value: 'private response' }] }), false);
  assert.equal(isWorkflowStepOutput({ ...output, fields: [{ key: 'ok', label: 'private response', value: true }] }), false);
});

test('captures pulse results and closed measurement windows with their actual identity', () => {
  const pulse = captureWorkflowOutput({ pulseId: 42, date: '2026-09-09', envelopeFlags: 2, centralFlags: 0, resolvedAnomalies: 1, resolvedFreshness: 0 });
  assert.ok(isWorkflowStepOutput(pulse));
  assert.equal(pulse.metrics.find((metric) => metric.key === 'pulseId').value, 42);
  const windows = captureWorkflowOutput({ scanned: 1, evaluated: 1, readings: 1, closed: [{ id: 'window-1', asset: 'northwind.example', outcome: 'inconclusive', note: 'private note' }], failed: [], overdue: [] });
  assert.ok(isWorkflowStepOutput(windows));
  assert.equal(windows.items[0].fields.find((field) => field.key === 'verdict').value, 'inconclusive');
  assert.ok(!JSON.stringify(windows).includes('private note'));
});

test('records output without changing returns and isolates projection failures', async () => {
  const trace = createWorkflowRecorder();
  const result = { attempted: 1, succeeded: 1, failed: 0 };
  assert.equal(await trace.run('collect', async () => result), result);
  assert.equal(trace.steps[0].output.metrics[1].value, 1);
  const unexpected = { get sources() { throw new Error('projection failed'); } };
  assert.equal(await trace.run('collect', async () => unexpected), unexpected);
  assert.equal(trace.steps[1].state, 'succeeded');
  assert.equal(trace.steps[1].output, undefined);
});
