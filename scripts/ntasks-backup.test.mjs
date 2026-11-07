import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { EXPORT_ATTEMPTS, NTASKS_BACKUP_FORMAT, pullNtasksBackup, readNtasksBackup, readPrivateExport, takeNtasksExport } from './ntasks-backup.mjs';

// scripts/ntasks-backup.mjs: Ntasks's whole store, read page by page through a
// scripted task service and written in the file format Ntasks's restore reads.

const TAKEN = '2026-11-07T04:00:00.000Z';
const MIGRATIONS = ['0001_tasks.sql', '0002_history.sql'];
const page = (table, rows, next) => ({ format: NTASKS_BACKUP_FORMAT, takenAt: TAKEN, migrations: MIGRATIONS, table, rows, next });
const PAGES = {
  '': page('projects', [{ id: 'p1', prefix: 'ex' }], 'b'),
  b: page('tasks', [{ id: 'ex-1' }, { id: 'ex-2' }], 'c'),
  c: page('tasks', [{ id: 'ex-3' }], 'd'),
  d: page('write_receipts', [], null),
};

function ntasks(answer = (token) => ({ status: 200, body: PAGES[token ?? ''] })) {
  const asked = [];
  return { asked, service: { call: async ({ method, path: target }) => {
    assert.equal(method, 'GET');
    const url = new URL(target, 'https://ntasks.example.com');
    assert.equal(url.pathname, '/api/backup');
    asked.push(url.searchParams.get('page'));
    return answer(url.searchParams.get('page'));
  } } };
}

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ntasks-backup-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('every page of the store is put together in one private file Ntasks\'s restore reads', async (t) => {
  const dir = await scratch(t);
  const { service, asked } = ntasks();
  const file = path.join(dir, 'backup.json');
  assert.deepEqual(await pullNtasksBackup(service, file), { takenAt: TAKEN, rows: { projects: 1, tasks: 3, write_receipts: 0 }, attempts: 1 });
  assert.deepEqual(asked, [null, 'b', 'c', 'd']);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { format: NTASKS_BACKUP_FORMAT, takenAt: TAKEN, migrations: MIGRATIONS,
    tables: { projects: [{ id: 'p1', prefix: 'ex' }], tasks: [{ id: 'ex-1' }, { id: 'ex-2' }, { id: 'ex-3' }], write_receipts: [] } });
  assert.deepEqual(await readNtasksBackup(file), { takenAt: TAKEN, migrations: MIGRATIONS, rows: { projects: 1, tasks: 3, write_receipts: 0 },
    bytes: (await fs.stat(file)).size });
  await assert.rejects(pullNtasksBackup(service, file), { code: 'EEXIST' }, 'an export never writes over a file');
});

test('the size bound counts a table\'s rows once across its pages, and the file holds at least that', async (t) => {
  const dir = await scratch(t);
  const rowBytes = Object.values(PAGES).reduce((sum, { rows }) => sum + Buffer.byteLength(JSON.stringify(rows)) - 2, 0);
  const fits = path.join(dir, 'fits.json');
  await pullNtasksBackup(ntasks().service, fits, { maxBytes: rowBytes });
  assert.ok((await fs.stat(fits)).size >= rowBytes);
  await assert.rejects(pullNtasksBackup(ntasks().service, path.join(dir, 'over.json'), { maxBytes: rowBytes - 1 }), new RegExp(`larger than ${rowBytes - 1} bytes`, 'u'));
});

test('a store written to while it is read is read again, and refused after the last attempt', async (t) => {
  const dir = await scratch(t);
  let changes = 1;
  const changing = ntasks((token) => token === 'b' && changes-- > 0
    ? { status: 409, body: { error: 'store_changed' } } : { status: 200, body: PAGES[token ?? ''] });
  assert.equal((await pullNtasksBackup(changing.service, path.join(dir, 'once.json'))).attempts, 2);
  const busy = ntasks((token) => token === null ? { status: 200, body: PAGES[''] } : { status: 409, body: { error: 'store_changed' } });
  await assert.rejects(pullNtasksBackup(busy.service, path.join(dir, 'busy.json')), new RegExp(`each of ${EXPORT_ATTEMPTS} attempts`, 'u'));
  await assert.rejects(fs.access(path.join(dir, 'busy.json')), { code: 'ENOENT' });
});

test('a refused or malformed export says why and leaves no file', async (t) => {
  const dir = await scratch(t);
  for (const [answer, reason] of [
    [() => ({ status: 403, body: { error: 'insufficient_scope' } }), /cannot read backups: make a service credential with backup/u],
    [() => ({ status: 500, body: { error: 'internal', detail: 'boom' } }), /answered HTTP 500 internal: boom/u],
    [(token) => ({ status: 200, body: token === null ? PAGES[''] : { ...PAGES.b, takenAt: '2026-11-07T05:00:00.000Z' } }), /from another export/u],
    [() => ({ status: 200, body: { ...PAGES[''], table: '../etc' } }), /not a page of an Ntasks backup/u],
  ]) {
    const exported = await takeNtasksExport(ntasks(answer).service, dir);
    assert.match(exported.error, reason);
    assert.equal(exported.file, undefined);
    assert.deepEqual(await fs.readdir(exported.dir), []);
  }
  const unanswered = { call: async () => { throw new Error('Ntasks did not answer (network)'); } };
  assert.match((await takeNtasksExport(unanswered, dir)).error, /did not answer/u);
  const large = await takeNtasksExport(ntasks().service, dir, { maxBytes: 20 });
  assert.match(large.error, /larger than 20 bytes/u, 'an export past the bound stops before it is written');
  assert.deepEqual(await fs.readdir(large.dir), []);
});

test('an export folder that cannot be made fails the export alone, with the reason', async (t) => {
  const dir = await scratch(t);
  const blocker = path.join(dir, 'a-file');
  await fs.writeFile(blocker, '');
  const { service, asked } = ntasks();
  const exported = await takeNtasksExport(service, path.join(blocker, 'task-export'));
  assert.equal(exported.dir, null);
  assert.equal(exported.file, undefined);
  assert.match(exported.error, /ENOTDIR|EEXIST/u);
  assert.deepEqual(asked, [], 'Ntasks is not read');
});

test('a backup keeps only a private file holding one whole export', async (t) => {
  const dir = await scratch(t);
  await assert.rejects(readNtasksBackup(path.join(dir, 'missing.json')), /no Ntasks export came with this backup/u);
  const write = async (name, value, mode = 0o600) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    await fs.chmod(file, mode);
    return file;
  };
  const whole = { format: NTASKS_BACKUP_FORMAT, takenAt: TAKEN, migrations: MIGRATIONS, tables: { tasks: [{ id: 'ex-1' }] } };
  await assert.rejects(readNtasksBackup(await write('shared.json', whole, 0o644)), /not a private file/u);
  await assert.rejects(readNtasksBackup(await write('text.json', 'not json')), /not JSON/u);
  await assert.rejects(readNtasksBackup(await write('other.json', { ...whole, format: 'other' })), /not a whole ntasks-backup-v1 backup/u);
  await assert.rejects(readNtasksBackup(await write('empty.json', { ...whole, tables: {} })), /not a whole/u);
  await assert.rejects(readNtasksBackup(await write('big.json', whole), { maxBytes: 10 }), /larger than 10 bytes/u);
  const link = path.join(dir, 'link.json');
  await fs.symlink(await write('target.json', whole), link);
  await assert.rejects(readNtasksBackup(link), /not a private file/u);
});

test('an export is read through one opened file: no link, no special file, and no more than the bound however it grows', async (t) => {
  const dir = await scratch(t);
  const fifo = path.join(dir, 'pipe');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  await assert.rejects(readPrivateExport(fifo), /not a private file/u, 'a pipe is refused without waiting on a writer');
  const opened = [];
  const growing = { open: async (file, flags) => {
    opened.push(flags);
    return { stat: async () => ({ isFile: () => true, nlink: 1, mode: 0o100600, size: 4 }),
      read: async (buffer, offset, length) => { buffer.fill(32, offset, offset + length); return { bytesRead: length }; },
      close: async () => {} };
  } };
  await assert.rejects(readPrivateExport('/export', { fs: growing, maxBytes: 64 }), /larger than 64 bytes/u);
  assert.ok(opened[0] & fs.constants.O_NOFOLLOW, 'opened without following a link');
});
