import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerBackupStatus } from '../../scripts/container-backup-channel.mjs';

export async function containerHealthy({ read = () => fs.readFile('/state/.local/runner-state.json', 'utf8'), fetchImpl = fetch, now = Date.now,
  backupStatus = () => containerBackupStatus('/state/backup-client.json', { now }) } = {}) {
  try {
    const state = JSON.parse(await read());
    const age = now() - Date.parse(state.updatedAt);
    if (state.status !== 'healthy' || state.homeRoot !== '/state' || !state.towerReady || !state.schedulerArmed || !(age >= 0 && age <= 60000)) return false;
    const backup = await backupStatus();
    if (backup.configured && !backup.available) return false;
    for (const url of ['http://127.0.0.1:5173/api/health', 'http://127.0.0.1:8791/healthz']) {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      await response.body?.cancel();
    }
    return true;
  } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const backup = await containerBackupStatus('/state/backup-client.json');
  const healthy = await containerHealthy({ backupStatus: () => backup });
  process.stdout.write(JSON.stringify({ healthy, backup }) + '\n');
  process.exitCode = healthy ? 0 : 1;
}
