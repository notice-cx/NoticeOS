#!/usr/bin/env node
// The provider history as analytical files.
//
// One site's downloaded provider archive — a folder `signals:download` or
// `signals:refresh` wrote — published as Parquet datasets that DuckDB reads:
// one dataset per report family, holding exactly the rows the analyzer reports
// for that family, each row carrying where it came from. A run writes only what
// changed, and a reader only ever sees a complete generation.
//
//   pnpm signals:history -- --asset example.com --in <downloads folder> --out <history folder>
//
// THE FOLDER IT WRITES (only ever under --out; --in is read, never changed)
//
//   generations/00000007.json      one complete generation: every dataset, its
//                                  schema and the files that hold its rows
//   data/<dataset>/<period>/<fingerprint>.parquet
//                                  a file is never rewritten; a later
//                                  generation names a new file instead
//   .lock                          held while a run writes or removes
//   .spill-<pid>/                  DuckDB scratch; reclaimed when its process is gone
//
// A generation's files are written first and its manifest last, by an
// exclusive link, so the highest-numbered manifest names only files that are
// complete. An interrupted run leaves at most files no manifest names. One run
// at a time holds the history's lock; a second is refused and changes nothing,
// and a manifest is never published over another. To publish to an object
// store, copy the data files first and the manifest last.
//
// How long a generation is kept
//
// After it publishes, or finds nothing changed, a run keeps every generation
// published in the last KEEP_GENERATIONS_DAYS days and the newest, and removes
// the rest: first their manifests, oldest first, so no reader can pin one; then
// every data file no kept manifest names, and the half-written files of a run
// that died. Retention touches only data/ and generations/ and never removes
// a file a kept generation names. Before publication, the lock holder also
// reclaims .spill-<pid> directories whose process is gone. An interruption leaves
// every listed generation readable; the next run finishes the removal. A report
// that asks for a generation no longer kept is refused, naming it and the rule
// (scripts/signal-history-analyze.mjs).
//
// What a dataset holds
//
// Rows come from scripts/signal-archive.mjs and nowhere else: `parseArchive`,
// `archiveRows` with the downloads manifest's confirmations, `resolveFamily`,
// `indexCoverageRows`. Archives are found in the analyzer's reading order
// (scripts/signal-downloads.mjs). One reading rule is the writer's own, from the
// archive rules' contract: of two archives for one report day — one
// (integration, report, report date) — the one read last is kept and the other
// is recorded as superseded. The downloads layout never holds two.
//
// Each row adds six lineage columns: `source_family`, `source_path` (the
// archive's path under --in), `source_sha256` (of the bytes read),
// `source_object_key` (the raw-archive object the downloads manifest names for
// that report day, or null), `schema_id` and `derivation_id`. Its report day is
// its own `report_date`.
//
// Values keep their type: numbers are DOUBLE, true/false BOOLEAN, text VARCHAR.
// A column whose rows hold more than one type is VARCHAR, each value written as
// the analyzer's CSV writes it. An empty value — unknown, never zero — is NULL.
// So every cell reads back as the analyzer's CSV cell, NULL as empty.
//
// The analyzer's order: a family whose revisions reach across report days
// (`resolvesAcrossReportDays`) and index coverage are one file each, in file
// order; every other family is ORDER BY report_date, then row within its file,
// because a report day's rows all sit in one file. The manifest says which.
//
// The register of sources
//
// Every archive the run found — read, superseded or unreadable — and every
// report day the downloads manifest names without an archive (missing) is a row
// of the generation's `sources` register, a Parquet dataset of its own: path,
// hash, state, report day, rows and columns. A row that cannot be read is listed
// with its reason and adds no rows: its report day is unknown, never empty.
//
// So that the analysis read from these files (scripts/signal-history-analyze.mjs)
// can name its sources exactly as the analyzer's summary does, a readable
// archive's row also keeps `envelope` — its own
// `reportDate`, `providerRows` and `providerTruncated`, as JSON, as the archive
// states them — and the manifest names the downloads folder it read
// (`downloadsFolder`, relative to the repository, as the analyzer's summary
// names it). A run that finds the same content in a moved folder publishes a
// generation naming the new folder.
//
// Incremental, and the same as a rebuild
//
// A dataset is split into periods of report dates: a calendar month. A period
// is rewritten only when one of its archives' bytes, its downloads-manifest
// confirmation or object key changed, or the family's schema changed; every
// other file is carried into the new generation as it is. A later confirmation
// that settles a provisional GA4 day therefore rewrites that day's period. A
// run that changes nothing writes nothing. A file's name is a hash of exactly
// the rows it holds, so an incremental run and a rebuild of the same archive
// name the same files, and the manifest's `content` hash is equal.
//
// A family's schema is its columns and their types; `schema_id` is their hash,
// so a new column or a changed type is a new schema id, and every file of the
// family in that generation is rewritten under it. `derivation_id` hashes the
// files that decide what a row is (DERIVATION_FILES) and the period, so a
// changed rule rebuilds everything, and an old generation names the code that
// produced it.
//
// Nothing here schedules itself or reads the running OS.
//
// How a generation is written, published, locked and kept is shared with every
// writer of a history folder: scripts/history-files.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  HISTORY_FORMAT,
  KEEP_GENERATIONS_DAYS,
  LOCK,
  RETENTION,
  contentOf,
  copyToParquet,
  datasetFiles,
  derivationFrom,
  generationFile,
  holdLock,
  keptGenerations,
  listGenerations,
  pruneHistory,
  publishManifest,
  readCurrentGeneration,
  readGeneration,
  schemaOf,
  sha256,
  sqlString,
  writePeriod,
} from './history-files.mjs';
import {
  INDEX_COVERAGE_FAMILY,
  INDEX_COVERAGE_SOURCES,
  PROVENANCE_COLUMNS,
  archiveFamily,
  archiveRows,
  compareReportDates,
  indexCoverageRows,
  manifestConfirmations,
  parseArchive,
  reportDayKey,
  resolveFamily,
  resolvesAcrossReportDays,
} from './signal-archive.mjs';
import { DOWNLOADS_MANIFEST, archiveFiles, readDownloadsManifest } from './signal-downloads.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export {
  HISTORY_FORMAT,
  KEEP_GENERATIONS_DAYS,
  RETENTION,
  copyToParquet,
  datasetFiles,
  holdLock,
  keptGenerations,
  listGenerations,
  readCurrentGeneration,
  readGeneration,
};

/** The files whose text decides what a published row is. A change to any of
 * them is a new derivation, and the next run rebuilds every dataset. */
export const DERIVATION_FILES = [
  'scripts/signal-archive.mjs',
  'packages/contract/src/posthog-families.mjs',
  'scripts/signal-downloads.mjs',
  'scripts/signal-history.mjs',
  'scripts/history-files.mjs',
];

/** The columns every published row gains, after the family's own. */
export const LINEAGE_COLUMNS = [
  'source_family',
  'source_path',
  'source_sha256',
  'source_object_key',
  'schema_id',
  'derivation_id',
];

/** How report dates are grouped into files. */
export const PARTITIONS = {
  day: (reportDate) => reportDate,
  month: (reportDate) => reportDate.slice(0, 7),
  year: (reportDate) => reportDate.slice(0, 4),
};
export const DEFAULT_PARTITION = 'month';

/** The one file of a dataset resolved whole. */
const WHOLE = 'all';
/** The period of a report date that is not a YYYY-MM-DD day. */
const UNDATED = 'undated';
/** The register's period for an archive that could not be read. */
const UNREADABLE = 'unreadable';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One row of the sources register, in column order. */
const SOURCE_COLUMNS = [
  ['path', 'VARCHAR'],
  ['state', 'VARCHAR'],
  ['family', 'VARCHAR'],
  ['integration', 'VARCHAR'],
  ['report', 'VARCHAR'],
  ['report_date', 'VARCHAR'],
  ['sha256', 'VARCHAR'],
  ['bytes', 'DOUBLE'],
  ['object_key', 'VARCHAR'],
  ['confirmed_at', 'VARCHAR'],
  ['fingerprint', 'VARCHAR'],
  ['rows', 'DOUBLE'],
  ['columns', 'VARCHAR'],
  ['envelope', 'VARCHAR'],
  ['reason', 'VARCHAR'],
  ['superseded_by', 'VARCHAR'],
  ['schema_id', 'VARCHAR'],
  ['derivation_id', 'VARCHAR'],
];
const SOURCES_SCHEMA = schemaOf(SOURCE_COLUMNS);

function posixPath(relative) {
  return relative.split(path.sep).join('/');
}

function periodOf(reportDate, partitionBy) {
  return ISO_DAY.test(reportDate) ? PARTITIONS[partitionBy](reportDate) : UNDATED;
}

/** The type one value is written as; null for an empty value. */
function valueType(value) {
  if (value === '' || value === undefined || value === null) return null;
  if (typeof value === 'number') return 'DOUBLE';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}

/** Two observations of one column's type: equal stays, different is text.
 * `NULL` is a column seen only empty. */
function mergeType(held, type) {
  if (held === undefined || held === 'NULL') return type ?? 'NULL';
  if (type === null || type === 'NULL' || type === held) return held;
  return 'VARCHAR';
}

/** Every column the rows carry and the type its values are, keys sorted. */
function observeColumns(rows) {
  const seen = new Map();
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) seen.set(column, mergeType(seen.get(column), valueType(value)));
  }
  return Object.fromEntries([...seen].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * A family's schema from its sources' observed columns: provenance first, the
 * rest sorted — the analyzer's CSV header — then lineage. A column seen only
 * empty is VARCHAR.
 */
function familySchema(name, observations) {
  const merged = new Map();
  for (const columns of observations) {
    for (const [column, type] of Object.entries(columns)) merged.set(column, mergeType(merged.get(column), type));
  }
  const reserved = LINEAGE_COLUMNS.filter((column) => merged.has(column));
  if (reserved.length > 0) {
    throw new Error(`${name} rows carry ${reserved.join(', ')}, which the writer reserves for lineage; the family cannot be published.`);
  }
  const rest = [...merged.keys()].filter((column) => !PROVENANCE_COLUMNS.includes(column)).sort();
  const type = (column) => {
    const held = merged.get(column);
    return held === undefined || held === 'NULL' ? 'VARCHAR' : held;
  };
  return schemaOf([
    ...[...PROVENANCE_COLUMNS, ...rest].map((column) => [column, type(column)]),
    ...LINEAGE_COLUMNS.map((column) => [column, 'VARCHAR']),
  ]);
}

/** One value as its column stores it. */
function encode(value, type) {
  if (value === '' || value === undefined || value === null) return null;
  if (type === 'VARCHAR') return String(value);
  if (typeof value !== (type === 'DOUBLE' ? 'number' : 'boolean')) {
    throw new Error(`A ${typeof value} reached a ${type} column; the family's schema is out of date.`);
  }
  return value;
}

/**
 * How an archive row is written: it gains its schema and derivation ids, and
 * each value is encoded under its column's type; it is dated by its report day,
 * in the archive rules' order.
 */
function archiveRow(schema, derivation) {
  return {
    encode(row) {
      row.schema_id = schema.id;
      row.derivation_id = derivation.id;
      return schema.columns.map(([name, type]) => encode(row[name], type));
    },
    dayOf: (row) => String(row.report_date ?? ''),
    compareDays: compareReportDates,
  };
}

/** The files that decide what a row is, hashed: the derivation id. */
export async function derivationOf(partitionBy = DEFAULT_PARTITION) {
  return derivationFrom(DERIVATION_FILES, { partitionBy });
}

/** The downloads manifest's say about each report day: when it was last
 * confirmed (the archive rules' own reading) and which object it names. */
async function readDownloads(input) {
  const manifest = await readDownloadsManifest(input);
  let state = 'read';
  if (manifest === null) {
    state = await fs.access(path.join(input, DOWNLOADS_MANIFEST)).then(() => 'unreadable', () => 'absent');
  }
  const days = new Map();
  const objects = manifest !== null && typeof manifest === 'object' && Array.isArray(manifest.objects) ? manifest.objects : [];
  for (const row of objects) {
    if (!row || typeof row !== 'object') continue;
    const { integration, report, reportDate } = row;
    if (typeof integration !== 'string' || typeof report !== 'string' || typeof reportDate !== 'string') continue;
    days.set(reportDayKey(row), {
      integration,
      report,
      reportDate,
      objectKey: typeof row.objectKey === 'string' ? row.objectKey : null,
    });
  }
  return { state, confirmations: manifestConfirmations(manifest), days };
}

/** The envelope fields the analyzer's summary quotes, as the archive states
 * them: JSON, so a missing field stays missing and a value keeps its type. */
function envelopeOf(archive) {
  return JSON.stringify({
    reportDate: archive.reportDate,
    ...(archive.integration === 'clarity' ? { collectedAt: archive.collectedAt } : {}),
    providerRows: archive.providerRows,
    providerTruncated: archive.providerTruncated,
  });
}

/** One archive checked by the rules; `counts.read` counts every archive read. */
function checkedArchive(bytes, asset, source, counts) {
  counts.read += 1;
  try {
    return { archive: parseArchive(bytes.toString('utf8'), { asset, source }) };
  } catch (error) {
    return { reason: error instanceof SyntaxError ? 'not JSON' : error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every archive under `input`, hashed, identified and — when its fingerprint
 * is new — read once for its row count and columns. The previous register
 * answers for an archive whose bytes and confirmation did not change.
 */
async function scanArchives({ asset, input, downloads, previous, counts }) {
  const records = [];
  for (const file of await archiveFiles(input)) {
    const relative = posixPath(path.relative(input, file));
    const bytes = await fs.readFile(file);
    const hash = sha256(bytes);
    const prior = previous.get(relative);
    const known = prior?.sha256 === hash ? prior : null;
    let archive = null;
    let identity;
    if (known) {
      identity = known.state === 'unreadable'
        ? { reason: known.reason }
        : { integration: known.integration, report: known.report, reportDate: known.report_date };
    } else {
      const checked = checkedArchive(bytes, asset, relative, counts);
      archive = checked.archive ?? null;
      identity = archive
        ? { integration: archive.integration, report: archive.report, reportDate: archive.reportDate }
        : { reason: checked.reason };
    }
    const base = { path: relative, sha256: hash, bytes: bytes.length };
    if (identity.reason !== undefined) {
      records.push({ ...base, state: 'unreadable', reason: identity.reason });
      continue;
    }
    const key = reportDayKey(identity);
    const confirmedAt = downloads.confirmations.get(key) ?? null;
    const objectKey = downloads.days.get(key)?.objectKey ?? null;
    const fingerprint = sha256(JSON.stringify([relative, hash, confirmedAt, objectKey]));
    let rows;
    let columns;
    if (known && known.state !== 'unreadable' && known.fingerprint === fingerprint) {
      rows = known.rows;
      columns = JSON.parse(known.columns);
    } else {
      archive ??= checkedArchive(bytes, asset, relative, counts).archive;
      const read = archiveRows(archive, downloads.confirmations);
      rows = read.length;
      columns = observeColumns(read);
    }
    // The same bytes state the same envelope.
    const envelope = archive ? envelopeOf(archive) : known.envelope;
    records.push({
      ...base,
      state: 'read',
      integration: identity.integration,
      report: identity.report,
      reportDate: identity.reportDate,
      family: archiveFamily(identity),
      key,
      confirmedAt,
      objectKey,
      fingerprint,
      rows,
      columns,
      envelope,
    });
  }
  // Of two archives for one report day, the one read last is kept.
  const kept = new Map();
  for (const record of records) if (record.state === 'read') kept.set(record.key, record);
  for (const record of records) {
    if (record.state === 'read' && kept.get(record.key) !== record) {
      record.state = 'superseded';
      record.supersededBy = kept.get(record.key).path;
    }
  }
  const missing = [...downloads.days]
    .filter(([key]) => !kept.has(key))
    .map(([key, day]) => ({
      state: 'missing',
      key,
      integration: day.integration,
      report: day.report,
      reportDate: day.reportDate,
      family: archiveFamily(day),
      objectKey: day.objectKey,
      confirmedAt: downloads.confirmations.get(key) ?? null,
    }));
  return { records, missing };
}

/** One source archive's rows, read again and checked against the scan. */
async function sourceRows(record, { input, asset, confirmations, counts }) {
  const bytes = await fs.readFile(path.join(input, record.path));
  if (sha256(bytes) !== record.sha256) {
    throw new Error(`${record.path} changed while this run read it. Nothing was published; run again.`);
  }
  const lineage = {
    source_family: record.family,
    source_path: record.path,
    source_sha256: record.sha256,
    source_object_key: record.objectKey,
  };
  return archiveRows(checkedArchive(bytes, asset, record.path, counts).archive, confirmations).map((row) => {
    for (const column of LINEAGE_COLUMNS) {
      if (Object.hasOwn(row, column)) {
        throw new Error(`${record.family} rows carry ${column}, which the writer reserves for lineage; the family cannot be published.`);
      }
    }
    return Object.assign(row, lineage);
  });
}

/**
 * A family's rows from `records` (its kept sources), resolved, in the
 * analyzer's order: whole for a family whose revisions reach across report
 * days, otherwise one report day at a time, report days in the rules' order.
 * Yields one batch of rows per resolution.
 */
async function* familyRows(family, records, reading) {
  if (resolvesAcrossReportDays(family)) {
    const rows = [];
    for (const record of records) for (const row of await sourceRows(record, reading)) rows.push(row);
    yield resolveFamily(family, rows);
    return;
  }
  const days = [...records].sort((left, right) => compareReportDates(left.reportDate, right.reportDate));
  for (const record of days) yield resolveFamily(family, await sourceRows(record, reading));
}

/** The register rows: every archive found and every missing report day. */
function sourceRecords(scan) {
  const row = (record) => ({
    path: record.path ?? null,
    state: record.state,
    family: record.family ?? null,
    integration: record.integration ?? null,
    report: record.report ?? null,
    report_date: record.reportDate ?? null,
    sha256: record.sha256 ?? null,
    bytes: record.bytes ?? null,
    object_key: record.objectKey ?? null,
    confirmed_at: record.confirmedAt ?? null,
    fingerprint: record.fingerprint ?? null,
    rows: record.rows ?? null,
    columns: record.columns ? JSON.stringify(record.columns) : null,
    envelope: record.envelope ?? null,
    reason: record.reason ?? null,
    superseded_by: record.supersededBy ?? null,
  });
  return [...scan.records, ...scan.missing].map(row);
}

async function readPreviousSources(connection, output, previous) {
  const known = new Map();
  if (!previous || previous.sources.files.length === 0) return known;
  const list = datasetFiles(output, previous, 'sources').map(sqlString).join(', ');
  const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet([${list}]) WHERE path IS NOT NULL`);
  for (const row of reader.getRowObjectsJS()) known.set(row.path, row);
  return known;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Only the lock holder reclaims a previous writer's scratch directory.
 * Unknown process state, live/reused PIDs, symlinks and other names stay put. */
async function removeAbandonedSpills(output) {
  for (const entry of await fs.readdir(output, { withFileTypes: true })) {
    const match = /^\.spill-([1-9][0-9]*)$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') {
        await fs.rm(path.join(output, entry.name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Publish `input` (one site's downloads folder) as the next generation under
 * `output`, or nothing when nothing changed, then remove what the history no
 * longer keeps (KEEP_GENERATIONS_DAYS). Returns what it did.
 *
 * `partitionBy` groups report dates into files: `month`, the command's only
 * choice; `day` and `year` exist for the measurements that chose it.
 *
 * `deps.writeFile(connection, table, target, metadata)` replaces the step that
 * turns a filled table into a Parquet file (tests interrupt a run with it);
 * `deps.beforeRemove(relative)` sees each removal before it happens (tests
 * interrupt the removal with it); `deps.now()` is the publication clock, and
 * the clock the kept generations are judged by.
 */
export async function publishSignalHistory(
  { asset, input, output, partitionBy = DEFAULT_PARTITION },
  deps = {},
) {
  if (typeof asset !== 'string' || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('asset must be a site id such as example.com.');
  }
  if (!Object.hasOwn(PARTITIONS, partitionBy)) {
    throw new Error(`partition must be one of ${Object.keys(PARTITIONS).join(', ')}.`);
  }
  const from = path.resolve(input);
  const to = path.resolve(output);
  if (!(await fs.stat(from).then((stat) => stat.isDirectory(), () => false))) {
    throw new Error(`${input} is not a folder of downloaded archives.`);
  }
  if (inside(from, to) || inside(to, from)) {
    throw new Error('The history folder and the downloads folder must not contain each other.');
  }
  const now = deps.now ?? (() => new Date().toISOString());
  await fs.mkdir(to, { recursive: true });
  const release = await holdLock(path.join(to, LOCK), (holder) => new Error(holder === null
    ? `Another signals:history run took ${output} first; nothing was changed.`
    : `Another signals:history run (process ${holder}) is writing ${output}; nothing was changed.`));
  try {
    const result = await publishGeneration({ asset, from, to, output, partitionBy, now, writeFile: deps.writeFile ?? copyToParquet });
    let retention;
    try {
      retention = await pruneHistory(to, now(), deps.beforeRemove);
    } catch (error) {
      const done = result.published ? `Generation ${result.generation} published` : `Nothing changed since generation ${result.generation}`;
      throw new Error(`${done}, but removing what the history no longer keeps stopped: ${error instanceof Error ? error.message : String(error)}. Every generation still listed reads; the next run finishes the removal.`);
    }
    return { ...result, ...retention };
  } finally {
    await release();
  }
}

/** One run's publication, under the history's lock. */
async function publishGeneration({ asset, from, to, output, partitionBy, now, writeFile }) {
  const derivation = await derivationOf(partitionBy);
  const previous = await readCurrentGeneration(to);
  // A history the importer wrote first (only its tables) names no site yet.
  if (previous && previous.asset !== null && previous.asset !== asset) {
    throw new Error(`${output} holds ${previous.asset}'s history, not ${asset}'s.`);
  }
  await removeAbandonedSpills(to);
  // Files and rows are reused only under the derivation that produced them.
  const reusable = previous?.derivation?.id === derivation.id ? previous : null;

  const instance = await DuckDBInstance.create(':memory:', {
    threads: '1',
    memory_limit: '1GB',
    temp_directory: path.join(to, `.spill-${process.pid}`),
  });
  const connection = await instance.connect();
  try {
    const downloads = await readDownloads(from);
    const counts = { read: 0 };
    const scan = await scanArchives({
      asset,
      input: from,
      downloads,
      previous: await readPreviousSources(connection, to, reusable),
      counts,
    });
    const context = { connection, output: to, derivation, writeFile, written: { files: [], tables: 0 } };
    const reading = { input: from, asset, confirmations: downloads.confirmations, counts };

    const families = new Map();
    for (const record of scan.records) {
      if (record.state !== 'read') continue;
      if (!families.has(record.family)) families.set(record.family, []);
      families.get(record.family).push(record);
    }
    const previousDatasets = new Map((reusable?.datasets ?? []).map((dataset) => [dataset.name, dataset]));
    const datasets = [];

    for (const family of [...families.keys()].sort()) {
      const records = families.get(family);
      const whole = resolvesAcrossReportDays(family);
      const schema = familySchema(family, records.map((record) => record.columns));
      const before = previousDatasets.get(family);
      const sameSchema = before?.schema.id === schema.id;
      const periods = new Map();
      for (const record of records) {
        const period = whole ? WHOLE : periodOf(record.reportDate, derivation.partitionBy);
        if (!periods.has(period)) periods.set(period, []);
        periods.get(period).push(record);
      }
      const files = [];
      for (const period of [...periods.keys()].sort()) {
        const inputs = periods.get(period);
        const fingerprint = sha256(JSON.stringify([family, period, inputs.map((record) => record.fingerprint)]));
        const reuse = sameSchema ? before.files.find((file) => file.partition === period && file.inputsFingerprint === fingerprint) : null;
        if (reuse) {
          files.push(reuse);
          continue;
        }
        files.push(await writePeriod(context, {
          dataset: family,
          partition: period,
          schema,
          inputsFingerprint: fingerprint,
          batches: familyRows(family, inputs, reading),
          ...archiveRow(schema, derivation),
        }));
      }
      datasets.push({
        name: family,
        schema,
        rowOrder: whole ? ['file_row_number'] : ['report_date', 'file_row_number'],
        rows: files.reduce((total, file) => total + file.rows, 0),
        files,
      });
    }

    // Index coverage, derived from its source families' kept archives. Like the
    // analyzer's file, it exists only when it has rows.
    const coverageSources = INDEX_COVERAGE_SOURCES.flatMap((family) => families.get(family) ?? []);
    if (coverageSources.length > 0) {
      const fingerprint = sha256(JSON.stringify([INDEX_COVERAGE_FAMILY, WHOLE, coverageSources.map((record) => record.fingerprint)]));
      const before = previousDatasets.get(INDEX_COVERAGE_FAMILY);
      if (before?.files.length === 1 && before.files[0].inputsFingerprint === fingerprint) {
        datasets.push(before);
      } else {
        const coverage = await indexCoverage(families, reading);
        if (coverage.rows.length > 0) {
          const schema = familySchema(INDEX_COVERAGE_FAMILY, [coverage.columns]);
          const file = await writePeriod(context, {
            dataset: INDEX_COVERAGE_FAMILY,
            partition: WHOLE,
            schema,
            inputsFingerprint: fingerprint,
            batches: [coverage.rows],
            ...archiveRow(schema, derivation),
          });
          datasets.push({ name: INDEX_COVERAGE_FAMILY, schema, rowOrder: ['file_row_number'], rows: file.rows, files: [file] });
        }
      }
    }
    datasets.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    // The register of sources, one file per period of report dates.
    const register = new Map();
    for (const row of sourceRecords(scan)) {
      const period = row.state === 'unreadable' ? UNREADABLE : periodOf(row.report_date, derivation.partitionBy);
      if (!register.has(period)) register.set(period, []);
      register.get(period).push(row);
    }
    const sourceFiles = [];
    for (const period of [...register.keys()].sort()) {
      const rows = register.get(period).sort((left, right) => {
        const a = left.path ?? `~${left.family}\0${left.report_date}`;
        const b = right.path ?? `~${right.family}\0${right.report_date}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      sourceFiles.push(await writePeriod(context, {
        dataset: 'sources',
        partition: period,
        schema: SOURCES_SCHEMA,
        inputsFingerprint: null,
        batches: [rows],
        ...archiveRow(SOURCES_SCHEMA, derivation),
      }));
    }

    const manifest = {
      format: HISTORY_FORMAT,
      asset,
      generation: (previous?.generation ?? 0) + 1,
      previous: previous?.generation ?? null,
      publishedAt: now(),
      content: null,
      derivation,
      writer: { duckdb: (await connection.runAndReadAll('SELECT version() AS version')).getRowObjectsJS()[0].version },
      downloadsFolder: path.relative(REPO_ROOT, from),
      downloadsManifest: downloads.state,
      sources: { schema: SOURCES_SCHEMA, rows: sourceFiles.reduce((total, file) => total + file.rows, 0), files: sourceFiles },
      datasets,
      // Existing operational-history table datasets are carried forward unchanged.
      ...(previous?.tables ? { tables: previous.tables } : {}),
    };
    manifest.content = contentOf(manifest);
    const fileCount = sourceFiles.length + datasets.reduce((total, dataset) => total + dataset.files.length, 0);
    // How much work the run did: the archives found, and how many times one was
    // parsed (a new archive twice: once for its columns, once to write it).
    const summary = {
      archivesFound: scan.records.length,
      archivesParsed: counts.read,
      written: context.written.files,
      kept: fileCount - context.written.files.length,
      datasets: datasets.length,
      unreadable: scan.records.filter((record) => record.state === 'unreadable').map(({ path: file, reason }) => ({ path: file, reason })),
      superseded: scan.records.filter((record) => record.state === 'superseded').map(({ path: file, supersededBy }) => ({ path: file, supersededBy })),
      missing: scan.missing.map(({ integration, report, reportDate }) => ({ integration, report, reportDate })),
    };
    if (previous && previous.content === manifest.content && previous.downloadsFolder === manifest.downloadsFolder) {
      return { published: false, generation: previous.generation, manifest: previous, ...summary };
    }
    await publishManifest(to, manifest);
    return { published: true, generation: manifest.generation, manifest, ...summary };
  } finally {
    connection.closeSync();
    instance.closeSync();
    await fs.rm(path.join(to, `.spill-${process.pid}`), { recursive: true, force: true });
  }
}

/**
 * Index coverage over the sources' resolved rows, each row traced to the one
 * source archive it was derived from. The archive rules take each coverage row
 * from one source family, in INDEX_COVERAGE_SOURCES order (pinned by
 * signal-archive.test.mjs); if that ever stops holding, this refuses rather than
 * guess a row's source.
 */
async function indexCoverage(families, reading) {
  const sources = new Map();
  for (const family of INDEX_COVERAGE_SOURCES) {
    const rows = [];
    for await (const batch of familyRows(family, families.get(family) ?? [], reading)) for (const row of batch) rows.push(row);
    sources.set(family, rows);
  }
  const coverage = indexCoverageRows(sources);
  const traced = INDEX_COVERAGE_SOURCES.flatMap((family) =>
    indexCoverageRows(new Map([[family, sources.get(family)]])).map((row) => ({ row, family })),
  );
  if (!isDeepStrictEqual(traced.map(({ row }) => row), coverage)) {
    throw new Error('Index coverage no longer takes each row from one source family; its rows cannot be traced, so it is not published.');
  }
  const byDay = new Map();
  for (const family of INDEX_COVERAGE_SOURCES) {
    for (const record of families.get(family) ?? []) byDay.set(`${family}\0${record.reportDate}`, record);
  }
  const columns = observeColumns(coverage);
  const rows = coverage.map((row, index) => {
    const record = byDay.get(`${traced[index].family}\0${row.report_date}`);
    if (!record) throw new Error(`An index coverage row names report date ${row.report_date}, which no ${traced[index].family} archive has.`);
    return {
      ...row,
      source_family: record.family,
      source_path: record.path,
      source_sha256: record.sha256,
      source_object_key: record.objectKey,
    };
  });
  return { rows, columns };
}

function usage() {
  console.log(`Usage:
  pnpm signals:history -- --asset example.com --in <downloads folder> --out <history folder>

Publishes one site's downloaded provider archive as Parquet datasets DuckDB
reads, one complete generation at a time. Reads --in and never changes it;
writes only under --out. A run that finds nothing changed writes nothing.
Every run then keeps ${RETENTION}
and removes the rest.

Options:
  --asset <id>         required site id
  --in <folder>        required: the folder signals:download or signals:refresh
                       wrote for this site (archives and manifest.json)
  --out <folder>       required: this site's history folder (created)
`);
}

export function parseArgs(argv) {
  const options = { asset: null, input: null, output: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') options.asset = value;
    else if (arg === '--in') options.input = path.resolve(REPO_ROOT, value);
    else if (arg === '--out') options.output = path.resolve(REPO_ROOT, value);
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!options.asset || !/^[a-z0-9.-]+$/.test(options.asset)) {
    throw new Error('--asset is required and must be a site id such as example.com.');
  }
  if (!options.input || !options.output) throw new Error('--in and --out are both required.');
  return options;
}

/** The lines a run prints. */
export function describeRun(result, output) {
  const lines = [];
  const relative = path.relative(REPO_ROOT, output);
  const shown = relative === '' ? '.' : relative.startsWith('..') || path.isAbsolute(relative) ? output : relative;
  const where = path.join(shown, 'generations', generationFile(result.generation));
  if (result.published) {
    lines.push(`Generation ${result.generation} published → ${where}: ${result.datasets} datasets, ${result.written.length} files written, ${result.kept} kept.`);
  } else {
    lines.push(`Nothing changed since generation ${result.generation}: no file written.`);
  }
  if (result.removedGenerations.length > 0 || result.removedFiles > 0) {
    const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    lines.push(`Removed ${count(result.removedGenerations.length, 'generation')} published ${KEEP_GENERATIONS_DAYS} or more days ago and ${count(result.removedFiles, 'file')} no kept generation names; ${count(result.keptGenerations.length, 'generation')} kept.`);
  }
  for (const { path: file, reason } of result.unreadable) lines.push(`Unreadable, no rows: ${file} — ${reason}`);
  for (const { path: file, supersededBy } of result.superseded) lines.push(`Superseded by ${supersededBy}: ${file}`);
  for (const { integration, report, reportDate } of result.missing) {
    lines.push(`Named by the downloads manifest, no archive: ${integration} ${report} ${reportDate}`);
  }
  return lines;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) usage();
    else {
      const result = await publishSignalHistory(options);
      for (const line of describeRun(result, options.output)) console.log(line);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
