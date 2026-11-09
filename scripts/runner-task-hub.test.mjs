import assert from 'node:assert/strict';
import { test } from 'node:test';

import { laneSkips } from './runner/log.mjs';

import { parseBeadsProjects, readBeadsProjects } from './runner/task-hub.mjs';
import { BEADS_ERROR_MAX, beadsFailure, beadsInstant, beadsText } from './task-snapshot-values.mjs';

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
  assert.deepEqual(parseBeadsProjects(raw), [
    { asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' },
    { asset: 'blog.example', prefix: 'blog', repo: '', unavailableReason: 'not linked on this host', database: 'blog' },
    { asset: 'bad.example', prefix: 'bad', repo: '../bad', database: null },
  ]);
  assert.deepEqual(parseBeadsProjects('not json'), []);
});

test('an unreadable store is a skip reason, an empty map is an empty answer', async () => {
  assert.deepEqual(await readBeadsProjects(async () => '{"spokes":[]}'), { projects: [] });
  assert.deepEqual(await readBeadsProjects(async () => { throw new Error('door closed'); }), {
    unreadable: 'the task map is unreadable (door closed)',
  });
});

test("bd's output is read defensively and its failures are one bounded line", () => {
  assert.equal(beadsText('  x  '), 'x');
  assert.equal(beadsText(7, 'fallback'), 'fallback');
  assert.equal(beadsInstant('2026-09-24T10:00:00+02:00'), '2026-09-24T08:00:00.000Z');
  assert.equal(beadsInstant('soon'), null);
  const line = beadsFailure('list', { code: 2, stderr: `${'e'.repeat(BEADS_ERROR_MAX + 50)}\nsecond line` });
  assert.ok(line.startsWith('bd list exited 2: '));
  assert.equal(line.length, 'bd list exited 2: '.length + BEADS_ERROR_MAX);
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
