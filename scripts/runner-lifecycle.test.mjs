import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as osUp from './os-up.mjs';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_RUNTIME_COPY,
  MANAGED_ORPHAN_MAX_AGE_MS,
  beginShutdown,
  ingestDoorEnv,
  isShuttingDown,
  managedOrphanDecision,
  runnerArmDecision,
  runtimeCopyRefusal,
} from './runner/lifecycle.mjs';

// scripts/runner/lifecycle.mjs: whether this runner may
// start, and whether it is stopping. Nothing here probes a real port or signals
// a real process.

const CONFIG = { ingestHost: '127.0.0.1', ingestPort: 8853 };
const NOW = Date.parse('2026-09-24T10:00:00.000Z');

test('a free door arms this runner; a held one refuses and names both hazards', () => {
  const free = runnerArmDecision({ ingestPortAnswers: false }, CONFIG);
  assert.deepEqual([free.arm, free.level], [true, 'INFO']);
  const held = runnerArmDecision({ ingestPortAnswers: true }, CONFIG);
  assert.deepEqual([held.arm, held.level], [false, 'ERROR']);
  assert.match(held.text, /127\.0\.0\.1:8853/u);
  assert.match(held.text, /fire every cron TWICE/u);
  assert.match(held.text, /no children, no crons/u);
  assert.notEqual(EXIT_ALREADY_RUNNING, EXIT_RUNTIME_COPY);
});

test('only a fresh, dead, managed predecessor whose group holds the door is cleaned up', () => {
  const previous = { managed: true, pid: 41, towerPid: 42, updatedAt: new Date(NOW - 1_000).toISOString() };
  const owners = [{ pid: 43, pgid: 42 }];
  const base = { previous, previousRunnerAlive: false, owners, nowMs: NOW };
  assert.deepEqual(managedOrphanDecision(base).recover, true);
  assert.equal(managedOrphanDecision({ ...base, previousRunnerAlive: true }).recover, false);
  assert.equal(managedOrphanDecision({ ...base, owners: null }).recover, false);
  assert.equal(managedOrphanDecision({ ...base, owners: [{ pid: 9, pgid: 9 }] }).recover, false);
  assert.equal(managedOrphanDecision({ ...base, previous: { ...previous, managed: false } }).recover, false);
  const stale = new Date(NOW - MANAGED_ORPHAN_MAX_AGE_MS - 1).toISOString();
  assert.equal(managedOrphanDecision({ ...base, previous: { ...previous, updatedAt: stale } }).recover, false);
});

test('a runtime copy needs shared links but no legacy D1 file', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'runner-life-'));
  try {
    const copy = path.join(home, '.local', 'runtime', 'runtime-a');
    const linked = async () => ({ created: [], linked: [], conflicts: [] });
    assert.equal(await runtimeCopyRefusal({ codeRoot: home, homeRoot: home }), null, 'home proves nothing');
    assert.equal(await runtimeCopyRefusal({ codeRoot: copy, homeRoot: home, ensureLinks: linked }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the Tower child is told the door the scheduler fires at', () => {
  assert.deepEqual(ingestDoorEnv(CONFIG), { OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: '8853' });
});

test('live source needs the same checkout and shared state inodes before startup', async () => {
  const rows = {'/code':1,'/source':1,'/code/.local':2,'/state/.local':2,'/code/.wrangler':3,'/state/.wrangler':3};
  const fsp={lstat:async file=>({dev:8,ino:rows[file],isDirectory:()=>true})};
  const check=()=>runtimeCopyRefusal({codeRoot:'/code',homeRoot:'/state',liveSourceRoot:'/source',fsp,
    ensureLinks:()=>assert.fail('live mode must not create links in its read-only source')});
  assert.equal(await check(),null);
  rows['/code/.wrangler']=4;assert.match(await check(),/state mounts do not match/);
  rows['/code/.wrangler']=3;rows['/source']=5;assert.match(await check(),/state mounts do not match/);
});

test('os-up.mjs still offers the same lifecycle guards', () => {
  for (const name of ['EXIT_ALREADY_RUNNING', 'EXIT_RUNTIME_COPY', 'MANAGED_ORPHAN_MAX_AGE_MS', 'ingestDoorEnv',
    'managedOrphanDecision', 'runnerArmDecision', 'runtimeCopyRefusal']) {
    assert.ok(osUp[name] !== undefined, `os-up.mjs no longer exports ${name}`);
  }
  assert.equal(osUp.runnerArmDecision, runnerArmDecision);
  assert.equal(osUp.runtimeCopyRefusal, runtimeCopyRefusal);
});

// Last, because it cannot be undone inside this process.
test('one shutdown flag stops every lane that did not name its own stop signal', async () => {
  assert.equal(isShuttingDown(), false);
  beginShutdown();
  assert.equal(isShuttingDown(), true);
  const refused = await osUp.runPanelRefresh({ running: true, ready: true }, {
    run: () => assert.fail('a lane ran after shutdown began'),
    emit: () => {},
    state: { skipping: null, running: false },
  });
  assert.equal(refused, null);
});
