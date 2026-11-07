// ntasks-backup.mjs — the installation's tasks in its nightly backup while
// they live in Ntasks. The runner reads Ntasks's whole store page by page from
// its backup route (GET /api/backup, Ntasks docs/api.md "Backing up the whole
// store") through the installation's task service, and writes one file in the
// format Ntasks's own restore reads (Ntasks tools/migrate `restore`). The
// backup (host-backup.mjs) checks that file and keeps it in the set.

import fs from 'node:fs/promises';
import path from 'node:path';

export const NTASKS_BACKUP_FORMAT = 'ntasks-backup-v1';
/** How many times an export starts again when Ntasks is written to while it is read. */
export const EXPORT_ATTEMPTS = 3;
/** At most this many pages in one export; Ntasks hands out at most 500 rows a page. */
export const EXPORT_PAGES = 20_000;
/** The largest export a backup keeps: the file is read whole to count its rows. */
export const EXPORT_BYTES = 256 * 1024 * 1024;

const TABLE = /^[a-z][a-z0-9_]{0,63}$/u;
const isRow = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

class StoreChanged extends Error {}

function refused(status, body) {
  if (status === 403 && body?.error === 'insufficient_scope') {
    return new Error('the connected Ntasks credential cannot read backups: make a service credential with backup and connect it on the Integrations page');
  }
  const detail = typeof body?.detail === 'string' ? `: ${body.detail.slice(0, 200)}` : '';
  return new Error(`Ntasks's backup route answered HTTP ${status}${typeof body?.error === 'string' ? ` ${body.error}` : ''}${detail}`);
}

async function collect(service, maxBytes) {
  const tables = {};
  let first = null;
  let token = null;
  let bytes = 0;
  for (let pages = 1; pages <= EXPORT_PAGES; pages += 1) {
    const { status, body } = await service.call({ method: 'GET', path: token === null ? '/api/backup' : `/api/backup?page=${encodeURIComponent(token)}` });
    if (status === 409 && body?.error === 'store_changed') throw new StoreChanged();
    if (status !== 200) throw refused(status, body);
    if (body?.format !== NTASKS_BACKUP_FORMAT || typeof body.takenAt !== 'string' || !Array.isArray(body.migrations)
      || !body.migrations.every((name) => typeof name === 'string') || typeof body.table !== 'string' || !TABLE.test(body.table)
      || !Array.isArray(body.rows) || !body.rows.every(isRow) || !(body.next === null || typeof body.next === 'string')) {
      throw new Error(`page ${pages} of Ntasks's backup is not a page of an Ntasks backup`);
    }
    first ??= body;
    if (body.takenAt !== first.takenAt || body.migrations.join() !== first.migrations.join()) {
      throw new Error(`page ${pages} of Ntasks's backup is from another export than the first`);
    }
    // The file holds at least these bytes (a page's rows without its brackets,
    // since a table's pages share one list), so an export past the bound stops
    // here, not after it is written.
    bytes += Buffer.byteLength(JSON.stringify(body.rows)) - 2;
    if (bytes > maxBytes) throw new Error(`Ntasks's backup is larger than ${maxBytes} bytes`);
    const rows = tables[body.table] ??= [];
    for (const row of body.rows) rows.push(row);
    if (body.next === null) return { format: NTASKS_BACKUP_FORMAT, takenAt: first.takenAt, migrations: [...first.migrations], tables };
    token = body.next;
  }
  throw new Error(`Ntasks's backup runs past ${EXPORT_PAGES} pages`);
}

/** The rows of each table, by table name. */
export function rowCounts(tables) {
  return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
}

/**
 * Reads Ntasks's whole store and writes it to `file` (mode 600, never over an
 * existing file). Starts again, EXPORT_ATTEMPTS times at most, when Ntasks is
 * written to while the pages are read. Throws with the reason when no whole
 * export was taken.
 */
export async function pullNtasksBackup(service, file, { attempts = EXPORT_ATTEMPTS, maxBytes = EXPORT_BYTES, fs: io = fs } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let backup;
    try { backup = await collect(service, maxBytes); }
    catch (error) {
      if (!(error instanceof StoreChanged)) throw error;
      if (attempt >= attempts) throw new Error(`Ntasks was written to during each of ${attempts} attempts, so no task export was taken`);
      continue;
    }
    await io.writeFile(file, JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
    return { takenAt: backup.takenAt, rows: rowCounts(backup.tables), attempts: attempt };
  }
}

/**
 * One backup run's export in a private folder under `parent`: `{ dir, file }`
 * when Ntasks gave a whole export, `{ dir, error }` with the reason when not,
 * `dir` null when no folder was made. Never throws, so a failed export fails
 * only the backup's task part. The caller removes `dir` once the backup has
 * kept the file.
 */
export async function takeNtasksExport(service, parent, { fs: io = fs, ...options } = {}) {
  let dir = null;
  try {
    await io.mkdir(parent, { recursive: true, mode: 0o700 });
    dir = await io.mkdtemp(path.join(parent, 'ntasks-export-'));
    const file = path.join(dir, 'backup.json');
    return { dir, file, ...await pullNtasksBackup(service, file, { fs: io, ...options }) };
  } catch (error) { return { dir, error: String(error?.message ?? error).slice(0, 300) }; }
}

/**
 * Checks that `file` is a private file holding one whole Ntasks backup, and
 * answers when it was taken, the store's migrations and the rows of each
 * table. Throws with the reason otherwise.
 */
/** Checks that `file` is a private regular file no larger than `maxBytes`, and answers its size. */
export async function privateExportSize(file, { fs: io = fs, maxBytes = EXPORT_BYTES } = {}) {
  let stat;
  try { stat = await io.lstat(file); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('no Ntasks export came with this backup; the runner\'s log names why');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('the Ntasks export is not a private file');
  if (stat.size > maxBytes) throw new Error(`the Ntasks export is larger than ${maxBytes} bytes`);
  return stat.size;
}

export async function readNtasksBackup(file, { fs: io = fs, maxBytes = EXPORT_BYTES } = {}) {
  const size = await privateExportSize(file, { fs: io, maxBytes });
  let value;
  try { value = JSON.parse(await io.readFile(file, 'utf8')); }
  catch { throw new Error('the Ntasks export is not JSON'); }
  const tables = value?.tables;
  if (value?.format !== NTASKS_BACKUP_FORMAT || typeof value.takenAt !== 'string' || !Number.isFinite(Date.parse(value.takenAt))
    || !Array.isArray(value.migrations) || !value.migrations.every((name) => typeof name === 'string')
    || !isRow(tables) || Object.keys(tables).length === 0
    || !Object.entries(tables).every(([table, rows]) => TABLE.test(table) && Array.isArray(rows) && rows.every(isRow))) {
    throw new Error(`the Ntasks export is not a whole ${NTASKS_BACKUP_FORMAT} backup`);
  }
  return { takenAt: value.takenAt, migrations: value.migrations, rows: rowCounts(tables), bytes: size };
}
