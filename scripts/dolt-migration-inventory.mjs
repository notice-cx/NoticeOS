// One explicit read-only metadata batch for ro-ujb9.9.1. No adoption/capture.
import { execFile } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { doltMigrationReceipt, inspectDoltMigrationSpokes, readDoltMigrationReceipt } from './dolt-migration-inspect.mjs';

const MAX_ROWS = 4096;
const MAX_TABLES = 64;
const MAX_QUERIES = 2500;
const MAX_DURATION = 300_000;
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/u.test(value);
const quoted = value => { if (!identifier(value)) throw Error(); return `\`${value}\``; };
const fail = () => { throw Error('Dolt migration inventory refused; no complete metadata receipt was produced.'); };
const globalQueries = [
  ['version', 'SELECT DOLT_VERSION() AS version, CURRENT_USER() AS account', ['version', 'account']],
  ['databaseNames', 'SELECT SCHEMA_NAME AS db FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME', ['db']],
  ['accounts', 'SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host', ['user', 'host']],
  ['globalPrivileges', 'SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE, PRIVILEGE_TYPE', ['grantee', 'privilege', 'grantable']],
  ['schemaPrivileges', 'SELECT Host AS host, Db AS db, User AS user, Select_priv, Insert_priv, Update_priv, Delete_priv, Create_priv, Drop_priv, Grant_priv, References_priv, Index_priv, Alter_priv, Create_tmp_table_priv, Lock_tables_priv, Create_view_priv, Show_view_priv, Create_routine_priv, Alter_routine_priv, Execute_priv, Event_priv, Trigger_priv FROM mysql.db ORDER BY Host, Db, User', ['host', 'db', 'user', 'Select_priv', 'Insert_priv', 'Update_priv', 'Delete_priv', 'Create_priv', 'Drop_priv', 'Grant_priv', 'References_priv', 'Index_priv', 'Alter_priv', 'Create_tmp_table_priv', 'Lock_tables_priv', 'Create_view_priv', 'Show_view_priv', 'Create_routine_priv', 'Alter_routine_priv', 'Execute_priv', 'Event_priv', 'Trigger_priv']],
  ['tablePrivileges', 'SELECT Host AS host, Db AS db, User AS user, Table_name AS table_name, Table_priv AS table_priv, Column_priv AS column_priv FROM mysql.tables_priv ORDER BY Host, Db, User, Table_name', ['host', 'db', 'user', 'table_name', 'table_priv', 'column_priv']],
  ['roleGrants', 'SELECT FROM_HOST AS from_host, FROM_USER AS from_user, TO_HOST AS to_host, TO_USER AS to_user, WITH_ADMIN_OPTION AS admin_option FROM mysql.role_edges ORDER BY FROM_HOST, FROM_USER, TO_HOST, TO_USER', ['from_host', 'from_user', 'to_host', 'to_user', 'admin_option']],
];

function databaseQueries(db) {
  quoted(db);
  return [
    ['tables', `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' ORDER BY TABLE_NAME`, ['table_name', 'table_type']],
    ['columns', `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS position, COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLUMN_KEY AS column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${db}' ORDER BY TABLE_NAME, ORDINAL_POSITION`, ['table_name', 'column_name', 'position', 'column_type', 'nullable', 'column_key']],
    ['indexes', `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS position, COLUMN_NAME AS column_name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${db}' ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, ['table_name', 'index_name', 'non_unique', 'position', 'column_name']],
    ['branches', `SELECT name, hash FROM ${quoted(db)}.dolt_branches ORDER BY name`, ['name', 'hash']],
    ['tags', `SELECT tag_name, tag_hash FROM ${quoted(db)}.dolt_tags ORDER BY tag_name`, ['tag_name', 'tag_hash']],
    ['commitCount', `SELECT COUNT(*) AS count FROM ${quoted(db)}.dolt_log`, ['count']],
    ['workingStatus', `SELECT table_name, staged, status FROM ${quoted(db)}.dolt_status ORDER BY table_name, staged`, ['table_name', 'staged', 'status']],
    ['branchPermissions', `SELECT \`database\` AS db, branch, user, host, permissions FROM ${quoted(db)}.dolt_branch_control ORDER BY \`database\`, branch, user, host`, ['db', 'branch', 'user', 'host', 'permissions']],
    ['branchNamespaces', `SELECT \`database\` AS db, branch, user, host FROM ${quoted(db)}.dolt_branch_namespace_control ORDER BY \`database\`, branch, user, host`, ['db', 'branch', 'user', 'host']],
  ];
}

export function describeDoltMigrationInventory(receipt) {
  const plan = doltMigrationReceipt(receipt);
  return { endpoint: plan.hub, spokeReads: plan.projects.flatMap(entry => Object.values(entry.files)),
    queries: [...globalQueries.map(([name, query]) => ({ name, query })),
      ...plan.projects.flatMap(({ database }) => databaseQueries(database).map(([name, query]) => ({ database, name, query })))],
    counts: { template: 'SELECT COUNT(*) AS count FROM `<declared-database>`.`<discovered-base-table>`',
      excludes: 'dolt_* version-control system tables', maxBaseTablesPerDatabase: MAX_TABLES },
    limits: { rowsPerQuery: MAX_ROWS, queries: Math.min(MAX_QUERIES, globalQueries.length + plan.projects.length * (MAX_TABLES + 9)), durationMs: MAX_DURATION, queryTimeoutMs: 20_000 },
    consistency: 'Sequential read-only metadata; not a quiescent snapshot or live-store membership verification.' };
}

export function runDoltInventoryQuery(binary, args, options) {
  return new Promise(resolve => execFile(binary, args, { ...options, timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr })));
}

function emptyOwnedClientHome(folder, io) {
  const home = path.resolve(folder);
  if (typeof process.getuid !== 'function') fail();
  for (let current = home; ; current = path.dirname(current)) {
    const stat = io.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    if (current === home && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail();
    if (path.dirname(current) === current) break;
  }
  // Names only: never open an ambient Dolt/client configuration to inspect it.
  if (io.readdirSync(home).length !== 0) fail();
  return home;
}

function rows(result, fields) {
  if (result.code !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 4 * 1024 * 1024) throw Error();
  const parsed = JSON.parse(result.stdout.trim());
  // Pinned Dolt renders a successful zero-row query as {}, not { rows: [] }.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0 &&
    !(fields.length === 1 && fields[0] === 'count')) return [];
  if (!Array.isArray(parsed.rows) || parsed.rows.length > MAX_ROWS) throw Error();
  if (fields.length === 1 && fields[0] === 'count' && parsed.rows.length !== 1) throw Error();
  return parsed.rows.map(row => {
    const selected = {};
    for (const field of fields) {
      if (!Object.hasOwn(row, field) || ![null, 'string', 'number', 'boolean'].includes(row[field] === null ? null : typeof row[field]) ||
        (typeof row[field] === 'string' && (row[field].length > 1024 || /[\0\r\n]/u.test(row[field])))) throw Error();
      selected[field] = row[field];
    }
    if (fields.length === 1 && fields[0] === 'count' &&
      !((typeof selected.count === 'number' && Number.isSafeInteger(selected.count) && selected.count >= 0) ||
        (typeof selected.count === 'string' && /^\d+$/u.test(selected.count)))) throw Error();
    return selected;
  });
}

export async function inventoryDoltMigration(receipt, { dolt, clientHome, run = runDoltInventoryQuery, fs } = {}) {
  try {
    if (!path.isAbsolute(dolt ?? '') || !path.isAbsolute(clientHome ?? '')) fail();
    clientHome = emptyOwnedClientHome(clientHome, fs ?? nodeFs);
    const plan = doltMigrationReceipt(receipt);
    // Every approved spoke is checked before the first source SQL request.
    const spokes = inspectDoltMigrationSpokes(receipt, fs ? { fs } : {});
    const description = describeDoltMigrationInventory(receipt);
    const started = Date.now(); let queries = 0;
    const query = async ([name, sql, fields], required = false) => {
      if (++queries > description.limits.queries || Date.now() - started >= MAX_DURATION) fail();
      const args = [`--host=${plan.hub.host}`, `--port=${plan.hub.port}`, `--user=${plan.hub.user}`, '--no-tls',
        'sql', '--result-format=json', '--query', sql];
      try {
        const result = await run(dolt, args, { cwd: clientHome, env: { HOME: clientHome,
          XDG_CONFIG_HOME: path.join(clientHome, '.config'), DOLT_CLI_PASSWORD: '',
          // Dolt v2.2.0 go/cmd/dolt/dolt.go checks this before event flushing.
          // Events may be written to this own HOME but cannot be sent remotely.
          DOLT_DISABLE_EVENT_FLUSH: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
          timeoutMs: Math.min(20_000, MAX_DURATION - (Date.now() - started)) });
        return { name, available: true, rows: rows(result, fields) };
      } catch { if (required) fail(); return { name, available: false }; }
    };
    const global = [];
    for (const entry of globalQueries) global.push(await query(entry, entry[0] === 'version'));
    if (global[0].rows.length !== 1 || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(global[0].rows[0].version)) fail();
    const databases = [];
    for (const { database } of plan.projects) {
      const summaries = [];
      for (const entry of databaseQueries(database)) summaries.push(await query(entry));
      const tables = summaries.find(item => item.name === 'tables');
      const counts = [];
      if (tables.available) {
        const base = tables.rows.filter(row => row.table_type === 'BASE TABLE' && !row.table_name.startsWith('dolt_'));
        if (base.length > MAX_TABLES || base.some(row => !identifier(row.table_name))) fail();
        for (const row of base) counts.push({ table: row.table_name,
          ...await query(['rowCount', `SELECT COUNT(*) AS count FROM ${quoted(database)}.${quoted(row.table_name)}`, ['count']]) });
      }
      databases.push({ database, summaries, counts });
    }
    return { format: 'noticeos-dolt-migration-inventory-v1', endpoint: plan.hub, spokes, global, databases,
      queries, consistency: description.consistency, batchCompleted: true,
      sqlMetadataComplete: global.every(item => item.available) && databases.every(db => [...db.summaries, ...db.counts].every(item => item.available)) };
  } catch { fail(); }
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      stdout.write('Usage: node scripts/dolt-migration-inventory.mjs --receipt <absolute-json> --dolt <absolute-client> --client-home <owned-absolute-directory> [--describe]\nNo installation rereads, authentication lookup, snapshots or source writes.\n'); return 0;
    }
    const options = {};
    for (let index = 0; index < argv.length; index++) {
      const key = argv[index];
      if (key === '--describe') { if (options.describe) fail(); options.describe = true; continue; }
      if (!['--receipt', '--dolt', '--client-home'].includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail();
      const name = key === '--client-home' ? 'clientHome' : key.slice(2);
      if (options[name]) fail(); options[name] = argv[++index];
    }
    const receipt = readDoltMigrationReceipt(options.receipt);
    const result = options.describe ? describeDoltMigrationInventory(receipt) : await inventoryDoltMigration(receipt, options);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`); return 0;
  } catch { stderr.write('Dolt migration inventory refused; no complete metadata receipt was produced.\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
