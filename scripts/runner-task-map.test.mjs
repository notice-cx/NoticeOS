import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { HOME_ROOT } from './runner/config.mjs';
import {
  TASK_MAP_LABEL,
  beadsDatabaseDrift,
  beadsShowDatabasesArgs,
  parseBeadsDatabases,
  readOsAsset,
  runTaskMapCheck,
  taskMapBeadAsset,
  taskMapTitle,
} from './runner/task-map.mjs';

// scripts/runner/task-map.mjs: the task-map lane. The hub's
// answer and `bd` are recorded here; nothing reaches a real hub or tracker.

const SPOKES = JSON.stringify({
  spokes: [
    { asset: 'os.example', prefix: 'os', repo: '.', database: 'os' },
    { asset: 'shop.example', prefix: 'shop', repo: '../shop', database: 'shop' },
  ],
});

function lane({ held = ['os', 'shop'], open = [], hubCode = 0, home = 'os.example', repo = '.' } = {}) {
  const ran = [];
  const lines = [];
  const config = JSON.parse(SPOKES);
  config.spokes[0].repo = repo;
  const deps = {
    readConfig: async () => JSON.stringify(config),
    run: async (argv) => {
      ran.push(argv);
      if (argv.includes('SHOW DATABASES')) {
        return { code: hubCode, stdout: JSON.stringify(held.map((Database) => ({ Database }))), stderr: hubCode ? 'refused' : '' };
      }
      if (argv.includes('list')) return { code: 0, stdout: JSON.stringify(open), stderr: '' };
      return { code: 0, stdout: '{"id":"os-7"}', stderr: '' };
    },
    now: () => new Date('2026-09-24T12:00:00Z'),
    state: { skipping: null },
    emit: (level, text) => lines.push(`${level} ${text}`),
    stopped: () => false,
    homeAsset: async () => home,
  };
  return { deps, ran, lines };
}

test("the hub's answer is read strictly: unreadable is not empty", () => {
  assert.equal(parseBeadsDatabases('not json'), null);
  assert.deepEqual([...parseBeadsDatabases('[{"Database":"os"},{"name":"shop"}]')], ['os', 'shop']);
  assert.deepEqual(beadsDatabaseDrift([{ asset: 'a', database: 'gone' }, { asset: 'b', database: 'bad name' }], new Set(['os'])),
    [{ asset: 'a', declared: 'gone' }, { asset: 'b', declared: null }]);
  assert.deepEqual(beadsShowDatabasesArgs('/synthetic/core').slice(0, 2), ['-C', '/synthetic/core']);
});

test('hub inventory and task actions use the same linked OS spoke on native, fresh and container hosts', async () => {
  for (const repo of ['.', 'tasks/core', '/spokes/core']) {
    const { deps, ran } = lane({ repo, held: ['os'] });
    const result = await runTaskMapCheck(deps);
    assert.equal(result.checked, 2);
    assert.equal(result.filed.length, 1);
    const expected = path.resolve(HOME_ROOT, repo);
    assert.deepEqual(ran.filter(argv => argv.includes('SHOW DATABASES') || argv.includes('list') || argv.includes('create')).map(argv => argv.slice(0, 2)),
      [['-C', expected], ['-C', expected], ['-C', expected]]);
  }
});

test('a drifting project is filed once, in the OS’s own tracker', async () => {
  const { deps, ran } = lane({ held: ['os'] });
  const result = await runTaskMapCheck(deps);
  assert.deepEqual(result.filed.map((entry) => entry.asset), ['shop.example']);
  const create = ran.find((argv) => argv.includes('create'));
  assert.ok(create.includes(taskMapTitle('shop.example')));
  assert.ok(create.includes(`${TASK_MAP_LABEL},human`));
});

test('a project that agrees again has its open bead closed', async () => {
  const open = [{ id: 'os-3', status: 'open', title: taskMapTitle('shop.example') }];
  assert.equal(taskMapBeadAsset(open[0]), 'shop.example');
  const { deps } = lane({ open });
  assert.deepEqual((await runTaskMapCheck(deps)).closed, [{ asset: 'shop.example', beadId: 'os-3' }]);
});

test('a hub that will not answer, or no OS site to file into, decides nothing', async () => {
  const refused = lane({ hubCode: 1 });
  assert.equal(await runTaskMapCheck(refused.deps), null);
  assert.equal(refused.ran.filter((argv) => argv.includes('list')).length, 0, 'not even the bead list is asked for');
  const homeless = lane({ home: null });
  assert.equal(await runTaskMapCheck(homeless.deps), null);
  assert.match(homeless.lines[0], /names no OS asset/u);
  const missingSpoke = lane({ home: 'missing.example' });
  assert.equal(await runTaskMapCheck(missingSpoke.deps), null);
  assert.equal(missingSpoke.ran.length, 0, 'no hub read or write occurs without the linked OS project');
});

test('the OS asset is whichever asset the store names, and an unanswered read is null', async () => {
  const url = 'http://127.0.0.1:8791/api/os-asset';
  const answer = (status, body) => async (requested, init) => {
    assert.equal(requested, url);
    assert.equal(init.headers.authorization, 'Bearer operator-token');
    return { ok: status === 200, status, json: async () => body };
  };
  const readToken = async () => 'operator-token';
  assert.equal(await readOsAsset({ url, readToken, get: answer(200, { asset: 'os.example.com' }) }), 'os.example.com');
  assert.equal(await readOsAsset({ url, readToken, get: answer(200, { asset: '' }) }), null);
  assert.equal(await readOsAsset({ url, readToken, get: answer(503, {}) }), null);
  assert.equal(await readOsAsset({ url, readToken: async () => null, get: answer(200, { asset: 'x' }) }), null);
  assert.equal(await readOsAsset({ url, readToken, get: async () => { throw new Error('connect ECONNREFUSED'); } }), null);
});
