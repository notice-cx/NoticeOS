import assert from 'node:assert/strict';
import test from 'node:test';
import { towerDependenciesReady, towerLaunch } from './runner/tower-launch.mjs';

test('one direct installed runtime preserves the supervisor group on every host', () => {
  assert.deepEqual(towerLaunch('/prepared/source', '/own/node'), {
    command: '/own/node', cwd: '/prepared/source/apps/tower',
    entry: '/prepared/source/apps/tower/node_modules/vite/bin/vite.js',
  });
});

test('dependency refusal, unavailable pnpm and timeout never authorize runtime launch', async () => {
  for (const code of [1, 127, 124]) {
    const calls = [];
    const ready = await towerDependenciesReady({ root: '/prepared/source', env: { PATH: '/own/tools' }, run: async (...args) => { calls.push(args); return { code }; } });
    assert.equal(ready, false);
    assert.deepEqual(calls, [['pnpm', ['exec', process.execPath, '--version'], {
      cwd: '/prepared/source', env: { PATH: '/own/tools' }, timeoutMs: 30_000,
    }]]);
  }
  assert.equal(await towerDependenciesReady({ root: '/prepared/source', run: async () => ({ code: 0 }) }), true);
});
