// One snapshot format for native and container transports and restore checks.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { DOLT_IMAGE, DOLT_VERSION } from './dolt-host.mjs';

export const DOLT_METADATA_NAMES = ['privileges.db', 'branch_control.db', 'server-config.json', 'global-config.json'];
export const DOLT_DATABASE_METADATA_NAMES = ['config.json', 'repo_state.json'];
const fail = () => { throw new Error('Dolt backup could not complete; no complete snapshot was published.'); };

export function checkedBackupDatabases(databases) {
  if (!Array.isArray(databases) || !databases.length || new Set(databases).size !== databases.length ||
    databases.some(name => typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(name))) fail();
  return databases;
}

export function doltBackupInventory(root, prefix = '', harden = true) {
  const files = {};
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail();
    if (entry.isDirectory()) Object.assign(files, doltBackupInventory(root, name, harden));
    else {
      const stat = fs.lstatSync(path.join(root, name));
      if (stat.nlink !== 1) fail();
      if (harden) fs.chmodSync(path.join(root, name), 0o600);
      const data = fs.readFileSync(path.join(root, name));
      files[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    }
  }
  return files;
}

export function doltMetadataPresent(root, name, required = false) {
  const file = path.join(root, name);
  const absent = `${file}.absent`;
  const present = fs.existsSync(file);
  if (present === fs.existsSync(absent) || (required && !present)) fail();
  const stat = fs.lstatSync(present ? file : absent);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (required && stat.size === 0) || (!present && stat.size !== 0)) fail();
  return present;
}

export function finalizeDoltBackup(outputDirectory, databases, credentials, sourceProfile) {
  checkedBackupDatabases(databases);
  for (const database of databases) {
    const status = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'status', `${database}.json`), 'utf8'));
    if (status.rows?.length !== 1 || ![0, '0'].includes(status.rows[0]?.status) ||
      !fs.existsSync(path.join(outputDirectory, 'databases', database, 'manifest'))) fail();
  }
  if (!/^[0-9a-f]{64}\n$/u.test(credentials.root) || !/^[0-9a-f]{64}\n$/u.test(credentials.noticeos) ||
    typeof credentials.credentials !== 'string' || !credentials.credentials.trim()) fail();
  const metadata = path.join(outputDirectory, 'metadata');
  const presence = {};
  for (const name of DOLT_METADATA_NAMES) presence[name] = doltMetadataPresent(metadata, name, name === 'privileges.db');
  for (const database of databases) for (const name of DOLT_DATABASE_METADATA_NAMES) {
    const relative = `databases/${database}/${name}`;
    presence[relative] = doltMetadataPresent(metadata, relative);
  }
  fs.mkdirSync(path.join(metadata, 'secrets'), { mode: 0o700 });
  for (const name of ['root', 'noticeos']) fs.writeFileSync(path.join(metadata, 'secrets', name), credentials[name], { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(metadata, 'beads-credentials'), credentials.credentials, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(metadata, 'source-profile.json'), `${JSON.stringify(sourceProfile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const files = doltBackupInventory(outputDirectory);
  const marker = { format: 'noticeos-dolt-backup-v1', complete: true, image: DOLT_IMAGE, version: DOLT_VERSION,
    databases, metadata: presence, files,
    consistency: 'Per-database online snapshots, sequential across databases; stable non-versioned metadata.' };
  fs.writeFileSync(path.join(outputDirectory, 'backup.json'), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { databases: [...databases], files: Object.keys(files).length, format: marker.format };
}
