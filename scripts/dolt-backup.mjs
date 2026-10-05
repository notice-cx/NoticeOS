// Online Dolt backup transport for an explicitly declared installation. The
// host backup pipeline publishes this subtree only after every stage passes.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { doltComposeArgs, doltExecutor, readDoltCredentials, validateDoltProfile, validateIsolatedDoltProfile, DOLT_IMAGE, DOLT_VERSION } from './dolt-host.mjs';

import { DOLT_METADATA_NAMES as metadataNames, DOLT_DATABASE_METADATA_NAMES as databaseNames,
  checkedBackupDatabases as databasesChecked, doltBackupInventory as inventory,
  doltMetadataPresent as metadataPresent, finalizeDoltBackup } from './dolt-backup-format.mjs';

const fail = () => { throw new Error('Dolt backup could not complete; no complete snapshot was published.'); };

/** Output directory must not exist. Raw driver/container diagnostics are never
 * surfaced; they can contain credentials or task data. `run` is the same
 * subprocess adapter used by the host backup pipeline's process tests. */
export async function backupDolt(profile, databases, outputDirectory, options = {}) {
  validateDoltProfile(profile);
  databasesChecked(databases);
  if (!path.isAbsolute(outputDirectory) || fs.existsSync(outputDirectory)) fail();
  const credentials = readDoltCredentials(profile);
  const execute = await doltExecutor(profile, options);
  const stage = `/tmp/noticeos-backup-${randomBytes(16).toString('hex')}`;
  const args = doltComposeArgs(profile);
  let complete = false;
  try {
    const captured = await execute([...args, 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/capture.sh', stage, ...databases], 300_000);
    if (captured.code !== 0) fail();
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const copied = await execute([...args, 'cp', `dolt:${stage}/.`, outputDirectory], 300_000);
    if (copied.code !== 0) fail();
    // Source credentials must remain the exact captured generation.
    const after = readDoltCredentials(profile);
    if (JSON.stringify(after) !== JSON.stringify(credentials)) fail();
    const result = finalizeDoltBackup(outputDirectory, databases, credentials, profile);
    complete = true;
    return result;
  } catch { fail(); }
  finally {
    // This invocation alone created this exact container-private folder.
    try {
      const cleaned = await execute([...args, 'exec', '--no-TTY', 'dolt', 'rm', '-rf', '--', stage]);
      if (cleaned.code !== 0) complete = false;
    } catch { complete = false; }
    if (!complete) {
      try { fs.rmSync(path.join(outputDirectory, 'backup.json'), { force: true }); } catch { /* The failed set is never publishable. */ }
    }
    if (!complete) fail();
  }
}

/** Restore has no overwrite path. It accepts the same pinned profile only
 * after exact service/volume absence is proven, and starts the server after
 * all logical databases and non-versioned permissions are restored. */
export async function restoreDolt(profile, backupDirectory, options = {}) {
  try {
    validateIsolatedDoltProfile(profile);
    const marker = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'backup.json'), 'utf8'));
    if (marker.format !== 'noticeos-dolt-backup-v1' || marker.complete !== true || marker.image !== DOLT_IMAGE || marker.version !== DOLT_VERSION) fail();
    databasesChecked(marker.databases);
    const files = inventory(backupDirectory, '', false);
    delete files['backup.json'];
    if (!marker.files || JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(marker.files).sort())) fail();
    const metadata = path.join(backupDirectory, 'metadata');
    for (const name of metadataNames) {
      if (metadataPresent(metadata, name, name === 'privileges.db') !== marker.metadata?.[name]) fail();
    }
    for (const database of marker.databases) {
      if (!fs.existsSync(path.join(backupDirectory, 'databases', database, 'manifest'))) fail();
      for (const name of databaseNames) {
        const relative = `databases/${database}/${name}`;
        if (metadataPresent(metadata, relative) !== marker.metadata?.[relative]) fail();
      }
    }
    const root = fs.readFileSync(path.join(metadata, 'secrets', 'root'), 'utf8');
    const noticeos = fs.readFileSync(path.join(metadata, 'secrets', 'noticeos'), 'utf8');
    if (!/^[0-9a-f]{64}\n$/u.test(root) || !/^[0-9a-f]{64}\n$/u.test(noticeos)) fail();
    if (fs.existsSync(path.dirname(profile.credentialsFile))) fail();
    const execute = await doltExecutor(profile, options);
    const args = doltComposeArgs(profile);
    const service = await execute([...args, 'ps', '--all', '--quiet', 'dolt']);
    const volume = await execute(['volume', 'inspect', `${profile.project}_dolt-data`]);
    if (service.code !== 0 || service.stdout.trim() || volume.code === 0 || !/no such volume/iu.test(volume.stderr)) fail();
    fs.mkdirSync(path.dirname(profile.credentialsFile), { mode: 0o700 });
    fs.mkdirSync(profile.secretsDir, { mode: 0o700 });
    fs.mkdirSync(path.join(path.dirname(profile.credentialsFile), 'client-home'), { mode: 0o700 });
    for (const [name, text] of [['root', root], ['noticeos', noticeos]]) fs.writeFileSync(path.join(profile.secretsDir, name), text, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(profile.credentialsFile, `[127.0.0.1:${profile.port}]\npassword=${noticeos.trim()}\n`, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(path.dirname(profile.credentialsFile), 'profile.json'), `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const stage = `/var/lib/dolt/.noticeos-restore-${randomBytes(16).toString('hex')}`;
    const created = await execute([...args, 'create', 'dolt'], 120_000);
    if (created.code !== 0) fail();
    const copied = await execute([...args, 'cp', `${backupDirectory}/.`, `dolt:${stage}`], 300_000);
    if (copied.code !== 0) fail();
    const restored = await execute([...args, 'run', '--rm', '--no-deps', '--no-TTY', '--entrypoint', '/bin/bash', 'dolt', '/etc/noticeos/restore.sh', stage, ...marker.databases], 300_000);
    if (restored.code !== 0) fail();
    const started = await execute([...args, 'up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'], 120_000);
    if (started.code !== 0) fail();
    return { databases: [...marker.databases], format: marker.format };
  } catch { throw new Error('Dolt restore refused or could not complete; any new resources were preserved for explicit recovery.'); }
}
