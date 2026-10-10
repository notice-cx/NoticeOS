#!/usr/bin/env node
// Which suites a change needs.
//
// AGENTS.md, The CI bar: documentation and image changes need their own
// checks, not runtime suites. So a pull request that changes only
// documentation skips the Tower and ingest unit jobs and the browser
// journeys; the docs workflow builds the site instead. The root script suite
// still runs: it reads every tracked Markdown file (product-name.test.mjs,
// grep-visible.test.mjs, docs-index.test.mjs), and a change to a file a test reads runs that test.
// A push to main runs everything.
//
// Documentation here is what those three jobs never read: docs/ and a
// Markdown file at the repository root. scripts/ci-scope.test.mjs refuses a
// read of any of it from the code those jobs run; a folder under docs/ that
// product code or a runtime suite comes to read is listed in READ_DOCS.
//
//   node scripts/ci-scope.mjs     in GitHub Actions: writes runtime=true|false to $GITHUB_OUTPUT

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The files a pull request changes, on the merge commit Actions checks out:
 * its first parent is the base branch. Renames count as both paths. */
function pullRequestFiles(cwd) {
  const listed = spawnSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { cwd, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git diff failed: ${listed.stderr}`);
  return listed.stdout.split('\n').filter(Boolean);
}

export function main(env = process.env, cwd = process.cwd()) {
  let runtime = true;
  let reason = `a ${env.GITHUB_EVENT_NAME ?? 'local'} run runs every suite`;
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const files = pullRequestFiles(cwd);
    runtime = needsRuntime(files);
    reason = runtime
      ? `${files.filter((file) => !unreadByRuntime(file)).length} of ${files.length} changed file(s) are read by a runtime suite`
      : `all ${files.length} changed file(s) are documentation no runtime suite reads`;
  }
  process.stdout.write(`runtime=${runtime}: ${reason}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `runtime=${runtime}\n`);
  return runtime;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
