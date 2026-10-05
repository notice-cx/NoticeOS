// Database I/O for the fixed, protected backup worker. Neither the app nor a
// filesystem request can choose these endpoints, source mounts or commands.
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { runCommand } from './run-command.mjs';
import { BACKUP_PATHS, readBackupWorker, privateBackupFile, backupWorkerEnvironment } from './container-backup-profile.mjs';
import { finalizeDoltBackup, checkedBackupDatabases, doltBackupInventory } from './dolt-backup-format.mjs';
import { FILES as POSTGRES_SECRET_FILES, VERIFIERS } from './postgres-secrets.mjs';
import { readDeclaredTaskClient, taskClientEnvironment } from './task-client.mjs';

const refusal = phase => { throw new Error(phase
  ? `Task snapshot failed during ${phase}; no complete backup was published.`
  : 'The declared container snapshot failed; no complete backup was published.'); };
const recoverySources = [
  ['bootstrap.json', '/state/workers/ingest/.dev.secrets.json', true],
  ['task-client.json', '/state/task-client.json', true],
  ['task-host.json', '/state/installation/task-host.json', true],
  ['beads.json', '/state/installation/beads.json', true],
  ['worker-profile.json', BACKUP_PATHS.profile, true],
  ...POSTGRES_SECRET_FILES.map(name => [`postgres/${name}`, path.join(BACKUP_PATHS.postgresSecrets, name), !VERIFIERS.includes(name)]),
];
function recoveryInputs(io) {
  const host = JSON.parse(privateBackupFile('/state/installation/task-host.json', io).text);
  if (!Array.isArray(host.repositories) || !host.repositories.length) refusal();
  const inputs = [...recoverySources];
  try {
    io.lstatSync('/run/backup-worker/host-backup.json');
    inputs.push(['host-backup.json', '/run/backup-worker/host-backup.json', true]);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const seen = new Set();
  for (const row of host.repositories) {
    if (typeof row.repo !== 'string' || !/^\/spokes\/[a-zA-Z0-9_-]+$/u.test(row.repo) || seen.has(row.repo)) refusal();
    seen.add(row.repo);
    for (const directory of [row.repo, path.join(row.repo, '.beads')]) {
      const stat = io.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refusal();
    }
    for (const name of ['config.yaml', 'metadata.json']) {
      inputs.push([`spokes/${path.basename(row.repo)}/.beads/${name}`, path.join(row.repo, '.beads', name), false]);
    }
  }
  return inputs.sort(([a], [b]) => a.localeCompare(b));
}
function outputChecked(output) {
  if (typeof output !== 'string' || !output.startsWith('/state/.local/backups/.backup-') ||
    path.resolve(output) !== output || /[\r\n\0]/u.test(output)) refusal();
}
function sourceCredentials(io) {
  return { root: privateBackupFile('/run/dolt-secrets/root', io).text,
    noticeos: privateBackupFile('/run/dolt-secrets/noticeos', io).text,
    credentials: privateBackupFile('/state/dolt/credentials', io).text };
}

export async function dumpContainerPostgres(output, options = {}) {
  const io = options.fs ?? fs;
  const run = options.run ?? runCommand;
  const sync = options.fsSync ?? fsSync;
  outputChecked(output); readBackupWorker({ fs: sync });
  await io.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const exclusive = await io.open(output, 'wx', 0o600); await exclusive.close();
  const result = await run('pg_dump', ['--host=/postgres-socket', '--port=5432', '--username=postgres',
    '--dbname=noticeos', '--no-password', '--format=custom', `--file=${output}`], {
    cwd: '/state', env: backupWorkerEnvironment(options.env), timeoutMs: 300_000,
  });
  if (result.code !== 0) refusal();
  const handle = await io.open(output, 'r');
  try {
    const magic = Buffer.alloc(5);
    const { bytesRead } = await handle.read(magic, 0, 5, 0);
    if (bytesRead !== 5 || magic.toString() !== 'PGDMP') refusal();
  } finally { await handle.close(); }
}

export async function backupContainerDolt(databases, output, options = {}) {
  const io = options.fs ?? fs;
  const sync = options.fsSync ?? fsSync;
  const run = options.run ?? runCommand;
  outputChecked(output); checkedBackupDatabases(databases); readBackupWorker({ fs: sync });
  const beforeCredentials = sourceCredentials(sync);
  const client = readDeclaredTaskClient('/state/task-client.json');
  if (client.host !== 'dolt' || client.port !== 3306 || client.user !== 'noticeos' || client.credentialsFile !== '/state/dolt/credentials') refusal();
  try { await io.lstat(output); refusal(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = `/backup-staging/noticeos-backup-${randomBytes(16).toString('hex')}`;
  const env = backupWorkerEnvironment(options.env);
  let complete = false;
  let ownsStage = false;
  let ownsOutput = false;
  let phase = 'metadata capture';
  try {
    await io.mkdir(stage, { mode: 0o700 });
    ownsStage = true;
    for (const name of ['databases', 'status']) await io.mkdir(path.join(stage, name), { mode: 0o700 });
    const captureMetadata = async name => {
      const result = await run('/bin/bash', ['/etc/noticeos/backup-metadata.sh', '/dolt-data',
        '/dolt-data/.noticeos-home', path.join(stage, name), ...databases], { cwd: '/state', env, timeoutMs: 30_000 });
      if (result.code !== 0) refusal();
    };
    await captureMetadata('before');
    phase = 'database capture';
    await io.mkdir(BACKUP_PATHS.clientHome, { recursive: true, mode: 0o700 });
    for (const database of databases) {
      const result = await run('/usr/local/bin/dolt', ['--host=dolt', '--port=3306', '--user=noticeos', '--no-tls',
        '--use-db', database, 'sql', '--result-format=json', '--query',
        `CALL DOLT_BACKUP('sync-url', 'file://${stage}/databases/${database}');`], {
        cwd: '/state', env: { ...taskClientEnvironment({ ...client, clientHome: BACKUP_PATHS.clientHome }, env),
          DOLT_CLI_PASSWORD: beforeCredentials.noticeos.trim() }, timeoutMs: 300_000,
      });
      if (result.code !== 0 || result.stdout.length > 65536) refusal();
      await io.writeFile(path.join(stage, 'status', `${database}.json`), result.stdout, { flag: 'wx', mode: 0o600 });
    }
    phase = 'metadata verification';
    await captureMetadata('after');
    const before = doltBackupInventory(path.join(stage, 'before'), '', false);
    const after = doltBackupInventory(path.join(stage, 'after'), '', false);
    if (JSON.stringify(Object.entries(before).sort()) !== JSON.stringify(Object.entries(after).sort()) ||
      JSON.stringify(beforeCredentials) !== JSON.stringify(sourceCredentials(sync))) refusal();
    await io.rename(path.join(stage, 'before'), path.join(stage, 'metadata'));
    await io.rm(path.join(stage, 'after'), { recursive: true });
    await io.mkdir(output, { mode: 0o700 });
    phase = 'snapshot copy';
    ownsOutput = true;
    // Reserve the parent ourselves; Node 24's exclusive cp also rejects an
    // existing directory. Each child therefore gets its own absent target.
    for (const entry of await io.readdir(stage, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) refusal();
      await io.cp(path.join(stage, entry.name), path.join(output, entry.name), { recursive: true, errorOnExist: true, force: false });
    }
    phase = 'snapshot verification';
    const result = finalizeDoltBackup(output, databases, beforeCredentials, { transport: 'noticeos-container-backup-v1', host: 'dolt', port: 3306 });
    complete = true;
    return result;
  } catch { refusal(phase); }
  finally {
    if (ownsStage) try { await io.rm(stage, { recursive: true }); } catch { complete = false; }
    if (!complete) {
      if (ownsOutput) try { await io.rm(path.join(output, 'backup.json'), { force: true }); } catch { /* Failed set is not publishable. */ }
      refusal(phase);
    }
  }
}

export async function copyContainerRecovery(output, options = {}) {
  const io = options.fs ?? fs;
  const sync = options.fsSync ?? fsSync;
  outputChecked(output); readBackupWorker({ fs: sync });
  const inputs = recoveryInputs(sync);
  const inventory = {};
  await io.mkdir(output, { mode: 0o700 });
  for (const [name, source, privateMode] of inputs) {
    const value = privateBackupFile(source, sync, privateMode).text;
    await io.mkdir(path.dirname(path.join(output, name)), { recursive: true, mode: 0o700 });
    await io.writeFile(path.join(output, name), value, { flag: 'wx', mode: 0o600 });
    if (privateBackupFile(source, sync, privateMode).text !== value) refusal();
    inventory[name] = { bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') };
  }
  await io.writeFile(path.join(output, 'recovery.json'), JSON.stringify({ format: 'noticeos-container-recovery-v1', files: inventory }) + '\n', { flag: 'wx', mode: 0o600 });
  return { files: inputs.length };
}

export async function verifyContainerRecovery(output, options = {}) {
  const sync = options.fsSync ?? fsSync;
  outputChecked(output); readBackupWorker({ fs: sync });
  const inputs = recoveryInputs(sync);
  const marker = JSON.parse(privateBackupFile(path.join(output, 'recovery.json'), sync).text);
  if (marker.format !== 'noticeos-container-recovery-v1' ||
    Object.keys(marker.files ?? {}).sort().join() !== inputs.map(([name]) => name).sort().join()) refusal();
  for (const [name, source, privateMode] of inputs) {
    const value = privateBackupFile(path.join(output, name), sync).text;
    const expected = marker.files[name];
    if (expected?.bytes !== Buffer.byteLength(value) || expected?.sha256 !== createHash('sha256').update(value).digest('hex') ||
      privateBackupFile(source, sync, privateMode).text !== value) refusal();
  }
}

export async function ownContainerBackup(output, worker, { fs: io = fs, offsite = false } = {}) {
  if (offsite) {
    if (!output.startsWith(`${BACKUP_PATHS.offsite}/.backup-`) || path.resolve(output) !== output) refusal();
  } else outputChecked(output);
  const visit = async directory => {
    const entries = await io.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) refusal();
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const stat = await io.lstat(file); if (stat.nlink !== 1) refusal();
        await io.chmod(file, 0o600); await io.chown(file, worker.operatorUid, worker.operatorGid);
      }
    }
    await io.chmod(directory, 0o700); await io.chown(directory, worker.operatorUid, worker.operatorGid);
  };
  await visit(output);
}
