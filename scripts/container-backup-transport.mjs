// Database I/O for the fixed, protected backup worker. Neither the app nor a
// filesystem request can choose these endpoints, source mounts or commands.
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand } from './run-command.mjs';
import { BACKUP_PATHS, readBackupWorker, privateBackupFile, backupWorkerEnvironment } from './container-backup-profile.mjs';
import { FILES as POSTGRES_SECRET_FILES, VERIFIERS } from './postgres-secrets.mjs';

const refusal = () => { throw new Error('The declared container snapshot failed; no complete backup was published.'); };
const recoverySources = [
  ['bootstrap.json', '/state/workers/ingest/.dev.secrets.json', true],
  ['worker-profile.json', BACKUP_PATHS.profile, true],
  ...POSTGRES_SECRET_FILES.map(name => [`postgres/${name}`, path.join(BACKUP_PATHS.postgresSecrets, name), !VERIFIERS.includes(name)]),
];
/** The recovery set: every fixed source, and the declarations an installation keeps only when it has them. */
function recoveryInputs(io) {
  const inputs = [...recoverySources];
  for (const [name, source] of [['host-backup.json', '/run/backup-worker/host-backup.json'], ['beads.json', '/state/installation/beads.json']]) {
    try {
      io.lstatSync(source);
      inputs.push([name, source, true]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return inputs.sort(([a], [b]) => a.localeCompare(b));
}
function outputChecked(output) {
  if (typeof output !== 'string' || !output.startsWith('/state/.local/backups/.backup-') ||
    path.resolve(output) !== output || /[\r\n\0]/u.test(output)) refusal();
}
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = fsSync.constants;

/**
 * Copy a published set into a fresh offsite working folder. Each entry is
 * created here and given its mode and owner through its own descriptor: a sync
 * client hard-links files it is uploading, so nothing is changed by path after
 * the copy. Top-level names in `omit` stay out of the copy.
 */
export async function copyOffsiteBackup(source, output, worker, { fs: io = fs, omit = [] } = {}) {
  if (typeof source !== 'string' || !/^\/state\/\.local\/backups\/\d{4}-\d{2}-\d{2}$/u.test(source)) refusal();
  if (typeof output !== 'string' || !output.startsWith(`${BACKUP_PATHS.offsite}/.backup-`) || path.resolve(output) !== output) refusal();
  const own = async (handle, mode) => {
    try { await handle.chmod(mode); await handle.chown(worker.operatorUid, worker.operatorGid); }
    finally { await handle.close(); }
  };
  const buffer = Buffer.allocUnsafe(1 << 20);
  const copy = async (from, to, top) => {
    await own(await io.open(to, O_RDONLY | O_DIRECTORY | O_NOFOLLOW), 0o700);
    for (const entry of await io.readdir(from, { withFileTypes: true })) {
      if (top && omit.includes(entry.name)) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) refusal();
      const [next, target] = [path.join(from, entry.name), path.join(to, entry.name)];
      if (entry.isDirectory()) {
        await io.mkdir(target, { mode: 0o700 });
        await copy(next, target, false);
        continue;
      }
      const input = await io.open(next, O_RDONLY | O_NOFOLLOW);
      try {
        const written = await io.open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
        try {
          await written.chmod(0o600); await written.chown(worker.operatorUid, worker.operatorGid);
          for (let position = 0; ;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            for (let offset = 0; offset < bytesRead;) offset += (await written.write(buffer, offset, bytesRead - offset)).bytesWritten;
            position += bytesRead;
          }
        } finally { await written.close(); }
      } finally { await input.close(); }
    }
  };
  await copy(source, output, true);
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

export async function ownContainerBackup(output, worker, { fs: io = fs } = {}) {
  outputChecked(output);
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
