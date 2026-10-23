import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JOBS, laneOf, main, neededJobs, needsRuntime, unreadByRuntime } from './ci-scope.mjs';

// A pull request runs the PR lane and every other run the full lane; a
// documentation-only pull request skips the unit and journey jobs (issue #4).
// These tests pin both, and check the documentation rule against what those
// jobs run: no code they run may read a file it skips.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('documentation is docs/ and Markdown at the root', () => {
  for (const file of ['docs/14-design.md', 'docs/artifacts/wall-build-2026-09-23/laptop/shot.png', 'docs/guides/add-your-first-site.md', 'docs/.vitepress/config.mts',
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

const EVERY_JOB_BUT_SMOKE = Object.fromEntries(JOBS.map((job) => [job, job !== 'smoke']));
const DOCS_ONLY = Object.fromEntries(JOBS.map((job) => [job, job === 'scripts']));

test('a pull request runs the PR lane; the merge queue, main, the nightly run and a hand-started run run the full lane', () => {
  assert.equal(laneOf('pull_request'), 'pr');
  for (const event of ['push', 'merge_group', 'schedule', 'workflow_dispatch', 'local']) {
    assert.equal(laneOf(event), 'full', event);
    assert.deepEqual(neededJobs(event, ['docs/14-design.md']), EVERY_JOB_BUT_SMOKE, `${event} runs every job, whatever it changes`);
  }
  assert.deepEqual(neededJobs('pull_request', ['apps/tower/src/routes/WallRoute.tsx']), {
    'tower-unit': true, 'ingest-unit': true, scripts: true, smoke: true, browser: false, 'flow-gate': false, 'task-store': false,
  });
  assert.deepEqual(neededJobs('pull_request', ['docs/14-design.md', 'AGENTS.md']), DOCS_ONLY);
});

test('every job a lane can skip is one the full lane runs, and the root script suite runs in every run', () => {
  const full = neededJobs('push');
  for (const files of [['docs/14-design.md'], ['apps/tower/src/routes/WallRoute.tsx'], []]) {
    const pr = neededJobs('pull_request', files);
    assert.deepEqual(Object.keys(pr), [...JOBS]);
    assert.equal(pr.scripts, true);
    for (const job of JOBS) if (pr[job] && job !== 'smoke') assert.equal(full[job], true, `${job} runs in the full lane`);
  }
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
      return { ...main({ ...env, GITHUB_OUTPUT: output }, repo), written: readFileSync(output, 'utf8') };
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
  assert.deepEqual(judge({ GITHUB_EVENT_NAME: 'pull_request' }), { lane: 'pr', needed: DOCS_ONLY, written: `lane=pr\nneeded=${JSON.stringify(DOCS_ONLY)}\n` });
  assert.deepEqual(judge({ GITHUB_EVENT_NAME: 'push' }), { lane: 'full', needed: EVERY_JOB_BUT_SMOKE, written: `lane=full\nneeded=${JSON.stringify(EVERY_JOB_BUT_SMOKE)}\n` });

  git('checkout', '-q', '-b', 'rename', 'HEAD^1');
  git('mv', 'code.ts', 'AGENTS.md');
  git('commit', '-q', '-m', 'rename');
  git('checkout', '-q', 'main');
  git('reset', '-q', '--hard', 'HEAD^1');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'rename');
  assert.equal(judge({ GITHUB_EVENT_NAME: 'pull_request' }).needed['tower-unit'], true, 'code renamed into documentation still runs the unit suites');
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
