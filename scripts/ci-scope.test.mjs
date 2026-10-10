import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main, needsRuntime, unreadByRuntime } from './ci-scope.mjs';

// A documentation-only pull request skips the unit and journey jobs (issue
// #4). These tests pin which files count as documentation, and check the rule
// against what those jobs run: no code they run may read a file it skips.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('documentation is docs/ and Markdown at the root', () => {
  for (const file of ['docs/14-design.md', 'docs/artifacts/wall-build-2026-09-23/laptop/shot.png', 'docs/briefs/2026-10-08-home-overview-redesign.md',
    'AGENTS.md', 'README.md', 'CONTRIBUTING.md']) {
    assert.equal(unreadByRuntime(file), true, file);
  }
  for (const file of ['apps/tower/README.md', 'config/tower.README.md', 'scripts/README.md', 'apps/tower/public/brand/notice-mark.svg',
    'apps/tower/e2e/ux-flows.mjs', '.github/workflows/ci.yml', 'package.json']) {
    assert.equal(unreadByRuntime(file), false, file);
  }
});

test('a change needs the runtime suites unless every file it touches is documentation they never read', () => {
  assert.equal(needsRuntime(['docs/14-design.md']), false);
  assert.equal(needsRuntime(['docs/14-design.md', 'AGENTS.md', 'docs/artifacts/x/shot.png']), false);
  assert.equal(needsRuntime(['docs/14-design.md', 'apps/tower/src/routes/WallRoute.tsx']), true);
  assert.equal(needsRuntime([]), true, 'a change that lists no file runs everything');
});

test('a push runs every suite; a pull request is judged on the files its merge commit changes, a rename on both paths', (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ci-scope-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' } });
    assert.equal(run.status, 0, run.stderr);
  };
  const output = path.join(repo, '.output');
  const judge = (env) => {
    writeFileSync(output, '');
    const stdout = process.stdout.write;
    process.stdout.write = () => true;
    try {
      return { runtime: main({ ...env, GITHUB_OUTPUT: output }, repo), written: readFileSync(output, 'utf8') };
    } finally {
      process.stdout.write = stdout;
    }
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'code.ts'), 'export {};\n');
  writeFileSync(path.join(repo, 'README.md'), '# A\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'docs');
  writeFileSync(path.join(repo, 'README.md'), '# B\n');
  git('commit', '-q', '-am', 'docs');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'docs');
  assert.deepEqual(judge({ GITHUB_EVENT_NAME: 'pull_request' }), { runtime: false, written: 'runtime=false\n' });
  assert.deepEqual(judge({ GITHUB_EVENT_NAME: 'push' }), { runtime: true, written: 'runtime=true\n' });

  git('checkout', '-q', '-b', 'rename', 'HEAD^1');
  git('mv', 'code.ts', 'AGENTS.md');
  git('commit', '-q', '-m', 'rename');
  git('checkout', '-q', 'main');
  git('reset', '-q', '--hard', 'HEAD^1');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'rename');
  assert.equal(judge({ GITHUB_EVENT_NAME: 'pull_request' }).runtime, true, 'code renamed into documentation still runs everything');
});

/** Tracked files under `folders`. */
function tracked(...folders) {
  const listed = spawnSync('git', ['ls-files', '-z', '--', ...folders], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter(Boolean);
}

/** What can read or import a file: scripts and modules, not data. */
const CODE = /\.(?:[cm]?[jt]sx?|html)$/u;
const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|new URL\(\s*)['"`]([^'"`]+)['"`]/gu;

/** The repository file a relative specifier in `from` names, if it exists. */
function resolveSpecifier(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const bare = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier.split('?')[0]));
  const authored = bare.replace(/\.mjs$/u, '.mts');
  for (const candidate of [bare, authored, `${bare}.ts`, `${bare}.tsx`, `${bare}.mjs`, `${bare}/index.ts`]) {
    if (existsSync(path.join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

test('no code a skipped job runs reads documentation the rule skips', () => {
  // What the Tower, ingest and browser jobs run: everything under apps/,
  // workers/ and packages/, and every module of the repository they import.
  const queue = tracked('apps', 'workers', 'packages').filter((file) => CODE.test(file));
  const seen = new Set(queue);
  const reads = [];
  for (let file = queue.shift(); file; file = queue.shift()) {
    const lines = readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (/^\s*(?:\/\/|\/?\*)/u.test(line)) continue;
      for (const [, specifier] of line.matchAll(SPECIFIER)) {
        const target = resolveSpecifier(file, specifier);
        if (!target) continue;
        if (unreadByRuntime(target)) reads.push(`${file}:${index + 1} imports ${target}`);
        if (CODE.test(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
      // A path built for a read: a docs/ path, or a root Markdown file by name.
      if (!/readFile|readdir|createReadStream|\?raw/u.test(line)) continue;
      const named = [...line.matchAll(/['"`]((?:docs\/[^'"`]*)|(?:[A-Z_]+\.md)|docs)['"`]/gu)].map((match) => match[1]);
      for (const name of named) {
        if (name === 'docs' || unreadByRuntime(name)) reads.push(`${file}:${index + 1} reads ${name}`);
      }
    }
  }
  assert.ok(seen.size > 500, `the scan followed the jobs' code (${seen.size} files)`);
  assert.deepEqual(reads, [], 'a skipped job reads this documentation: narrow unreadByRuntime in scripts/ci-scope.mjs, or stop the read');
});
