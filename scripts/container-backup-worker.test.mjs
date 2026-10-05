import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBackupClient, requestContainerBackup, readBackupRequest } from './container-backup-channel.mjs';
import { serviceBackupRequest } from './container-backup-worker.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-backup-worker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transportDir = path.join(root, 'transport'); await fs.mkdir(transportDir, { mode: 0o700 });
  const file = path.join(root, 'client.json');
  await fs.writeFile(file, JSON.stringify({ format: 'noticeos-backup-client-v1', transportDir }), { mode: 0o600 });
  const profile = await readBackupClient(file);
  const waiting = requestContainerBackup(file, { timeoutMs: 2000, intervalMs: 5 });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 1000;
    const check = async () => {
      try {
        if (await readBackupRequest(profile)) { resolve(); return; }
        if (Date.now() >= deadline) throw new Error('request missing');
        setTimeout(check, 5);
      } catch (error) { reject(error); }
    }; void check();
  });
  return { file, profile, waiting };
}

test('two workers cannot execute one request twice', async t => {
  const f = await fixture(t);
  let calls = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  const execute = async () => { calls++; await blocked; return { ok: true, detail: 'All required stages completed.' }; };
  const workers = [serviceBackupRequest(f.profile, execute), serviceBackupRequest(f.profile, execute)];
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.equal((await Promise.all(workers)).filter(Boolean).length, 1);
  assert.equal(calls, 1);
  assert.equal((await f.waiting).ok, true);
  assert.deepEqual(await fs.readdir(f.profile.transportDir), []);
});

test('a failed worker returns failure without raw diagnostics and retires only after completion', async t => {
  const f = await fixture(t);
  await serviceBackupRequest(f.profile, async () => { throw new Error('synthetic private diagnostic'); });
  const result = await f.waiting;
  assert.equal(result.ok, false);
  assert.match(result.detail, /previous complete set was preserved/u);
  assert.doesNotMatch(result.detail, /private diagnostic/u);
});

test('an existing worker claim is never inferred dead or removed', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.profile.transportDir, 'request.lock/worker.lock'), { mode: 0o700 });
  assert.equal(await serviceBackupRequest(f.profile, async () => assert.fail('must not execute')), false);
  // Finish through the channel only to clean this owned fixture; service
  // itself neither cleared the claim nor claimed a complete backup.
  const { finishBackupRequest } = await import('./container-backup-channel.mjs');
  await finishBackupRequest(f.profile, await readBackupRequest(f.profile), { ok: false, detail: 'Explicit owned fixture cleanup.' });
  assert.equal((await f.waiting).ok, false);
});

test('a request retired during worker acquisition cannot execute against its successor', async t => {
  const f = await fixture(t);
  const file = path.join(f.profile.transportDir, 'request.lock/request.json');
  const successor = { format: 'noticeos-backup-request-v1', id: randomUUID() };
  const io = { ...fs, mkdir: async (directory, options) => {
    if (directory.endsWith('/worker.lock')) await fs.writeFile(file, JSON.stringify(successor), { mode: 0o600 });
    return fs.mkdir(directory, options);
  } };
  assert.equal(await serviceBackupRequest(f.profile, async () => assert.fail('old request must not execute'), { fs: io }), false);
  assert.equal((await readBackupRequest(f.profile)).id, successor.id);
  await assert.rejects(fs.lstat(path.join(f.profile.transportDir, 'request.lock/worker.lock')), { code: 'ENOENT' });
  // This fixture deliberately replaced its waiting request, so its old
  // caller times out without touching the unfinished successor claim.
  assert.equal((await f.waiting).ok, false);
  assert.equal((await readBackupRequest(f.profile)).id, successor.id);
});
