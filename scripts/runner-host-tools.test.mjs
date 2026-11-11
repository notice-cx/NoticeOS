import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { gitBin, lsofBin, probeTcp, resolveBin } from './runner/host-tools.mjs';

// scripts/runner/host-tools.mjs: finding git and lsof
// under a service's minimal PATH, and the TCP probe.

test('an override outranks every candidate; a blank one does not count', () => {
  const everywhere = () => true;
  assert.equal(resolveBin('/custom/git', ['/opt/homebrew/bin/git'], everywhere, 'git'), '/custom/git');
  assert.equal(resolveBin('   ', ['/opt/homebrew/bin/git'], everywhere, 'git'), '/opt/homebrew/bin/git');
});

test('the first candidate on disk wins, and the bare name is the last resort', () => {
  const only = (want) => (candidate) => candidate === want;
  assert.equal(resolveBin(undefined, ['/a/git', '/b/git'], only('/b/git'), 'git'), '/b/git');
  assert.equal(resolveBin(undefined, ['/a/git'], () => false, 'git'), 'git');
});

test('each tool reads its override when asked, not when the module loaded', () => {
  const names = { OS_UP_GIT_BIN: gitBin, OS_UP_LSOF_BIN: lsofBin };
  for (const [variable, find] of Object.entries(names)) {
    const saved = process.env[variable];
    process.env[variable] = `/pinned/${variable}`;
    try {
      assert.equal(find(), `/pinned/${variable}`);
    } finally {
      if (saved === undefined) delete process.env[variable];
      else process.env[variable] = saved;
    }
  }
});

test('the probe says yes to a listener and no once it is gone', async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    assert.equal(await probeTcp('127.0.0.1', port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeTcp('127.0.0.1', port, 500), false);
});
