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
// A pull request that changes only documentation skips the unit and smoke
// jobs too; the docs workflow builds the site instead. The root script suite
// always runs: it reads every tracked Markdown file (product-name.test.mjs,
// grep-visible.test.mjs, docs-index.test.mjs), and a change to a file a test
// reads runs that test.
//
// Documentation here is what the skipped jobs never read: docs/ and a
// Markdown file at the repository root. scripts/ci-scope.test.mjs refuses a
// read of any of it from the code those jobs run; a folder under docs/ that
// product code or a runtime suite comes to read is listed in READ_DOCS.
//
//   node scripts/ci-scope.mjs     in GitHub Actions: writes lane=pr|full and
//                                 needed=<job: true|false, as JSON> to $GITHUB_OUTPUT

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
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

/** Which jobs a run needs, by job name. `files` is what a pull request
 * changes; other events ignore it. */
export function neededJobs(event, files = []) {
  if (laneOf(event) === 'full') return Object.fromEntries(JOBS.map((job) => [job, job !== 'smoke']));
  const runtime = needsRuntime(files);
  const pr = { 'tower-unit': runtime, 'ingest-unit': runtime, scripts: true, smoke: runtime, browser: false, 'flow-gate': false, 'task-store': false };
  return Object.fromEntries(JOBS.map((job) => [job, pr[job]]));
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
  const needed = neededJobs(event, files);
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
