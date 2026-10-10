#!/usr/bin/env node
// Install the repository's git hooks on `pnpm install`.
//
// The root `prepare` script runs this after every install. It points
// `core.hooksPath` at `.githooks/`, whose pre-commit runs the neutral-code
// gate on staged product files. No dependency: husky and friends do the same
// one line of git config with a package attached.
//
// It does nothing, and never fails the install, when:
//   - CI is set (CI runs the gate through `pnpm test:scripts`, not a hook);
//   - this is not a git work tree (a tarball or an exported copy);
//   - `.githooks/pre-commit` is missing from the checkout;
//   - `core.hooksPath` already points somewhere else (it says so, and leaves
//     the operator's own choice alone).
//
// `core.hooksPath` is repository config, so one install covers the main
// checkout and every `.claude/worktrees/*` worktree; the relative path resolves
// inside whichever work tree is committing.

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_DIR = '.githooks';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: !result.error && result.status === 0, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

/** @returns {{ installed: boolean, reason: string }} */
export function installGitHooks({ cwd = process.cwd(), env = process.env, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (env.CI) return { installed: false, reason: 'CI' };
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return { installed: false, reason: 'not a git work tree' };
  const root = top.stdout;
  if (!existsSync(path.join(root, HOOKS_DIR, 'pre-commit'))) {
    return { installed: false, reason: `${HOOKS_DIR}/pre-commit is missing` };
  }
  const current = git(root, ['config', '--get', 'core.hooksPath']).stdout;
  if (current === HOOKS_DIR) return { installed: true, reason: 'already installed' };
  if (current) {
    log(
      `git hooks: core.hooksPath is already "${current}", so ${HOOKS_DIR}/pre-commit (the neutral-code gate) is NOT installed. ` +
        `Run it from your hook, or: git config core.hooksPath ${HOOKS_DIR}`,
    );
    return { installed: false, reason: `core.hooksPath is ${current}` };
  }
  const set = git(root, ['config', 'core.hooksPath', HOOKS_DIR]);
  if (!set.ok) {
    log(`git hooks: could not set core.hooksPath (${set.stderr}); the neutral-code gate still runs in pnpm test:scripts.`);
    return { installed: false, reason: set.stderr };
  }
  log(`git hooks: installed ${HOOKS_DIR}/pre-commit (the neutral-code gate on staged product files).`);
  return { installed: true, reason: 'installed' };
}

function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    installGitHooks();
  } catch (error) {
    process.stdout.write(`git hooks: not installed (${error?.message ?? error})\n`);
  }
}
