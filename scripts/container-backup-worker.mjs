// The worker chooses the operation from its protected configuration. A client
// can request that operation once, but cannot choose executable or resource.
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBackupRequest, completedBackupRequest, finishBackupRequest } from './container-backup-channel.mjs';

export async function serviceBackupRequest(profile, execute, { fs: io = fs } = {}) {
  const request = await readBackupRequest(profile, { fs: io });
  if (!request || await completedBackupRequest(profile, request.id, { fs: io })) return false;
  const claim = path.join(profile.transportDir, 'request.lock');
  const stat = await io.lstat(claim);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== profile.uid) {
    throw new Error('The private backup request claim is invalid.');
  }
  try { await io.mkdir(path.join(claim, 'worker.lock'), { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  // Completion lets the client retire this whole private directory. Its
  // identity must be able to traverse the empty worker fence during removal.
  await io.chown(path.join(claim, 'worker.lock'), profile.uid, profile.gid);
  const current = await readBackupRequest(profile, { fs: io });
  if (current?.id !== request.id) {
    // Retirement could have happened while this worker was acquiring the
    // claim. An unfinished successor cannot be retired while our exclusive
    // worker lock exists, so relinquish it without executing the old request.
    if (current && !await completedBackupRequest(profile, current.id, { fs: io })) {
      await io.rmdir(path.join(claim, 'worker.lock'));
    }
    return false;
  }
  if (await completedBackupRequest(profile, request.id, { fs: io })) return false;
  // This claim is never reaped by PID. A lost worker requires explicit
  // recovery; an exact finished response lets the client retire everything.
  let result;
  try {
    result = await execute();
    if (typeof result?.ok !== 'boolean' || typeof result?.detail !== 'string') throw new Error();
  } catch { result = { ok: false, detail: 'The declared backup worker failed; the previous complete set was preserved.' }; }
  await finishBackupRequest(profile, request, { ok: result.ok, detail: result.detail.slice(0, 4000) }, { fs: io });
  // Do not address generation-relative files after publishing completion:
  // the client may already have retired this directory and started another.
  return true;
}
