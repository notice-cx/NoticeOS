import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEV_DATABASE, ROLES_SQL, createWorkspace, findPostgres, inWorkspace, openThrowaway, psqlEnvironment } from './postgres-dev.mjs';
import { applyMigrations, migrationStatus } from './postgres-migrate.mjs';
import { constraintsMarkdown, readCatalog } from './postgres-docs.mjs';

// Cross-major restore uses two new socket-only clusters. The old binaries
// must be explicitly supplied for this proof; no installation is discovered.
const SOURCE_BIN = 'NOTICEOS_TEST_POSTGRES17_BIN';
const schemas = ['noticeos', 'noticeos_ref', 'noticeos_migrations'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function command(binary, args) {
  const result = spawnSync(binary, args, { env: psqlEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${path.basename(binary)} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function contents(dev) {
  const tables = dev.sql("SELECT schemaname AS schema, tablename AS name FROM pg_tables WHERE schemaname IN ('noticeos', 'noticeos_ref', 'noticeos_migrations') ORDER BY schemaname, tablename");
  const sequences = dev.sql("SELECT schemaname AS schema, sequencename AS name FROM pg_sequences WHERE schemaname IN ('noticeos', 'noticeos_ref', 'noticeos_migrations') ORDER BY schemaname, sequencename");
  const qualified = item => {
    assert.match(item.schema, /^[a-z_]+$/u);
    assert.match(item.name, /^[a-z_]+$/u);
    return `"${item.schema}"."${item.name}"`;
  };
  return {
    tables: Object.fromEntries(tables.map(table => [qualified(table), dev.sql(`SELECT row_to_json(t)::text AS row FROM ${qualified(table)} t ORDER BY row_to_json(t)::text COLLATE "C"`)])),
    sequences: Object.fromEntries(sequences.map(sequence => [qualified(sequence), dev.sql(`SELECT last_value::text AS value, is_called FROM ${qualified(sequence)}`)])),
  };
}

test('a synthetic PostgreSQL 17 dump restores on 18 with exact rows, sequences, constraints and workspace isolation', t => {
  const sourceBin = process.env[SOURCE_BIN];
  if (!sourceBin) { t.skip(`set ${SOURCE_BIN} to an explicit PostgreSQL 17 binary directory`); return; }
  assert.ok(path.isAbsolute(sourceBin), 'the old binaries are an explicit absolute fixture path');
  const tools = findPostgres();
  assert.equal(tools?.major, 18, 'this upgrade proof runs against PostgreSQL 18 on PATH');
  const version = command(path.join(sourceBin, 'psql'), ['--version']);
  assert.match(version, /PostgreSQL\) 17\./u);
  const sourceTools = { ...tools, initdb: path.join(sourceBin, 'initdb'), pgCtl: path.join(sourceBin, 'pg_ctl'), psql: path.join(sourceBin, 'psql'), major: 17, version };
  const root = mkdtempSync(path.join(os.tmpdir(), 'nos-upgrade-'));
  const closers = [];
  t.after(() => {
    for (const close of closers.reverse()) close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = openThrowaway(path.join(root, 'source-17'), sourceTools);
  closers.push(() => source.close());
  applyMigrations(source);
  const workspace = createWorkspace(source, { slug: 'upgrade', displayName: 'Café Ω 中' });
  const other = createWorkspace(source, { slug: 'other' });
  inWorkspace(source, workspace, `
    INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status)
      VALUES (:'workspace_id', 'example', 'example.com', 'Café Ω 中', 'live');
    INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state, note)
      VALUES (:'workspace_id', 'revenue', 'example', '2026-09-01', 'ads', 9007199254740993, 'USD', 'reconciled', 'Café Ω 中');
  `);
  const before = contents(source);
  const constraints = constraintsMarkdown(readCatalog(source.text));
  const dump = path.join(root, 'noticeos-17.dump');
  command(path.join(sourceBin, 'pg_dump'), ['--host', source.socketDir, '--username', 'postgres', '--dbname', DEV_DATABASE, '--no-password', '--format=custom', '--file', dump, ...schemas.flatMap(schema => ['--schema', schema])]);

  const target = openThrowaway(path.join(root, 'target-18'), tools);
  closers.push(() => target.close());
  target.run(readFileSync(ROLES_SQL, 'utf8'));
  command(path.join(path.dirname(tools.psql), 'pg_restore'), ['--host', target.socketDir, '--username', 'postgres', '--dbname', DEV_DATABASE, '--no-password', '--exit-on-error', '--single-transaction', dump]);
  assert.deepEqual(contents(target), before, 'every operational row, shared vocabulary row, migration record and sequence survives');
  assert.equal(constraintsMarkdown(readCatalog(target.text)), constraints);
  assert.ok(migrationStatus(target).migrations.every(migration => migration.state === 'applied'));
  const read = 'SELECT amount_minor::text AS amount, note FROM noticeos.ledger_entries';
  assert.deepEqual(inWorkspace(target, workspace, '', { read }), [{ amount: '9007199254740993', note: 'Café Ω 中' }]);
  assert.deepEqual(inWorkspace(target, other, '', { read }), [], 'the other workspace sees none of the restored ledger');
  assert.throws(() => inWorkspace(target, workspace, 'UPDATE noticeos.ledger_entries SET amount_minor = 1'), /immutable|permission denied/u);
  const next = inWorkspace(target, workspace, `INSERT INTO noticeos.ledger_entries (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, booking_state)
    VALUES (:'workspace_id', 'cost', 'example', '2026-09-01', 'infra', 1, 'USD', 'reconciled')`, { read: 'SELECT entry_number::text AS number FROM noticeos.ledger_entries ORDER BY entry_number' });
  assert.deepEqual(next, [{ number: '1' }, { number: '2' }], 'restored counters still allocate the next number');
  t.diagnostic(JSON.stringify({ source: version, target: tools.version, tables: Object.keys(before.tables).length, sequences: Object.keys(before.sequences).length, contentsSha256: digest(before), constraintsSha256: createHash('sha256').update(constraints).digest('hex') }));
});
