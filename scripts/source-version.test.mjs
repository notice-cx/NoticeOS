import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitSourceVersion, sourceVersion } from './source-version.mjs';

const DATE = '2026-10-05T12:34:00.000Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE } }).trim();
  const manifest = version => fs.writeFileSync(path.join(root, 'container-source.json'), JSON.stringify({ schema: 'noticeos-container-source/1', version }));
  return { root, git, manifest };
}

test('source checkouts identify their own commit and timestamp, flag edits, and refuse a parent repository', t => {
  const f = fixture(t);
  f.git('-c', 'init.defaultBranch=main', 'init');
  fs.writeFileSync(path.join(f.root, 'source.ts'), 'export const value = 1;');
  f.git('add', 'source.ts');
  f.git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.com', 'commit', '-m', 'synthetic');
  const expected = { commit: f.git('rev-parse', 'HEAD'), committedAt: DATE, modified: false };
  assert.deepEqual(sourceVersion(f.root), expected);
  fs.appendFileSync(path.join(f.root, 'source.ts'), '\nexport const edited = true;');
  assert.deepEqual(sourceVersion(f.root), { ...expected, modified: true });
  const nested = path.join(f.root, 'nested'); fs.mkdirSync(nested);
  assert.equal(gitSourceVersion(nested), null);
  // A sealed image reports its own source even when located in a newer checkout.
  const image = { commit: 'a'.repeat(40), committedAt: DATE, modified: false };
  f.manifest(image);
  assert.deepEqual(sourceVersion(f.root), image);
  f.manifest({ ...image, committedAt: 'invalid' });
  assert.equal(sourceVersion(f.root), null);
});

test('Git-free archives preserve sealed provenance and never invent missing or invalid metadata', t => {
  const f = fixture(t);
  assert.equal(sourceVersion(f.root), null);
  const version = { commit: 'b'.repeat(40), committedAt: DATE, modified: false };
  f.manifest(version);
  assert.deepEqual(sourceVersion(f.root), version);
  for (const value of [null, { ...version, commit: 'main' }, { ...version, modified: 'false' }]) {
    f.manifest(value);
    assert.equal(sourceVersion(f.root), null);
  }
  const manifest = path.join(f.root, 'container-source.json');
  fs.writeFileSync(manifest, 'invalid JSON');
  assert.equal(sourceVersion(f.root), null);
  fs.unlinkSync(manifest); fs.symlinkSync(path.join(f.root, 'missing'), manifest);
  assert.equal(sourceVersion(f.root), null);
});
