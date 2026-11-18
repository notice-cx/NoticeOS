import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export function writeStackFile(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Serialize operations that can replace the app or change its declaration. */
export async function holdingStackLock(selectorFile, name, operation) {
  const lock = path.join(path.dirname(selectorFile), 'stack-deploy', 'lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Another app operation holds the stack lock.'); }
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, operation: name }));
    return await operation();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}
