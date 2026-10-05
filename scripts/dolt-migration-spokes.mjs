#!/usr/bin/env node
// Explicit captured-spoke operations; no SQL, process, service or initialization.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyStoppedDoltCapture } from './dolt-migration-capture.mjs';
import { readDoltProfile, readDoltCredentials } from './dolt-profile.mjs';

const fail = () => { throw Error('Captured spoke operation refused; preserve the private journal and any partial resources.'); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value && !/[\0\r\n]/u.test(value);
const name = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
function directory(folder, privateOwned = false) {
  for (let current = folder; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (current === folder && privateOwned && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) fail();
    if (path.dirname(current) === current) break;
  }
}
function read(file, privateOwned = false) {
  if (!absolute(file)) fail(); directory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) || stat.size > 64 * 1024 || (privateOwned && (stat.mode & 0o077))) fail();
  return { body: fs.readFileSync(file), stat };
}
function identity(file) {
  const { body, stat } = read(file);
  return { hash: digest(body), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, mode: stat.mode & 0o777, uid: stat.uid };
}
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function syncDirectory(folder) { const fd = fs.openSync(folder, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeNew(file, body, mode = 0o600) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, body); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function temporary(file, body, mode) {
  const temp = `${file}.noticeos-${randomBytes(12).toString('hex')}`;
  writeNew(temp, body, mode); return temp;
}
function journal(file, value, fresh = false) {
  const body = JSON.stringify(value, null, 2) + '\n';
  if (fresh) writeNew(file, body);
  else { read(file, true); const temp = temporary(file, body, 0o600); fs.renameSync(temp, file); }
  syncDirectory(path.dirname(file));
}

export function readSpokeMigrationPlan(file) {
  const input = JSON.parse(read(file, true).body);
  if (input.format !== 'noticeos-dolt-spokes-v1' || !absolute(input.capture) || !absolute(input.doltHome) || !absolute(input.rehearsal) || !absolute(input.journal) ||
    typeof input.approval !== 'string' || !input.approval || typeof input.writerFence !== 'string' || !input.writerFence ||
    !Array.isArray(input.spokes) || !input.spokes.length || input.spokes.length > 64 || input.spokes.some(spoke =>
      !absolute(spoke.repo) || !name(spoke.database) || !name(spoke.prefix) || !name(spoke.metadataName) || !name(spoke.configName) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(spoke.projectId ?? '')) ||
    new Set(input.spokes.map(spoke => spoke.repo)).size !== input.spokes.length || new Set(input.spokes.map(spoke => spoke.database)).size !== input.spokes.length) fail();
  // Destinations must never overlap immutable capture, original database files,
  // or any source project directory, including in the reverse direction.
  const marker = verifyStoppedDoltCapture(input.capture);
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  for (const destination of [input.rehearsal, input.journal]) {
    for (const source of [input.capture, marker.sourceDirectory, ...input.spokes.map(spoke => path.join(spoke.repo, '.beads'))]) if (overlaps(destination, source)) fail();
  }
  if (overlaps(input.rehearsal, input.journal)) fail();
  directory(path.dirname(input.journal), true); directory(path.dirname(input.rehearsal), true); directory(input.doltHome, true);
  read(path.join(input.doltHome, 'dolt/profile.json'), true);
  const profile = readDoltProfile(input.doltHome); if (!profile) fail(); readDoltCredentials(profile);
  const files = [];
  for (const spoke of input.spokes) {
    if (!marker.databases.includes(spoke.database)) fail();
    for (const [kind, metadataName, filename] of [['metadata', spoke.metadataName, 'metadata.json'], ['config', spoke.configName, 'config.yaml']]) {
      const original = path.join(spoke.repo, '.beads', filename);
      if (!marker.sourceFiles.some(source => source.name === metadataName && source.path === original) || marker.metadataPresent[metadataName] !== true) fail();
      const captured = path.join(input.capture, 'metadata', metadataName); const body = read(captured, true).body;
      let changed;
      if (kind === 'metadata') {
        const meta = JSON.parse(body);
        if (meta.project_id !== spoke.projectId || meta.dolt_database !== spoke.database || meta.dolt_mode !== 'server') fail();
        changed = Buffer.from(JSON.stringify({ ...meta, dolt_server_host: '127.0.0.1', dolt_server_port: profile.port, dolt_server_user: 'noticeos' }, null, 2) + '\n');
      } else {
        const lines = body.toString('utf8').split('\n');
        // Bound this adapter to the reviewed flat safety/connection declaration.
        // Unknown simple settings/comments survive; nested or multiline YAML is
        // refused rather than rewritten by a guessed parser.
        if (lines.some(line => line.trim() && !/^\s*#/u.test(line) && !/^[a-zA-Z][a-zA-Z0-9_.-]*:\s*(?:[^|>\r\n]*)$/u.test(line))) fail();
        const noGit = lines.filter(line => /^no-git-ops:/u.test(line));
        const imports = lines.filter(line => /^import\.auto:/u.test(line));
        if (noGit.length !== 1 || !/^no-git-ops:\s*true\s*(?:#.*)?$/u.test(noGit[0]) ||
          imports.length !== 1 || !/^import\.auto:\s*false\s*(?:#.*)?$/u.test(imports[0]) || lines.some(line => /^sync\.remote:/u.test(line))) fail();
        changed = Buffer.from(lines.filter(line => !/^dolt\.server\.(?:host|port|user):/u.test(line)).join('\n').replace(/\n*$/u, '') +
          `\ndolt.server.host: 127.0.0.1\ndolt.server.port: ${profile.port}\ndolt.server.user: noticeos\n`);
      }
      files.push({ original, captured, body, changed, database: spoke.database, filename });
    }
  }
  return { input, profile, files };
}

export function rehearseSpokeMigration(file) {
  const { input, files } = readSpokeMigrationPlan(file);
  if (fs.lstatSync(input.rehearsal, { throwIfNoEntry: false })) fail();
  fs.mkdirSync(input.rehearsal, { mode: 0o700 });
  const results = [];
  for (const spoke of input.spokes) {
    const repo = path.join(input.rehearsal, spoke.database); fs.mkdirSync(repo, { mode: 0o700 }); fs.mkdirSync(path.join(repo, '.beads'), { mode: 0o700 });
    for (const selected of files.filter(entry => entry.database === spoke.database)) writeNew(path.join(repo, '.beads', selected.filename), selected.changed);
    writeNew(path.join(repo, '.beads.gate.lock'), ''); results.push({ database: spoke.database, repo, projectId: spoke.projectId });
  }
  writeNew(path.join(input.rehearsal, 'spokes.json'), JSON.stringify({ format: 'noticeos-dolt-spokes-v1', complete: true, projects: results }) + '\n');
  return { complete: true, projects: results };
}

export function installSpokeMigration(file) {
  const { input, files } = readSpokeMigrationPlan(file);
  if (fs.lstatSync(input.journal, { throwIfNoEntry: false })) fail();
  // Check every original before any replacement; source-generation drift fails.
  const entries = files.map(selected => {
    const old = read(selected.original);
    if (!old.body.equals(selected.body)) fail();
    return { original: selected.original, captured: selected.captured, before: identity(selected.original), after: null, temp: null };
  });
  const receipt = { format: 'noticeos-dolt-spokes-journal-v1', capture: input.capture, approval: input.approval, writerFence: input.writerFence, complete: false, entries };
  journal(input.journal, receipt, true);
  for (const [index, selected] of files.entries()) {
    const entry = entries[index]; if (!same(identity(entry.original), entry.before)) fail();
    const temp = temporary(entry.original, selected.changed, entry.before.mode);
    entry.temp = temp; entry.after = identity(temp); journal(input.journal, receipt);
    if (!same(identity(entry.original), entry.before)) fail();
    fs.renameSync(temp, entry.original); syncDirectory(path.dirname(entry.original)); entry.temp = null; journal(input.journal, receipt);
  }
  receipt.complete = true; journal(input.journal, receipt);
  return { complete: true, files: entries.length, endpoint: { host: '127.0.0.1', port: files.length ? JSON.parse(files[0].changed).dolt_server_port : null, user: 'noticeos' } };
}

export function rollbackSpokeMigration(file) {
  const { input, files } = readSpokeMigrationPlan(file);
  const receipt = JSON.parse(read(input.journal, true).body);
  if (receipt.format !== 'noticeos-dolt-spokes-journal-v1' || receipt.capture !== input.capture || receipt.approval !== input.approval || receipt.writerFence !== input.writerFence || receipt.entries?.length !== files.length || receipt.rolledBack) fail();
  // Accept partial journals, including a crash after rename before journaling.
  // Preflight every entry; never overwrite a caller's later independent edit.
  for (const [index, selected] of files.entries()) {
    const entry = receipt.entries[index];
    const safeTemp = temp => typeof temp === 'string' && new RegExp(`^${entry.original.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.noticeos-[0-9a-f]{24}$`, 'u').test(temp);
    if (entry.original !== selected.original || entry.captured !== selected.captured || entry.before.hash !== digest(selected.body) ||
      !Number.isInteger(entry.before.mode) || (entry.before.mode & 0o022) || entry.before.mode < 0 || entry.before.mode > 0o777 ||
      (entry.after && entry.after.hash !== digest(selected.changed)) ||
      (entry.restored && (entry.restored.hash !== digest(selected.body) || entry.restored.mode !== entry.before.mode)) ||
      (entry.temp && !safeTemp(entry.temp)) || (entry.restoreTemp && (!entry.restored || !safeTemp(entry.restoreTemp)))) fail();
    const current = identity(entry.original);
    if (!same(current, entry.before) && (!entry.after || !same(current, entry.after)) && (!entry.restored || !same(current, entry.restored))) fail();
    if (entry.temp && fs.lstatSync(entry.temp, { throwIfNoEntry: false }) && !same(identity(entry.temp), entry.after)) fail();
    if (entry.restoreTemp) {
      if (fs.lstatSync(entry.restoreTemp, { throwIfNoEntry: false })) { if (!same(identity(entry.restoreTemp), entry.restored)) fail(); }
      else if (!same(current, entry.restored)) fail();
    }
  }
  for (const [index, selected] of files.entries()) {
    const entry = receipt.entries[index];
    if (!same(identity(entry.original), entry.before) && (!entry.restored || !same(identity(entry.original), entry.restored))) {
      if (!same(identity(entry.original), entry.after)) fail();
      const temp = entry.restoreTemp ?? temporary(entry.original, selected.body, entry.before.mode);
      entry.restoreTemp = temp; entry.restored = identity(temp); journal(input.journal, receipt);
      if (!same(identity(entry.original), entry.after)) fail();
      fs.renameSync(temp, entry.original); syncDirectory(path.dirname(entry.original)); entry.restoreTemp = null; journal(input.journal, receipt);
    } else if (entry.restoreTemp) {
      // A previous restore already renamed this recorded inode. Clear the
      // pending path only after fsync; never adopt an independently replaced file.
      if (fs.lstatSync(entry.restoreTemp, { throwIfNoEntry: false })) fail();
      syncDirectory(path.dirname(entry.original)); entry.restoreTemp = null; journal(input.journal, receipt);
    }
    if (entry.temp && fs.lstatSync(entry.temp, { throwIfNoEntry: false })) {
      if (!same(identity(entry.temp), entry.after)) fail(); fs.unlinkSync(entry.temp);
    }
  }
  receipt.rolledBack = true; journal(input.journal, receipt); return { rolledBack: true, files: files.length };
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv.length !== 3 || argv[1] !== '--plan' || !['rehearse', 'install', 'rollback'].includes(argv[0])) fail();
    const result = ({ rehearse: rehearseSpokeMigration, install: installSpokeMigration, rollback: rollbackSpokeMigration })[argv[0]](argv[2]);
    stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch { stderr.write('Captured spoke operation refused; preserve protected receipts and partial resources.\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
