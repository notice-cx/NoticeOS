import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { generatorSteps, main } from './generate.mjs';

const ran = (statuses = {}) => {
  const calls = [];
  const run = (_node, [script, ...flags]) => {
    calls.push([path.basename(script), ...flags]);
    return { status: statuses[path.basename(script)] ?? 0 };
  };
  return { calls, run };
};

test('generate runs the compiled pairs, then the config docs, then the command index', () => {
  const write = ran();
  assert.equal(main([], { run: write.run }), 0);
  assert.deepEqual(write.calls, [['generate-config-contract.mjs'], ['config-docs.mjs', '--write'], ['scripts-index.mjs', '--write']]);
  const check = ran();
  assert.equal(main(['--', '--check'], { run: check.run }), 0);
  assert.deepEqual(check.calls, generatorSteps(true).map(([script, flags]) => [script, ...flags]));
});

test('a failed rewrite stops before the steps that read it; a check reports every stale step', () => {
  const write = ran({ 'generate-config-contract.mjs': 1 });
  assert.equal(main([], { run: write.run }), 1);
  assert.equal(write.calls.length, 1);
  const check = ran({ 'config-docs.mjs': 1 });
  assert.equal(main(['--check'], { run: check.run }), 1);
  assert.equal(check.calls.length, 3);
});
