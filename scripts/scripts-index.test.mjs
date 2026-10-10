import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { END, README, REPO_ROOT, START, currentBlock, headerLine, indexRows, renderIndex, scriptFile, targets, withBlock } from './scripts-index.mjs';

// The command index in scripts/README.md is generated from package.json and
// each script's header, so it cannot say something the code does not.

test('a package command names the script it runs', () => {
  assert.equal(scriptFile('node scripts/os-up.mjs --backup'), 'scripts/os-up.mjs');
  assert.equal(scriptFile('node scripts/os-control.mjs status'), 'scripts/os-control.mjs');
  assert.equal(scriptFile('node apps/tower/e2e/flow-gate.mjs'), 'apps/tower/e2e/flow-gate.mjs');
  assert.equal(scriptFile('node --import ./scripts/x.mjs --test scripts/*.test.mjs'), null);
  assert.equal(scriptFile('pnpm -r --if-present run typecheck'), null);
});

test('the header line is the first comment line, without the file naming itself', () => {
  assert.equal(headerLine('#!/usr/bin/env node\n// os-up.mjs — the NoticeOS LOCAL RUNNER.\n//\n// more', 'scripts/os-up.mjs'), 'the NoticeOS LOCAL RUNNER.');
  assert.equal(headerLine('/** Agent sign-in: OAuth 2.1 for the MCP endpoint,\n * continued */\nexport {};', 'scripts/agent-access.mjs'), 'Agent sign-in: OAuth 2.1 for the MCP endpoint,');
  assert.equal(headerLine('import x from "y";\n// not a header', 'scripts/a.mjs'), '');
});

test('every script package.json runs exists and says what it is', () => {
  const rows = indexRows(REPO_ROOT);
  assert.ok(rows.length > 40);
  for (const row of rows.filter((entry) => entry.file)) {
    assert.ok(existsSync(path.join(REPO_ROOT, row.file)), `${row.name} runs ${row.file}, which does not exist`);
    assert.ok(row.description && row.description !== '(missing file)', `${row.file} has no header comment to describe pnpm ${row.name}`);
  }
});

test('the committed index matches what the code says (pnpm scripts:index -- --write refreshes it)', () => {
  const readme = readFileSync(path.join(REPO_ROOT, README), 'utf8');
  const block = currentBlock(readme);
  assert.ok(block, `${README} has no ${START} … ${END} block`);
  assert.equal(block, renderIndex(indexRows(REPO_ROOT)));
  for (const target of targets(REPO_ROOT)) {
    const file = path.join(REPO_ROOT, target.file);
    assert.ok(existsSync(file), `${target.file} is missing`);
    assert.ok(target.current(readFileSync(file, 'utf8')), `${target.file} is stale`);
  }
});

test('a README without markers gets the block before its first section', () => {
  const block = `${START}\nx\n${END}`;
  assert.equal(withBlock('intro\n\n# First\nbody\n', block), `intro\n\n${block}\n\n# First\nbody\n`);
  assert.equal(withBlock(`a\n${START}\nold\n${END}\nb\n`, block), `a\n${block}\nb\n`);
});
