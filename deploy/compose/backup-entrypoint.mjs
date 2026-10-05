import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BACKUP_PATHS, readBackupWorker, backupWorkerEnvironment } from '../../scripts/container-backup-profile.mjs';
import { readBackupClient } from '../../scripts/container-backup-channel.mjs';
import { serviceBackupRequest } from '../../scripts/container-backup-worker.mjs';
import { backupNamespace } from '../../scripts/backup-claim.mjs';
import { runBackup } from '../../scripts/host-backup.mjs';

export async function main() {
  let worker, client, namespace;
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error();
    worker = readBackupWorker(); client = await readBackupClient(BACKUP_PATHS.client);
    namespace = await backupNamespace();
    await fs.mkdir(BACKUP_PATHS.exporterHome, { recursive: true, mode: 0o700 });
    await fs.chown(BACKUP_PATHS.exporterHome, worker.clientUid, worker.clientGid);
    const selected = backupWorkerEnvironment();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, selected);
  } catch { process.stderr.write('Backup worker refused: prepare its private profile, mounts and credentials.\n'); return 1; }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const publish = async ready => {
    const temporary = path.join(BACKUP_PATHS.transport, `.worker-health-${randomUUID()}`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ format: 'noticeos-backup-worker-health-v1', namespace,
        pid: process.pid, ready, updatedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.chown(temporary, client.uid, client.gid);
      await fs.rename(temporary, path.join(BACKUP_PATHS.transport, 'worker-health.json'));
    } finally { await fs.rm(temporary, { force: true }); }
  };
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => { heartbeat = heartbeat.then(() => publish(true)).catch(() => { stopping = true; }); }, 2000);
  try {
    await publish(true);
    while (!stopping) {
      await serviceBackupRequest(client, () => runBackup({ repoRoot: '/state', retentionDays: worker.retentionDays, transport: 'container' }));
      if (!stopping) await new Promise(resolve => setTimeout(resolve, 250));
    }
    return 0;
  } catch { process.stderr.write('Backup worker stopped: review its protected request before retrying.\n'); return 1; }
  finally {
    clearInterval(timer); await heartbeat;
    try { await publish(false); } catch { /* Health becomes stale if its mount was lost. */ }
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
