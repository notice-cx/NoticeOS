import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// THE RUNNER'S MODULES (bead ro-ujb9.22). scripts/os-up.mjs is the one
// coordinator; what it coordinates lives in scripts/runner/. These rules keep
// that split honest as modules are added:
//
//   - a module never imports the coordinator back, so a module runs alone and
//     the import graph has one direction;
//   - a module never spawns a process itself: commands go through
//     scripts/run-command.mjs (bead ro-ujb9.185), and the one supervised child
//     stays in the coordinator;
//   - every module has its own test file, beside the other root tests, because
//     `pnpm test:scripts` runs scripts/*.test.mjs and nothing below it.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = path.join(SCRIPTS_DIR, 'runner');

function runnerModules() {
  return readdirSync(RUNNER_DIR)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
}

test('the runner modules are there to check', () => {
  assert.ok(runnerModules().includes('config.mjs'), 'scripts/runner/config.mjs must exist');
});

test('no runner module imports the coordinator back', () => {
  for (const name of runnerModules()) {
    const source = readFileSync(path.join(RUNNER_DIR, name), 'utf8');
    assert.doesNotMatch(source, /['"]\.\.\/os-up\.mjs['"]/u, `runner/${name} imports os-up.mjs`);
  }
});

test('no runner module spawns a process except through run-command.mjs', () => {
  for (const name of runnerModules()) {
    const source = readFileSync(path.join(RUNNER_DIR, name), 'utf8');
    assert.doesNotMatch(
      source,
      /['"](?:node:)?child_process['"]/u,
      `runner/${name} imports child_process; run the command through scripts/run-command.mjs`,
    );
  }
});

test('every runner module has its own test file in the root suite', () => {
  for (const name of runnerModules()) {
    const testFile = `runner-${name.replace(/\.mjs$/u, '')}.test.mjs`;
    assert.ok(existsSync(path.join(SCRIPTS_DIR, testFile)), `runner/${name} needs scripts/${testFile}`);
  }
});
