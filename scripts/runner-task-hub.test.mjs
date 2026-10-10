import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import {
  BEADS_ERROR_MAX,
  beadsCreatedId,
  beadsFailure,
  beadsHubDiagnosis,
  beadsHubHealthLine,
  beadsInstant,
  beadsSkipDecision,
  beadsText,
  parseBeadsProjects,
  parseBeadsSpokes,
  parseDoltServers,
  runBd,
} from './runner/task-hub.mjs';

// scripts/runner/task-hub.mjs: the runner's side of the task
// hub and the readers every bead lane shares. Nothing here reaches a real hub;
// the one `bd` run is /usr/bin/false standing in for a failing bd.

const HUB = { beadsHubHost: '127.0.0.1', beadsHubPort: 8856 };

test('the hub line carries the fix, and two servers or a dead one are named as such', () => {
  assert.equal(beadsHubHealthLine(true, HUB).level, 'INFO');
  assert.match(beadsHubHealthLine(false, HUB).text, /brew services start dolt/u);
  const two = [{ pid: 1, command: 'dolt sql-server' }, { pid: 2, command: 'dolt sql-server' }];
  assert.equal(beadsHubDiagnosis({ reachable: true, servers: two, dataDir: '/d' }, HUB).key, 'contended');
  assert.equal(beadsHubDiagnosis({ reachable: false, servers: two.slice(0, 1), dataDir: '/d' }, HUB).key, 'crash-looping');
  assert.equal(beadsHubDiagnosis({ reachable: false, servers: null, dataDir: '/d' }, HUB).key, 'down');
});

test("a concurrent pgrep is not counted as a dolt server", () => {
  const servers = parseDoltServers('101 /opt/homebrew/bin/dolt sql-server --config x\n102 pgrep -fl dolt sql-server\n');
  assert.deepEqual(servers.map((server) => server.pid), [101]);
});

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
  assert.deepEqual(parseBeadsSpokes(raw), ['shop', 'dup', 'blog']);
  assert.deepEqual(parseBeadsProjects('not json'), []);
});

test("bd's output is read defensively and its failures are one bounded line", () => {
  assert.equal(beadsText('  x  '), 'x');
  assert.equal(beadsText(7, 'fallback'), 'fallback');
  assert.equal(beadsInstant('2026-09-24T10:00:00+02:00'), '2026-09-24T08:00:00.000Z');
  assert.equal(beadsInstant('soon'), null);
  const line = beadsFailure('list', { code: 2, stderr: `${'e'.repeat(BEADS_ERROR_MAX + 50)}\nsecond line` });
  assert.ok(line.startsWith('bd list exited 2: '));
  assert.equal(line.length, 'bd list exited 2: '.length + BEADS_ERROR_MAX);
  assert.equal(beadsCreatedId('[{"id":" ex-1 "}]'), 'ex-1');
  assert.equal(beadsCreatedId('{"id":"ex-2"}'), 'ex-2');
  assert.equal(beadsCreatedId('created'), null);
});

test('a repeated skip reason is logged once; a new one always is', () => {
  const state = { skipping: null };
  assert.equal(beadsSkipDecision(state, 'hub down'), true);
  assert.equal(beadsSkipDecision(state, 'hub down'), false);
  assert.equal(beadsSkipDecision(state, 'no token'), true);
});

test("a bd that exits non-zero is data for the lane, never a throw", async () => {
  const saved = process.env.BEADS_BD_BIN;
  process.env.BEADS_BD_BIN = '/usr/bin/false';
  try {
    const result = await runBd(['list', '--json']);
    assert.notEqual(result.code, 0);
  } finally {
    if (saved === undefined) delete process.env.BEADS_BD_BIN;
    else process.env.BEADS_BD_BIN = saved;
  }
});

test('os-up.mjs still offers the same task-hub names', () => {
  for (const [name, value] of Object.entries({ beadsCreatedId, beadsHubDiagnosis, beadsHubHealthLine, beadsSkipDecision,
    parseBeadsProjects, parseBeadsSpokes, parseDoltServers, runBd })) {
    assert.equal(osUp[name], value, name);
  }
});
