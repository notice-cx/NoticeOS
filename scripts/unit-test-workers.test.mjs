import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_UNIT_TEST_WORKERS, unitTestWorkers } from './unit-test-workers.mjs';

// Each unit suite takes half the cores unless UNIT_TEST_WORKERS says otherwise:
// `pnpm -r test` runs the Tower and ingest suites at once.

test('each suite takes half the cores by default', () => {
  assert.equal(DEFAULT_UNIT_TEST_WORKERS, '50%');
  assert.equal(unitTestWorkers({}), '50%');
  assert.equal(unitTestWorkers({ UNIT_TEST_WORKERS: '  ' }), '50%');
});

test('UNIT_TEST_WORKERS sets a count or a share of the cores', () => {
  assert.equal(unitTestWorkers({ UNIT_TEST_WORKERS: '3' }), 3);
  assert.equal(unitTestWorkers({ UNIT_TEST_WORKERS: '25%' }), '25%');
  for (const value of ['0', '2.5', 'many', '0%', '150%', '-1']) {
    assert.throws(() => unitTestWorkers({ UNIT_TEST_WORKERS: value }), /UNIT_TEST_WORKERS/);
  }
});

test('both unit suites read it', () => {
  for (const config of ['apps/tower/vitest.config.ts', 'workers/ingest/vitest.config.ts']) {
    const source = readFileSync(new URL(`../${config}`, import.meta.url), 'utf8');
    assert.match(source, /maxWorkers: unitTestWorkers\(\)/, config);
  }
});
