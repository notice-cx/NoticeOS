import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { preparePublicSource } from './public-source.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-public-source-'));
  const root = path.join(temporary, 'private');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  function git(...args) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: temporary,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function write(file, text = `fixture ${file}\n`) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  git('init', '--quiet');
  for (const file of ['.gitignore', '.githooks/pre-commit', '.github/workflows/ci.yml',
    'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
    'THIRD_PARTY_NOTICES.md', 'db/README.md',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
    'tsconfig.config-contract.json', 'tsconfig.config-contract.node.json',
    'scripts/script-tests-setup.mjs', 'apps/tower/package.json', 'workers/ingest/package.json',
    'db/postgres/tables.json', 'db/dolt/host/compose.yaml', 'deploy/compose/Dockerfile',
    'docs/README.md', 'docs/images/overview.svg', 'workers/ingest/src/credentials.ts',
    'workers/ingest/test/credentials.test.ts', 'apps/tower/public/brand/notice-design-system.zip']) write(file);
  write('scripts/public-source.settings.json', JSON.stringify({ schema: 'noticeos-public-documents/1', files: ['docs/README.md', 'docs/images/overview.svg'] }));
  for (const file of ['installation/beads.json', '.beads/config.yaml', '.dev.vars',
    'scripts/.env', 'apps/tower/node_modules/secret.txt', 'docs/artifacts/private.json',
    'docs/reports/private.md', 'docs/unreviewed.md', 'apps/tower/credentials.json',
    'apps/tower/private.key', 'apps/tower/private.zip', 'apps/tower/dist/compiled.js']) write(file, 'private fixture\n');
  write('.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(root, '.githooks/pre-commit'), 0o755);
  function commit() { git('add', '.'); git('commit', '--quiet', '-m', 'synthetic source'); return git('rev-parse', 'HEAD'); }
  return { temporary, root, write, git, commit, destination: name => path.join(temporary, name) };
}

test('export uses the immutable commit, includes required tests and excludes private state/history', t => {
  const f = fixture(t); const commit = f.commit();
  f.write('README.md', 'dirty readme must not ship\n');
  f.write('apps/tower/untracked.ts', 'untracked must not ship\n');
  const result = preparePublicSource({ root: f.root, commit, destination: f.destination('public') });
  assert.equal(fs.readFileSync(path.join(result.directory, 'README.md'), 'utf8'), 'fixture README.md\n');
  const names = result.manifest.files.map(row => row.file);
  for (const wanted of ['.githooks/pre-commit', '.github/workflows/ci.yml', 'docs/images/overview.svg',
    'workers/ingest/src/credentials.ts', 'workers/ingest/test/credentials.test.ts',
    'apps/tower/public/brand/notice-design-system.zip']) assert.ok(names.includes(wanted), wanted);
  for (const denied of ['.git', '.beads', 'installation', '.dev.vars', 'scripts/.env',
    'apps/tower/node_modules', 'docs/artifacts', 'docs/reports', 'docs/unreviewed.md',
    'apps/tower/untracked.ts', 'apps/tower/credentials.json', 'apps/tower/private.key', 'apps/tower/private.zip', 'apps/tower/dist']) {
    assert.equal(fs.existsSync(path.join(result.directory, denied)), false, denied);
  }
  assert.equal(fs.statSync(path.join(result.directory, '.githooks/pre-commit')).mode & 0o777, 0o755);
  for (const row of result.manifest.files) {
    const bytes = fs.readFileSync(path.join(result.directory, row.file));
    assert.equal(bytes.length, row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
  }
  const second = preparePublicSource({ root: f.root, commit, destination: f.destination('repeat') });
  assert.deepEqual(second.manifest, result.manifest);
  assert.deepEqual(fs.readFileSync(path.join(second.directory, 'public-source.json')),
    fs.readFileSync(path.join(result.directory, 'public-source.json')));
});

test('refuses mutable revisions, existing destinations, missing inputs and invalid document inventories', t => {
  const f = fixture(t); const commit = f.commit();
  assert.throws(() => preparePublicSource({ root: f.root, commit: 'HEAD', destination: f.destination('a') }), /full commit/);
  assert.throws(() => preparePublicSource({ root: f.root, commit, destination: f.root }), /outside the source/);
  assert.throws(() => preparePublicSource({ root: f.root, commit, destination: path.join(f.root, 'export') }), /outside the source/);
  fs.symlinkSync(f.root, f.destination('source-alias'));
  assert.throws(() => preparePublicSource({ root: f.root, commit, destination: path.join(f.destination('source-alias'), 'export') }), /outside the source/);
  fs.mkdirSync(f.destination('existing'));
  assert.throws(() => preparePublicSource({ root: f.root, commit, destination: f.destination('existing') }), /already exists/);
  fs.symlinkSync(path.join(f.temporary, 'absent'), f.destination('link'));
  assert.throws(() => preparePublicSource({ root: f.root, commit, destination: f.destination('link') }), /already exists/);
  f.git('rm', 'SECURITY.md'); const missing = f.commit();
  assert.throws(() => preparePublicSource({ root: f.root, commit: missing, destination: f.destination('b') }), /required public source/);
  f.write('SECURITY.md');
  f.write('scripts/public-source.settings.json', JSON.stringify({ schema: 'noticeos-public-documents/1', files: ['docs/../installation/private.md'] }));
  const invalid = f.commit();
  assert.throws(() => preparePublicSource({ root: f.root, commit: invalid, destination: f.destination('c') }), /inventory is invalid/);
  for (const name of ['a', 'b', 'c']) assert.equal(fs.existsSync(f.destination(name)), false);
});

test('refuses symlinks and nonportable collisions in public source', t => {
  const f = fixture(t);
  fs.symlinkSync('../../installation/beads.json', path.join(f.root, 'apps/tower/leak'));
  const symlink = f.commit();
  assert.throws(() => preparePublicSource({ root: f.root, commit: symlink, destination: f.destination('symlink') }), /regular files/);
  f.git('rm', 'apps/tower/leak'); f.commit();
  const blob = f.git('rev-parse', 'HEAD:README.md');
  f.git('update-index', '--add', '--cacheinfo', `100644,${blob},apps/tower/Case.ts`);
  f.git('update-index', '--add', '--cacheinfo', `100644,${blob},apps/tower/case.ts`);
  f.git('commit', '--quiet', '-m', 'case collision fixture');
  assert.throws(() => preparePublicSource({ root: f.root, commit: f.git('rev-parse', 'HEAD'), destination: f.destination('collision') }), /case-insensitive/);
  assert.equal(fs.existsSync(f.destination('symlink')), false);
  assert.equal(fs.existsSync(f.destination('collision')), false);
});
