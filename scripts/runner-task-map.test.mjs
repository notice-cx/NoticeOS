import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runTaskMapCheck } from './runner/task-map.mjs';

// scripts/runner/task-map.mjs: the task-map lane, which stands down on every
// pass. The lanes' stand-down while no task service is connected is
// runner-task-service-poll.test.mjs's.

test('the task map check stands down while tasks live in Ntasks, and once per reason', async () => {
  const lines = [];
  const deps = { taskService: { backend: async () => 'ntasks' }, state: { skipping: null }, emit: (level, text) => lines.push(`${level} ${text}`), stopped: () => false };
  assert.equal(await runTaskMapCheck(deps), null);
  assert.equal(await runTaskMapCheck(deps), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN task map check skipped — tasks live in Ntasks/u);
});

test('a shutting-down runner asks nothing and says nothing', async () => {
  const lines = [];
  const asked = [];
  assert.equal(await runTaskMapCheck({ taskService: { backend: async () => { asked.push(1); return 'ntasks'; } }, state: { skipping: null },
    emit: (_level, text) => lines.push(text), stopped: () => true }), null);
  assert.deepEqual([asked, lines], [[], []]);
});
