import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import { bdBin, gitBin, lsofBin, probeTcp, resolveBin } from './runner/host-tools.mjs';

// scripts/runner/host-tools.mjs: finding bd, git and lsof
// under launchd's bare PATH, and the TCP probe.

/** A port in this suite's own range, so a parallel run elsewhere never collides. */
const PORT = 8851;

test('an override outranks every candidate; a blank one does not count', () => {
  const everywhere = () => true;
  assert.equal(resolveBin('/custom/bd', ['/opt/homebrew/bin/bd'], everywhere, 'bd'), '/custom/bd');
  assert.equal(resolveBin('   ', ['/opt/homebrew/bin/bd'], everywhere, 'bd'), '/opt/homebrew/bin/bd');
});

test('the first candidate on disk wins, and the bare name is the last resort', () => {
  const only = (want) => (candidate) => candidate === want;
  assert.equal(resolveBin(undefined, ['/a/bd', '/b/bd'], only('/b/bd'), 'bd'), '/b/bd');
  assert.equal(resolveBin(undefined, ['/a/bd'], () => false, 'bd'), 'bd');
});

test('each tool reads its override when asked, not when the module loaded', () => {
  const names = { BEADS_BD_BIN: bdBin, OS_UP_GIT_BIN: gitBin, OS_UP_LSOF_BIN: lsofBin };
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
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  try {
    assert.equal(await probeTcp('127.0.0.1', PORT), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeTcp('127.0.0.1', PORT, 500), false);
});

test('os-up.mjs still offers the same resolveBin, bdBin and probeTcp', () => {
  assert.equal(osUp.resolveBin, resolveBin);
  assert.equal(osUp.bdBin, bdBin);
  assert.equal(osUp.probeTcp, probeTcp);
});
