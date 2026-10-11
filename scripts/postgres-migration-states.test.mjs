// The state of each Postgres migration: one derivation
// for the runner's status and `pnpm os:migrate`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MIGRATION_FILE, PROBLEM_STATES, migrationStates } from './postgres-migration-states.mjs';
import { MIGRATION_FILE as SHARED_MIGRATION_FILE } from './postgres-migration-files.mjs';
import { migrationFiles } from './postgres-dev.mjs';
import { codeMigrationVersions } from './database-address.mjs';

const file = (version, name, sha256) => ({ version, name, sha256 });
const record = (version, name, sha256, applied_at = '2026-09-30T00:00:00Z') => ({ version, name, sha256, applied_at });
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const states = (result) => result.migrations.map((m) => [m.name, m.state]);

test('each migration is applied, pending, changed, missing or out-of-order, sorted by version', () => {
  const up = migrationStates([file(1, '0001_baseline', A), file(2, '0002_more', B)], [record(1, '0001_baseline', A), record(2, '0002_more', B)]);
  assert.deepEqual(states(up), [['0001_baseline', 'applied'], ['0002_more', 'applied']]);
  assert.deepEqual([up.pending, up.problems], [[], []]);
  assert.equal(up.migrations[0].appliedAt, '2026-09-30T00:00:00Z');

  const pending = migrationStates([file(1, '0001_baseline', A), file(2, '0002_more', B)], [record(1, '0001_baseline', A)]);
  assert.deepEqual(states(pending), [['0001_baseline', 'applied'], ['0002_more', 'pending']]);
  assert.deepEqual(pending.pending.map((m) => m.name), ['0002_more']);
  assert.deepEqual(pending.problems, []);
  assert.equal(pending.pending[0].appliedAt, null);

  // Another hash, or another name under the same version, is a changed file.
  const changed = migrationStates([file(1, '0001_baseline', C), file(2, '0002_renamed', B)], [record(1, '0001_baseline', A), record(2, '0002_more', B)]);
  assert.deepEqual(states(changed), [['0001_baseline', 'changed'], ['0002_renamed', 'changed']]);

  // Recorded, but the code carries no file for it: listed under the record's own name.
  const missing = migrationStates([file(1, '0001_baseline', A)], [record(2, '0002_more', B), record(1, '0001_baseline', A)]);
  assert.deepEqual(states(missing), [['0001_baseline', 'applied'], ['0002_more', 'missing']]);

  const outOfOrder = migrationStates([file(1, '0001_baseline', A), file(2, '0002_more', B), file(3, '0003_last', C)], [record(1, '0001_baseline', A), record(3, '0003_last', C)]);
  assert.deepEqual(states(outOfOrder), [['0001_baseline', 'applied'], ['0002_more', 'out-of-order'], ['0003_last', 'applied']]);

  assert.deepEqual(
    [changed, missing, outOfOrder].map((result) => result.problems.map((m) => m.state)),
    [['changed', 'changed'], ['missing'], ['out-of-order']],
  );
  assert.deepEqual(PROBLEM_STATES, ['changed', 'missing', 'out-of-order']);
});

test("a migration file's name is NNNN_name.sql and nothing else", () => {
  assert.equal(MIGRATION_FILE.exec('0001_baseline.sql')?.[1], '0001');
  for (const name of ['0001-baseline.sql', '1_baseline.sql', '0001_Baseline.sql', '0001_baseline.sql.bak', 'README.md']) {
    assert.equal(MIGRATION_FILE.test(name), false, name);
  }
});

test('apply, startup and deploy recognize the same migration filename boundaries', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'noticeos-migration-names-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = ['0000_zero.sql', '0001__1.sql', '0002_lower_case2.sql', '9999_last.sql'];
  const invalid = ['README.md', '1_short.sql', '00001_long.sql', '0003-joined.sql',
    '0003_Upper.sql', '0003_.sql', '0003_name.SQL', '0003_name.sql.bak', '0003_náme.sql', '0003_line.sql\n'];
  for (const name of [...valid, ...invalid]) writeFileSync(path.join(directory, name), '');
  assert.equal(MIGRATION_FILE, SHARED_MIGRATION_FILE, 'deploy keeps the shared pattern export');
  assert.deepEqual(migrationFiles(directory).map(file => path.basename(file)), valid);
  assert.deepEqual(codeMigrationVersions(directory), [0, 1, 2, 9999]);
  for (const name of valid) assert.ok(MIGRATION_FILE.test(name), name);
  for (const name of invalid) assert.equal(MIGRATION_FILE.test(name), false, name);
});
