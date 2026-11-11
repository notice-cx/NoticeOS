import assert from 'node:assert/strict';
import { test } from 'node:test';

import { laneSkips } from './runner/log.mjs';

import { parseTaskProjects, readTaskProjectList } from './runner/task-hub.mjs';
import { TASK_SNAPSHOT_ERROR_MAX, taskFailure, taskInstant, taskText } from './task-snapshot-values.mjs';

// scripts/runner/task-hub.mjs: the saved task projects as the task lanes read
// them, and the task-value readers the lanes share (scripts/task-snapshot-values.mjs).

test('the saved projects are read once, in order, dropping what a lane cannot use', () => {
  const raw = JSON.stringify({
    spokes: [
      { asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' },
      { asset: 'shop.example', prefix: 'dup', repo: '../dup', database: 'dup' },
      { asset: 'blog.example', prefix: 'blog', repo: '', unavailableReason: 'not linked on this host', database: 'blog' },
      { asset: 'bad.example', prefix: 'bad', repo: '../bad', database: 'bad name' },
      { prefix: 'noasset', repo: '../x' },
    ],
  });
  assert.deepEqual(parseTaskProjects(raw), [
    { asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' },
    { asset: 'blog.example', prefix: 'blog', repo: '', unavailableReason: 'not linked on this host', database: 'blog' },
    { asset: 'bad.example', prefix: 'bad', repo: '../bad', database: null },
  ]);
  assert.deepEqual(parseTaskProjects('not json'), []);
});

test('an unreadable store is a skip reason, an empty map is an empty answer', async () => {
  assert.deepEqual(await readTaskProjectList(async () => '{"spokes":[]}'), { projects: [] });
  assert.deepEqual(await readTaskProjectList(async () => { throw new Error('door closed'); }), {
    unreadable: 'the task map is unreadable (door closed)',
  });
});

test("bd's output is read defensively and its failures are one bounded line", () => {
  assert.equal(taskText('  x  '), 'x');
  assert.equal(taskText(7, 'fallback'), 'fallback');
  assert.equal(taskInstant('2026-09-24T10:00:00+02:00'), '2026-09-24T08:00:00.000Z');
  assert.equal(taskInstant('soon'), null);
  const line = taskFailure('list', { code: 2, stderr: `${'e'.repeat(TASK_SNAPSHOT_ERROR_MAX + 50)}\nsecond line` });
  assert.ok(line.startsWith('bd list exited 2: '));
  assert.equal(line.length, 'bd list exited 2: '.length + TASK_SNAPSHOT_ERROR_MAX);
});

test('a repeated skip reason is logged once, a new one always is, and the return is said once', () => {
  const lines = [];
  const state = { skipping: null };
  const { skip, resume } = laneSkips('example lane', state, (level, text) => lines.push(`${level} ${text}`));
  assert.equal(skip('hub down'), null);
  skip('hub down');
  skip('no token');
  resume();
  resume();
  assert.deepEqual(lines, [
    'WARN example lane skipped — hub down (silent until it changes)',
    'WARN example lane skipped — no token (silent until it changes)',
    'INFO example lane resumed (was skipped: no token)',
  ]);
  assert.equal(state.skipping, null);
});
