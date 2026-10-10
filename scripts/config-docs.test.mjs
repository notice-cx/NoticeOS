import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { END, REPO_ROOT, START, blocks, currentBlock, fieldRule, renderRegister } from './config-docs.mjs';

// Each config README's "what the Tower may edit here" block is generated from
// scripts/config-registers.mts, so a README cannot describe a field the
// declaration does not have.

test('a field rule reads its bounds, values and fixedness off the declaration', () => {
  assert.equal(fieldRule({ type: 'integer', min: 1, max: 31 }), '1 to 31');
  assert.equal(fieldRule({ type: 'enum', values: ['on', 'off'] }), 'one of `on`, `off`');
  assert.equal(fieldRule({ type: 'string', maxLength: 64, pattern: '^[a-z]+$', readOnly: true }), 'up to 64 characters; matches `^[a-z]+$`; fixed once written');
  assert.equal(fieldRule({ type: 'string' }), '—');
});

test('an opaque register says its rows move whole; a field register carries a table', () => {
  const opaque = renderRegister('x', { label: 'X', describe: 'one x', container: '/xs', file: 'config/x.json', shape: 'object', keyRule: 'asset-id', fields: null, surface: 'Settings' });
  assert.match(opaque, /Rows are added and removed whole/u);
  const fielded = renderRegister('y', { label: 'Y', describe: 'one y', container: '/ys', file: 'config/y.json', shape: 'array', keyField: 'id',
    fields: [{ name: 'id', label: 'Id', type: 'string', required: true, describe: 'lowercase' }] });
  assert.match(fielded, /\| `id` \| Id \| `string` \| yes \| lowercase \| — \|/u);
});

test('every owning README exists and carries the current block (pnpm config:docs -- --write refreshes it)', () => {
  for (const [owner, block] of blocks()) {
    const file = path.join(REPO_ROOT, owner);
    assert.ok(existsSync(file), `${owner} is named as a register's owner but does not exist`);
    const current = currentBlock(readFileSync(file, 'utf8'));
    assert.ok(current, `${owner} has no ${START} … ${END} block`);
    assert.equal(current, block, `${owner}: the registers block is stale`);
  }
});
