#!/usr/bin/env node
// Regenerate every committed file the code writes: compiled `.mts` pairs, the config docs and the command index.
//
//   pnpm generate                 rewrite them
//   pnpm generate -- --check      exit 1 when any is stale (CI and the tests run this)
//
// In order, because each reads the one before: the `.mjs` + `.d.mts` pairs
// (scripts/generate-config-contract.mjs), the "what the Tower may edit" blocks
// they declare (scripts/config-docs.mjs), then the command index from
// package.json and each script's header (scripts/scripts-index.mjs).

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedDirectly } from './invoked-directly.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Each generator and its arguments, for `--check` or for a rewrite. */
export function generatorSteps(check) {
  return [
    ['generate-config-contract.mjs', check ? ['--check'] : []],
    ['config-docs.mjs', [check ? '--check' : '--write']],
    ['scripts-index.mjs', [check ? '--check' : '--write']],
  ];
}

export function main(argv = process.argv.slice(2), { run = spawnSync } = {}) {
  const args = argv.filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--check')) {
    process.stderr.write('usage: pnpm generate [-- --check]\n');
    return 2;
  }
  const check = args.includes('--check');
  let failed = 0;
  for (const [script, flags] of generatorSteps(check)) {
    const result = run(process.execPath, [path.join(HERE, script), ...flags], { stdio: 'inherit' });
    if (result.status === 0) continue;
    failed = 1;
    // A later step reads what an earlier one writes; a check reports every stale step.
    if (!check) break;
  }
  return failed;
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = main();
