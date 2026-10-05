import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { captureStoppedDoltSource } from './dolt-migration-capture.mjs';
import { createHostWorkspaceGates, installHostBeads, rollbackHostBeads, rollbackHostWorkspaceGates } from './host-beads-install.mjs';

async function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-host-install-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'); fs.mkdirSync(path.join(source, 'synthetic_tasks/.dolt'), { recursive: true });
  fs.writeFileSync(path.join(source, 'synthetic_tasks/.dolt/chunk'), 'Synthetic immutable native data');
  const gates = ['first', 'second'].map(name => {
    const repo = path.join(base, name); fs.mkdirSync(repo, { mode: 0o700 });
    return { path: path.join(repo, '.beads.gate.lock'), metadataName: name + '-gate' };
  });
  const capture = path.join(base, 'capture');
  await captureStoppedDoltSource({ sourceDirectory: source, outputDirectory: capture, sourceVersion: '2.2.3', databases: ['synthetic_tasks'],
    service: { brew: '/synthetic/bin/brew', home: base, name: 'dolt', label: 'synthetic.dolt' },
    files: gates.map(gate => ({ name: gate.metadataName, path: gate.path, required: false })), approval: 'Synthetic test only', writerFence: 'No clients exist' },
  { run: async () => ({ code: 0, stdout: JSON.stringify([{ name: 'dolt', service_name: 'synthetic.dolt', running: false, loaded: false, schedulable: false, pid: null, status: 'none' }]) }) });
  const entrypoint = path.join(base, 'bd'); const old = 'Synthetic original host binary bytes'; fs.writeFileSync(entrypoint, old, { mode: 0o755 });
  const wrapper = path.join(base, 'wrapper'); const shim = '#!/bin/sh\n# Synthetic bundle adapter\n'; fs.writeFileSync(wrapper, shim, { mode: 0o700 });
  const plan = { format: 'noticeos-host-beads-install-v1', capture, entrypoint, wrapper, backup: path.join(base, 'bd-original'),
    gateReceipt: path.join(base, 'gates.json'), installReceipt: path.join(base, 'installed.json'), gates,
    approval: 'Synthetic test only', writerFence: 'No clients exist', original: { uid: process.getuid(), mode: 0o755, bytes: Buffer.byteLength(old), sha256: createHash('sha256').update(old).digest('hex') } };
  const file = path.join(base, 'plan.json'); fs.writeFileSync(file, JSON.stringify(plan), { mode: 0o600 });
  return { base, plan, file, old, shim };
}

test('exclusive shared gates and atomic entrypoint install retain identities and restore exact old bytes/mode', async t => {
  const f = await fixture(t);
  assert.equal(createHostWorkspaceGates(f.file).gates, 2);
  const gates = JSON.parse(fs.readFileSync(f.plan.gateReceipt));
  for (const gate of gates.gates) {
    assert.equal(gate.originalAbsent, true); assert.equal(gate.inode, fs.statSync(gate.path).ino);
    assert.equal(fs.statSync(gate.path).mode & 0o777, 0o600);
  }
  const beforeInode = fs.statSync(f.plan.entrypoint).ino;
  assert.equal(installHostBeads(f.file).complete, true);
  assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.shim);
  assert.notEqual(fs.statSync(f.plan.entrypoint).ino, beforeInode, 'Replacement is a new inode, never a partially overwritten executable');
  assert.equal(fs.readFileSync(f.plan.backup, 'utf8'), f.old); assert.equal(fs.statSync(f.plan.backup).mode & 0o777, 0o755);
  const installed = JSON.parse(fs.readFileSync(f.plan.installReceipt));
  assert.equal(installed.installed.inode, fs.statSync(f.plan.entrypoint).ino);
  assert.equal(rollbackHostBeads(f.file).removedCreatedGates, 2);
  assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.old); assert.equal(fs.statSync(f.plan.entrypoint).mode & 0o777, 0o755);
  for (const gate of f.plan.gates) assert.equal(fs.existsSync(gate.path), false);
  assert.equal(fs.existsSync(f.plan.backup), true); assert.equal(fs.existsSync(f.plan.wrapper), true);
  assert.equal(fs.existsSync(f.plan.capture), true); assert.equal(fs.existsSync(f.plan.gateReceipt), true);
});

test('an existing or linked gate refuses without truncation, partial receipt or any other gate creation', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t); const gate = f.plan.gates[0].path;
    if (linked) fs.symlinkSync(f.plan.wrapper, gate); else fs.writeFileSync(gate, 'Original gate content');
    assert.throws(() => createHostWorkspaceGates(f.file));
    assert.equal(fs.readFileSync(linked ? f.plan.wrapper : gate, 'utf8'), linked ? f.shim : 'Original gate content');
    assert.equal(fs.existsSync(f.plan.gates[1].path), false); assert.equal(fs.existsSync(f.plan.gateReceipt), false);
  }
});

test('unprotected plans, changed originals, existing backups and immutable-capture write destinations are refused', async t => {
  const f = await fixture(t);
  fs.chmodSync(f.file, 0o644); assert.throws(() => createHostWorkspaceGates(f.file)); fs.chmodSync(f.file, 0o600);
  const unsafe = { ...f.plan, gateReceipt: path.join(f.plan.capture, 'new-receipt.json') };
  fs.writeFileSync(f.file, JSON.stringify(unsafe)); assert.throws(() => createHostWorkspaceGates(f.file));
  fs.writeFileSync(f.file, JSON.stringify(f.plan)); createHostWorkspaceGates(f.file);
  assert.throws(() => createHostWorkspaceGates(f.file), 'No automatic gate adoption or retry');
  fs.appendFileSync(f.plan.entrypoint, 'Concurrent change'); assert.throws(() => installHostBeads(f.file));
  assert.equal(fs.existsSync(f.plan.installReceipt), false); assert.equal(fs.existsSync(f.plan.backup), false);
  fs.writeFileSync(f.plan.entrypoint, f.old); fs.writeFileSync(f.plan.backup, 'Existing unknown backup');
  assert.throws(() => installHostBeads(f.file)); assert.equal(fs.readFileSync(f.plan.backup, 'utf8'), 'Existing unknown backup');
});

test('rollback refuses an unknown entrypoint or gate inode without modifying originals, current files or custody', async t => {
  for (const change of ['entrypoint', 'gate']) {
    const f = await fixture(t); createHostWorkspaceGates(f.file); installHostBeads(f.file);
    if (change === 'entrypoint') fs.appendFileSync(f.plan.entrypoint, 'Later unknown change');
    else { fs.unlinkSync(f.plan.gates[0].path); fs.writeFileSync(f.plan.gates[0].path, 'Unknown replacement gate', { mode: 0o600 }); }
    const before = fs.readFileSync(f.plan.entrypoint);
    assert.throws(() => rollbackHostBeads(f.file));
    assert.deepEqual(fs.readFileSync(f.plan.entrypoint), before); assert.equal(fs.existsSync(f.plan.gates[1].path), true);
    assert.equal(fs.readFileSync(f.plan.backup, 'utf8'), f.old);
  }
});

test('early rollback removes only journaled gates when the original host entrypoint still matches', async t => {
  const f = await fixture(t); createHostWorkspaceGates(f.file);
  assert.equal(rollbackHostWorkspaceGates(f.file).removedCreatedGates, 2);
  assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.old);
  assert.equal(fs.existsSync(f.plan.installReceipt), false);
  const second = await fixture(t); createHostWorkspaceGates(second.file); installHostBeads(second.file);
  assert.throws(() => rollbackHostWorkspaceGates(second.file), 'An installed wrapper must be rolled back before removing its workspace gates');
  assert.equal(fs.existsSync(second.plan.gates[0].path), true);
});

function interruptRollback(fixture, point, operation) {
  const rename = mutableFs.renameSync; const unlink = mutableFs.unlinkSync;
  mutableFs.renameSync = (from, to) => {
    rename(from, to);
    if (point === 'restore' && to === fixture.plan.entrypoint) throw Error('Synthetic loss after original entrypoint rename');
  };
  mutableFs.unlinkSync = file => {
    unlink(file);
    if (point === 'gate' && file === fixture.plan.gates[0].path) throw Error('Synthetic loss after first gate unlink');
  };
  syncBuiltinESMExports();
  try { assert.throws(operation, /Synthetic loss/u); }
  finally { mutableFs.renameSync = rename; mutableFs.unlinkSync = unlink; syncBuiltinESMExports(); }
}

test('explicit rollback resumes after original rename or partial gate cleanup using journaled identities', async t => {
  for (const point of ['restore', 'gate']) {
    const f = await fixture(t); createHostWorkspaceGates(f.file); installHostBeads(f.file);
    const unrelated = path.join(f.base, 'unrelated'); fs.writeFileSync(unrelated, 'Unrelated custody');
    interruptRollback(f, point, () => rollbackHostBeads(f.file));
    const receipt = JSON.parse(fs.readFileSync(f.plan.installReceipt));
    assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.old);
    assert.equal(receipt.restored.inode, fs.statSync(f.plan.entrypoint).ino);
    if (point === 'restore') {
      assert.ok(receipt.restoreTemporary); assert.equal(fs.existsSync(receipt.restoreTemporary), false);
    } else {
      assert.deepEqual(receipt.gateRemovalIntents, [f.plan.gates[0].path]);
      assert.equal(fs.existsSync(f.plan.gates[0].path), false);
    }
    assert.equal(fs.existsSync(f.plan.gates[1].path), true);
    assert.equal(rollbackHostBeads(f.file).removedCreatedGates, 2);
    assert.equal(rollbackHostBeads(f.file).restored, true, 'completed cleanup remains an explicit safe no-op');
    for (const gate of f.plan.gates) assert.equal(fs.existsSync(gate.path), false);
    assert.equal(JSON.parse(fs.readFileSync(f.plan.installReceipt)).rollbackComplete, true);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Unrelated custody');
    assert.equal(fs.readFileSync(f.plan.backup, 'utf8'), f.old);
  }
});

test('resumed rollback refuses independently replaced entrypoints or retired gate paths without further cleanup', async t => {
  for (const change of ['entrypoint', 'retired-gate', 'remaining-gate']) {
    const f = await fixture(t); createHostWorkspaceGates(f.file); installHostBeads(f.file);
    interruptRollback(f, 'gate', () => rollbackHostBeads(f.file));
    let changed;
    if (change === 'entrypoint') {
      changed = f.plan.entrypoint; fs.renameSync(changed, changed + '.held'); fs.writeFileSync(changed, f.old, { mode: 0o755 });
    } else {
      changed = f.plan.gates[change === 'retired-gate' ? 0 : 1].path;
      if (fs.existsSync(changed)) fs.renameSync(changed, changed + '.held');
      fs.writeFileSync(changed, '', { mode: 0o600 });
    }
    const inode = fs.statSync(changed).ino;
    assert.throws(() => rollbackHostBeads(f.file));
    assert.equal(fs.statSync(changed).ino, inode);
    assert.equal(fs.existsSync(f.plan.gates[1].path), true);
    assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.old);
    assert.equal(fs.readFileSync(f.plan.backup, 'utf8'), f.old);
  }
});

test('early gates-only rollback resumes partial cleanup and refuses foreign gate replacements', async t => {
  const f = await fixture(t); createHostWorkspaceGates(f.file);
  interruptRollback(f, 'gate', () => rollbackHostWorkspaceGates(f.file));
  assert.equal(fs.existsSync(f.plan.gates[0].path), false);
  assert.equal(rollbackHostWorkspaceGates(f.file).removedCreatedGates, 2);
  assert.equal(fs.existsSync(f.plan.gates[1].path), false);
  assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), f.old);
  const foreign = await fixture(t); createHostWorkspaceGates(foreign.file);
  interruptRollback(foreign, 'gate', () => rollbackHostWorkspaceGates(foreign.file));
  fs.writeFileSync(foreign.plan.gates[0].path, '', { mode: 0o600 });
  assert.throws(() => rollbackHostWorkspaceGates(foreign.file));
  assert.equal(fs.existsSync(foreign.plan.gates[0].path), true);
  assert.equal(fs.existsSync(foreign.plan.gates[1].path), true);
});

test('an incomplete executable identity in the rollback journal cannot act as a wildcard', async t => {
  const f = await fixture(t); createHostWorkspaceGates(f.file); installHostBeads(f.file);
  const receipt = JSON.parse(fs.readFileSync(f.plan.installReceipt)); receipt.installed = {};
  fs.writeFileSync(f.plan.installReceipt, JSON.stringify(receipt));
  fs.writeFileSync(f.plan.entrypoint, 'Synthetic independent replacement');
  assert.throws(() => rollbackHostBeads(f.file));
  assert.equal(fs.readFileSync(f.plan.entrypoint, 'utf8'), 'Synthetic independent replacement');
  for (const gate of f.plan.gates) assert.equal(fs.existsSync(gate.path), true);
});
