import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import {
  cronFireDecision,
  doorOwnershipDecision,
  isDescendantOf,
  listenerOwnersArgs,
  parseListenerOwners,
  parseProcessParents,
  runtimeDoorOwnership,
} from './runner/door-ownership.mjs';

// scripts/runner/door-ownership.mjs: a cron fires only at a
// door this runner's own child holds. Everything here is fed recorded output;
// nothing asks the real lsof or ps.

const CONFIG = { ingestHost: '127.0.0.1', ingestPort: 8852 };

test('a runner with no child refuses the first and repeated ticks without a listener lookup', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    throw new Error('A missing child must not start a process lookup.');
  });
  syncBuiltinESMExports();
  try {
    for (const child of [{ proc: null }, {}, { proc: undefined }]) {
      const ownership = await runtimeDoorOwnership(child);
      assert.deepEqual(ownership, {
        owns: false,
        reason: `this runner has no ingest child holding ${osUp.CONFIG.ingestHost}:${osUp.CONFIG.ingestPort}`,
      });
      const tick = cronFireDecision({ running: true, ready: true, ownership }, '0 * * * *');
      assert.equal(tick.fire, false);
      assert.equal(tick.outcome, 'skipped');
    }
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test("lsof's field output becomes pid + group pairs, dropping half-read blocks", () => {
  assert.deepEqual(listenerOwnersArgs(8852), ['-nP', '-iTCP:8852', '-sTCP:LISTEN', '-F', 'pg']);
  assert.deepEqual(parseListenerOwners('p100\ng100\nfcwd\np200\np300\ng7\n'), [
    { pid: 100, pgid: 100 },
    { pid: 300, pgid: 7 },
  ]);
  assert.deepEqual(parseListenerOwners(''), []);
});

test('a descendant is found by walking parents, and a cycle cannot hang it', () => {
  const parents = parseProcessParents('  12   11\n 11 10\n10 1\n 20 21\n21 20\n');
  assert.equal(isDescendantOf(12, 10, parents), true);
  assert.equal(isDescendantOf(20, 10, parents), false);
});

test('ours by group, ours by tree, foreign, or unknown — each said as such', () => {
  const group = 500;
  assert.equal(doorOwnershipDecision({ owners: [{ pid: 501, pgid: 500 }], group }, CONFIG).owns, true);
  const tree = new Map([[700, 600], [600, 500]]);
  assert.equal(doorOwnershipDecision({ owners: [{ pid: 700, pgid: 700 }], group, parents: tree }, CONFIG).owns, true);
  assert.equal(doorOwnershipDecision({ owners: [{ pid: 900, pgid: 900 }], group }, CONFIG).owns, false);
  assert.equal(doorOwnershipDecision({ owners: null, group }, CONFIG).owns, null);
  assert.equal(doorOwnershipDecision({ owners: [], group: null }, CONFIG).owns, false);
});

test('a tick fires on an owned or unprovable door and stands down on a foreign one', () => {
  const down = cronFireDecision({ running: false, ready: false, ownership: null }, '0 * * * *');
  assert.deepEqual([down.fire, down.outcome, down.level], [false, 'skipped', 'WARN']);
  const foreign = cronFireDecision({ running: true, ready: true, ownership: { owns: false, reason: 'held elsewhere' } }, '0 * * * *');
  assert.deepEqual([foreign.fire, foreign.level], [false, 'ERROR']);
  assert.match(foreign.text, /STANDING DOWN: held elsewhere/u);
  const unproven = cronFireDecision({ running: true, ready: true, ownership: { owns: null, reason: 'no lsof' } }, '0 * * * *');
  assert.deepEqual([unproven.fire, unproven.level], [true, 'WARN']);
  const owned = cronFireDecision({ running: true, ready: true, ownership: { owns: true, reason: 'ours' } }, '0 * * * *');
  assert.deepEqual(owned, { fire: true, outcome: 'ran', detail: null, level: null, text: null });
});

test('os-up.mjs still offers the same door-ownership decisions', () => {
  assert.equal(osUp.cronFireDecision, cronFireDecision);
  assert.equal(osUp.doorOwnershipDecision, doorOwnershipDecision);
  assert.equal(osUp.isDescendantOf, isDescendantOf);
  assert.equal(osUp.listenerOwnersArgs, listenerOwnersArgs);
  assert.equal(osUp.parseListenerOwners, parseListenerOwners);
  assert.equal(osUp.parseProcessParents, parseProcessParents);
});
