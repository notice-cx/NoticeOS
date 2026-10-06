import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PostgresUnavailable } from './postgres-dev.mjs';
import { REQUIRE_POSTGRES, openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';

// Issue #11: the guard sat around `findPostgres()`, which answers null rather
// than throwing, so a machine without Postgres failed these tests instead of
// skipping them. The guard now wraps the opening.

function context() {
  const skipped = [];
  return { skipped, skip: (message) => skipped.push(message) };
}

/** Runs `fn` with NOTICEOS_REQUIRE_POSTGRES set to `value` (unset for undefined). */
async function requiring(value, fn) {
  const before = process.env[REQUIRE_POSTGRES];
  if (value === undefined) delete process.env[REQUIRE_POSTGRES];
  else process.env[REQUIRE_POSTGRES] = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[REQUIRE_POSTGRES];
    else process.env[REQUIRE_POSTGRES] = before;
  }
}

test('no server binaries: the opening skips the test with the reason, and creates nothing', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'noticeos-skip-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cluster = path.join(dir, 'pg');
  const skipping = context();
  assert.equal(await requiring(undefined, () => skipWithoutPostgres(skipping, () => openOnLoopbackPort(cluster, null))), null);
  assert.deepEqual(skipping.skipped, ['no Postgres server binaries (initdb, pg_ctl, psql) on this machine']);
});

test('where Postgres is required, its absence fails instead', async () => {
  const required = context();
  await assert.rejects(requiring('1', () => skipWithoutPostgres(required, () => { throw new PostgresUnavailable('initdb: cannot be run as root'); })),
    PostgresUnavailable);
  assert.deepEqual(required.skipped, []);
});

test('any other failure and any answer pass through untouched', async () => {
  const other = context();
  await assert.rejects(requiring(undefined, () => skipWithoutPostgres(other, () => { throw new TypeError('a real bug'); })), TypeError);
  assert.equal(await requiring(undefined, () => skipWithoutPostgres(other, async () => 'owner')), 'owner');
  assert.deepEqual(other.skipped, []);
});
