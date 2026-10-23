import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JOBS, laneOf, main, NONE, neededJobs, needsRuntime, queuedRun, scopeGraph, unreadByRuntime } from './ci-scope.mjs';

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
  assert.deepEqual(neededJobs('pull_request', ['pnpm-lock.yaml']), {
    'tower-unit': true, 'ingest-unit': true, scripts: true, smoke: true, browser: false, 'flow-gate': false, 'task-store': false,
  });
  assert.deepEqual(neededJobs('pull_request', ['docs/14-design.md', 'AGENTS.md']), DOCS_ONLY);
});

/** The PR-lane jobs `files` runs, besides the root script suite. */
function jobsFor(files, reached = {}, manifest = null) {
  const needed = neededJobs('pull_request', files, (job) => new Set(reached[job] ?? []), manifest);
  return JOBS.filter((job) => needed[job] && job !== 'scripts');
}

test('a pull request runs a job only when a changed file reaches its code', () => {
  assert.deepEqual(jobsFor(['apps/tower/src/routes/WallRoute.tsx']), ['tower-unit', 'smoke']);
  assert.deepEqual(jobsFor(['workers/ingest/test/pull.test.ts']), ['ingest-unit']);
  assert.deepEqual(jobsFor(['workers/ingest/src/pull.ts']), ['ingest-unit', 'smoke'], 'the journey server loads ingest modules by path');
  assert.deepEqual(jobsFor(['packages/contract/src/schema.ts']), ['tower-unit', 'ingest-unit', 'smoke']);
  assert.deepEqual(jobsFor(['scripts/shared.mjs'], { 'ingest-unit': ['scripts/shared.mjs'] }), ['ingest-unit'], 'a module the ingest code imports');
  assert.deepEqual(jobsFor(['scripts/unreached.mjs', 'scripts/unreached.test.mjs', 'deploy/compose/README.md', '.githooks/pre-commit',
    '.github/dependabot.yml', 'db/postgres/README.md', 'deploy/compose/Dockerfile', 'scripts/hosted-task-operations-compose.test.mjs']), [],
    'files only the root script suite reads; the task store runs in the full lane');
});

test('dependencies, CI, the store schema and unknown paths run every PR-lane job; config and TypeScript settings run what reads them', () => {
  const every = ['tower-unit', 'ingest-unit', 'smoke'];
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/ci.yml', 'db/postgres/model.json', 'LICENSE', 'tools/new.mjs']) {
    assert.deepEqual(jobsFor([file]), every, file);
  }
  assert.deepEqual(jobsFor(['config/tower.json']), ['tower-unit', 'ingest-unit'], 'only the seed-validation tests read config/');
  assert.deepEqual(jobsFor(['tsconfig.base.json']), ['tower-unit', 'ingest-unit', 'smoke']);
  assert.deepEqual(jobsFor(['tsconfig.config-contract.json']), ['ingest-unit']);
  assert.deepEqual(jobsFor([]), every, 'a change that lists no file runs everything');
});

test('a root package.json change reaches every job unless it changes scripts alone', () => {
  const every = ['tower-unit', 'ingest-unit', 'smoke'];
  assert.deepEqual(jobsFor(['package.json'], {}, { fields: ['scripts'], scripts: ['audit:copy'] }), []);
  assert.deepEqual(jobsFor(['package.json'], {}, { fields: ['scripts'], scripts: ['test:task-store'] }), []);
  assert.deepEqual(jobsFor(['package.json'], {}, { fields: ['scripts', 'engines'], scripts: [] }), every);
  assert.deepEqual(jobsFor(['package.json'], {}, null), every, 'an unreadable manifest runs everything');
});

test("each job's code reaches the modules it imports, and no root suite test file", () => {
  const reaches = scopeGraph(REPO_ROOT);
  assert.ok(reaches('ingest-unit').has('scripts/postgres-test-cluster.mts'), 'the ingest suite starts its Postgres through the shared cluster');
  assert.ok(reaches('tower-unit').has('scripts/test-config-isolation.mjs'), 'the Tower config imports the isolation guard');
  for (const job of ['tower-unit', 'ingest-unit', 'smoke']) {
    assert.deepEqual([...reaches(job)].filter((file) => /^scripts\/[^/]+\.test\.mjs$/u.test(file)), [], `${job} reaches no root suite test file`);
  }
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

test('a push runs every suite; a pull request is judged on the files its merge commit changes, a rename on both paths', async (t) => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'ci-scope-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci@example.invalid' } });
    assert.equal(run.status, 0, run.stderr);
  };
  const output = path.join(repo, '.output');
  const judge = async (env) => {
    writeFileSync(output, '');
    const stdout = process.stdout.write;
    process.stdout.write = () => true;
    try {
      return { ...(await main({ ...env, GITHUB_OUTPUT: output }, repo)), written: readFileSync(output, 'utf8') };
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
  assert.deepEqual(await judge({ GITHUB_EVENT_NAME: 'pull_request' }), { lane: 'pr', needed: DOCS_ONLY, written: `lane=pr\nneeded=${JSON.stringify(DOCS_ONLY)}\n` });
  assert.deepEqual(await judge({ GITHUB_EVENT_NAME: 'push' }), { lane: 'full', needed: EVERY_JOB_BUT_SMOKE, written: `lane=full\nneeded=${JSON.stringify(EVERY_JOB_BUT_SMOKE)}\n` });

  git('checkout', '-q', '-b', 'rename', 'HEAD^1');
  git('mv', 'code.ts', 'AGENTS.md');
  git('commit', '-q', '-m', 'rename');
  git('checkout', '-q', 'main');
  git('reset', '-q', '--hard', 'HEAD^1');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'rename');
  assert.equal((await judge({ GITHUB_EVENT_NAME: 'pull_request' })).needed['tower-unit'], true, 'code renamed into documentation still runs the unit suites');
});

test('a push whose commit passed the full lane in the merge queue needs no job; any doubt runs the full lane', async () => {
  const sha = 'a'.repeat(40);
  const push = { GITHUB_EVENT_NAME: 'push', GITHUB_TOKEN: 'token', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: 'https://api.example.test' };
  const asked = [];
  const answer = (runs, ok = true) => async (url, init) => {
    asked.push({ url, authorization: init.headers.authorization });
    return { ok, json: async () => ({ workflow_runs: runs }) };
  };
  const passed = { head_sha: sha, event: 'merge_group', conclusion: 'success', html_url: 'https://example.test/run/1' };
  assert.equal(await queuedRun(push, answer([passed])), 'https://example.test/run/1');
  assert.deepEqual(asked, [{ url: `https://api.example.test/repos/owner/repo/actions/workflows/ci.yml/runs?event=merge_group&head_sha=${sha}&status=success&per_page=5`, authorization: 'Bearer token' }]);
  for (const [why, env, request] of [
    ['a pull request', { ...push, GITHUB_EVENT_NAME: 'pull_request' }, answer([passed])],
    ['no token', { ...push, GITHUB_TOKEN: '' }, answer([passed])],
    ['another commit', push, answer([{ ...passed, head_sha: 'b'.repeat(40) }])],
    ['a failed queue run', push, answer([{ ...passed, conclusion: 'failure' }])],
    ['an API error', push, answer([passed], false)],
    ['an unreachable API', push, async () => { throw new Error('offline'); }],
  ]) {
    assert.equal(await queuedRun(env, request), null, why);
  }
  const stdout = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.deepEqual(await main(push, REPO_ROOT, answer([passed])), { lane: 'queued', needed: NONE });
    assert.deepEqual(await main(push, REPO_ROOT, answer([], false)), { lane: 'full', needed: EVERY_JOB_BUT_SMOKE });
  } finally {
    process.stdout.write = stdout;
  }
  assert.deepEqual(Object.values(NONE), JOBS.map(() => false));
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
