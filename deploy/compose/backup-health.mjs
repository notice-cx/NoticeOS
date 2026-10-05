import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_PATHS, privateBackupFile, readBackupWorker } from '../../scripts/container-backup-profile.mjs';
import { backupNamespace } from '../../scripts/backup-claim.mjs';

export async function healthy() {
  try {
    const profile = readBackupWorker();
    const file = privateBackupFile(path.join(BACKUP_PATHS.transport, 'worker-health.json'));
    const value = JSON.parse(file.text);
    if (file.uid !== profile.clientUid || value.format !== 'noticeos-backup-worker-health-v1' || value.ready !== true ||
      value.namespace !== await backupNamespace() || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return false;
    const age = Date.now() - Date.parse(value.updatedAt);
    if (age < 0 || age > 15_000) return false;
    process.kill(value.pid, 0); // Exact verified PID namespace, never a foreign claim.
    return true;
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await healthy() ? 0 : 1;
