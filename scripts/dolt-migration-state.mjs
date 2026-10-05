#!/usr/bin/env node
// Target-only bounded reconciliation. Row contents remain in SQL; only their
// digests, counts, schema/identity and history hashes enter the private receipt.
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSpokeMigrationPlan } from './dolt-migration-spokes.mjs';
import { doltExecutor, doltComposeArgs, DOLT_VERSION } from './dolt-host.mjs';

const fail = () => { throw Error('Copied target reconciliation refused; no task content was emitted.'); };
const identifier = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(value);
const quote = value => { if (!identifier(value)) fail(); return '`' + value + '`'; };
const controls = new Set(['schema_migrations', 'ignored_schema_migrations', 'local_metadata']);
const auxiliary = new Set(['comments', 'events', 'issue_snapshots', 'compaction_snapshots', 'dependencies']);
const textTypes = new Set(['tinytext', 'text', 'mediumtext', 'longtext']);
export const reconciliationChanges = {
  columns: 'Auxiliary IDs in comments/events/snapshots/dependencies are derived again; issues/wisps is_blocked is recomputed. Task IDs and all other pre-existing columns must remain identical.',
  controls: 'Schema migration cursors and local migration/CLI bookkeeping change. Compare project identity and all remaining base-table content; new tables/columns are allowed.',
  audit: 'Migration62 preserves event rows in durable Dolt-ignored working storage. Existing reachable commits remain; new audit events no longer create versioned history.',
};

export function semanticColumns(table, columns) {
  if (!identifier(table) || !Array.isArray(columns) || !columns.length || columns.length > 256 || columns.some(column => !identifier(column))) fail();
  return columns.filter(column => !(column === 'id' && auxiliary.has(table)) && !(column === 'is_blocked' && ['issues', 'wisps'].includes(table)));
}
function fingerprint(values) {
  if (!Array.isArray(values) || values.length > 100_000 || values.some(row => !/^[0-9a-f]{64}$/u.test(row.digest ?? ''))) fail();
  return { count: values.length, sha256: createHash('sha256').update(values.map(row => row.digest).sort().join('\n')).digest('hex') };
}

export async function captureTargetState(databases, query, { baseline = null } = {}) {
  if (!Array.isArray(databases) || !databases.length || databases.length > 64 || databases.some(db => !identifier(db))) fail();
  const version = await query('SELECT DOLT_VERSION() AS version');
  if (version.length !== 1 || version[0].version !== DOLT_VERSION) fail();
  const result = { format: 'noticeos-dolt-target-state-v1', version: DOLT_VERSION, changes: reconciliationChanges, databases: [] };
  for (const db of databases) {
    const schema = await query(`SELECT MAX(version) AS version FROM ${quote(db)}.schema_migrations`);
    const project = await query(`SELECT value AS project_id FROM ${quote(db)}.metadata WHERE \`key\`='_project_id'`);
    const prefix = await query(`SELECT value AS prefix FROM ${quote(db)}.config WHERE \`key\`='issue_prefix'`);
    if (schema.length !== 1 || ![53, 66].includes(Number(schema[0].version)) || project.length !== 1 || prefix.length !== 1) fail();
    const roots = await query(`USE ${quote(db)}; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working`);
    const branches = await query(`SELECT name,hash FROM ${quote(db)}.dolt_branches ORDER BY name`);
    const tags = await query(`SELECT tag_name,tag_hash FROM ${quote(db)}.dolt_tags ORDER BY tag_name`);
    const history = await query(`SELECT commit_hash FROM ${quote(db)}.dolt_log ORDER BY commit_hash`);
    const catalog = await query(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${db}' ORDER BY TABLE_NAME,ORDINAL_POSITION`);
    const baseTables = await query(`SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA='${db}' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`);
    if (baseTables.length > 64 || catalog.length > 4096 || history.length > 100_000) fail();
    const prior = baseline?.databases.find(entry => entry.database === db);
    const tables = [];
    for (const table of baseTables.map(row => row.table_name).filter(table => !table.startsWith('dolt_') && !controls.has(table))) {
      quote(table);
      const definitions = catalog.filter(row => row.table_name === table);
      const existing = definitions.map(row => row.column_name);
      if (new Set(existing).size !== existing.length || definitions.some(row =>
        typeof row.data_type !== 'string' || !/^[a-z]+$/iu.test(row.data_type))) fail();
      const types = new Map(definitions.map(row => [row.column_name, row.data_type.toLowerCase()]));
      const columns = prior?.tables.find(entry => entry.table === table)?.columns ?? semanticColumns(table, existing);
      if (!columns.length || columns.some(column => !existing.includes(column))) fail();
      // CAST preserves nulls and uses a stable string representation before
      // JSON_ARRAY frames each cell; delimiter collisions cannot lose records.
      // Dolt stores large TEXT out of line; CONCAT materializes it for CAST.
      // Other types keep the original CAST: CONCAT changes DATE formatting.
      const cells = columns.map(column => `CAST(${textTypes.has(types.get(column))
        ? `CONCAT('',${quote(column)})` : quote(column)} AS CHAR)`).join(',');
      const rows = await query(`SELECT SHA2(JSON_ARRAY(${cells}),256) AS digest FROM ${quote(db)}.${quote(table)} ORDER BY digest LIMIT 100001`);
      tables.push({ table, columns, ...fingerprint(rows) });
    }
    result.databases.push({ database: db, schema: Number(schema[0].version), projectId: project[0].project_id, prefix: prefix[0].prefix,
      roots, branches, tags, history, tables });
  }
  return result;
}

export function compareTargetState(before, after, { upgraded = true } = {}) {
  if (before?.format !== 'noticeos-dolt-target-state-v1' || after?.format !== before.format || before.version !== DOLT_VERSION || after.version !== before.version ||
    JSON.stringify(before.databases.map(db => db.database)) !== JSON.stringify(after.databases.map(db => db.database))) fail();
  for (const [index, old] of before.databases.entries()) {
    const current = after.databases[index];
    if ((upgraded && old.schema !== 53) || current.projectId !== old.projectId || current.prefix !== old.prefix || current.schema !== (upgraded ? 66 : old.schema)) fail();
    for (const table of old.tables) {
      const now = current.tables.find(entry => entry.table === table.table);
      if (!now || now.count !== table.count || now.sha256 !== table.sha256 || JSON.stringify(now.columns) !== JSON.stringify(table.columns)) fail();
    }
    if (old.history.some(row => !current.history.some(entry => entry.commit_hash === row.commit_hash))) fail();
    // Upgrade writes are expected only on main. Other branches and all tags
    // must keep their exact heads; no new branches/tags are silently accepted.
    if (JSON.stringify(old.tags) !== JSON.stringify(current.tags) || old.branches.length !== current.branches.length || old.branches.some(row =>
      !current.branches.some(entry => entry.name === row.name && (upgraded && row.name === 'main' || entry.hash === row.hash)))) fail();
    if (!upgraded && JSON.stringify(old.roots) !== JSON.stringify(current.roots)) fail();
  }
  return { complete: true, databases: before.databases.length, schema: upgraded ? 66 : before.databases[0].schema, semanticContentPreserved: true, originalHistoryReachable: true };
}

function privateReceipt(file) {
  if (!path.isAbsolute(file ?? '')) fail();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 16 * 1024 ** 2) fail();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    if (![5, 7].includes(argv.length) || !['snapshot', 'verify'].includes(argv[0]) || argv[1] !== '--plan' || argv[3] !== '--output' ||
      (argv[0] === 'verify' ? argv.length !== 7 || argv[5] !== '--baseline' : argv.length !== 5)) fail();
    const { input, profile } = readSpokeMigrationPlan(argv[2]);
    if (!path.isAbsolute(argv[4]) || path.dirname(argv[4]) !== path.dirname(input.journal) || fs.lstatSync(argv[4], { throwIfNoEntry: false })) fail();
    if (argv[0] === 'verify' && path.dirname(argv[6]) !== path.dirname(input.journal)) fail();
    const baseline = argv[0] === 'verify' ? privateReceipt(argv[6]) : null;
    const run = await doltExecutor(profile, { env });
    const query = async sql => {
      const reply = await run([...doltComposeArgs(profile), 'exec', '--no-TTY', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', sql], 60_000);
      if (reply.code !== 0 || reply.stdout.length > 16 * 1024 ** 2) fail();
      const parsed = JSON.parse(reply.stdout.trim().split('\n').at(-1));
      if (JSON.stringify(parsed) === '{}') return [];
      if (!Array.isArray(parsed.rows) || parsed.rows.length > 100_001) fail(); return parsed.rows;
    };
    const state = await captureTargetState(input.spokes.map(spoke => spoke.database), query, { baseline });
    for (const [index, db] of state.databases.entries()) if (db.projectId !== input.spokes[index].projectId || db.prefix !== input.spokes[index].prefix) fail();
    if (!baseline && state.databases.some(db => db.schema !== 53)) fail();
    const comparison = baseline ? compareTargetState(baseline, state) : { complete: true, databases: state.databases.length, schema: state.databases[0].schema };
    const fd = fs.openSync(argv[4], fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    stdout.write(JSON.stringify(comparison) + '\n'); return 0;
  } catch { stderr.write('Copied target reconciliation refused; inspect protected receipts without emitting task content.\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
