import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describeDoltMigrationInventory, inventoryDoltMigration, main } from './dolt-migration-inventory.mjs';

const SECRET = 'synthetic-task-or-secret-never-output';
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noticeos-migration-inventory-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'spoke'); const clientHome = path.join(base, 'client');
  fs.mkdirSync(path.join(repo, '.beads'), { recursive: true }); fs.mkdirSync(clientHome, { mode: 0o700 });
  const files = { metadata: path.join(repo, '.beads', 'metadata.json'), config: path.join(repo, '.beads', 'config.yaml') };
  fs.writeFileSync(files.metadata, JSON.stringify({ dolt_database: 'synthetic_tasks', body: SECRET, password: SECRET }));
  fs.writeFileSync(files.config, 'issue-prefix: ex\nno-git-ops: true\nimport.auto: false\n');
  const receipt = { format: 'noticeos-dolt-migration-metadata-v1', scope: 'maps-only',
    hub: { host: '127.0.0.1', port: 5343, user: 'synthetic' },
    projects: [{ asset: 'tasks.example', prefix: 'ex', database: 'synthetic_tasks', repo, files }] };
  const calls = []; const reads = [];
  const io = { ...fs, openSync(file, ...args) { reads.push(file); return fs.openSync(file, ...args); } };
  const run = async (binary, args, options) => {
    calls.push({ binary, args, options });
    const sql = args.at(-1);
    let rows = [];
    if (sql.startsWith('SELECT DOLT_VERSION')) rows = [{ version: '1.58.0', account: 'synthetic@%', password: SECRET }];
    else if (sql.includes('FROM information_schema.TABLES')) rows = [{ table_name: 'issues', table_type: 'BASE TABLE' },
      { table_name: 'dolt_schemas', table_type: 'BASE TABLE' }, { table_name: 'task_view', table_type: 'VIEW' }];
    else if (sql.startsWith('SELECT COUNT')) rows = [{ count: 7 }];
    else if (sql.includes('.dolt_branches')) rows = [{ name: 'main', hash: 'a'.repeat(32), message: SECRET }];
    return { code: 0, stdout: JSON.stringify({ rows }), stderr: SECRET };
  };
  return { base, receipt, clientHome, files, calls, reads, options: { dolt: '/synthetic/bin/dolt', clientHome, run, fs: io } };
}

test('receipt plan is a no-source-I/O review of exactly spoke files and fixed SELECT metadata queries', t => {
  const f = fixture(t); const result = describeDoltMigrationInventory(f.receipt);
  assert.deepEqual(result.spokeReads, Object.values(f.files)); assert.equal(result.queries.length, 16);
  for (const { query } of result.queries) {
    assert.match(query, /^SELECT /u);
    assert.doesNotMatch(query, /SELECT\s+\*|COLUMN_DEFAULT|COMMENT|DEFINITION|authentication|password|title|body|message|CALL|SHOW GRANTS/iu);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.calls.length, 0);
});

test('batch reads only named spoke pair then fixed endpoint SQL; environment never chooses source or credentials', async t => {
  const f = fixture(t); const result = await inventoryDoltMigration(f.receipt, f.options);
  assert.deepEqual(f.reads, Object.values(f.files)); assert.equal(f.calls.length, 17);
  assert.ok(f.calls.every(call => call.args.includes('--host=127.0.0.1') && call.args.includes('--port=5343') && call.args.includes('--user=synthetic')));
  assert.ok(f.calls.every(call => call.options.cwd === f.clientHome && call.options.env.HOME === f.clientHome &&
    call.options.env.DOLT_CLI_PASSWORD === '' && !Object.hasOwn(call.options.env, 'BEADS_DIR') && !Object.hasOwn(call.options.env, 'DOCKER_HOST')));
  assert.ok(f.calls.every(call => call.options.env.DOLT_DISABLE_EVENT_FLUSH === '1' &&
    !Object.hasOwn(call.options.env, 'DOLT_DISABLE_EVENT_LOGGING') && call.options.env.XDG_CONFIG_HOME === path.join(f.clientHome, '.config')));
  assert.equal(result.global[0].rows[0].version, '1.58.0');
  assert.equal(result.databases[0].counts.length, 1);
  assert.equal(result.databases[0].counts[0].table, 'issues');
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('client HOME must be a real private owned empty directory before any spoke or SQL access', async t => {
  const f = fixture(t);
  const other = path.join(f.base, 'other'); fs.mkdirSync(other, { mode: 0o700 });
  const linked = path.join(f.base, 'linked'); fs.symlinkSync(other, linked);
  const linkedAncestor = path.join(f.base, 'ancestor'); fs.symlinkSync(f.base, linkedAncestor);
  const missing = path.join(f.base, 'missing');
  const ambient = path.join(f.base, 'ambient'); fs.mkdirSync(ambient, { mode: 0o700 });
  fs.writeFileSync(path.join(ambient, '.doltconfig'), SECRET);
  const shared = path.join(f.base, 'shared'); fs.mkdirSync(shared, { mode: 0o755 });
  for (const clientHome of [linked, path.join(linkedAncestor, 'other'), missing, ambient, shared]) {
    await assert.rejects(inventoryDoltMigration(f.receipt, { ...f.options, clientHome }), /no complete metadata receipt/u);
  }
  const foreignOwner = { ...f.options.fs, lstatSync(file) {
    const stat = fs.lstatSync(file);
    return file === f.clientHome ? Object.assign(Object.create(stat), { uid: process.getuid() + 1 }) : stat;
  } };
  await assert.rejects(inventoryDoltMigration(f.receipt, { ...f.options, fs: foreignOwner }), /no complete metadata receipt/u);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.calls, []);
});

test('unsupported metadata is unknown, while source-version failure prevents further SQL', async t => {
  const f = fixture(t);
  const original = f.options.run;
  const result = await inventoryDoltMigration(f.receipt, { ...f.options, run: async (...args) => {
    if (args[1].at(-1).includes('information_schema.USER_PRIVILEGES')) return { code: 1, stdout: SECRET, stderr: SECRET };
    return original(...args);
  } });
  assert.deepEqual(result.global.find(row => row.name === 'globalPrivileges'), { name: 'globalPrivileges', available: false });
  let calls = 0;
  await assert.rejects(inventoryDoltMigration(f.receipt, { ...f.options, run: async () => { calls++; return { code: 1, stdout: SECRET, stderr: SECRET }; } }), /no complete metadata receipt/u);
  assert.equal(calls, 1);
});

test('Dolt zero-row JSON rendering is recognized without inventing grant or tag rows', async t => {
  const f = fixture(t); const original = f.options.run;
  const result = await inventoryDoltMigration(f.receipt, { ...f.options, run: async (...args) => {
    if (args[1].at(-1).includes('mysql.db') || args[1].at(-1).includes('.dolt_tags')) return { code: 0, stdout: '{}\n\n', stderr: '' };
    return original(...args);
  } });
  assert.deepEqual(result.global.find(row => row.name === 'schemaPrivileges').rows, []);
  assert.deepEqual(result.databases[0].summaries.find(row => row.name === 'tags').rows, []);
  assert.equal(result.sqlMetadataComplete, true);
});

test('redirected spoke selectors or unsafe receipt mappings refuse before SQL', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.files.metadata, JSON.stringify({ dolt_server_host: 'foreign.invalid' }));
  await assert.rejects(inventoryDoltMigration(f.receipt, f.options), /no complete metadata receipt/u);
  assert.equal(f.calls.length, 0);
  const bad = structuredClone(f.receipt); bad.projects[0].database = 'tasks; SELECT body FROM issues';
  assert.throws(() => describeDoltMigrationInventory(bad), /metadata refused/u);
  const wrong = structuredClone(f.receipt); wrong.projects[0].files.metadata = '/unapproved/metadata.json';
  assert.throws(() => describeDoltMigrationInventory(wrong), /metadata refused/u);
});

test('untrusted table names cannot add query text and raw SQL failures never appear in CLI diagnostics', async t => {
  const f = fixture(t); const original = f.options.run;
  await assert.rejects(inventoryDoltMigration(f.receipt, { ...f.options, run: async (...args) => {
    if (args[1].at(-1).includes('FROM information_schema.TABLES')) return { code: 0,
      stdout: JSON.stringify({ rows: [{ table_name: 'issues`; SELECT body FROM issues', table_type: 'BASE TABLE' }] }) };
    return original(...args);
  } }), /no complete metadata receipt/u);
  assert.ok(!f.calls.some(call => call.args.at(-1).includes('SELECT body')));
  let output = ''; let errors = '';
  assert.equal(await main(['--unknown', SECRET], { stdout: { write(value) { output += value; } }, stderr: { write(value) { errors += value; } } }), 1);
  assert.equal(output, ''); assert.ok(!errors.includes(SECRET));
});
