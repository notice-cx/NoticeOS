#!/usr/bin/env node
// Protected maintenance only. No service, SQL, schema, PATH or implicit retry.
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyStoppedDoltCapture } from './dolt-migration-capture.mjs';

const refuse = () => { throw new Error('Host task-client maintenance refused; preserve private receipts and partial resources.'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/u.test(value);
function directory(file, privateOwned = false) {
  for (let current = file; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (privateOwned && current === file && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) refuse();
    if (path.dirname(current) === current) break;
  }
}
function fileIdentity(file) {
  directory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size > 512 * 1024 ** 2) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd); if (opened.ino !== stat.ino || opened.dev !== stat.dev) refuse();
    const digest = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, bytes));
    return { device: opened.dev, inode: opened.ino, birthtimeMs: opened.birthtimeMs, uid: opened.uid, mode: opened.mode & 0o777, bytes: opened.size, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); }
}
const same = (left, right) => Object.entries(right).every(([key, value]) => left[key] === value);
const validIdentity = value => value && Object.keys(value).sort().join() === 'birthtimeMs,bytes,device,inode,mode,sha256,uid' &&
  ['bytes', 'device', 'inode', 'mode', 'uid'].every(key => Number.isInteger(value[key]) && value[key] >= 0) &&
  Number.isFinite(value.birthtimeMs) && value.mode <= 0o777 && /^[0-9a-f]{64}$/u.test(value.sha256);
function syncDirectory(folder) { const fd = fs.openSync(folder, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomicPrivateJson(file, value, initial = false) {
  directory(path.dirname(file), true);
  const temporary = initial ? file : `${file}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!initial) fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}
function privateJson(file) {
  const identity = fileIdentity(file); if ((identity.mode & 0o077) || identity.bytes > 64 * 1024) refuse();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function readPlan(file) {
  if (!absolute(file)) refuse();
  const plan = privateJson(file);
  if (plan.format !== 'noticeos-host-beads-install-v1' || !plan.approval || !plan.writerFence ||
    !['capture', 'entrypoint', 'backup', 'wrapper', 'gateReceipt', 'installReceipt'].every(key => absolute(plan[key])) ||
    !/^[0-9a-f]{64}$/u.test(plan.original?.sha256 ?? '') || !Number.isInteger(plan.original?.bytes) ||
    !Number.isInteger(plan.original?.mode) || plan.original.mode < 0 || plan.original.mode > 0o777 ||
    !Number.isInteger(plan.original?.uid) || !Array.isArray(plan.gates) || !plan.gates.length || plan.gates.length > 64 ||
    plan.gates.some(gate => !absolute(gate.path) || path.basename(gate.path) !== '.beads.gate.lock' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(gate.metadataName ?? '')) ||
    new Set(plan.gates.map(gate => gate.path)).size !== plan.gates.length ||
    new Set([plan.entrypoint, plan.backup, plan.wrapper, plan.gateReceipt, plan.installReceipt]).size !== 5) refuse();
  const marker = verifyStoppedDoltCapture(plan.capture);
  for (const output of [plan.entrypoint, plan.backup, plan.gateReceipt, plan.installReceipt, ...plan.gates.map(gate => gate.path)]) {
    if ([plan.capture, marker.sourceDirectory].some(protectedRoot => output === protectedRoot || output.startsWith(protectedRoot + path.sep))) refuse();
  }
  if (new Set([plan.entrypoint, plan.backup, plan.wrapper, plan.gateReceipt, plan.installReceipt, ...plan.gates.map(gate => gate.path)]).size !== 5 + plan.gates.length) refuse();
  for (const gate of plan.gates) {
    if (marker.metadataPresent[gate.metadataName] !== false ||
      !marker.sourceFiles.some(file => file.name === gate.metadataName && file.path === gate.path && file.required === false)) refuse();
  }
  return plan;
}

export function createHostWorkspaceGates(file) {
  const plan = readPlan(file);
  directory(path.dirname(plan.gateReceipt), true);
  for (const gate of plan.gates) {
    directory(path.dirname(gate.path));
    if (fs.lstatSync(gate.path, { throwIfNoEntry: false })) refuse();
  }
  const receipt = { format: 'noticeos-host-gates-v1', complete: false, capture: plan.capture, approval: plan.approval, writerFence: plan.writerFence, gates: [] };
  atomicPrivateJson(plan.gateReceipt, receipt, true);
  for (const gate of plan.gates) {
    const fd = fs.openSync(gate.path, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_RDWR, 0o600);
    let stat;
    try { fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); stat = fs.fstatSync(fd); } finally { fs.closeSync(fd); }
    receipt.gates.push({ path: gate.path, metadataName: gate.metadataName, originalAbsent: true,
      device: stat.dev, inode: stat.ino, birthtimeMs: stat.birthtimeMs, uid: stat.uid, mode: stat.mode & 0o777 });
    atomicPrivateJson(plan.gateReceipt, receipt);
  }
  receipt.complete = true; atomicPrivateJson(plan.gateReceipt, receipt);
  return { complete: true, gates: receipt.gates.length, receipt: plan.gateReceipt };
}

export function installHostBeads(file) {
  const plan = readPlan(file); const original = fileIdentity(plan.entrypoint);
  if (!same(original, plan.original) || fs.lstatSync(plan.backup, { throwIfNoEntry: false })) refuse();
  directory(path.dirname(plan.backup), true); directory(path.dirname(plan.installReceipt), true);
  const wrapper = fileIdentity(plan.wrapper); if (wrapper.bytes > 64 * 1024 || (wrapper.mode & 0o077)) refuse();
  const gates = privateJson(plan.gateReceipt);
  if (gates.format !== 'noticeos-host-gates-v1' || gates.complete !== true || gates.capture !== plan.capture ||
    gates.gates.length !== plan.gates.length || plan.gates.some(gate => !gates.gates.some(saved => saved.path === gate.path))) refuse();
  for (const saved of gates.gates) {
    const actual = fileIdentity(saved.path); if (!same(actual, { device: saved.device, inode: saved.inode, birthtimeMs: saved.birthtimeMs, uid: saved.uid, mode: saved.mode })) refuse();
  }
  const receipt = { format: 'noticeos-host-entrypoint-v1', complete: false, entrypoint: plan.entrypoint,
    backup: plan.backup, original, approval: plan.approval, writerFence: plan.writerFence };
  atomicPrivateJson(plan.installReceipt, receipt, true);
  fs.copyFileSync(plan.entrypoint, plan.backup, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(plan.backup, original.mode);
  const backup = fileIdentity(plan.backup); if (!same(backup, plan.original)) refuse();
  const backupFd = fs.openSync(plan.backup, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
  syncDirectory(path.dirname(plan.backup));
  const temporary = path.join(path.dirname(plan.entrypoint), `.noticeos-bd-${randomBytes(16).toString('hex')}`);
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_WRONLY, 0o700);
  try { fs.writeFileSync(fd, fs.readFileSync(plan.wrapper)); fs.fchmodSync(fd, 0o700); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  receipt.installed = fileIdentity(temporary);
  if (receipt.installed.sha256 !== wrapper.sha256 || !same(fileIdentity(plan.entrypoint), original)) refuse();
  atomicPrivateJson(plan.installReceipt, receipt);
  fs.renameSync(temporary, plan.entrypoint); syncDirectory(path.dirname(plan.entrypoint));
  receipt.complete = true; atomicPrivateJson(plan.installReceipt, receipt);
  return { complete: true, entrypoint: plan.entrypoint, receipt: plan.installReceipt };
}

function rollbackGates(plan, partial = false) {
  const gates = privateJson(plan.gateReceipt);
  if (gates.format !== 'noticeos-host-gates-v1' || gates.capture !== plan.capture || !Array.isArray(gates.gates) ||
    (partial ? gates.gates.length > plan.gates.length : gates.gates.length !== plan.gates.length) ||
    new Set(gates.gates.map(gate => gate.path)).size !== gates.gates.length) refuse();
  for (const gate of gates.gates) {
    if (gate.originalAbsent !== true || !plan.gates.some(expected => expected.path === gate.path && expected.metadataName === gate.metadataName)) refuse();
  }
  return gates;
}
const gateIdentity = gate => ({ device: gate.device, inode: gate.inode, birthtimeMs: gate.birthtimeMs, uid: gate.uid, mode: gate.mode });
function preflightGateCleanup(gates, receipt) {
  const intents = receipt.gateRemovalIntents ?? [];
  if (!Array.isArray(intents) || new Set(intents).size !== intents.length || intents.some(file => !gates.gates.some(gate => gate.path === file))) refuse();
  for (const gate of gates.gates) {
    if (!fs.lstatSync(gate.path, { throwIfNoEntry: false })) { if (!intents.includes(gate.path)) refuse(); }
    else if (!same(fileIdentity(gate.path), gateIdentity(gate))) refuse();
  }
}
function finishGateCleanup(plan, gates, receipt, save, entrypoint) {
  preflightGateCleanup(gates, receipt);
  receipt.gateRemovalIntents ??= [];
  for (const gate of gates.gates) {
    if (!same(fileIdentity(plan.entrypoint), entrypoint)) refuse();
    if (!fs.lstatSync(gate.path, { throwIfNoEntry: false })) { syncDirectory(path.dirname(gate.path)); continue; }
    if (!same(fileIdentity(gate.path), gateIdentity(gate))) refuse();
    if (!receipt.gateRemovalIntents.includes(gate.path)) {
      receipt.gateRemovalIntents.push(gate.path); save();
    }
    if (fs.lstatSync(gate.path, { throwIfNoEntry: false })) {
      if (!same(fileIdentity(gate.path), gateIdentity(gate))) refuse();
      fs.unlinkSync(gate.path);
    }
    syncDirectory(path.dirname(gate.path));
  }
  receipt.rollbackComplete = true; save();
}

export function rollbackHostBeads(file) {
  const plan = readPlan(file); const receipt = privateJson(plan.installReceipt);
  if (receipt.format !== 'noticeos-host-entrypoint-v1' || receipt.entrypoint !== plan.entrypoint || receipt.backup !== plan.backup ||
    !validIdentity(receipt.installed) || !same(fileIdentity(plan.backup), plan.original) ||
    (receipt.restored && (!validIdentity(receipt.restored) || !same(receipt.restored, plan.original)))) refuse();
  const current = fileIdentity(plan.entrypoint);
  if (!same(current, receipt.installed) && (!receipt.restored || !same(current, receipt.restored))) refuse();
  const gates = rollbackGates(plan); preflightGateCleanup(gates, receipt);
  const save = () => atomicPrivateJson(plan.installReceipt, receipt);
  if (receipt.restoreTemporary) {
    if (!receipt.restored || path.dirname(receipt.restoreTemporary) !== path.dirname(plan.entrypoint) ||
      !/^\.noticeos-bd-rollback-[0-9a-f]{32}$/u.test(path.basename(receipt.restoreTemporary))) refuse();
    if (fs.lstatSync(receipt.restoreTemporary, { throwIfNoEntry: false })) {
      if (!same(fileIdentity(receipt.restoreTemporary), receipt.restored)) refuse();
    } else if (!same(current, receipt.restored)) refuse();
  }
  if (!receipt.restored || !same(current, receipt.restored)) {
    if (receipt.restored && !receipt.restoreTemporary) refuse();
    const temporary = receipt.restoreTemporary ?? path.join(path.dirname(plan.entrypoint), `.noticeos-bd-rollback-${randomBytes(16).toString('hex')}`);
    if (!receipt.restoreTemporary) {
      fs.copyFileSync(plan.backup, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(temporary, plan.original.mode);
      const fd = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      receipt.restored = fileIdentity(temporary);
      if (!same(receipt.restored, plan.original)) refuse();
      receipt.restoreTemporary = temporary; save();
    }
    if (!same(fileIdentity(plan.entrypoint), receipt.installed)) refuse();
    fs.renameSync(temporary, plan.entrypoint);
  } else if (receipt.restoreTemporary && fs.lstatSync(receipt.restoreTemporary, { throwIfNoEntry: false })) refuse();
  syncDirectory(path.dirname(plan.entrypoint)); receipt.restoreTemporary = null; save();
  finishGateCleanup(plan, gates, receipt, save, receipt.restored);
  return { restored: true, originalSha256: plan.original.sha256, removedCreatedGates: gates.gates.length,
    custody: 'Original backup, adapter, capture and receipts retained.' };
}

/** Early rollback when installation has not replaced the old entrypoint.
 * Delete only journaled inodes; an unjournaled partial resource stays private
 * for explicit recovery rather than being adopted or guessed away. */
export function rollbackHostWorkspaceGates(file) {
  const plan = readPlan(file);
  const original = fileIdentity(plan.entrypoint); if (!same(original, plan.original)) refuse();
  const receipt = rollbackGates(plan, true); preflightGateCleanup(receipt, receipt);
  if (receipt.rollbackEntrypoint && (!validIdentity(receipt.rollbackEntrypoint) || !same(original, receipt.rollbackEntrypoint))) refuse();
  receipt.rollbackEntrypoint ??= original;
  const save = () => atomicPrivateJson(plan.gateReceipt, receipt);
  save(); finishGateCleanup(plan, receipt, receipt, save, receipt.rollbackEntrypoint);
  return { restored: true, originalEntrypointUnchanged: true, removedCreatedGates: receipt.gates.length,
    custody: 'Any unjournaled partial files, adapter, capture and receipts retained.' };
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 3 || argv[1] !== '--plan' || !['gates', 'install', 'rollback', 'rollback-gates'].includes(argv[0])) refuse();
    const operation = { gates: createHostWorkspaceGates, install: installHostBeads, rollback: rollbackHostBeads, 'rollback-gates': rollbackHostWorkspaceGates }[argv[0]];
    process.stdout.write(JSON.stringify(operation(argv[2]), null, 2) + '\n'); return 0;
  } catch { process.stderr.write('Host task-client maintenance refused. Preserve receipts and partial resources; no automatic retry.\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
