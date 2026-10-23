#!/usr/bin/env node
// Which CI jobs a run needs.
//
// AGENTS.md, The CI bar. A pull request runs the PR lane: the typechecks, the
// unit suites, the root script suite and the browser smoke journeys (those
// tagged @pull-request, apps/tower/e2e/fixtures.ts). The merge queue, a push
// to main, the nightly run and a run started by hand run the full lane: every
// job, every journey, the UX flow walker and the task store against Dolt. So
// every test still runs before a change is released, and before it lands once
// the merge queue is on.
//
// In the PR lane a job runs only when the change can reach it: a file in a
// folder the job's code lives in, or a scripts/ module that code imports or
// names by file name. A change to dependencies, the toolchain, CI, config/ or
// db/, or to a path no rule knows, runs every PR-lane job. The task store
// also runs on a pull request that changes its own code; a change that
// reaches it only through the Tower or ingest Worker it bundles is caught in
// the full lane. The root script suite always runs: it reads every tracked
// Markdown file (product-name.test.mjs, grep-visible.test.mjs,
// docs-index.test.mjs), and a change to a file a test reads runs that test.
// So a pull request that changes only documentation runs it alone; the docs
// workflow builds the site.
//
// Documentation here is what the skipped jobs never read: docs/ and a
// Markdown file at the repository root. scripts/ci-scope.test.mjs refuses a
// read of any of it from the code those jobs run; a folder under docs/ that
// product code or a runtime suite comes to read is listed in READ_DOCS.
//
//   node scripts/ci-scope.mjs     in GitHub Actions: writes lane=pr|full and
//                                 needed=<job: true|false, as JSON> to $GITHUB_OUTPUT

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every job the scope decides, in the workflow's order. */
export const JOBS = Object.freeze(['tower-unit', 'ingest-unit', 'scripts', 'smoke', 'browser', 'flow-gate', 'task-store']);

/** Folders under docs/ that runtime suites or product code read. */
export const READ_DOCS = Object.freeze([]);

/** Whether `file` (a repository path) is documentation no runtime suite reads. */
export function unreadByRuntime(file) {
  if (file.startsWith('docs/')) return !READ_DOCS.some((folder) => file.startsWith(folder));
  return !file.includes('/') && file.endsWith('.md');
}

/** Whether a change to `files` needs the runtime suites: every change does,
 * unless each file it touches is documentation they never read. */
export function needsRuntime(files) {
  return files.length === 0 || !files.every(unreadByRuntime);
}

/** The lane an event runs: pull requests the PR lane, everything else the full lane. */
export function laneOf(event) {
  return event === 'pull_request' ? 'pr' : 'full';
}

/** The PR-lane jobs a change can skip, each with the folders its code lives
 * in. A job's code also reaches every module it imports or names by file
 * name (scopeGraph). */
export const SCOPES = Object.freeze({
  'tower-unit': ['apps/tower/', 'packages/'],
  'ingest-unit': ['workers/', 'packages/'],
  // The journey server loads the ingest modules by path (apps/tower/e2e/server.mjs).
  smoke: ['apps/tower/', 'workers/ingest/src/', 'packages/'],
  // The task client and Dolt pins and the job's preparation step. The task
  // store's own code is its test files and what they import.
  'task-store': ['deploy/compose/Dockerfile', 'scripts/task-store-test-tools.mjs'],
});
const SCOPED = Object.keys(SCOPES);

/** Files outside those folders that reach jobs: dependencies, CI and the
 * store schema (db/ but its Markdown) reach every job; the shared TypeScript
 * base every typecheck and build; the config contract's settings the contract
 * package's typecheck; config/ only the seed-validation tests, since every
 * other test reads fixture copies (scripts/test-config-isolation.mjs). */
const REACHES = [
  [/^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.github\/workflows\/ci\.yml)$|^db\/.*(?<!\.md)$/u, SCOPED],
  [/^tsconfig\.base\.json$/u, ['tower-unit', 'ingest-unit', 'smoke']],
  [/^tsconfig\.config-contract[^/]*\.json$/u, ['ingest-unit']],
  [/^config\//u, ['tower-unit', 'ingest-unit']],
];

/** Folders whose files reach only the jobs the rules above name; a changed
 * file anywhere else runs every PR-lane job. */
const KNOWN = ['apps/tower/', 'workers/', 'packages/', 'scripts/', 'deploy/', 'db/', '.githooks/', '.github/'];

/** Which jobs a run needs, by job name. `files` is what a pull request
 * changes; other events ignore it. `reaches(job)` is the set of files the
 * job's code imports or names (scopeGraph). `manifest` is the root
 * package.json's changed top-level fields and scripts, when it changed. */
export function neededJobs(event, files = [], reaches = scopeGraph(), manifest = null) {
  if (laneOf(event) === 'full') return Object.fromEntries(JOBS.map((job) => [job, job !== 'smoke']));
  const runtime = files.filter((file) => !unreadByRuntime(file));
  const pr = { scripts: true, browser: false, 'flow-gate': false };
  for (const job of SCOPED) pr[job] = files.length === 0;
  for (const file of runtime) {
    const rule = REACHES.find(([pattern]) => pattern.test(file));
    const jobs = rule ? rule[1]
      : file === 'package.json' ? manifestJobs(manifest)
      : !KNOWN.some((folder) => file.startsWith(folder)) ? SCOPED
      : SCOPED.filter((job) => SCOPES[job].some((folder) => file.startsWith(folder)) || reaches(job).has(file));
    for (const job of jobs) pr[job] = true;
  }
  return Object.fromEntries(JOBS.map((job) => [job, pr[job]]));
}

/** The jobs a root package.json change reaches: its scripts run in the root
 * suite, the task store's own script in that job; any other field (the
 * package manager, engines, dependencies) reaches every job. */
function manifestJobs(manifest) {
  if (!manifest || manifest.fields.some((field) => field !== 'scripts')) return SCOPED;
  return manifest.scripts.includes('test:task-store') ? ['task-store'] : [];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(?:[cm]?[jt]sx?)$/u;
const IMPORT = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|new URL\(\s*)['"`]([^'"`]+)['"`]/gu;
const NAMED = /['"`/]([\w.-]+\.(?:[cm]?[jt]sx?|json|sql|sh))['"`]/gu;
/** Specifier prefixes the Tower's Vite config maps to folders. */
const ALIASES = [['@/', 'apps/tower/src/'], ['@shared/', 'apps/tower/shared/']];

/** For each scoped job, the files its code reaches: the modules it imports,
 * and any scripts/ file its code names, which covers a script it spawns or a
 * fixture it reads by name. Over-reaching only runs more. */
export function scopeGraph(root = REPO_ROOT) {
  let graph;
  const cache = new Map();
  return (job) => {
    graph ??= repositoryGraph(root);
    if (!cache.has(job)) cache.set(job, graph(job));
    return cache.get(job);
  };
}

/** For a job, the files its code reaches, read from the tracked files. */
function repositoryGraph(root) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const tracked = listed.stdout.split('\0').filter(Boolean);
  const exists = new Set(tracked);
  const byName = new Map();
  for (const file of tracked.filter((name) => name.startsWith('scripts/'))) {
    const name = path.posix.basename(file);
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const resolve = (from, specifier) => {
    const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
    if (!alias && !specifier.startsWith('.')) return null;
    const bare = alias ? alias[1] + specifier.slice(alias[0].length) : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier.split('?')[0]));
    for (const candidate of [bare, bare.replace(/\.mjs$/u, '.mts'), bare.replace(/\.js$/u, '.ts'), `${bare}.ts`, `${bare}.tsx`, `${bare}.mjs`, `${bare}/index.ts`]) {
      if (exists.has(candidate)) return candidate;
    }
    return null;
  };
  const task = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['test:task-store'].split(/\s+/u).filter((word) => /^scripts\/.+\.test\.mjs$/u.test(word));
  const roots = Object.fromEntries(Object.entries(SCOPES).map(([job, folders]) => [job,
    tracked.filter((file) => CODE.test(file) && (job === 'task-store' ? task.includes(file) : folders.some((folder) => file.startsWith(folder))))]));
  return (job) => {
    const seen = new Set(roots[job]);
    const queue = [...seen];
    for (let file = queue.shift(); file; file = queue.shift()) {
      // The Workers the task store bundles reach it in the full lane.
      if (!CODE.test(file) || (job === 'task-store' && /^(?:apps|workers)\//u.test(file))) continue;
      const text = readFileSync(path.join(root, file), 'utf8');
      const found = [...text.matchAll(IMPORT)].map(([, specifier]) => resolve(file, specifier));
      // A generated .mjs and the .mts it is written from are one module.
      for (const target of found.filter(Boolean)) found.push(target.replace(/\.mts$/u, '.mjs'), target.replace(/\.mjs$/u, '.mts'));
      for (const [, name] of text.matchAll(NAMED)) found.push(...(byName.get(name) ?? []));
      for (const target of found) {
        // A root suite test file runs in its own job, whoever names it.
        if (target && exists.has(target) && !seen.has(target) && !(/^scripts\/[^/]+\.test\.mjs$/u.test(target) && !roots[job].includes(target))) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return seen;
  };
}

/** The root package.json's top-level fields and scripts a pull request
 * changes, or null when either side cannot be read. */
function manifestChange(cwd) {
  const read = (revision) => {
    const shown = spawnSync('git', ['show', `${revision}:package.json`], { cwd, encoding: 'utf8' });
    try {
      return shown.status === 0 ? JSON.parse(shown.stdout) : null;
    } catch {
      return null;
    }
  };
  const [before, after] = [read('HEAD^1'), read('HEAD')];
  if (!before || !after) return null;
  const differ = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  const keys = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return {
    fields: keys(before, after).filter((key) => differ(before[key], after[key])),
    scripts: keys(before.scripts, after.scripts).filter((name) => differ(before.scripts?.[name], after.scripts?.[name])),
  };
}

/** The files a pull request changes, on the merge commit Actions checks out:
 * its first parent is the base branch. Renames count as both paths. */
function pullRequestFiles(cwd) {
  const listed = spawnSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { cwd, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git diff failed: ${listed.stderr}`);
  return listed.stdout.split('\n').filter(Boolean);
}

export function main(env = process.env, cwd = process.cwd()) {
  const event = env.GITHUB_EVENT_NAME ?? 'local';
  const lane = laneOf(event);
  const files = lane === 'pr' ? pullRequestFiles(cwd) : [];
  const needed = neededJobs(event, files, scopeGraph(cwd), files.includes('package.json') ? manifestChange(cwd) : null);
  const reason = lane === 'full'
    ? `a ${event} run runs the full lane`
    : needsRuntime(files)
      ? `${files.filter((file) => !unreadByRuntime(file)).length} of ${files.length} changed file(s) are read by a runtime suite`
      : `all ${files.length} changed file(s) are documentation no runtime suite reads`;
  const runs = JOBS.filter((job) => needed[job]);
  process.stdout.write(`lane=${lane}: ${reason}; runs ${runs.join(', ')}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `lane=${lane}\nneeded=${JSON.stringify(needed)}\n`);
  return { lane, needed };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
