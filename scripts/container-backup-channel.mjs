// One declared private filesystem channel. Requests choose no command, path,
// database or service; the backup worker's protected profile owns those facts.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FORMAT = 'noticeos-backup-request-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const failure = detail => ({ ok: false, detail });
const refusal = () => { throw new Error('The declared backup channel is unavailable.'); };
const claimFile = (profile, name) => path.join(profile.transportDir, 'request.lock', name);

export function validateBackupClient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join() !== 'format,transportDir' ||
    value.format !== 'noticeos-backup-client-v1' || typeof value.transportDir !== 'string' ||
    !path.isAbsolute(value.transportDir) || /[\0\r\n]/u.test(value.transportDir)) refusal();
  return { format: value.format, transportDir: value.transportDir };
}

async function privateJson(file, io, maxBytes = 16384) {
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > maxBytes) refusal();
  return { value: JSON.parse(await io.readFile(file, 'utf8')), uid: stat.uid, gid: stat.gid };
}

async function privateClaim(profile, io) {
  const stat = await io.lstat(path.join(profile.transportDir, 'request.lock'));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== profile.uid) refusal();
}

export async function readBackupClient(file, { fs: io = fs } = {}) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) refusal();
    const input = await privateJson(file, io);
    const profile = validateBackupClient(input.value);
    const dir = await io.lstat(profile.transportDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== input.uid) refusal();
    return { ...profile, uid: input.uid, gid: input.gid };
  } catch { refusal(); }
}

export async function containerBackupStatus(file, { fs: io = fs, now = Date.now } = {}) {
  try { await io.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { configured: false, available: false, detail: 'Backups need a declared worker.' };
    return { configured: true, available: false, detail: 'The backup declaration cannot be read.' };
  }
  try {
    const profile = await readBackupClient(file, { fs: io });
    const heartbeat = await privateJson(path.join(profile.transportDir, 'worker-health.json'), io);
    const value = heartbeat.value;
    const age = now() - Date.parse(value.updatedAt);
    // A PID in another container is not evidence. The private worker's fresh
    // heartbeat says it is serving the fixed channel; completion is separate.
    const available = heartbeat.uid === profile.uid && value.format === 'noticeos-backup-worker-health-v1' &&
      value.ready === true && /^[0-9a-f]{64}$/u.test(value.namespace ?? '') && age >= 0 && age <= 15000;
    return { configured: true, available, detail: available ? 'The backup worker is ready.' : 'The backup worker is unavailable.' };
  } catch { return { configured: true, available: false, detail: 'The backup worker is unavailable.' }; }
}

export function validateBackupRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join() !== 'format,id' || value.format !== FORMAT || !UUID.test(value.id ?? '')) refusal();
  return { format: FORMAT, id: value.id };
}

export async function readBackupRequest(profile, { fs: io = fs } = {}) {
  try {
    await privateClaim(profile, io);
    const input = await privateJson(claimFile(profile, 'request.json'), io);
    if (input.uid !== profile.uid) refusal();
    return validateBackupRequest(input.value);
  } catch (error) { if (error.code === 'ENOENT') return null; refusal(); }
}

async function atomicJson(profile, name, value, io) {
  const temporary = claimFile(profile, `.${name}-${randomUUID()}`);
  try {
    await io.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await io.chown(temporary, profile.uid, profile.gid);
    await io.rename(temporary, claimFile(profile, name));
  } finally { await io.rm(temporary, { force: true }); }
}

function resultChecked(value) {
  if (!value || typeof value.ok !== 'boolean' || typeof value.detail !== 'string' || value.detail.length > 4000) refusal();
  return { ok: value.ok, detail: value.detail };
}

export async function finishBackupRequest(profile, request, result, options = {}) {
  const io = options.fs ?? fs;
  validateBackupRequest(request);
  const current = await readBackupRequest(profile, { fs: io });
  if (current?.id !== request.id) refusal();
  await atomicJson(profile, 'response.json', { format: FORMAT, id: request.id, finished: true, result: resultChecked(result) }, io);
}

export async function completedBackupRequest(profile, id, { fs: io = fs } = {}) {
  try {
    await privateClaim(profile, io);
    const response = await privateJson(claimFile(profile, 'response.json'), io);
    const value = response.value;
    if (response.uid !== profile.uid || value.format !== FORMAT || value.id !== id || value.finished !== true) return null;
    return resultChecked(value.result);
  } catch (error) { if (error.code === 'ENOENT') return null; refusal(); }
}

// A completed response is the only proof allowing claim cleanup. A timeout,
// lost client or unknown worker must leave an in-flight request fenced.
async function retireCompleted(profile, id, io) {
  const claim = path.join(profile.transportDir, 'request.lock');
  await privateClaim(profile, io);
  // Only one client may retire this generation. A crash here fails closed;
  // neither a PID nor elapsed time can prove the worker finished safely.
  await io.mkdir(path.join(claim, 'retirement.lock'), { mode: 0o700 });
  const owner = await privateJson(path.join(claim, 'owner.json'), io);
  if (owner.value.id !== id) {
    // A faster client may already have retired the old generation. This
    // exclusive retirement directory is ours, and its current generation
    // cannot be renamed by another client until we relinquish it.
    await io.rmdir(path.join(claim, 'retirement.lock'));
    refusal();
  }
  if (!await completedBackupRequest(profile, id, { fs: io })) refusal();
  const retired = path.join(profile.transportDir, `.completed-${id}`);
  await io.rename(claim, retired);
  // All generation-specific files travel with the directory. A successor can
  // start immediately without any old cleanup addressing its files.
  await io.rm(retired, { recursive: true });
}

export async function requestContainerBackup(file, { fs: io = fs, timeoutMs = 600_000, intervalMs = 250 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000 || intervalMs < 1 || intervalMs > 1000) return failure('The backup request wait is invalid.');
  let profile;
  try { profile = await readBackupClient(file, { fs: io }); }
  catch { return failure('The declared container backup service is not configured or unavailable.'); }
  const claim = path.join(profile.transportDir, 'request.lock');
  const request = { format: FORMAT, id: randomUUID() };
  try {
    try { await io.mkdir(claim, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await privateClaim(profile, io);
      const previous = await privateJson(path.join(claim, 'owner.json'), io);
      if (!UUID.test(previous.value.id ?? '') || !await completedBackupRequest(profile, previous.value.id, { fs: io })) {
        return failure('Backup already in progress. If the worker stopped, review its request before retrying.');
      }
      await retireCompleted(profile, previous.value.id, io);
      await io.mkdir(claim, { mode: 0o700 });
    }
    await io.writeFile(path.join(claim, 'owner.json'), JSON.stringify({ id: request.id }), { flag: 'wx', mode: 0o600 });
    await atomicJson(profile, 'request.json', request, io);
    const deadline = Date.now() + timeoutMs;
    const result = await new Promise((resolve, reject) => {
      const check = async () => {
        try {
          const completed = await completedBackupRequest(profile, request.id, { fs: io });
          if (completed) { resolve(completed); return; }
          if (Date.now() >= deadline) { resolve(null); return; }
          setTimeout(check, intervalMs);
        } catch (error) { reject(error); }
      };
      void check();
    });
    if (!result) return failure('Backup timed out. Its request was preserved for review.');
    await retireCompleted(profile, request.id, io);
    return result;
  } catch { return failure('Backup could not finish. Its request was preserved for review.'); }
}
