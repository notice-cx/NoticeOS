import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { END, GROUPS, README, REPO_ROOT, START, currentBlock, groupOf, headerLine, indexRows, renderIndex, scriptFile, targets, usageLine, withBlock } from './scripts-index.mjs';

// The command index in scripts/README.md is generated from package.json and
// each script's header, so it cannot say something the code does not.

test('a package command names the script it runs', () => {
  assert.equal(scriptFile('node scripts/os-up.mjs --backup'), 'scripts/os-up.mjs');
  assert.equal(scriptFile('node scripts/stack-control.mjs status'), 'scripts/stack-control.mjs');
  assert.equal(scriptFile('node apps/tower/e2e/flow-gate.mjs'), 'apps/tower/e2e/flow-gate.mjs');
  assert.equal(scriptFile('node --import ./scripts/x.mjs --test scripts/*.test.mjs'), null);
  assert.equal(scriptFile('pnpm -r --if-present run typecheck'), null);
});

test('the header line is the header\'s first sentence, joined across lines, without the file naming itself', () => {
  assert.equal(headerLine('#!/usr/bin/env node\n// os-up.mjs — the NoticeOS runner.\n//\n// more', 'scripts/os-up.mjs'), 'The NoticeOS runner.');
  assert.equal(headerLine('/** Agent sign-in: OAuth 2.1 for the MCP endpoint,\n * continued here. And more. */\nexport {};', 'scripts/agent-access.mjs'), 'Agent sign-in: OAuth 2.1 for the MCP endpoint, continued here.');
  assert.equal(headerLine('// `pnpm db:seed-demo`: a store filled with invented history.\n', 'scripts/db-seed.mjs'), 'A store filled with invented history.');
  assert.equal(headerLine('import x from "y";\n// not a header', 'scripts/a.mjs'), '');
});

test('a script serving several commands describes each by its own usage line', () => {
  const header = '#!/usr/bin/env node\n// The stack.\n//\n//   pnpm os:status      What runs.\n//   pnpm os:logs -- --follow  Recent logs.\n//   pnpm os:stop        lowercase usage note\nimport x from "y";\n//   pnpm os:start      After the header.\n';
  assert.equal(usageLine(header, 'os:status'), 'What runs.');
  assert.equal(usageLine(header, 'os:logs'), 'Recent logs.');
  assert.equal(usageLine(header, 'os:stop'), null, 'a usage note that is not a sentence is not a description');
  assert.equal(usageLine(header, 'os:start'), null, 'only the header counts');
  assert.equal(usageLine(header, 'os'), null);
});

test('the index groups commands by what a person is doing, and every command lands in one group', () => {
  assert.equal(groupOf('os:migrate').title, 'Run the installation');
  assert.equal(groupOf('db:new-migration').title, 'Change the database');
  assert.equal(groupOf('mediavine').title, 'Signals and imports');
  assert.equal(groupOf('test:scripts').title, 'Tests');
  assert.equal(groupOf('generate').title, 'The repository');
  const block = renderIndex(indexRows(REPO_ROOT));
  for (const row of indexRows(REPO_ROOT)) assert.equal(block.split(`| \`${row.name}\` |`).length, 2, `${row.name} appears once`);
  assert.ok(GROUPS.at(-1).prefixes.includes(''), 'the last group takes the rest');
});

test('every script package.json runs exists and says what it is', () => {
  const rows = indexRows(REPO_ROOT);
  assert.ok(rows.length > 40);
  for (const row of rows.filter((entry) => entry.file)) {
    assert.ok(existsSync(path.join(REPO_ROOT, row.file)), `${row.name} runs ${row.file}, which does not exist`);
    assert.ok(row.description && row.description !== '(missing file)', `${row.file} has no header comment to describe pnpm ${row.name}`);
  }
});

test('the committed index matches what the code says (pnpm generate refreshes it)', () => {
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
