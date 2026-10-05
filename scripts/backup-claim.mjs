// Backup claims cross shared storage but PIDs do not cross kernel namespaces.
// Only an exact verified namespace permits a local liveness probe or cleanup.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runCommand } from './run-command.mjs';

const active = new Set();
const hash = value => createHash('sha256').update(value).digest('hex');
export const BACKUP_OWNER_FAILURE = Object.freeze({ code: 'NOTICEOS_BACKUP_OWNER_UNVERIFIED',
  detail: 'Backup paused: a previous backup owner cannot be verified. Review its lock before retrying.' });
const blocked = () => Object.assign(new Error(BACKUP_OWNER_FAILURE.detail), { code: BACKUP_OWNER_FAILURE.code });

export async function backupNamespace({ platform = process.platform, readFile = fs.readFile, readlink = fs.readlink, run = runCommand } = {}) {
  try {
    if (platform === 'linux') {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const pid = await readlink('/proc/self/ns/pid');
      if (!/^[0-9a-f-]{36}$/u.test(boot) || !/^pid:\[\d+\]$/u.test(pid)) throw blocked();
      return hash(`linux:${boot}:${pid}`);
    }
    if (platform === 'darwin') {
      const result = await run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeoutMs: 5000 });
      const boot = result.stdout?.trim();
      if (result.code !== 0 || !/^[0-9a-f-]{36}$/iu.test(boot ?? '')) throw blocked();
      return hash(`darwin:${boot.toLowerCase()}`);
    }
    throw blocked();
  } catch { throw blocked(); }
}

export async function claimBackup(root, { fs: io = fs, namespace, pid = process.pid, kill = process.kill } = {}) {
  namespace ??= await backupNamespace();
  if (!/^[0-9a-f]{64}$/u.test(namespace) || !Number.isSafeInteger(pid) || pid < 1) throw blocked();
  const name = `.backup-claim-${pid}-${randomUUID()}`;
  const directory = path.join(root, name);
  await io.mkdir(directory, { mode: 0o700 });
  active.add(directory);
  try {
    await io.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ format: 'noticeos-backup-claim-v1', namespace, pid }), { flag: 'wx', mode: 0o600 });
    // Create before scanning: contenders may both decline, never both proceed.
    for (const other of await io.readdir(root)) {
      if (other === name || !/^\.backup-claim-\d+-/u.test(other)) continue;
      const previous = path.join(root, other);
      let owner;
      try {
        const dir = await io.lstat(previous);
        const file = path.join(previous, 'owner.json');
        const stat = await io.lstat(file);
        if (!dir.isDirectory() || dir.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 1000) throw blocked();
        owner = JSON.parse(await io.readFile(file, 'utf8'));
      } catch { throw blocked(); }
      if (!owner || Object.keys(owner).sort().join() !== 'format,namespace,pid' ||
        owner.format !== 'noticeos-backup-claim-v1' || owner.namespace !== namespace ||
        !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !other.startsWith(`.backup-claim-${owner.pid}-`)) throw blocked();
      let alive = active.has(previous);
      if (owner.pid !== pid) {
        try { kill(owner.pid, 0); alive = true; }
        catch (error) { alive = error.code !== 'ESRCH'; }
      }
      if (alive) throw new Error(`Another backup holds the host claim (PID ${owner.pid})`);
      await io.rm(previous, { recursive: true, force: true });
    }
    return { directory, release: async () => {
      try { await io.rm(directory, { recursive: true, force: true }); }
      finally { active.delete(directory); }
    } };
  } catch (error) {
    try { await io.rm(directory, { recursive: true, force: true }); }
    finally { active.delete(directory); }
    throw error;
  }
}
