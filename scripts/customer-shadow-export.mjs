#!/usr/bin/env node
// Preview or export selected workspace evidence from a private offline PostgreSQL backup.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invokedDirectly } from './invoked-directly.mjs';
import { POSTGRES_DUMP_FILE } from './postgres-backup.mjs';
import { findPsql } from './postgres-tools.mjs';
import { projectShadowJourneys } from './customer-shadow-journeys.mjs';

export const SHADOW_EVIDENCE_FORMAT = 'noticeos-shadow-evidence-v1';
export const SHADOW_RUN_REFERENCE = 'offline-shadow';
export const SHADOW_RUN_ERROR = 'Original provider detail omitted';
export const SHADOW_EVIDENCE_TABLES = Object.freeze([
  'assets', 'pulses', 'asset_insight_snapshots', 'flags', 'annotations', 'counter_readings',
  'measurement_series', 'signal_runs', 'signal_observations', 'revenue_observations', 'ledger_entries', 'task_daily_counts',
]);
const SELECTED = ['workspaces', 'config_documents', 'config_changes', 'archive_objects', ...SHADOW_EVIDENCE_TABLES];
const REQUIRED = ['workspaces', 'assets', 'pulses', 'asset_insight_snapshots'];
const EVIDENCE_COLUMNS = Object.fromEntries(Object.entries({
  workspaces: 'workspace_id slug display_name created_at status',
  config_documents: 'workspace_id document_key body version updated_at updated_by',
  config_changes: 'workspace_id change_id change_number document_key ops reason actor version_before version_after changed_at',
  archive_objects: 'workspace_id object_seq object_key content_sha256 object_bytes first_stored_at',
  assets: 'workspace_id asset_id domain display_name status sense_only is_os list_position created_at updated_at',
  pulses: 'workspace_id pulse_id pulse_number asset_id pulse_date revision generated_at received_at capabilities envelope',
  asset_insight_snapshots: 'workspace_id snapshot_id asset_id generated_at window_start window_end source_archive_count content_sha256 payload created_at',
  flags: 'workspace_id flag_id flag_number asset_id pulse_id fired_at severity kind metric message rule_id rule_inputs disposition disposition_at disposition_note snooze_until ack_expiry hypothesis_ref incident_ref resolved_at replaced_by_pulse_id',
  annotations: 'workspace_id annotation_id annotation_number asset_id at kind ref note created_at',
  counter_readings: 'workspace_id asset_id metric value observed_at',
  measurement_series: 'workspace_id series_id asset_id integration property_ref time_zone metric',
  signal_runs: 'workspace_id run_seq run_id asset_id integration credential_ref property_ref time_zone started_at finished_at status window_start window_end data_state provisional_from provider_rows observation_count error_code error_message',
  signal_observations: 'workspace_id observation_id run_seq series_id observed_date value',
  revenue_observations: 'workspace_id observation_id observation_number asset_id source account_ref revenue_date item_ref amount_minor currency run_ref recorded_at sales_minor refunds_minor fees_minor payment_count refund_count occurred_at covered_from covered_until',
  ledger_entries: 'workspace_id entry_id entry_number kind asset_id period_month family amount_minor currency source ref booking_state supersedes_id note recorded_at external_id coverage_start coverage_end coverage_complete predicted_monthly_value_minor predicted_success_chance predicted_cost_minor predicted_days_to_signal',
  task_daily_counts: 'workspace_id project day captured_at waiting urgent open in_progress blocked closed_ids',
}).map(([table, columns]) => [table, new Set(columns.split(' '))]));
const WORKSPACE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const COPY_HEADER = /^COPY noticeos\.([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) FROM stdin;$/u;
const MIN_DISK_BYTES = 8 * 1024 ** 3;
const DISK_CHECK_INTERVAL = 32 * 1024 ** 2;
const MAX_LINE = 32 * 1024 ** 2;
export const SHADOW_SETTINGS_MAX_BYTES = 32 * 1024 ** 2;
const TIMEOUT_MS = 15 * 60_000;
const digest = text => createHash('sha256').update(text).digest('hex');

class ExportRefused extends Error {}
const refuse = message => { throw new ExportRefused(message); };

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/u.test(value)) refuse(`${label} must be an absolute local path.`);
  return path.resolve(value);
}
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function privateDump(source, expected) {
  if (await fs.realpath(source) !== source) refuse('Choose the actual dump file, without symlinks.');
  const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || (expected && !sameFile(stat, expected))) {
      refuse('The backup must be an unchanged, owner-only regular file.');
    }
    const magic = Buffer.alloc(5);
    if ((await handle.read(magic, 0, magic.length, 0)).bytesRead !== magic.length || magic.toString() !== 'PGDMP') {
      refuse('Choose a PostgreSQL custom-format backup file.');
    }
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

function restoreTool() {
  const tools = findPsql();
  if (tools?.major !== 18) refuse('Put PostgreSQL 18 client tools on PATH.');
  const binary = path.join(path.dirname(tools.psql), 'pg_restore');
  const env = { PATH: '/usr/bin:/bin', TZ: 'UTC', LC_ALL: 'C' };
  try {
    if (!/^pg_restore \(PostgreSQL\) 18\b/u.test(execFileSync(binary, ['--version'], {
      encoding: 'utf8', env, maxBuffer: 4096, timeout: 5000,
    }))) refuse('Put PostgreSQL 18 client tools on PATH.');
  } catch { refuse('Put PostgreSQL 18 client tools on PATH.'); }
  return { binary, env };
}

/** The only subprocess output is a private text stream. No database target is
 * passed to pg_restore, and its output never becomes an executable SQL script. */
async function restoreText(tool, handle, args, onLine, signal) {
  const child = spawn(tool.binary, args, { env: tool.env, stdio: [handle.fd, 'pipe', 'ignore'] });
  let closed = false;
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('close', code => { closed = true; resolve(code === 0); });
  });
  const stop = () => { if (!closed) child.kill('SIGKILL'); };
  const timer = setTimeout(stop, TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    signal?.throwIfAborted();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n', start)) {
        if (end - start > MAX_LINE) refuse('A backup row exceeds the supported size.');
        await onLine(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
      if (pending.length > MAX_LINE) refuse('A backup row exceeds the supported size.');
    }
    pending += decoder.decode();
    if (pending) await onLine(pending);
    if (!await exited) refuse('PostgreSQL could not read the offline backup.');
    signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stop();
    await exited;
  }
}

const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
/** pg_restore emits PostgreSQL COPY text with literal UTF-8 and these escapes. */
function copyField(value) {
  if (value === '\\N') return null;
  return value.replace(/\\([\s\S]|$)/gu, (_match, escaped) => {
    if (!Object.hasOwn(escapes, escaped)) refuse('The backup contains an unsupported COPY field.');
    return escapes[escaped];
  });
}

function jsonRecord(text) {
  if (typeof text !== 'string') return null;
  const value = JSON.parse(text);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const SETTINGS = {
  os_time_zone: value => typeof value === 'string' && value.length <= 80 && (() => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  })(),
  operator_rate_usd_per_min: value => typeof value === 'number' && Number.isFinite(value) && value >= 0,
};

export function validShadowSetting(field, value) {
  return Object.hasOwn(SETTINGS, field) && SETTINGS[field](value);
}

export function validShadowColumns(name, columns) {
  return Object.hasOwn(EVIDENCE_COLUMNS, name) && Array.isArray(columns)
    && columns.includes('workspace_id') && columns.every(column => EVIDENCE_COLUMNS[name].has(column))
    && (name !== 'signal_runs' || ['credential_ref', 'error_message', 'status'].every(column => columns.includes(column)))
    && (name !== 'task_daily_counts' || columns.includes('closed_ids'))
    && new Set(columns).size === columns.length;
}

function allowedAudit(row) {
  if (row.document_key !== 'constants') return null;
  const ops = JSON.parse(row.ops ?? 'null');
  if (!Array.isArray(ops) || !ops.length || ops.length > 32) return null;
  const captured = [];
  for (const op of ops) {
    const field = typeof op?.pointer === 'string' ? op.pointer.slice(1) : '';
    if (op?.kind !== 'file-json-set' || op.file !== 'config/constants.json' || op.pointer !== `/${field}`
      || !validShadowSetting(field, op.value)
      || (op.expect !== undefined && op.expect !== null && !validShadowSetting(field, op.expect))) return null;
    captured.push({ kind: op.kind, file: op.file, pointer: op.pointer, value: op.value,
      ...(op.expect === undefined ? {} : { expect: op.expect }) });
  }
  return { documentKey: row.document_key, versionBefore: row.version_before, versionAfter: row.version_after,
    changedAt: row.changed_at, actor: row.actor, reason: row.reason, ops: captured };
}

async function freeSpace(directory, reserveBytes = 0) {
  const stat = await fs.statfs(directory, { bigint: true });
  if (stat.bavail * stat.bsize < BigInt(MIN_DISK_BYTES + reserveBytes)) refuse('Keep at least 8 GiB free while writing the shadow bundle.');
}

async function tableFile(root, name, columns) {
  const file = `tables/${name}.jsonl`;
  const handle = root === null ? null : await fs.open(path.join(root, file), 'wx', 0o600);
  const hash = createHash('sha256');
  let rows = 0, bytes = 0, sinceCheck = 0;
  return {
    async write(row) {
      const data = Buffer.from(JSON.stringify(row) + '\n');
      rows++;
      bytes += data.length;
      sinceCheck += data.length;
      hash.update(data);
      if (handle && sinceCheck >= DISK_CHECK_INTERVAL) {
        await freeSpace(root, data.length + DISK_CHECK_INTERVAL);
        sinceCheck = 0;
      }
      if (handle) await handle.writeFile(data);
    },
    async close() { await handle?.close(); },
    result: () => ({ name, path: file, columns, rows, bytes, sha256: hash.digest('hex') }),
  };
}

/** Export only explicitly recognized product tables. PostgreSQL scalar values
 * stay as original text so readers cannot round money or reserialize reports. */
async function readEvidence({ tool, handle, root, workspaceId, snapshotAt, sourceBytes, signal }) {
  const files = new Map();
  const seen = new Set(), knownWorkspaces = new Set(), recordWorkspaces = new Set();
  const assets = new Set(), assetReferences = new Set();
  const settings = { values: {}, document: null, audit: [] };
  const journeyDocuments = new Map();
  const omitted = { credentialAndIdentityState: true, jobState: true, providerDiagnostics: true, closedTaskIdentifiers: true, rawArchiveObjects: 0,
    legacyArchiveObjects: 0, unlistedSettings: 0, unlistedAudit: 0, unavailableTables: [] };
  let active = null;
  try {
    await restoreText(tool, handle, ['--format=custom', '--data-only', '--file=-', '--no-owner', '--no-acl',
      '--schema=noticeos', ...SELECTED.map(table => `--table=${table}`)], async line => {
      if (active === null) {
        const match = COPY_HEADER.exec(line);
        if (!match) {
          if (line.startsWith('COPY ')) refuse('The backup contains an unsupported COPY layout.');
          return;
        }
        const [, name, list] = match, columns = list.split(', ');
        if (!SELECTED.includes(name) || seen.has(name) || !validShadowColumns(name, columns)) {
          refuse('The backup contains an unexpected table or column.');
        }
        seen.add(name);
        const file = SHADOW_EVIDENCE_TABLES.includes(name) ? await tableFile(root, name, columns) : null;
        if (file) files.set(name, file);
        active = { name, columns, file };
        return;
      }
      if (line === '\\.') { active = null; return; }
      const { name, columns, file } = active;
      const values = line.split('\t');
      if (values.length !== columns.length) refuse('The backup has a malformed COPY row.');
      const owner = copyField(values[columns.indexOf('workspace_id')]);
      if (typeof owner !== 'string' || !WORKSPACE.test(owner)) refuse('The backup contains an invalid workspace identifier.');
      recordWorkspaces.add(owner);
      if (recordWorkspaces.size > 10_000) refuse('The backup contains too many workspace identifiers.');
      if (name === 'workspaces') {
        if (knownWorkspaces.has(owner)) refuse('The backup contains duplicate workspaces.');
        knownWorkspaces.add(owner);
      }
      if (owner !== workspaceId || name === 'workspaces') return;
      const row = Object.fromEntries(columns.map((column, index) => [column, copyField(values[index])]));
      if (name === 'config_documents') {
        if (['value-events', 'integrations'].includes(row.document_key)) {
          if (journeyDocuments.has(row.document_key)) refuse('The backup contains duplicate journey settings.');
          const body = row.document_key === 'integrations' ? JSON.parse(row.body) : jsonRecord(row.body);
          if (row.document_key === 'value-events' && body === null) refuse('The backup has invalid journey settings.');
          journeyDocuments.set(row.document_key, body);
        }
        if (row.document_key !== 'constants') { omitted.unlistedSettings++; return; }
        if (settings.document !== null || !/^[1-9][0-9]*$/u.test(row.version ?? '')) refuse('The backup contains invalid workspace settings metadata.');
        const body = jsonRecord(row.body);
        if (body === null) refuse('The backup has invalid workspace settings.');
        for (const [field, value] of Object.entries(body)) {
          if (validShadowSetting(field, value)) settings.values[field] = value;
          else omitted.unlistedSettings++;
        }
        settings.document = { key: 'constants', version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
        return;
      }
      if (name === 'config_changes') {
        const entry = allowedAudit(row);
        if (entry === null) omitted.unlistedAudit++;
        else settings.audit.push(entry);
        return;
      }
      if (name === 'archive_objects') {
        omitted.rawArchiveObjects++;
        if (!row.object_key?.startsWith(`workspaces/${workspaceId}/raw/`)) omitted.legacyArchiveObjects++;
        return;
      }
      if (name === 'assets') {
        if (!row.asset_id || assets.has(row.asset_id)) refuse('The backup contains an invalid or duplicate asset.');
        assets.add(row.asset_id);
      } else if (row.asset_id) assetReferences.add(row.asset_id);
      if (name === 'asset_insight_snapshots' && (typeof row.payload !== 'string' || digest(row.payload) !== row.content_sha256)) {
        refuse('An asset report does not match its recorded content hash.');
      }
      if (name === 'signal_runs') {
        row.credential_ref = SHADOW_RUN_REFERENCE;
        row.error_message = row.status === 'error' ? SHADOW_RUN_ERROR : null;
      }
      if (name === 'task_daily_counts') row.closed_ids = null;
      await file.write(row);
    }, signal);
    if (active !== null || REQUIRED.some(name => !seen.has(name))) refuse('The backup does not contain the required NoticeOS evidence tables.');
    if (!knownWorkspaces.has(workspaceId) || [...recordWorkspaces].some(id => !knownWorkspaces.has(id))) {
      refuse('The selected workspace or evidence ownership is missing from the backup.');
    }
    if ([...assetReferences].some(asset => !assets.has(asset))) refuse('The backup contains evidence without its owning asset.');
    settings.journeys = projectShadowJourneys(journeyDocuments.get('value-events'), journeyDocuments.get('integrations'), assets);
    omitted.unavailableTables = SHADOW_EVIDENCE_TABLES.filter(name => !seen.has(name));
    const settingsText = JSON.stringify(settings, null, 2) + '\n';
    const settingsBytes = Buffer.byteLength(settingsText);
    if (settingsBytes > SHADOW_SETTINGS_MAX_BYTES) refuse('The saved workspace settings exceed the supported bundle size.');
    if (root !== null) {
      await freeSpace(root, settingsBytes);
      await fs.writeFile(path.join(root, 'settings.json'), settingsText, { mode: 0o600, flag: 'wx' });
    }
    return { format: SHADOW_EVIDENCE_FORMAT, workspaceId, snapshotAt, snapshotTimeZone: null, sourceBytes, encoding: 'postgres-copy-text-jsonl',
      files: [...files.values()].map(file => file.result()).concat({
        name: 'settings', path: 'settings.json', rows: settings.audit.length, bytes: settingsBytes, sha256: digest(settingsText),
      }), omitted, refusals: [] };
  } finally { await Promise.all([...files.values()].map(file => file.close())); }
}

async function onlyWorkspace(tool, source, stat, signal) {
  const { handle } = await privateDump(source, stat);
  let workspaceId = null, columns = null, found = false;
  try {
    await restoreText(tool, handle, ['--format=custom', '--data-only', '--file=-', '--no-owner', '--no-acl',
      '--schema=noticeos', '--table=workspaces'], line => {
      if (columns === null) {
        const match = COPY_HEADER.exec(line);
        if (!match) return;
        columns = match[2].split(', ');
        if (found || match[1] !== 'workspaces' || !validShadowColumns('workspaces', columns)) refuse('The backup has an invalid workspace inventory.');
        found = true;
        return;
      }
      if (line === '\\.') { columns = null; return; }
      const values = line.split('\t');
      const id = values[columns.indexOf('workspace_id')];
      if (values.length !== columns.length || !WORKSPACE.test(id ?? '')) refuse('The backup has an invalid workspace inventory.');
      if (workspaceId !== null) refuse('The backup contains several workspaces. Choose one by its UUID.');
      workspaceId = id;
    }, signal);
    if (columns !== null || workspaceId === null) refuse('The backup does not contain a workspace.');
    return workspaceId;
  } finally { await handle.close(); }
}

export async function exportShadowEvidence({ dump, workspaceId = null, selectOnlyWorkspace = false, output = null, signal }) {
  if (!selectOnlyWorkspace && (typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId))) refuse('Choose the workspace by its UUID.');
  if (selectOnlyWorkspace && workspaceId !== null) refuse('Choose one workspace selection method.');
  const source = absolute(dump, 'The backup');
  const root = output === null ? null : absolute(output, 'The output');
  let ownedRoot, manifestWritten = false;
  const tool = restoreTool();
  const inventory = await privateDump(source);
  try {
    let snapshotAt = null;
    try {
      await restoreText(tool, inventory.handle, ['--format=custom', '--list'], line => {
        const time = /^;\s+Archive created at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/u.exec(line);
        if (time) {
          // The archive records pg_dump's local clock without its time zone.
          const local = `${time[1]}T${time[2]}`, validation = local + '.000Z';
          if (Number.isFinite(Date.parse(validation)) && new Date(validation).toISOString() === validation) snapshotAt = local;
        }
      }, signal);
    } finally { await inventory.handle.close(); }
    if (snapshotAt === null) refuse('The backup does not contain a valid snapshot creation time.');
    if (selectOnlyWorkspace) workspaceId = await onlyWorkspace(tool, source, inventory.stat, signal);
    signal?.throwIfAborted();
    if (root !== null) {
      if (await fs.realpath(path.dirname(root)) !== path.dirname(root)) refuse('Choose an output parent without symlinks.');
      await freeSpace(path.dirname(root), DISK_CHECK_INTERVAL);
      await fs.mkdir(root, { mode: 0o700 });
      ownedRoot = await fs.lstat(root);
      await fs.mkdir(path.join(root, 'tables'), { mode: 0o700 });
    }
    const input = await privateDump(source, inventory.stat);
    try {
      const manifest = await readEvidence({ tool, handle: input.handle, root, workspaceId, snapshotAt, sourceBytes: inventory.stat.size, signal });
      if (!sameFile(await input.handle.stat(), inventory.stat)) refuse('The backup changed while it was being read.');
      if (root !== null) await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      manifestWritten = true;
      return manifest;
    } finally { await input.handle.close(); }
  } finally {
    if (!manifestWritten && ownedRoot) {
      const current = await fs.lstat(root).catch(() => null);
      if (current?.isDirectory() && current.dev === ownedRoot.dev && current.ino === ownedRoot.ino) await fs.rm(root, { recursive: true });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop).on('SIGTERM', stop);
  try {
    const args = new Map();
    for (let i = 0; i < argv.length;) {
      const key = argv[i], value = argv[i + 1];
      if (key === '--only-workspace' && !args.has(key)) { args.set(key, true); i++; continue; }
      if (!['--dump', '--backup-dir', '--workspace', '--out'].includes(key) || !value || args.has(key)) {
        refuse('Use --dump <file> or --backup-dir <folder>, then --workspace <UUID> or --only-workspace, and optionally --out <new-folder>.');
      }
      args.set(key, value);
      i += 2;
    }
    if (args.has('--dump') === args.has('--backup-dir') || args.has('--workspace') === args.has('--only-workspace')) {
      refuse('Use --dump <file> or --backup-dir <folder>, plus --workspace <UUID> or --only-workspace.');
    }
    const dump = args.get('--dump') ?? path.join(absolute(args.get('--backup-dir'), 'The backup folder'), POSTGRES_DUMP_FILE);
    const manifest = await exportShadowEvidence({ dump, workspaceId: args.get('--workspace') ?? null,
      selectOnlyWorkspace: args.has('--only-workspace'), output: args.get('--out') ?? null, signal: controller.signal });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return 0;
  } catch (error) {
    const message = controller.signal.aborted ? 'The export was interrupted.' : error instanceof ExportRefused ? error.message : error?.code === 'EEXIST'
      ? 'The output folder already exists. Choose a new folder.' : 'The private backup or output folder could not be read.';
    process.stderr.write(JSON.stringify({ format: SHADOW_EVIDENCE_FORMAT, refusals: [message] }) + '\n');
    return 1;
  } finally { process.off('SIGINT', stop).off('SIGTERM', stop); }
}

if (invokedDirectly(process.argv[1], import.meta.url)) process.exitCode = await main();
