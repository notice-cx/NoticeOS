import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupNamespace, claimBackup } from './backup-claim.mjs';

const namespace = 'a'.repeat(64);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-backup-claim-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function oldClaim(root, owner) {
  const directory = path.join(root, '.backup-claim-12345-fixture');
  await fs.mkdir(directory, { mode: 0o700 });
  if (owner) await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return directory;
}

test('namespace identity uses the Linux boot plus PID namespace, and macOS boot session', async () => {
  const linux = { platform: 'linux', readFile: async () => '11111111-1111-4111-8111-111111111111\n' };
  const one = await backupNamespace({ ...linux, readlink: async () => 'pid:[42]' });
  const two = await backupNamespace({ ...linux, readlink: async () => 'pid:[43]' });
  assert.notEqual(one, two);
  assert.match(one, /^[a-f0-9]{64}$/u);
  const mac = await backupNamespace({ platform: 'darwin', run: async (command, args) => {
    assert.equal(command, '/usr/sbin/sysctl'); assert.deepEqual(args, ['-n', 'kern.bootsessionuuid']);
    return { code: 0, stdout: '11111111-1111-4111-8111-111111111111\n' };
  } });
  assert.notEqual(mac, one);
  await assert.rejects(backupNamespace({ platform: 'unknown' }), /previous backup owner cannot be verified/u);
  await assert.rejects(backupNamespace({ platform: 'linux', readFile: async () => 'invalid' }), /previous backup owner cannot be verified/u);
});

for (const kind of ['foreign', 'legacy', 'malformed']) {
  test(`${kind} shared-storage claims cannot trigger a local PID probe or cleanup`, async t => {
    const root = await fixture(t);
    const old = await oldClaim(root, kind === 'legacy' ? null : {
      format: 'noticeos-backup-claim-v1', namespace: kind === 'foreign' ? 'b'.repeat(64) : namespace,
      pid: kind === 'malformed' ? '12345' : 12345,
    });
    let probes = 0;
    await assert.rejects(claimBackup(root, { namespace, kill: () => { probes++; } }), /previous backup owner cannot be verified/u);
    assert.equal(probes, 0);
    assert.deepEqual(await fs.readdir(root), [path.basename(old)]);
  });
}

test('only a dead owner in the same namespace can be recovered', async t => {
  const root = await fixture(t);
  await oldClaim(root, { format: 'noticeos-backup-claim-v1', namespace, pid: 12345 });
  const probes = [];
  const claim = await claimBackup(root, { namespace, kill: (pid, signal) => {
    probes.push([pid, signal]); throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  } });
  assert.deepEqual(probes, [[12345, 0]]);
  assert.deepEqual(await fs.readdir(root), [path.basename(claim.directory)]);
  await assert.rejects(claimBackup(root, { namespace }), /Another backup holds/u);
  await claim.release();
  assert.deepEqual(await fs.readdir(root), []);
});

test('simultaneous contenders never both acquire the backup publication claim', async t => {
  const root = await fixture(t);
  const results = await Promise.allSettled([claimBackup(root, { namespace }), claimBackup(root, { namespace })]);
  const owners = results.filter(result => result.status === 'fulfilled');
  assert.ok(owners.length <= 1);
  for (const owner of owners) await owner.value.release();
  assert.deepEqual(await fs.readdir(root), []);
});
