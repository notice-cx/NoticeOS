import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import { laneSkips } from './runner/log.mjs';
import {
  BEADS_ERROR_MAX,
  beadsCloseArgs,
  beadsCreateArgs,
  beadsCreatedId,
  beadsFailure,
  beadsHubDiagnosis,
  beadsHubHealthLine,
  beadsInstant,
  beadsLabelListArgs,
  beadsOpenRows,
  beadsText,
  parseBeadsProjects,
  parseDoltServers,
  readBeadsList,
  readBeadsProjects,
  runBd,
  runBeadsStep,
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
  assert.equal(beadsCreatedId('[{"id":" ex-1 "}]'), 'ex-1');
  assert.equal(beadsCreatedId('{"id":"ex-2"}'), 'ex-2');
  assert.equal(beadsCreatedId('created'), null);
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

test('every filing lane lists, files and closes with one argv shape', () => {
  assert.deepEqual(beadsLabelListArgs('/r', 'lane'), [
    '-C', '/r', 'list', '--label', 'lane', '--status', 'open,in_progress,blocked,deferred', '--json', '--limit', '0',
  ]);
  assert.deepEqual(beadsLabelListArgs('/r', 'lane', { closed: true, limit: 5 }).slice(5), [
    '--status', 'open,in_progress,blocked,deferred,closed', '--json', '--limit', '5',
  ]);
  const filing = {
    actor: 'example-actor', title: 'T', type: 'task', priority: 2, labels: ['lane', 'human'],
    metadata: { k: 'v' }, description: 'D', acceptance: 'A',
  };
  assert.deepEqual(beadsCreateArgs('/r', filing), [
    '-C', '/r', '--actor', 'example-actor', 'create', 'T', '--type', 'task', '--priority', '2',
    '--labels', 'lane,human', '--metadata', '{"k":"v"}', '--description', 'D', '--acceptance', 'A', '--json',
  ]);
  const due = beadsCreateArgs('/r', { ...filing, due: '2026-09-01' });
  assert.deepEqual(due.slice(due.indexOf('--labels'), due.indexOf('--metadata')), ['--labels', 'lane,human', '--due', '2026-09-01']);
  assert.deepEqual(beadsCloseArgs('/r', 'example-actor', 'ex-1', 'why'), ['-C', '/r', '--actor', 'example-actor', 'close', 'ex-1', '-r', 'why']);
});

test('only open rows with an id are read back, and a non-list is null', () => {
  assert.equal(beadsOpenRows({}), null);
  const rows = [{ id: ' ex-1 ', status: 'open' }, { id: 'ex-2', status: 'closed' }, { id: '', status: 'open' }];
  assert.deepEqual(beadsOpenRows(rows), [{ beadId: 'ex-1', row: rows[0] }]);
});

test('a bd step is its result or the one line the lane logs', async () => {
  const answer = (result) => async () => result;
  assert.deepEqual(await runBeadsStep(answer({ code: 0, stdout: '{}' }), [], 'create', 'lane create'), {
    result: { code: 0, stdout: '{}' },
  });
  assert.deepEqual(
    await runBeadsStep(async () => { throw new Error('ENOENT'); }, [], 'close', 'lane close'),
    { failure: 'bd close could not run: ENOENT' },
  );
  const exited = await runBeadsStep(answer({ code: 3, stderr: 'locked' }), [], 'create', 'lane create');
  assert.equal(exited.failure, 'bd lane create exited 3: locked');
  assert.deepEqual((await readBeadsList(answer({ code: 0, stdout: '[1]' }), [], 'lane list')).rows, [1]);
  assert.equal((await readBeadsList(answer({ code: 0, stdout: 'nope' }), [], 'lane list')).unparseable, true);
  assert.equal((await readBeadsList(answer({ code: 1, stdout: '' }), [], 'lane list')).failure, 'bd lane list exited 1: no output');
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
  for (const [name, value] of Object.entries({ beadsCreatedId, beadsHubDiagnosis, beadsHubHealthLine,
    parseBeadsProjects, parseDoltServers, runBd })) {
    assert.equal(osUp[name], value, name);
  }
});
