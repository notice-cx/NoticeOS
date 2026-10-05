// Published analytical generations are immutable. Backup pins their manifest
// closure without taking over a writer's process-local lock.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FORMAT = 'noticeos-analytical-history-backup/1';
const MANIFEST = /^\d{8}\.json$/u;
const HASH = /^[0-9a-f]{64}$/u;
const DATA = /^data\/[a-z0-9][a-z0-9-]*\/[a-zA-Z0-9_-]+\/([0-9a-f]{32})\.parquet$/u;

export function analyticalHistoryDirectory(settings) {
  const relative = settings.analyticalHistoryDirectory;
  if (relative === undefined || relative === null) return null;
  if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0')
    || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('analyticalHistoryDirectory must name a folder inside the installation directory.');
  }
  return relative;
}

async function regularPath(root, relative, io, directory = false) {
  let current = root;
  const rootStat = await io.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('History requires a regular source directory.');
  const parts = relative ? relative.split('/') : [];
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await io.lstat(current);
    const folder = directory || index < parts.length - 1;
    if (stat.isSymbolicLink() || (folder ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('History paths must contain only regular directories and files.');
    }
  }
  return current;
}

function unchanged(before, after) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]);
}

async function digestFile(file, io, output) {
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('History requires regular files.');
    if (output) target = await io.open(output, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (target) await target.writeFile(chunk);
      bytes += read.bytesRead;
    }
    if (!unchanged(before, await handle.stat())) throw new Error('A captured history file changed during backup.');
    if (target) await target.sync();
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await target?.close();
    await handle.close();
  }
}

async function manifestBytes(file, io) {
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('History manifest is not a bounded regular file.');
    const bytes = await handle.readFile();
    if (!unchanged(stat, await handle.stat())) throw new Error('A captured history manifest changed during backup.');
    return bytes;
  } finally { await handle.close(); }
}

const heldKey = file => JSON.stringify([file.workspaceId, file.table, file.path, file.bytes, file.sha256, file.fingerprint]);

async function snapshot(root, io, names) {
  const { HISTORY_FORMAT, contentOf, generationFile } = await import('./history-files.mjs');
  await regularPath(root, 'generations', io, true);
  names ??= (await io.readdir(path.join(root, 'generations'))).filter(name => MANIFEST.test(name)).sort();
  if (!names.length) throw new Error('Configured analytical history has no published generation.');
  const manifests = [];
  const files = new Map();
  const heldFiles = new Map();
  for (const name of names) {
    const relative = `generations/${name}`;
    const bytes = await manifestBytes(await regularPath(root, relative, io), io);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.format !== HISTORY_FORMAT || !Number.isSafeInteger(manifest.generation) || manifest.generation < 1
      || generationFile(manifest.generation) !== name || !Array.isArray(manifest.datasets)
      || (manifest.tables !== undefined && !Array.isArray(manifest.tables?.datasets))
      || manifest.content !== contentOf(manifest)) throw new Error('History generation is incomplete or has changed content.');
    const datasets = [manifest.sources, ...manifest.datasets, ...(manifest.tables?.datasets ?? [])].filter(Boolean);
    for (const dataset of datasets) {
      if (!Array.isArray(dataset.files) || !Number.isSafeInteger(dataset.rows) || dataset.rows < 0) throw new Error('History dataset is incomplete.');
      let rows = 0;
      for (const file of dataset.files) {
        const match = DATA.exec(file.path);
        if (!match || match[1] !== file.fingerprint || !HASH.test(file.sha256)
          || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !Number.isSafeInteger(file.rows) || file.rows < 0) {
          throw new Error('History file declaration is incomplete or unsafe.');
        }
        const record = { path: file.path, bytes: file.bytes, sha256: file.sha256, fingerprint: file.fingerprint };
        if (files.has(file.path) && JSON.stringify(files.get(file.path)) !== JSON.stringify(record)) throw new Error('History generations disagree about a shared file.');
        files.set(file.path, record);
        if (manifest.tables?.datasets.includes(dataset)) {
          if (typeof manifest.tables.workspaceId !== 'string' || !manifest.tables.workspaceId
            || typeof dataset.table !== 'string' || !dataset.table) throw new Error('Held table identity is incomplete.');
          const held = { workspaceId: manifest.tables.workspaceId, table: dataset.table, ...record };
          heldFiles.set(heldKey(held), held);
        }
        rows += file.rows;
      }
      if (rows !== dataset.rows) throw new Error('History dataset row counts disagree with its files.');
    }
    manifests.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: manifest.content, generation: manifest.generation, body: bytes });
  }
  return { manifests, files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    heldFiles: [...heldFiles.values()].sort((left, right) => heldKey(left).localeCompare(heldKey(right))) };
}

function inventory(pinned) {
  return {
    format: FORMAT, complete: true,
    generations: pinned.manifests.map(({ body: _body, ...record }) => record),
    files: pinned.files,
    heldFiles: pinned.heldFiles,
  };
}

/** Verify the entire captured closure, including each generation's own format
 * and content fingerprint. New unrelated files are never treated as datasets. */
export async function verifyAnalyticalHistoryBackup(root, { io = fs, expected } = {}) {
  const receipt = JSON.parse((await manifestBytes(await regularPath(root, 'custody.json', io), io)).toString('utf8'));
  if (receipt.format !== FORMAT || receipt.complete !== true || !Array.isArray(receipt.generations) || !Array.isArray(receipt.files)) throw new Error('History custody is incomplete.');
  const pinned = await snapshot(root, io);
  const actual = inventory(pinned);
  if (JSON.stringify(receipt) !== JSON.stringify(actual) || (expected && JSON.stringify(actual) !== JSON.stringify(expected))) throw new Error('History custody does not match the captured generation closure.');
  for (const file of actual.files) {
    const found = await digestFile(await regularPath(root, file.path, io), io);
    if (found.bytes !== file.bytes || found.sha256 !== file.sha256) throw new Error('History Parquet bytes do not match their generation manifest.');
  }
  return actual;
}

async function heldCoverage(directory, io) {
  let historyExists = false;
  try { await io.lstat(path.join(directory, 'history')); historyExists = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let marker;
  try { marker = JSON.parse(await io.readFile(path.join(directory, 'backup.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && !historyExists) return []; throw error; }
  if (marker.format !== 'noticeos-backup-v1' || marker.analyticalHistory === undefined) {
    if (historyExists) throw new Error('History custody metadata is missing or unrecognized; rotation was refused.');
    return [];
  }
  if (marker.complete !== true) throw new Error('Incomplete history custody cannot justify backup rotation.');
  const verified = await verifyAnalyticalHistoryBackup(path.join(directory, 'history'), { io, expected: marker.analyticalHistory });
  return verified.heldFiles.map(heldKey);
}

/** A same-day replacement cannot discard the only captured held rows. */
export async function assertAnalyticalHistoryReplacement(previous, next, { io = fs } = {}) {
  const required = await heldCoverage(previous, io);
  if (!required.length) return;
  const replacement = new Set(await heldCoverage(next, io));
  if (required.some(key => !replacement.has(key))) throw new Error('Replacement would discard retained held-table history; the previous set was preserved.');
}

/** Dated rotation can remove redundant custody, never the last verified copy
 * of a held-table file. Derive requirements once from published manifests,
 * then prefer the newest verified backup covering any still-uncovered file. */
export async function retainedAnalyticalHistoryDates(base, dates, retained, { io = fs } = {}) {
  const keep = new Set(retained);
  const coverage = new Map();
  for (const date of [...dates].sort()) coverage.set(date, await heldCoverage(path.join(base, date), io));
  const covered = new Set([...keep].flatMap(date => coverage.get(date) ?? []));
  for (const date of [...dates].sort().reverse()) {
    const keys = coverage.get(date);
    if (keys.some(key => !covered.has(key))) {
      keep.add(date);
      for (const key of keys) covered.add(key);
    }
  }
  return keep;
}

/** Copy all generations published at snapshot start and every file they name.
 * A newer immutable generation can appear while copying; captured mutations,
 * removals, or damaged files fail. No source files or writer locks are changed. */
export async function backupAnalyticalHistory({ installation, relative, output, io = fs }) {
  relative = analyticalHistoryDirectory({ analyticalHistoryDirectory: relative });
  if (relative === null) throw new Error('An analytical history source must be declared.');
  const source = await regularPath(installation, relative, io, true);
  const resolvedOutput = path.resolve(output);
  if (source === resolvedOutput || resolvedOutput.startsWith(source + path.sep) || source.startsWith(resolvedOutput + path.sep)) {
    throw new Error('History source and backup destination must be separate folders.');
  }
  const pinned = await snapshot(source, io);
  const receipt = inventory(pinned);
  await io.mkdir(output, { mode: 0o700 });
  for (const file of pinned.files) {
    const from = await regularPath(source, file.path, io);
    const target = path.join(output, file.path);
    await io.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const found = await digestFile(from, io, target);
    if (found.bytes !== file.bytes || found.sha256 !== file.sha256) throw new Error('History Parquet bytes do not match their generation manifest.');
  }
  await io.mkdir(path.join(output, 'generations'), { mode: 0o700 });
  for (const manifest of pinned.manifests) await io.writeFile(path.join(output, manifest.path), manifest.body, { flag: 'wx', mode: 0o600 });
  const checked = inventory(await snapshot(source, io, pinned.manifests.map(manifest => path.basename(manifest.path))));
  if (JSON.stringify(checked) !== JSON.stringify(receipt)) throw new Error('Captured history generations changed during backup.');
  for (const file of pinned.files) {
    const found = await digestFile(await regularPath(source, file.path, io), io);
    if (found.bytes !== file.bytes || found.sha256 !== file.sha256) throw new Error('A captured history file changed before backup completed.');
  }
  await io.writeFile(path.join(output, 'custody.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return verifyAnalyticalHistoryBackup(output, { io, expected: receipt });
}
