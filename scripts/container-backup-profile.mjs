import * as fs from 'node:fs';
import path from 'node:path';
import { VERIFIERS, URLS } from './postgres-secrets.mjs';

export const BACKUP_PATHS = Object.freeze({
  state: '/state', profile: '/run/backup-worker/profile.json', client: '/state/backup-client.json',
  transport: '/backup-transport', staging: '/backup-staging', data: '/dolt-data', spokes: '/spokes',
  postgresSocket: '/postgres-socket', postgresSecrets: '/run/postgres-secrets',
  doltSecrets: '/run/dolt-secrets', clientHome: '/tmp/backup-client-home',
  exporterHome: '/tmp/backup-exporter-home', offsite: '/backup-offsite/backups',
});
const refusal = () => { throw new Error('The declared backup worker is not prepared; no complete backup was published.'); };

export function privateBackupFile(file, io = fs, privateMode = true) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (privateMode && (stat.mode & 0o077)) || stat.size > 65536) refusal();
  return { text: io.readFileSync(file, 'utf8'), uid: stat.uid, gid: stat.gid };
}

export function readBackupWorker({ fs: io = fs } = {}) {
  try {
    const file = privateBackupFile(BACKUP_PATHS.profile, io);
    const profileDir = io.lstatSync(path.dirname(BACKUP_PATHS.profile));
    if (!profileDir.isDirectory() || profileDir.isSymbolicLink() || (profileDir.mode & 0o077) || profileDir.uid !== file.uid) refusal();
    const value = JSON.parse(file.text);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== 'format,retentionDays' || value.format !== 'noticeos-backup-worker-v1' ||
      !Number.isSafeInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 3650) refusal();
    for (const name of ['state', 'transport', 'staging', 'data', 'spokes', 'postgresSocket', 'postgresSecrets', 'doltSecrets']) {
      const stat = io.lstatSync(BACKUP_PATHS[name]);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refusal();
    }
    const client = privateBackupFile(BACKUP_PATHS.client, io);
    // Exporters run as the client inside the operator's private backup tree.
    // This profile supports one identity, so every protected parent is usable.
    if (client.uid !== file.uid || client.gid !== file.gid) refusal();
    const declaration = JSON.parse(client.text);
    if (declaration.format !== 'noticeos-backup-client-v1' || declaration.transportDir !== BACKUP_PATHS.transport ||
      Object.keys(declaration).sort().join() !== 'format,transportDir') refusal();
    const channel = io.lstatSync(BACKUP_PATHS.transport);
    if ((channel.mode & 0o077) || channel.uid !== client.uid) refusal();
    const bootstrap = privateBackupFile('/state/workers/ingest/.dev.secrets.json', io);
    const bindings = JSON.parse(bootstrap.text);
    const database = new URL(bindings.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== 'postgres' ||
      (database.port || '5432') !== '5432' || database.pathname !== '/noticeos' || !database.password ||
      typeof bindings.CREDENTIALS_KEY !== 'string' || !bindings.CREDENTIALS_KEY.trim() ||
      typeof bindings.OPERATOR_TOKEN !== 'string' || !bindings.OPERATOR_TOKEN.trim()) refusal();
    const pgDirectory = io.lstatSync(BACKUP_PATHS.postgresSecrets);
    if (pgDirectory.mode & 0o077) refusal();
    for (const name of VERIFIERS) {
      const credential = privateBackupFile(path.join(BACKUP_PATHS.postgresSecrets, name), io, false);
      if (!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+\n?$/u.test(credential.text)) refusal();
    }
    for (const name of Object.keys(URLS)) {
      const credential = privateBackupFile(path.join(BACKUP_PATHS.postgresSecrets, name), io);
      const address = new URL(credential.text.trim());
      if (!['postgres:', 'postgresql:'].includes(address.protocol) || !address.password || address.pathname !== '/noticeos') refusal();
    }
    for (const name of ['root', 'noticeos']) {
      const credential = privateBackupFile(path.join(BACKUP_PATHS.doltSecrets, name), io);
      if (!/^[0-9a-f]{64}\n$/u.test(credential.text)) refusal();
    }
    return { format: value.format, retentionDays: value.retentionDays, clientUid: client.uid, clientGid: client.gid,
      operatorUid: file.uid, operatorGid: file.gid };
  } catch { refusal(); }
}

export function backupWorkerEnvironment(env = process.env) {
  const selected = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']) if (env[key] !== undefined) selected[key] = env[key];
  return { ...selected, HOME: BACKUP_PATHS.clientHome, TMPDIR: '/tmp',
    NOTICEOS_HOME: BACKUP_PATHS.state, NOTICEOS_INSTALLATION_DIR: '/state/installation',
    BD_DISABLE_METRICS: '1', BD_DISABLE_ERROR_REPORTING: '1', DO_NOT_TRACK: '1', DOLT_DISABLE_EVENT_FLUSH: '1' };
}
