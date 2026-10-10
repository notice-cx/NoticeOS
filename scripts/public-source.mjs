#!/usr/bin/env node
// Export committed source only. This prepares files; it never publishes them.
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';

const MAX_BYTES = 256 * 1024 * 1024;
const FREE_FLOOR = 8 * 1024 * 1024 * 1024;
const ROOT_FILES = new Set(['.gitignore', '.githooks/pre-commit', '.github/workflows/ci.yml', '.github/workflows/docs.yml',
  'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'THIRD_PARTY_NOTICES.md', 'db/README.md',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
  'tsconfig.config-contract.json', 'tsconfig.config-contract.node.json']);
const TREES = ['apps/tower/', 'workers/ingest/', 'packages/contract/', 'packages/postgres/',
  'packages/mediavine/', 'scripts/', 'config/', 'db/postgres/', 'db/dolt/', 'db/fixtures/', 'deploy/'];
const PRIVATE_SEGMENTS = /(?:^|\/)(?:\.[^/]+|installation|node_modules|secrets?|backups?|artifacts|test-results|playwright-report|dist|coverage)(?:\/|$)/iu;
const PRIVATE_FILE = /(?:^|\/)(?:[^/]*\.(?:pem|key|sqlite(?:3)?|db|dump|tar|gz|zip)|credentials(?:\.(?:json|ya?ml|ini|txt))?)$/iu;
// Public download referenced by the shipped brand page. Review its contents
// and scan nested archives as part of release qualification; no general ZIP rule.
const PUBLIC_ARCHIVES = new Set(['apps/tower/public/brand/notice-design-system.zip']);
// The documentation site's own config folder; every other dot-folder stays private.
const PUBLIC_DOT_TREES = ['docs/.vitepress/'];
const SETTINGS = 'scripts/public-source.settings.json';
const REQUIRED = [...ROOT_FILES, SETTINGS, 'scripts/script-tests-setup.mjs',
  'apps/tower/package.json', 'workers/ingest/package.json', 'db/postgres/tables.json',
  'db/dolt/host/compose.yaml', 'deploy/compose/Dockerfile'];

function validPath(file) {
  return typeof file === 'string' && !/[\\\x00-\x1f\x7f]/u.test(file)
    && !file.split('/').some(part => !part || part === '.' || part === '..');
}
function privatePath(file) {
  const tree = PUBLIC_DOT_TREES.find(prefix => file.startsWith(prefix));
  return PRIVATE_SEGMENTS.test(tree ? file.slice(tree.length) : file)
    || (PRIVATE_FILE.test(file) && !PUBLIC_ARCHIVES.has(file));
}
/** Whether the document inventory lists a file, by its own path or a listed folder ending in `/`. */
export function inventoryCovers(inventory, file) {
  return [...inventory].some(entry => (entry.endsWith('/') ? file.startsWith(entry) : entry === file));
}
function publicPath(file, documents) {
  if (!validPath(file)) return false;
  if (ROOT_FILES.has(file)) return true;
  if (privatePath(file)) return false;
  return inventoryCovers(documents, file) || TREES.some(prefix => file.startsWith(prefix));
}
function git(root, args, input) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', root, ...args], {
    input, maxBuffer: MAX_BYTES + 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('Committed source could not be read.');
  return result.stdout;
}
function tree(root, commit) {
  return git(root, ['ls-tree', '-rlz', commit]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/u.exec(line);
    if (!match) throw new Error('Unexpected source tree entry.');
    return { mode: match[1], type: match[2], object: match[3], bytes: Number(match[4]), file: match[5] };
  });
}
function documents(root, entries) {
  const entry = entries.find(row => row.file === SETTINGS);
  if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.bytes > 64 * 1024) {
    throw new Error('Committed public document inventory is missing or invalid.');
  }
  const settings = JSON.parse(git(root, ['cat-file', 'blob', entry.object]).toString('utf8'));
  if (settings.schema !== 'noticeos-public-documents/1' || !Array.isArray(settings.files)
    || settings.files.some(file => !validPath(file.replace(/\/$/u, '')) || !file.startsWith('docs/')
      || privatePath(file.endsWith('/') ? `${file}x` : file))
    || new Set(settings.files).size !== settings.files.length) {
    throw new Error('Public document inventory is invalid.');
  }
  return new Set(settings.files);
}

/** A new directory containing the exact selected Git blobs and a portable
 * SHA-256 manifest. Dirty/untracked files, filters, archives and Git history
 * never enter the export. Secret/content review is a separate release check. */
export function preparePublicSource({ root, commit, destination } = {}) {
  if (!path.isAbsolute(root ?? '') || !path.isAbsolute(destination ?? '')
    || typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
    throw new Error('Use an absolute source, a full commit hash and a new absolute destination.');
  }
  root = fs.realpathSync(root);
  if (git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim() !== commit) {
    throw new Error('Source must name an exact commit.');
  }
  const parent = fs.realpathSync(path.dirname(destination));
  destination = path.join(parent, path.basename(destination));
  if (destination === root || destination.startsWith(root + path.sep)) {
    throw new Error('Export destination must be outside the source checkout.');
  }
  try { fs.lstatSync(destination); throw new Error('Export destination already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = tree(root, commit);
  const docs = documents(root, entries);
  const selected = entries.filter(row => publicPath(row.file, docs)).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const names = new Set(selected.map(row => row.file));
  const present = (entry) => (entry.endsWith('/') ? [...names].some(file => file.startsWith(entry)) : names.has(entry));
  if ([...REQUIRED, ...docs].some(entry => !present(entry))) throw new Error('A required public source file is missing.');
  if (selected.some(row => row.type !== 'blob' || !['100644', '100755'].includes(row.mode))) {
    throw new Error('Public source must contain regular files only.');
  }
  if (new Set(selected.map(row => row.file.normalize('NFC').toLowerCase())).size !== selected.length) {
    throw new Error('Public file names collide on a case-insensitive filesystem.');
  }
  const sourceBytes = selected.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_BYTES) throw new Error('Public source exceeds the bounded export size.');
  const disk = fs.statfsSync(parent);
  if (disk.bavail * disk.bsize - sourceBytes * 2 - 16 * 1024 * 1024 < FREE_FLOOR) {
    throw new Error('Export would leave less than 8 GiB free.');
  }
  // One batch reads immutable blobs, without checkout filters or per-file Git processes.
  const blobs = git(root, ['cat-file', '--batch'], selected.map(row => row.object).join('\n') + '\n');
  let offset = 0;
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    const files = [];
    for (const row of selected) {
      const newline = blobs.indexOf(10, offset);
      const header = blobs.subarray(offset, newline).toString('utf8');
      if (newline < offset || header !== `${row.object} blob ${row.bytes}`) throw new Error('Source blob inventory mismatch.');
      offset = newline + 1;
      const bytes = blobs.subarray(offset, offset + row.bytes);
      offset += row.bytes;
      if (bytes.length !== row.bytes || blobs[offset++] !== 10) throw new Error('Source blob is truncated.');
      const target = path.join(destination, row.file);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      const mode = row.mode === '100755' ? 0o755 : 0o644;
      fs.writeFileSync(target, bytes, { flag: 'wx', mode });
      fs.chmodSync(target, mode);
      files.push({ file: row.file, mode: row.mode, bytes: row.bytes,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    if (offset !== blobs.length) throw new Error('Unexpected trailing source bytes.');
    const manifest = { schema: 'noticeos-public-source/1', commit, files };
    fs.writeFileSync(path.join(destination, 'public-source.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    return { directory: destination, manifest };
  } catch (error) {
    // This function created this new directory and has not started any process in it.
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== '--commit' || process.argv[4] !== '--destination') throw new Error('Invalid arguments.');
    const result = preparePublicSource({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      commit: process.argv[3], destination: process.argv[5] });
    process.stdout.write(`Prepared public source: ${result.manifest.files.length} committed files. Review before publication.\n`);
  } catch (error) {
    process.stderr.write(`Public export refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
