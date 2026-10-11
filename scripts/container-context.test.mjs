import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { prepareContainerContext, publicContainerPath } from './container-context.mjs';
import { sourceVersion } from './source-version.mjs';

const required = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'deploy/compose/licenses/beads-1.3.1-LICENSE.txt', 'deploy/compose/licenses/dolt-2.4.0-LICENSE.txt', 'deploy/compose/licenses/sources.json',
  'apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc', 'db/postgres/tables.json', 'deploy/compose/Dockerfile', 'deploy/compose/entrypoint.mjs', 'deploy/compose/development.mjs', 'deploy/compose/health.mjs'];
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-container-context-'));
  const root = path.join(parent, 'source'); fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const write = (file, body = 'public input') => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), body); };
  for (const file of required) write(file);
  return { root, destination: path.join(parent, 'context'), write };
}

test('the public image context excludes every private root, nested state and secret file before copying', t => {
  const own = fixture(t);
  const denied = ['.git/config', '.beads/config.yaml', 'installation/beads.json', '.local/backups/secret.json', '.wrangler/state/data.json', 'postgres/secret.json',
    'artifacts/capture.json', 'deploy/compose/private.json', 'apps/tower/.env', 'apps/tower/.dev.vars', 'apps/tower/public/secrets/key.json',
    'apps/tower/src/token.key', 'workers/ingest/src/.dev.secrets.json', 'packages/postgres/node_modules/secret.js', 'scripts/example.test.mjs', 'docs/private.md', '../package.json'];
  const allowed = ['scripts/dev-secrets.mjs', 'scripts/host-backup.mjs', 'packages/postgres/src/store.mjs', 'db/postgres/migrations/0001_baseline.sql',
    'config/beads.json', 'apps/tower/src/App.tsx'];
  for (const file of denied) assert.equal(publicContainerPath(file), false, file);
  for (const file of allowed) { assert.equal(publicContainerPath(file), true, file); own.write(file); }
  for (const file of denied.filter(file => !file.startsWith('../'))) own.write(file, 'PRIVATE-SENTINEL');
  const result = prepareContainerContext({ ...own, files: [...required, ...allowed, ...denied] });
  assert.deepEqual(result.files.map(row => row.file), [...required, ...allowed].sort());
  assert.ok(result.files.every(row => !fs.readFileSync(path.join(result.directory, row.file), 'utf8').includes('PRIVATE-SENTINEL')));
  assert.match(fs.readFileSync(path.join(result.directory, '.dockerignore'), 'utf8'), /\*\*\/\.beads/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.directory, 'container-source.json'), 'utf8')).files.length, required.length + allowed.length);
});

test('a source symlink or symlinked ancestor refuses before making a build context', t => {
  for (const ancestor of [false, true]) {
    const own = fixture(t);
    const target = path.join(path.dirname(own.root), `outside-${ancestor}`); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'file.mjs'), 'PRIVATE-SENTINEL');
    if (ancestor) fs.symlinkSync(target, path.join(own.root, 'scripts'));
    else { fs.mkdirSync(path.join(own.root, 'scripts')); fs.symlinkSync(path.join(target, 'file.mjs'), path.join(own.root, 'scripts/file.mjs')); }
    assert.throws(() => prepareContainerContext({ ...own, files: [...required, 'scripts/file.mjs'] }), /regular files/);
    assert.equal(fs.existsSync(own.destination), false);
  }
});

test('a Git-free image context carries the exact committed source and timestamp', t => {
  const own = fixture(t);
  const date = '2026-10-05T12:34:00.000Z';
  const git = (...args) => execFileSync('git', args, { cwd: own.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
  git('-c', 'init.defaultBranch=main', 'init'); git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.com', 'commit', '-m', 'synthetic');
  const expected = { commit: git('rev-parse', 'HEAD'), committedAt: date, modified: false };
  const context = prepareContainerContext({ ...own, files: required });
  assert.equal(fs.existsSync(path.join(context.directory, '.git')), false);
  assert.deepEqual(context.version, expected);
  assert.deepEqual(sourceVersion(context.directory), expected);
});

test('existing, missing-input or in-checkout contexts refuse without writes', t => {
  const own = fixture(t);
  assert.throws(() => prepareContainerContext({ ...own, destination: path.join(own.root, 'context'), files: required }), /outside/);
  assert.throws(() => prepareContainerContext({ ...own, files: required.slice(1) }), /required/);
  assert.equal(fs.existsSync(own.destination), false);
  fs.mkdirSync(own.destination); fs.writeFileSync(path.join(own.destination, 'sentinel'), 'retained');
  assert.throws(() => prepareContainerContext({ ...own, files: required }), /new absolute/);
  assert.equal(fs.readFileSync(path.join(own.destination, 'sentinel'), 'utf8'), 'retained');
});

test('every workspace pnpm-workspace.yaml declares sends its manifest, or the image cannot install the lockfile', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const globs = [...fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8').matchAll(/^\s+-\s+"([^"]+)"\s*$/gmu)].map(match => match[1]);
  assert.ok(globs.length >= 4, 'the workspace list was read');
  const manifests = globs.flatMap(glob => glob.endsWith('/*')
    ? fs.readdirSync(path.join(root, glob.slice(0, -2)), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${glob.slice(0, -2)}/${entry.name}/package.json`)
    : [`${glob}/package.json`]).filter(file => fs.existsSync(path.join(root, file)));
  assert.ok(manifests.includes('docs/package.json'));
  for (const file of manifests) assert.equal(publicContainerPath(file), true, `${file} is a workspace the lockfile records`);
});
