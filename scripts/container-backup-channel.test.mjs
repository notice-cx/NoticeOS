import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readBackupClient, readBackupRequest, validateBackupRequest, finishBackupRequest, requestContainerBackup, containerBackupStatus } from './container-backup-channel.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-backup-channel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transportDir = path.join(root, 'transport');
  await fs.mkdir(transportDir, { mode: 0o700 });
  const file = path.join(root, 'client.json');
  await fs.writeFile(file, JSON.stringify({ format: 'noticeos-backup-client-v1', transportDir }), { mode: 0o600 });
  return { root, file, profile: await readBackupClient(file) };
}

async function requested(profile) {
  const deadline = Date.now() + 2000;
  return await new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const request = await readBackupRequest(profile);
        if (request) { resolve(request); return; }
        if (Date.now() >= deadline) throw new Error('owned request was not published');
        setTimeout(check, 5);
      } catch (error) { reject(error); }
    };
    void check();
  });
}

test('the private channel carries only a generated identity, and completion fences cleanup', async t => {
  const f = await fixture(t);
  const waiting = requestContainerBackup(f.file, { timeoutMs: 2000, intervalMs: 5 });
  const request = await requested(f.profile);
  assert.deepEqual(Object.keys(request).sort(), ['format', 'id']);
  assert.throws(() => validateBackupRequest({ ...request, command: 'unapproved' }), /unavailable/u);
  assert.throws(() => validateBackupRequest({ ...request, path: '/other' }), /unavailable/u);
  await finishBackupRequest(f.profile, request, { ok: true, detail: 'All required stores copied.' });
  assert.deepEqual(await waiting, { ok: true, detail: 'All required stores copied.' });
  assert.deepEqual(await fs.readdir(f.profile.transportDir), []);
});

test('simultaneous requests and a lost worker never remove the in-flight claim', async t => {
  const f = await fixture(t);
  const first = requestContainerBackup(f.file, { timeoutMs: 50, intervalMs: 5 });
  const request = await requested(f.profile);
  const second = await requestContainerBackup(f.file, { timeoutMs: 50, intervalMs: 5 });
  assert.equal(second.ok, false); assert.match(second.detail, /already in progress/u);
  assert.match((await first).detail, /timed out/u);
  assert.equal((await readBackupRequest(f.profile)).id, request.id);
  assert.ok((await fs.lstat(path.join(f.profile.transportDir, 'request.lock'))).isDirectory());
  const third = await requestContainerBackup(f.file, { timeoutMs: 50, intervalMs: 5 });
  assert.equal(third.ok, false); assert.match(third.detail, /already in progress/u);
});

test('an exact finished response permits recovery after a client timeout; failed backup results remain failures', async t => {
  const f = await fixture(t);
  const lost = requestContainerBackup(f.file, { timeoutMs: 30, intervalMs: 5 });
  const previous = await requested(f.profile);
  assert.equal((await lost).ok, false);
  await finishBackupRequest(f.profile, previous, { ok: false, detail: 'The previous complete set was preserved.' });
  const retry = requestContainerBackup(f.file, { timeoutMs: 2000, intervalMs: 5 });
  const deadline = Date.now() + 2000;
  let current;
  while (!(current = await readBackupRequest(f.profile)) || current.id === previous.id) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await finishBackupRequest(f.profile, current, { ok: false, detail: 'Database backup failed.' });
  assert.deepEqual(await retry, { ok: false, detail: 'Database backup failed.' });
  assert.deepEqual(await fs.readdir(f.profile.transportDir), []);
});

test('missing, insecure or symlinked declarations cannot fall through to a host backup', async t => {
  const f = await fixture(t);
  const missing = await requestContainerBackup(path.join(f.root, 'absent'));
  assert.equal(missing.ok, false); assert.match(missing.detail, /not configured or unavailable/u);
  await fs.chmod(f.file, 0o644);
  await assert.rejects(readBackupClient(f.file), /unavailable/u);
  await fs.chmod(f.file, 0o600);
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.file, alias);
  await assert.rejects(readBackupClient(alias), /unavailable/u);
});

test('an aliased request claim cannot write to or remove another private folder', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'other'); await fs.mkdir(other, { mode: 0o700 });
  await fs.writeFile(path.join(other, 'sentinel'), 'preserve', { mode: 0o600 });
  await fs.symlink(other, path.join(f.profile.transportDir, 'request.lock'));
  await assert.rejects(readBackupRequest(f.profile), /unavailable/u);
  assert.equal((await requestContainerBackup(f.file, { timeoutMs: 30, intervalMs: 5 })).ok, false);
  assert.deepEqual(await fs.readdir(other), ['sentinel']);
  assert.equal(await fs.readFile(path.join(other, 'sentinel'), 'utf8'), 'preserve');
});

test('health distinguishes missing declaration, unavailable worker and fresh private heartbeat without probing a foreign PID', async t => {
  const f = await fixture(t);
  assert.deepEqual(await containerBackupStatus(path.join(f.root, 'absent')), { configured: false, available: false, detail: 'Backups need a declared worker.' });
  assert.equal((await containerBackupStatus(f.file)).available, false);
  const now = Date.now();
  const heartbeat = path.join(f.profile.transportDir, 'worker-health.json');
  await fs.writeFile(heartbeat, JSON.stringify({ format: 'noticeos-backup-worker-health-v1', namespace: 'a'.repeat(64),
    pid: 2_000_000_000, ready: true, updatedAt: new Date(now).toISOString() }), { mode: 0o600 });
  assert.equal((await containerBackupStatus(f.file, { now: () => now })).available, true);
  assert.equal((await containerBackupStatus(f.file, { now: () => now + 15001 })).available, false);
  await fs.chmod(heartbeat, 0o644);
  assert.equal((await containerBackupStatus(f.file, { now: () => now })).available, false);
});
