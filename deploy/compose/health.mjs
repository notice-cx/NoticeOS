import fs from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containerBackupStatus } from '../../scripts/container-backup-channel.mjs';
import { composeCustomerPlan, customerReadinessPath, runningContainerProfile } from './customer-entry.mjs';

export function customerReadinessStatus(url, { host, signal }) {
  return new Promise((resolve, reject) => {
    const probe = request(url, { headers: { host }, signal }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    probe.once('error', reject);
    probe.end();
  });
}

export async function containerHealthy({ read = () => fs.readFile('/state/.local/runner-state.json', 'utf8'), fetchImpl = fetch, now = Date.now,
  profile = () => 'standalone', env = process.env, customerProbe = customerReadinessStatus,
  backupStatus = () => containerBackupStatus('/state/backup-client.json', { now }) } = {}) {
  try {
    const active = profile();
    if (active === 'customer') {
      if ((await backupStatus()).configured) return false;
      const { url } = composeCustomerPlan(env);
      const status = await customerProbe(`http://127.0.0.1:5173${customerReadinessPath}`, {
        host: new URL(url).host, signal: AbortSignal.timeout(2000),
      });
      return status === 204;
    }
    if (active !== 'standalone') return false;
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
  const healthy = await containerHealthy({ profile: runningContainerProfile, backupStatus: () => backup });
  process.stdout.write(JSON.stringify({ healthy, backup }) + '\n');
  process.exitCode = healthy ? 0 : 1;
}
