import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class ShadowTargetRefused extends Error {}
const refuse = message => { throw new ShadowTargetRefused(message); };

export async function privateShadowDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || /[\r\n\0]/u.test(input)) refuse('Choose an absolute private directory.');
  const directory = path.resolve(input), stat = await fs.lstat(directory);
  if (await fs.realpath(directory) !== directory || !stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) {
    refuse('Choose an owner-only directory without symlinks.');
  }
  return directory;
}

export async function openPrivateShadowFile(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.nlink !== 1) refuse('Use an owner-only local file.');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

export async function readPrivateShadowFile(filename, cap) {
  const { handle, stat } = await openPrivateShadowFile(filename);
  try {
    if (stat.size > cap) refuse('A shadow metadata file exceeds the supported size.');
    // Read through the bounded descriptor even if the file grows after stat.
    const bytes = Buffer.alloc(cap + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > cap) refuse('A shadow metadata file exceeds the supported size.');
    return bytes.subarray(0, filled);
  } finally { await handle.close(); }
}

const receiptFields = ['format', 'workspaceId', 'ownerEmail', 'postgresSystemId', 'dataDir', 'socketDir', 'port', 'database'];

/** Bind local role URLs to the prepared PostgreSQL instance before opening them. */
export async function verifyShadowTargetReceipt(root, psql, { workspaceId, ownerEmail, port, database }) {
  const receipt = JSON.parse(await readPrivateShadowFile(path.join(root, 'shadow-target.json'), 8192));
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).length !== receiptFields.length
    || receiptFields.some(field => !Object.hasOwn(receipt, field)) || receipt.format !== 'noticeos-shadow-target-v1'
    || receipt.workspaceId !== workspaceId || typeof receipt.ownerEmail !== 'string' || receipt.ownerEmail.length > 254
    || !/^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/u.test(receipt.ownerEmail)
    || typeof receipt.postgresSystemId !== 'string' || !/^\d{1,20}$/u.test(receipt.postgresSystemId)
    || receipt.database !== 'noticeos_dev' || !Number.isInteger(receipt.port) || receipt.port < 1024 || receipt.port > 65535
    || receipt.dataDir !== path.join(root, 'postgres', 'data') || (ownerEmail !== undefined && ownerEmail !== receipt.ownerEmail)
    || (port !== undefined && port !== receipt.port) || (database !== undefined && database !== receipt.database)) {
    refuse('Choose the prepared target for this workspace.');
  }
  await privateShadowDirectory(path.join(root, 'postgres'));
  await privateShadowDirectory(receipt.dataDir);
  const socket = await privateShadowDirectory(receipt.socketDir);
  const pid = (await readPrivateShadowFile(path.join(receipt.dataDir, 'postmaster.pid'), 8192)).toString('utf8').split('\n');
  if (!/^[1-9]\d*$/u.test(pid[0] ?? '') || pid[1] !== receipt.dataDir || pid[3] !== String(receipt.port)
    || !path.isAbsolute(pid[4] ?? '') || await fs.realpath(pid[4]) !== socket
    || pid[5] !== '127.0.0.1' || pid[7]?.trim() !== 'ready') {
    refuse('Start this prepared target before using it.');
  }
  const socketStat = await fs.lstat(path.join(socket, `.s.PGSQL.${receipt.port}`));
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid()) refuse('The prepared target socket is unavailable.');
  const control = execFileSync(path.join(path.dirname(psql), 'pg_controldata'), [receipt.dataDir], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (/^Database system identifier:\s*(\d+)$/mu.exec(control)?.[1] !== receipt.postgresSystemId) {
    refuse('The prepared target is a different PostgreSQL cluster.');
  }
  // A stale socket and PID file alone do not prove that this cluster is serving the loopback port.
  const live = JSON.parse(execFileSync(psql, ['-XqAtw', '--set=ON_ERROR_STOP=1', '--host', socket,
    '--port', String(receipt.port), '--dbname', receipt.database, '--username', 'postgres', '--command', `
      BEGIN READ ONLY;
      SELECT json_build_object('id', system_identifier::text, 'data', current_setting('data_directory'),
        'listen', current_setting('listen_addresses'), 'port', current_setting('port'),
        'version', current_setting('server_version_num')) FROM pg_control_system();
      COMMIT;`], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', PGCONNECT_TIMEOUT: '3' }, encoding: 'utf8', timeout: 5000,
    maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'],
  }));
  if (live?.id !== receipt.postgresSystemId || live.data !== receipt.dataDir || live.listen !== '127.0.0.1'
    || live.port !== String(receipt.port) || !/^18\d{4}$/u.test(live.version)) {
    refuse('The prepared PostgreSQL instance is unavailable.');
  }
  return receipt;
}
