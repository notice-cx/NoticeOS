#!/usr/bin/env node
// Import a verified evidence bundle into an already activated private shadow.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SHADOW_EVIDENCE_FORMAT, SHADOW_EVIDENCE_TABLES, SHADOW_RUN_ERROR, SHADOW_RUN_REFERENCE, SHADOW_SETTINGS_MAX_BYTES,
  validShadowColumns, validShadowSetting } from './customer-shadow-export.mjs';
import { openPrivateShadowFile as privateFile, privateShadowDirectory as privateDirectory,
  readPrivateShadowFile as readPrivate, ShadowTargetRefused, verifyShadowTargetReceipt } from './customer-shadow-receipt.mjs';
import { invokedDirectly } from './invoked-directly.mjs';
import { findPsql } from './postgres-tools.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';
import { SHADOW_DISPLAY_DOCUMENTS, shadowDisplayAssets, shadowDisplayDocument } from './customer-shadow-display.mjs';
import { checkShadowSpendRows } from './customer-shadow-spend.mjs';
import { validShadowJourneys } from './customer-shadow-journeys.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const INT = /^\d{1,10}$/u;
const EXTRA_EMPTY = ['archive_runs', 'archive_objects', 'integration_connections', 'connection_secrets', 'task_snapshots',
  'hosted_job_occurrences', 'job_runs', 'research_log', 'dataforseo_request_charges'];
const MIN_DISK_BYTES = 8n * 1024n ** 3n;
const TIMEOUT = 15 * 60_000;
const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC', PGCONNECT_TIMEOUT: '5' };
const sha256 = data => createHash('sha256').update(data).digest('hex');
class ImportRefused extends Error {}
const refuse = message => { throw new ImportRefused(message); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
// These values are data even when they contain quotes or backslashes.
const literal = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;

function validatedManifest(value) {
  if (!exact(value, ['format', 'workspaceId', 'snapshotAt', 'snapshotTimeZone', 'sourceBytes', 'encoding', 'files', 'omitted', 'refusals'])
    || value.format !== SHADOW_EVIDENCE_FORMAT || typeof value.workspaceId !== 'string' || !UUID.test(value.workspaceId)
    || value.encoding !== 'postgres-copy-text-jsonl' || !Array.isArray(value.files)
    || !Array.isArray(value.refusals) || value.refusals.length !== 0) refuse('The bundle manifest is invalid.');
  const names = new Set();
  for (const file of value.files) {
    const settings = file?.name === 'settings';
    if (!exact(file, ['name', 'path', 'rows', 'bytes', 'sha256', ...(settings ? [] : ['columns'])])
      || names.has(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !Number.isSafeInteger(file.rows) || file.rows < 0 || !HASH.test(file.sha256 ?? '')
      || (settings ? file.path !== 'settings.json' : (!SHADOW_EVIDENCE_TABLES.includes(file.name)
        || file.path !== `tables/${file.name}.jsonl` || !validShadowColumns(file.name, file.columns)))) {
      refuse('The bundle manifest has an invalid or repeated file.');
    }
    names.add(file.name);
  }
  if (!['settings', 'assets', 'pulses', 'asset_insight_snapshots'].every(name => names.has(name))) {
    refuse('The bundle is missing required evidence.');
  }
  return value;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+\d\d(?::\d\d)?|-\d\d(?::\d\d)?)$/u.test(value)
    && Number.isFinite(Date.parse(value.replace(/([+-]\d\d)$/u, '$1:00')));
}
function safeText(value) {
  return typeof value === 'string' && !value.includes('\0');
}
function checkSettings(value) {
  const hasJourneys = record(value) && Object.hasOwn(value, 'journeys');
  if (!exact(value, ['values', 'document', 'audit', ...(hasJourneys ? ['journeys'] : []), ...(value?.display === undefined ? [] : ['display']),
    ...(value?.metered === undefined ? [] : ['metered'])])
    || (hasJourneys && !validShadowJourneys(value.journeys)) || !record(value.values) || !Array.isArray(value.audit)
    || !Object.entries(value.values).every(([key, data]) => validShadowSetting(key, data))) refuse('The bundle has invalid saved settings.');
  if (value.display !== undefined) {
    try {
      if (!record(value.display) || !Object.entries(value.display).every(([key, doc]) => SHADOW_DISPLAY_DOCUMENTS.includes(key)
        && exact(doc, ['body', 'updatedAt']) && validDate(doc.updatedAt)
        && isDeepStrictEqual(doc.body, shadowDisplayDocument(key, doc.body)))) refuse('The bundle has invalid display settings.');
    } catch { refuse('The bundle has invalid display settings.'); }
  }
  if (value.metered !== undefined) checkShadowSpendRows(value.metered);
  const settings = value.document;
  if (settings === null) {
    if (Object.keys(value.values).length || value.audit.length) refuse('The saved settings have no source document.');
    return value;
  }
  if (!exact(settings, ['key', 'version', 'updatedAt', 'updatedBy']) || settings.key !== 'constants'
    || !INT.test(settings.version ?? '') || Number(settings.version) < 1 || Number(settings.version) >= 2 ** 31
    || !validDate(settings.updatedAt) || (settings.updatedBy !== null && !safeText(settings.updatedBy))) {
    refuse('The bundle has invalid saved settings metadata.');
  }
  const versions = new Set();
  for (const audit of value.audit) {
    if (!exact(audit, ['documentKey', 'versionBefore', 'versionAfter', 'changedAt', 'actor', 'reason', 'ops'])
      || audit.documentKey !== 'constants' || !INT.test(audit.versionBefore ?? '') || !INT.test(audit.versionAfter ?? '')
      || Number(audit.versionBefore) >= Number(audit.versionAfter) || Number(audit.versionAfter) > Number(settings.version)
      || versions.has(audit.versionAfter) || !validDate(audit.changedAt) || !safeText(audit.actor) || !audit.actor
      || (audit.reason !== null && !safeText(audit.reason)) || !Array.isArray(audit.ops) || !audit.ops.length || audit.ops.length > 32) {
      refuse('The bundle has invalid settings audit evidence.');
    }
    versions.add(audit.versionAfter);
    for (const op of audit.ops) {
      const field = typeof op?.pointer === 'string' ? op.pointer.slice(1) : '';
      if (!exact(op, ['kind', 'file', 'pointer', 'value', ...(op?.expect === undefined ? [] : ['expect'])])
        || op.kind !== 'file-json-set' || op.file !== 'config/constants.json' || op.pointer !== '/' + field
        || !validShadowSetting(field, op.value)
        || (op.expect != null && !validShadowSetting(field, op.expect))) refuse('The bundle has an unapproved settings change.');
    }
  }
  return value;
}

const escaped = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v' };
const copyText = value => value === null ? '\\N' : value.replace(/[\\\n\r\t\b\f\v]/gu, character => escaped[character]);
const columnSql = file => file.columns.map(column => `"${column}"`).join(', ');
const orderBy = { assets: 'list_position', pulses: 'pulse_number,revision', ledger_entries: 'entry_number', revenue_observations: 'observation_number' };

async function stageTable(bundle, file, workspaceId, output, signal) {
  const { handle, stat } = await privateFile(path.join(bundle, file.path));
  const columns = columnSql(file);
  const stage = `pg_temp.shadow_${file.name}`;
  const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', seenBytes = 0, rows = 0;
  try {
    if (stat.size !== file.bytes) refuse('A bundle file changed after export.');
    await output.writeFile(`CREATE TEMP TABLE shadow_${file.name} ON COMMIT DROP AS SELECT ${columns} FROM noticeos.${file.name} WITH NO DATA;\nCOPY ${stage} (${columns}) FROM STDIN;\n`);
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      seenBytes += chunk.length;
      if (seenBytes > file.bytes) refuse('A bundle file changed after export.');
      hash.update(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
        if (end - start > 64 * 1024 ** 2) refuse('A bundle row exceeds the supported size.');
        const row = JSON.parse(pending.slice(start, end));
        start = end + 1;
        if (!exact(row, file.columns) || row.workspace_id !== workspaceId || !Object.values(row).every(value => value === null || safeText(value))) {
          refuse('A bundle row is malformed or belongs to another workspace.');
        }
        if (file.name === 'asset_insight_snapshots' && (!safeText(row.payload) || sha256(row.payload) !== row.content_sha256)) {
          refuse('An asset report no longer matches its recorded hash.');
        }
        if ((file.name === 'signal_runs' && (row.credential_ref !== SHADOW_RUN_REFERENCE
          || row.error_message !== (row.status === 'error' ? SHADOW_RUN_ERROR : null)))
          || (file.name === 'task_daily_counts' && row.closed_ids !== null)) {
          refuse('The bundle contains a private source reference.');
        }
        await output.writeFile(file.columns.map(column => copyText(row[column])).join('\t') + '\n');
        rows++;
      }
      pending = pending.slice(start);
      if (pending.length > 64 * 1024 ** 2) refuse('A bundle row exceeds the supported size.');
    }
    if (pending + decoder.decode() !== '' || rows !== file.rows || seenBytes !== file.bytes || hash.digest('hex') !== file.sha256) {
      refuse('A bundle file no longer matches the export manifest.');
    }
    await output.writeFile('\\.\n');
  } finally { await handle.close(); }
}

function verifySql(expression, message) {
  const body = `BEGIN IF NOT COALESCE((${expression}),false) THEN RAISE EXCEPTION ${literal(message)}; END IF; END;`;
  return `DO ${literal(body)};\n`;
}

function frozenMigrationsSql() {
  const marker = new URL('../db/postgres/frozen-migrations.sha256', import.meta.url);
  const entries = readFileSync(marker, 'utf8').trim().split('\n');
  return entries.map((entry, index) => {
    const match = /^([0-9a-f]{64}) [ *]migrations\/(\d{4}_[a-z0-9_]+)\.sql$/u.exec(entry);
    if (!match || Number(match[2].slice(0, 4)) !== index + 1) refuse('The released schema checksums are unavailable.');
    return `(${index + 1},${literal(match[2])}::text,${literal(match[1])}::text)`;
  }).join(',');
}

function preflightSql(target, migrationRows, tables) {
  const workspace = literal(target.workspaceId);
  return `BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='5min';
SET LOCAL noticeos.workspace_id=${workspace};
` + verifySql(`current_database()='noticeos_dev' AND current_user='postgres' AND current_setting('data_directory')=${literal(target.dataDir)}
      AND current_setting('server_version_num')::int BETWEEN 180000 AND 189999
      AND (SELECT system_identifier::text FROM pg_control_system())=${literal(target.postgresSystemId)}`, 'Wrong shadow cluster')
    + 'DO $shadow$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(\'noticeos.shadow-import\',0)); END $shadow$;\n'
    + `LOCK TABLE noticeos.workspaces, noticeos_migrations.applied, noticeos_identity.auth_member, noticeos_identity.auth_user,
      noticeos_identity.platform_enrollment, noticeos.config_documents, noticeos.config_changes,
      ${tables.map(name => 'noticeos.' + name).join(', ')} IN SHARE ROW EXCLUSIVE MODE;\n`
    + verifySql(`(SELECT count(*) FROM noticeos.workspaces)=1
      AND EXISTS(SELECT 1 FROM noticeos.workspaces WHERE workspace_id=${workspace}::uuid AND status='active')
      AND (SELECT count(*) FROM noticeos_identity.auth_member WHERE organization_id=${workspace}::uuid)=1
      AND EXISTS(SELECT 1 FROM noticeos_identity.auth_member m JOIN noticeos_identity.auth_user u ON u.id=m.user_id
        JOIN noticeos_identity.platform_enrollment e ON e.workspace_id=m.organization_id AND e.verified_person_id=u.id
        WHERE m.organization_id=${workspace}::uuid AND m.role='owner' AND lower(u.email)=${literal(target.ownerEmail.toLowerCase())}
        AND u.email_verified AND lower(u.email)=e.email AND e.activated_at IS NOT NULL AND e.revoked_at IS NULL)`, 'Shadow owner enrollment is unavailable')
    + verifySql(`NOT EXISTS(
      (SELECT version,name,sha256 FROM noticeos_migrations.applied EXCEPT SELECT * FROM (VALUES ${migrationRows}) expected)
      UNION ALL
      (SELECT * FROM (VALUES ${migrationRows}) expected EXCEPT SELECT version,name,sha256 FROM noticeos_migrations.applied))`, 'Shadow schema does not match the release')
    + verifySql(EXTRA_EMPTY.map(name => `NOT EXISTS(SELECT 1 FROM noticeos.${name})`).join(' AND '), 'The shadow already has unrelated data');
}

function transferSql(manifest, settings, manifestHash) {
  const files = manifest.files.filter(file => file.name !== 'settings');
  const included = new Set(files.map(file => file.name));
  const defaults = releasedDefaultDocuments();
  const workspace = literal(manifest.workspaceId);
  const saved = settings.document;
  const change = saved && Object.keys(settings.values).length > 0;
  const version = change ? Math.max(2, Number(saved.version)) : 1;
  const audit = change ? settings.audit.filter(row => Number(row.versionBefore) > 0) : [];
  const settingsBody = literal(JSON.stringify(settings.values));
  const display = new Map(Object.entries(settings.display ?? {}).map(([key, { body, updatedAt }]) => {
    const baseline = defaults.find(row => row.key === key);
    return [key, { body: literal(JSON.stringify({ ...JSON.parse(baseline.body), ...body })), updatedAt: literal(updatedAt) }];
  }));
  const journeys = settings.journeys ?? [];
  const byDocument = new Map([
    ['value-events', Object.fromEntries(journeys.map(({ asset, definitions }) => [asset, { journeys: definitions }]))],
    ['integrations', Object.fromEntries(journeys.filter(entry => entry.ga4).map(({ asset, ga4 }) => [asset, { ga4 }]))],
  ]);
  const journeyBodies = new Map();
  for (const [key, assets] of byDocument) {
    if (Object.keys(assets).length) {
      const baseline = defaults.find(row => row.key === key);
      journeyBodies.set(key, JSON.stringify({ ...JSON.parse(baseline.body), assets }));
    }
  }
  const registers = includeChanges => {
    const bodies = defaults.map(row => {
      const changed = includeChanges && change && row.key === 'constants';
      const displayBody = includeChanges ? (display.get(row.key)?.body ?? (journeyBodies.has(row.key) ? literal(journeyBodies.get(row.key)) : undefined)) : undefined;
      return `(${literal(row.key)}::text,${displayBody ?? literal(row.body)}::jsonb${changed ? ' || ' + settingsBody + '::jsonb' : ''},
        ${changed ? version : displayBody ? 2 : 1},${literal(changed ? saved.updatedBy : displayBody ? 'offline-shadow' : 'platform-provisioning')}::text)`;
    }).join(',');
    return `(SELECT count(*) FROM noticeos.config_documents)=${defaults.length}
      AND NOT EXISTS(SELECT 1 FROM (VALUES ${bodies}) expected(key,body,version,actor)
      LEFT JOIN noticeos.config_documents saved ON saved.document_key=expected.key
      WHERE saved.version IS DISTINCT FROM expected.version OR saved.updated_by IS DISTINCT FROM expected.actor
      OR saved.body::jsonb IS DISTINCT FROM expected.body)`;
  };
  const metered = settings.metered;
  const meteredColumns = 'day,asset_id,spent_usd,unknown_prices';
  const meteredQuery = metered?.length ? `SELECT * FROM (VALUES ${metered.map(({ day, asset, usd, unknown }) =>
    `(${literal(day)}::date,${literal(asset)}::text,${literal(usd)}::numeric,${unknown}::integer)`).join(',')}) copied(${meteredColumns})`
    : 'SELECT null::date,null::text,null::numeric,null::integer WHERE false';
  const displayAssets = [...new Set([...shadowDisplayAssets(settings.display ?? {}), ...(metered ?? []).flatMap(row => row.asset === null ? [] : [row.asset])])];
  let sql = displayAssets.length ? verifySql(`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${literal(JSON.stringify(displayAssets))}::jsonb) selected(asset)
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.shadow_assets a WHERE a.asset_id=selected.asset))`,
  'Saved cost evidence does not belong to an imported asset') : '';
  sql += journeys.length ? verifySql(`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(${literal(JSON.stringify(journeys.map(entry => entry.asset)))}::jsonb) selected(asset)
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.shadow_assets a WHERE a.asset_id=selected.asset))`,
  'Saved journeys do not belong to an imported asset') : '';
  sql += "SELECT to_regclass('noticeos_shadow.evidence_import') IS NOT NULL AS shadow_replay \\gset\n\\if :shadow_replay\n";
  sql += verifySql(`(SELECT count(*) FROM noticeos_shadow.evidence_import)=1
    AND EXISTS (SELECT 1 FROM noticeos_shadow.evidence_import WHERE workspace_id=${workspace}::uuid AND manifest_sha256=${literal(manifestHash)})`,
  'A different bundle was already imported');
  for (const file of files) {
    const columns = columnSql(file);
    const rows = relation => `SELECT row_to_json(r)::text FROM (SELECT ${columns} FROM ${relation}) r`;
    const target = rows(`noticeos.${file.name}`), staged = rows(`pg_temp.shadow_${file.name}`);
    sql += verifySql(`NOT EXISTS ((${target} EXCEPT ALL ${staged}) UNION ALL (${staged} EXCEPT ALL ${target}))`, 'Imported evidence changed after publication');
  }
  const missing = SHADOW_EVIDENCE_TABLES.filter(name => !included.has(name));
  for (const table of missing) sql += verifySql(`NOT EXISTS(SELECT 1 FROM noticeos.${table})`, 'The shadow gained extra evidence');
  sql += verifySql(registers(true) + ` AND (SELECT count(*) FROM noticeos.config_changes)=${defaults.length + audit.length}`,
    'Imported settings or audit count changed after publication');
  for (const [key, { updatedAt }] of display) {
    sql += verifySql(`EXISTS (SELECT 1 FROM noticeos.config_documents WHERE document_key=${literal(key)}
      AND updated_at=${updatedAt}::timestamptz)`, 'Imported display settings changed after publication');
  }
  if (metered !== undefined) {
    const imported = `SELECT ${meteredColumns} FROM noticeos_shadow.metered_spend WHERE workspace_id=${workspace}::uuid`;
    sql += verifySql(`NOT EXISTS ((${imported} EXCEPT ALL ${meteredQuery})
      UNION ALL (${meteredQuery} EXCEPT ALL ${imported}))`, 'Imported metered spend changed after publication');
  }
  for (const row of audit) {
    sql += verifySql(`EXISTS (SELECT 1 FROM noticeos.config_changes WHERE document_key='constants'
      AND version_before=${Number(row.versionBefore)} AND version_after=${Number(row.versionAfter)}
      AND changed_at=${literal(row.changedAt)}::timestamptz AND actor=${literal(row.actor)}
      AND reason IS NOT DISTINCT FROM ${literal(row.reason)} AND ops=${literal(JSON.stringify(row.ops))}::jsonb)`,
    'Imported audit evidence changed after publication');
  }
  if (change) {
    const expected = defaults.find(row => row.key === 'constants').body;
    sql += verifySql(`EXISTS (SELECT 1 FROM noticeos.config_documents WHERE document_key='constants' AND version=${version}
      AND updated_at=${literal(saved.updatedAt)}::timestamptz
      AND updated_by IS NOT DISTINCT FROM ${literal(saved.updatedBy)}
      AND body::jsonb=(${literal(expected)}::jsonb || ${settingsBody}::jsonb))`, 'Imported settings changed after publication');
  }
  sql += "\\echo shadow-reused\n\\else\n";
  for (const table of SHADOW_EVIDENCE_TABLES) sql += verifySql(`NOT EXISTS(SELECT 1 FROM noticeos.${table})`, 'The shadow already contains business evidence');
  sql += verifySql(registers(false) + ` AND (SELECT count(*) FROM noticeos.config_changes)=${defaults.length}`,
    'The prepared settings were already changed');
  // The output allowlist is in dependency order, regardless of the backup TOC.
  for (const table of SHADOW_EVIDENCE_TABLES) {
    const file = files.find(row => row.name === table);
    if (!file) continue;
    // The observation trigger joins these parents once per row. Fresh table
    // statistics let it look up the matching run instead of scanning history.
    if (table === 'signal_observations' && file.rows > 0) {
      sql += 'ANALYZE noticeos.measurement_series, noticeos.signal_runs;\n';
    }
    const columns = columnSql(file);
    sql += `INSERT INTO noticeos.${table} (${columns}) OVERRIDING SYSTEM VALUE
      SELECT ${columns} FROM pg_temp.shadow_${table}${orderBy[table] ? ' ORDER BY ' + orderBy[table] : ''};\n`;
  }
  if (change) {
    sql += `UPDATE noticeos.config_documents SET body=(body::jsonb || ${settingsBody}::jsonb)::json,
      version=${version},updated_at=${literal(saved.updatedAt)}::timestamptz,updated_by=${literal(saved.updatedBy)}
      WHERE document_key='constants' AND workspace_id=${workspace}::uuid AND version=1;\n`;
    for (const row of audit) sql += `INSERT INTO noticeos.config_changes
      (workspace_id,document_key,ops,reason,actor,version_before,version_after,changed_at)
      VALUES (${workspace}::uuid,'constants',${literal(JSON.stringify(row.ops))}::jsonb,${literal(row.reason)},${literal(row.actor)},
      ${Number(row.versionBefore)},${Number(row.versionAfter)},${literal(row.changedAt)}::timestamptz);\n`;
  }
  for (const [key, { body, updatedAt }] of display) {
    sql += `UPDATE noticeos.config_documents SET body=${body}::json, version=2, updated_by='offline-shadow',
      updated_at=${updatedAt}::timestamptz
      WHERE document_key=${literal(key)} AND workspace_id=${workspace}::uuid AND version=1;\n`;
  }
  for (const [key, body] of journeyBodies) {
    sql += `UPDATE noticeos.config_documents SET body=${literal(body)}::jsonb::json, version=2, updated_at=clock_timestamp(),
      updated_by='offline-shadow' WHERE document_key=${literal(key)} AND workspace_id=${workspace}::uuid AND version=1;\n`;
  }
  sql += `CREATE SCHEMA noticeos_shadow AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA noticeos_shadow FROM PUBLIC;
CREATE TABLE noticeos_shadow.evidence_import (workspace_id uuid PRIMARY KEY, manifest_sha256 text NOT NULL);
INSERT INTO noticeos_shadow.evidence_import VALUES (${workspace}::uuid,${literal(manifestHash)});
`;
  if (metered !== undefined) {
    sql += `CREATE TABLE noticeos_shadow.metered_spend (
      workspace_id uuid NOT NULL REFERENCES noticeos.workspaces,
      day date NOT NULL, asset_id text, spent_usd numeric(26,6) NOT NULL CHECK (spent_usd >= 0),
      unknown_prices integer NOT NULL CHECK (unknown_prices >= 0),
      UNIQUE NULLS NOT DISTINCT (workspace_id,day,asset_id),
      FOREIGN KEY (workspace_id,asset_id) REFERENCES noticeos.assets
    );
    INSERT INTO noticeos_shadow.metered_spend (workspace_id,${meteredColumns})
      SELECT ${workspace}::uuid,staged.* FROM (${meteredQuery}) staged;
    ALTER TABLE noticeos_shadow.metered_spend ENABLE ROW LEVEL SECURITY;
    CREATE POLICY shadow_workspace_scope ON noticeos_shadow.metered_spend FOR SELECT
      USING (workspace_id=noticeos.current_workspace_id());
    GRANT USAGE ON SCHEMA noticeos_shadow TO noticeos_app;
    GRANT SELECT ON noticeos_shadow.metered_spend TO noticeos_app;
    `;
  }
  sql += `\\echo shadow-imported
\\endif
COMMIT;\n`;
  return sql;
}

async function applySql(psql, target, sql, signal) {
  signal?.throwIfAborted();
  const child = spawn(psql, ['-X', '--quiet', '--no-password', '--set=ON_ERROR_STOP=1', '--host', target.socketDir,
    '--port', String(target.port), '--dbname', target.database, '--username', 'postgres', '--file', sql],
  { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const stop = () => child.kill('SIGTERM');
  const timer = setTimeout(stop, TIMEOUT);
  signal?.addEventListener('abort', stop, { once: true });
  let outcome = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    outcome += chunk;
    if (outcome.length > 4096) stop();
  });
  try {
    const success = await new Promise(resolve => {
      child.once('error', () => {});
      child.once('close', code => resolve(code === 0));
    });
    signal?.throwIfAborted();
    if (!success) refuse('The target did not confirm the import. Check the private target and run the import again.');
    return outcome.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

export async function importShadowEvidence({ bundle: bundleInput, target: targetInput, signal }) {
  const bundle = await privateDirectory(bundleInput), root = await privateDirectory(targetInput);
  await privateDirectory(path.join(bundle, 'tables'));
  const manifestBytes = await readPrivate(path.join(bundle, 'manifest.json'), 512 * 1024);
  const manifest = validatedManifest(JSON.parse(manifestBytes));
  const settingsFile = manifest.files.find(file => file.name === 'settings');
  const settingsBytes = await readPrivate(path.join(bundle, 'settings.json'), SHADOW_SETTINGS_MAX_BYTES);
  if (settingsBytes.length !== settingsFile.bytes || sha256(settingsBytes) !== settingsFile.sha256) refuse('The saved settings no longer match the export manifest.');
  const settings = checkSettings(JSON.parse(settingsBytes));
  if (settings.audit.length !== settingsFile.rows) refuse('The settings count no longer matches the export manifest.');
  const tools = findPsql();
  if (tools?.major !== 18) refuse('Put PostgreSQL 18 client tools on PATH.');
  const lock = path.join(root, '.shadow-running');
  let held;
  try { held = await fs.open(lock, 'wx', 0o600); } catch { refuse('Stop the shadow before importing evidence.'); }
  let scratch;
  try {
    const target = await verifyShadowTargetReceipt(root, tools.psql, { workspaceId: manifest.workspaceId });
    const disk = await fs.statfs(root, { bigint: true });
    const need = manifest.files.reduce((sum, file) => sum + BigInt(file.bytes), 0n);
    if (disk.bavail * disk.bsize < MIN_DISK_BYTES + need * 2n) refuse('Keep at least 8 GiB free after staging and importing evidence.');
    scratch = await fs.mkdtemp(path.join(root, '.import-'));
    const sql = path.join(scratch, 'load.sql');
    const output = await fs.open(sql, 'wx', 0o600);
    try {
      const migrations = frozenMigrationsSql();
      await output.writeFile(preflightSql(target, migrations, [...SHADOW_EVIDENCE_TABLES, ...EXTRA_EMPTY]));
      for (const file of manifest.files) if (file.name !== 'settings') await stageTable(bundle, file, target.workspaceId, output, signal);
      await output.writeFile(transferSql(manifest, settings, sha256(manifestBytes)));
    } finally { await output.close(); }
    const outcome = await applySql(tools.psql, target, sql, signal);
    if (!['shadow-imported', 'shadow-reused'].includes(outcome)) refuse('The target did not confirm the import.');
    return { workspaceId: target.workspaceId, imported: outcome === 'shadow-imported',
      rows: Object.fromEntries(manifest.files.map(file => [file.name, file.rows])) };
  } finally {
    try { if (scratch) await fs.rm(scratch, { recursive: true }); }
    finally {
      const owned = await held.stat();
      await held.close();
      const present = await fs.lstat(lock).catch(() => null);
      if (present?.dev === owned.dev && present.ino === owned.ino) await fs.unlink(lock);
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop).on('SIGTERM', stop);
  try {
    if (args.length !== 4 || args[0] !== '--bundle' || args[2] !== '--target') {
      refuse('Use --bundle <private evidence bundle> --target <prepared shadow folder>.');
    }
    process.stdout.write(JSON.stringify(await importShadowEvidence({ bundle: args[1], target: args[3], signal: controller.signal }), null, 2) + '\n');
    return 0;
  } catch (error) {
    const message = controller.signal.aborted ? 'The import was interrupted. Re-run it to verify the target.'
      : (error instanceof ImportRefused || error instanceof ShadowTargetRefused) ? error.message : 'The evidence bundle or private target is unavailable.';
    process.stderr.write(JSON.stringify({ refusals: [message] }) + '\n');
    return 1;
  } finally { process.off('SIGINT', stop).off('SIGTERM', stop); }
}
if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
