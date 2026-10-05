#!/usr/bin/env node
// THE ANALYSIS, READ FROM THE HISTORY FILES (bead ro-ujb9.67.3, decision D25).
//
// The one signal report: one
// CSV per report family, index-coverage.csv, executive.json and summary.json —
// read from one published generation of a site's history files
// (`pnpm signals:history`, scripts/signal-history.mjs) with DuckDB, instead of
// from every provider answer ever downloaded.
//
//   pnpm signals:analyze-history -- --asset example.com --history <history folder> --out <report link>
//
// The archive writer owns normalization and revision choice; this module alone
// owns CSV/report publication. Frozen reference hashes prove report parity
// with the retired raw analyzer over one copy per report day. A report day
// delivered twice is read once, from the copy read last under the history
// rule. Raw evidence and dated reference outputs remain available for rebuild
// and comparison; signal-history-analyze.test.mjs covers those contracts.
//
// Parquet cannot tell an empty cell from a missing one, nor the number 20 from
// the text "20" in a column that holds both. An empty cell is read back as ''
// and such a column as text; the rules read every value through helpers that
// treat these alike, and docs/artifacts/signal-history-analyze-2026-09-29/
// measures that no finding changes (rules-blindness.mjs).
//
// PINNED TO A GENERATION. A run reads one generation — the newest, or
// `--generation <n>` — checks every file it reads against the sha256 its
// manifest records, and names it in report.json. The same generation read by
// the same code on the same clock writes the same bytes. It refuses:
//   * a generation that lists an archive it could not read, as the analyzer
//     refuses such an archive (a report day it cannot read is unknown, and a
//     report that silently leaves it out would read as complete). A report day
//     the downloads manifest names with no archive is left out, as the
//     analyzer leaves it out: it never sees one.
//   * a generation written by other archive rules than this checkout's (its
//     derivation): run `pnpm signals:history` first, which rewrites it.
//   * a file whose bytes differ from what the manifest records, or that is
//     missing.
//   * a generation the history no longer keeps (KEEP_GENERATIONS_DAYS in
//     scripts/history-files.mjs), asked for or removed while the job reads
//     it: the refusal names the generation, the rule and the oldest kept.
//
// BOUNDED. The work runs in a child process with four limits, and hitting any
// one stops it with a plain message and publishes nothing:
//   --memory-mb           the child's JavaScript heap (V8's own limit)
//   --duckdb-memory-mb    DuckDB's memory
//   --temp-disk-mb        the disk the job fills before it publishes: DuckDB's
//                         spill, then the report it stages (never both at once:
//                         DuckDB is closed before the report is written)
//   --time-limit-seconds  wall time, after which the child is killed
// DuckDB runs in memory with one thread, may read only the history folder and
// its own spill folder, loads no extension and cannot change its settings.
// There is no database file, so no second process can open one.
//
// PUBLISHED WHOLE. `--out` is a link to the newest complete report, a folder
// under `<out>.reports/`. The job stages the whole report beside it, flushes it
// to disk and swaps the link in one rename, so a reader of `--out` sees the
// previous report or the new one, never a mix, and a job stopped at any point —
// a limit, a kill, a crash — leaves the previous report in place. The report
// before the current one is kept; older ones are removed. It never replaces a
// folder it did not write, and one lock lets one job at a time write a link.
//
// The scheduled panel refresh calls this bounded job; it reads no
// file of the running OS. Run from the command line, it asks the
// installation's stored settings two things through the ingest's door, as the
// analyzer does (scripts/config-store-client.mjs): which events count as
// value, and the site's search market. A caller that hands both in
// (`readValueEvents`, `market`) reads nothing but the history folder, which is
// how every test runs it. The supervisor runs the refresh in a separate child process.
//
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { readConfigSnapshot } from './config-store-client.mjs';
import {
  INDEX_COVERAGE_FAMILY,
  PROVENANCE_COLUMNS,
  posthogColumns,
  resolveFamily,
  resolvesAcrossReportDays,
} from './signal-archive.mjs';
import { savedSearchMarket } from '../packages/contract/src/search-market.mjs';
import { productUseStagesRefusal } from '../packages/contract/src/product-use.mjs';
import {
  LINEAGE_COLUMNS,
  RETENTION,
  datasetFiles,
  derivationOf,
  holdLock,
  listGenerations,
  readCurrentGeneration,
  readGeneration,
} from './signal-history.mjs';
import { buildExecutiveSnapshot, marketPhrase, reclamationTargetList } from './signal-insights.mjs';

const MODULE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(MODULE), '..');

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * THE SITE'S SAVED SEARCH MARKET in a stored settings snapshot (bead
 * ro-ujb9.207): its `dataforseo` entry in config/integrations.json, read by the
 * contract's rule the collector asks by. Null when the site saved none, and
 * its findings name its default market rather than assume one.
 */
export function storedSearchMarket(snapshot, asset) {
  const assets = record(record(snapshot.get('config/integrations.json')?.body)?.assets);
  return savedSearchMarket(record(assets?.[asset])?.dataforseo);
}

/** Resolve the acknowledged declaration once. Current declarations only select
 * comparison warnings; archived event names and key-event counts stay intact. */
export async function readStoredValueEvents(options = {}) {
  return storedValueEvents(await readConfigSnapshot(options));
}

/** The value-event declaration in a snapshot already read. */
export function storedValueEvents(snapshot) {
  const saved = snapshot.get('config/value-events.json');
  if (!saved) throw new Error('Value-event declarations are not stored. Seed configuration before analyzing reports.');
  const assets = record(saved.body)?.assets;
  if (!record(assets)) throw new Error('Stored value-event declarations are invalid.');
  for (const entry of Object.values(assets)) {
    if (!record(entry) || (entry.productUseStages !== undefined && productUseStagesRefusal(entry.productUseStages) !== null) || (entry.valueEvents !== undefined &&
      (!Array.isArray(entry.valueEvents) || entry.valueEvents.some((name) => typeof name !== 'string' || !name.trim())))) {
      throw new Error('Stored value-event declarations are invalid.');
    }
  }
  return { body: saved.body, version: saved.version };
}

export const REPORT_FORMAT = 'noticeos-signal-report/1';
export const REPORT_RECORD = 'report.json';

/** The limits a run gets unless it is given others. */
export const DEFAULT_LIMITS = {
  memoryMb: 4096,
  duckdbMemoryMb: 512,
  tempDiskMb: 4096,
  timeLimitSeconds: 600,
};

const LIMIT_FLAGS = {
  memoryMb: '--memory-mb',
  duckdbMemoryMb: '--duckdb-memory-mb',
  tempDiskMb: '--temp-disk-mb',
  timeLimitSeconds: '--time-limit-seconds',
};

const MB = 1024 * 1024;
const REPORT_FOLDER = /^\d{8}-/;

/** A failure with a plain message for the operator; `kind` says which limit, if any. */
class JobFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlName(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shown(file) {
  const relative = path.relative(REPO_ROOT, file);
  return relative === '' ? '.' : relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
}

/** Where a link's reports are kept. */
export function reportsFolder(output) {
  return `${path.resolve(output)}.reports`;
}

function manifestFile(history, generation) {
  return path.join(history, 'generations', `${String(generation).padStart(8, '0')}.json`);
}

/**
 * Why `history` lists no generation `generation`: the history no longer keeps
 * it (the writer numbers generations without gaps, and only its retention
 * removes one), or it was never published. `whileReading`: it went while a
 * job read it.
 */
async function absentGeneration(history, generation, whileReading = false) {
  const listed = await listGenerations(history);
  if (listed.length > 0 && generation < listed.at(-1)) {
    const lead = whileReading ? `Generation ${generation} was removed while this report read it` : `Generation ${generation} is no longer kept`;
    return `${lead} (the history keeps ${RETENTION}). The oldest it keeps is generation ${listed[0]}.`;
  }
  return `${shown(history)} has no generation ${generation}.`;
}

// ─── The report, written as the analyzer writes it ────────────────────────────

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, emptyHeaders = null) {
  if (rows.length === 0) return emptyHeaders ? `${emptyHeaders.join(',')}\n` : '';
  const base = PROVENANCE_COLUMNS;
  const discovered = new Set(rows.flatMap((row) => Object.keys(row)));
  const headers = [...base, ...[...discovered].filter((header) => !base.includes(header)).sort()];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    '',
  ].join('\n');
}

function summaryCaveats(market) {
  return [
    'Absent provider rows remain unknown; this tool does not manufacture zeroes.',
    'GSC page/query datasets are top-row exports and can omit anonymized or low-volume data.',
    'GA4 Data API rows are aggregate/modelled reports, not raw event or session sequences.',
    'GA4 attribution families (traffic-acquisition, traffic-sources, landing-page-acquisition) carry provisional=1 on a report day not yet confirmed by a collection at least two days after it: GA4 is still attributing that day, so its channel and source/medium split reads high on Unassigned / (not set) / (data not available) and low on the real channels. Leave provisional=1 days out of any change; an empty provisional cell means the collection date could not be read.',
    'The GA4 js-errors family reads event parameters, which GA4 answers only once an operator registers them as custom dimensions and never backfills; an absent family is unknown, not an error-free property.',
    'Clarity rows are a trailing 72-hour, sampled read capped at 1,000 rows per metric block with no pagination, and clarity.ms is adblock-DNS-listed (undercounts ~15-25%): treat them as behavior rankings, never as population counts.',
    'Bing top-query/page snapshots update weekly; crawl statistics update daily, and repeated snapshots are revisions rather than additive rows.',
    'index-coverage.csv is DERIVED from the already-archived Bing crawl-stats and feeds families and states BING\'s index, not Google\'s: site-level per measured day (row_grain=site-day) plus the submitted sitemap counts (row_grain=sitemap), with no ratio between them because they carry different dates. It says nothing about any individual URL, and an absent file means the Bing lane did not collect — never that nothing is indexed.',
    'The bing-webmaster-ai-* families are operator-downloaded AI Performance exports, not API collections: report_date is the day the file was exported, the query and page families are period totals with no per-day breakdown, and an absent family means nobody has dropped that export yet — never that Bing cited nothing.',
    'DataForSEO rankings, backlinks, and LLM mentions are weekly provider snapshots; analysis compares stored snapshots and never repulls history.',
    'DataForSEO API cost is preserved on each report family so the metered lane remains auditable.',
    `The tracked SERP panel is a top-20 read in ${marketPhrase(market)} of hand-picked head terms on BOTH devices: one row per query per \`device\`, so nothing may be summed across devices without filtering first. An empty rank means no result inside that depth, and an empty AI Overview column means unknown, never absent.`,
    'PostHog families (posthog-*.csv) are server-side aggregates over each archive\'s own trailing window (window_start–window_end, inclusive, in the PostHog project\'s timezone): read one report_date at a time, and never add `people` across rows, days or report dates — it is a unique-person count over that row\'s window. posthog-web-daily is resolved newest-archive-wins per date. provider_truncated=true means the family hit its row limit and is a top-N read. An empty file is PostHog answering with no rows; a missing file is a family nobody collected.',
    'PostHog undercounts in known directions: browsers that block it are invisible, so its totals run below GA4; its browser library drops known bots that GA4 keeps, so a GA4-only spike can be a crawler; signed-in events arrive only after consent, so they are a floor; server-side events (any `$lib` other than the browser library) use account ids that do not join browser ids; and a site that sends its first-party events by name only has events with no properties by design, not by defect.',
  ];
}

/**
 * Every file of the report, handed to `write(name, text)` in the order the
 * analyzer writes them, from rows already read: `families` in the analyzer's
 * reading order, `coverage` the derived index-coverage rows, `archives` the
 * archives behind them. One file's text is held at a time.
 */
export async function writeReport({
  asset,
  output,
  input,
  analyzedAt,
  valueEventDocument,
  reclamationTargets,
  market,
  families,
  coverage,
  archives,
}, write) {
  const datasets = [];
  const place = (name) => path.relative(REPO_ROOT, path.join(output, name));
  for (const [name, rows] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const emptyHeaders = name.startsWith('posthog-') ? posthogColumns(name.slice('posthog-'.length)) : null;
    await write(`${name}.csv`, toCsv(rows, emptyHeaders));
    datasets.push({ name, rows: rows.length, file: place(`${name}.csv`) });
  }
  if (coverage.length > 0) {
    await write(`${INDEX_COVERAGE_FAMILY}.csv`, toCsv(coverage));
    datasets.push({ name: INDEX_COVERAGE_FAMILY, rows: coverage.length, file: place(`${INDEX_COVERAGE_FAMILY}.csv`) });
  }
  const executive = buildExecutiveSnapshot({
    asset,
    families,
    archives,
    generatedAt: analyzedAt,
    reclamationTargets,
    valueEvents: valueEventDocument.body,
    market,
  });
  await write('executive.json', `${JSON.stringify(executive, null, 2)}\n`);
  const summary = {
    analyzedAt,
    configuration: { valueEventsVersion: valueEventDocument.version },
    asset,
    input: path.relative(REPO_ROOT, input),
    archiveCount: archives.length,
    datasets,
    executive: {
      file: place('executive.json'),
      insightCount: executive.items.length,
      queryTrendProviders: executive.searchQueries
        ? ['google', 'bing'].filter((provider) => executive.searchQueries[provider] !== null).length
        : 0,
    },
    archives,
    caveats: summaryCaveats(market),
  };
  await write('summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, executive };
}

// ─── Reading one generation (inside the job) ──────────────────────────────────

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** DuckDB for one job: in memory, one thread, reading only `readable`. */
async function openEngine({ readable, spill, limits }) {
  const instance = await DuckDBInstance.create(':memory:', {
    threads: '1',
    memory_limit: `${limits.duckdbMemoryMb}MiB`,
    temp_directory: spill,
    max_temp_directory_size: `${limits.tempDiskMb}MiB`,
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  const connection = await instance.connect();
  const allowed = [...readable, spill].map((folder) => sqlString(`${folder}${path.sep}`)).join(', ');
  await connection.run(`SET allowed_directories = [${allowed}]`);
  await connection.run('SET enable_external_access = false');
  await connection.run('SET lock_configuration = true');
  const version = (await connection.runAndReadAll('SELECT version() AS version')).getRowObjectsJS()[0].version;
  return { instance, connection, version };
}

/** A DuckDB error as the limit it hit, or as it is. */
function engineFailure(error, limits) {
  const message = error instanceof Error ? error.message : String(error);
  if (/max_temp_directory_size|temp(orary)? director/i.test(message)) {
    return new JobFailure('temp-disk', `DuckDB needed more than its ${limits.tempDiskMb} MB of temporary disk (${LIMIT_FLAGS.tempDiskMb}).`);
  }
  if (/^Out of Memory Error/i.test(message)) {
    return new JobFailure('duckdb-memory', `DuckDB needed more than its ${limits.duckdbMemoryMb} MB of memory (${LIMIT_FLAGS.duckdbMemoryMb}).`);
  }
  return error;
}

/**
 * One file's rows, checked: its bytes are the ones the manifest records, its
 * columns have the types the schema names, and its rows come back in file
 * order. `empty` is what a NULL cell becomes.
 */
async function readFileRows(context, entry, file, columns, empty) {
  const { connection, history, manifest, cost } = context;
  const relative = path.relative(history, file);
  let digest;
  try {
    digest = await fileSha256(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // The history removes a generation's manifest before any file of it.
    if (!(await fs.access(manifestFile(history, manifest.generation)).then(() => true, () => false))) {
      throw new JobFailure('refused', await absentGeneration(history, manifest.generation, true));
    }
    throw new JobFailure('refused', `Generation ${manifest.generation} names ${relative}, which is missing. Nothing was read from it.`);
  }
  if (digest !== entry.sha256) {
    throw new JobFailure('refused', `${relative} is not the file generation ${manifest.generation} names: its bytes changed after it was published.`);
  }
  cost.bytesRead += entry.bytes;
  cost.filesRead += 1;
  const select = columns.map(([name]) => sqlName(name)).join(', ');
  const result = await connection.stream(`SELECT ${select}, file_row_number FROM read_parquet(${sqlString(file)}, file_row_number = true)`);
  const types = result.columnTypes().map(String);
  columns.forEach(([name, type], index) => {
    if (types[index] !== type) {
      throw new JobFailure('refused', `${relative} holds ${name} as ${types[index]}, not the ${type} its generation names.`);
    }
  });
  const rows = [];
  let position = 0n;
  // A text equal to the one above it in its column is that one: a report
  // day's rows share their provenance, as the analyzer's rows share it.
  const above = columns.map(() => undefined);
  for (;;) {
    const chunk = await result.fetchChunk();
    if (!chunk || chunk.rowCount === 0) break;
    const values = chunk.getColumns();
    const numbers = values[columns.length];
    for (let index = 0; index < chunk.rowCount; index++) {
      if (numbers[index] !== position) throw new JobFailure('refused', `DuckDB did not return ${relative} in file order.`);
      position += 1n;
      const row = {};
      for (let column = 0; column < columns.length; column++) {
        let value = values[column][index];
        if (value === null) value = empty;
        else if (typeof value === 'string') {
          if (value === above[column]) value = above[column];
          else above[column] = value;
        }
        row[columns[column][0]] = value;
      }
      rows.push(row);
    }
  }
  if (rows.length !== entry.rows) {
    throw new JobFailure('refused', `${relative} holds ${rows.length} rows; generation ${manifest.generation} records ${entry.rows}.`);
  }
  return rows;
}

/** A dataset's rows in its files' order. The analyzer's empty value is ''. */
async function readDataset(context, dataset, name) {
  const columns = dataset.schema.columns.filter(([column]) => !LINEAGE_COLUMNS.includes(column));
  const paths = datasetFiles(context.history, context.manifest, name);
  const rows = [];
  for (const [index, entry] of dataset.files.entries()) {
    for (const row of await readFileRows(context, entry, paths[index], columns, '')) rows.push(row);
  }
  return rows;
}

const REGISTER_COLUMNS = ['path', 'state', 'family', 'integration', 'report', 'report_date', 'rows', 'envelope', 'reason'];

/** The generation's register of sources; a NULL stays null. */
async function readRegister(context) {
  const { manifest } = context;
  const types = new Map(manifest.sources.schema.columns);
  for (const column of REGISTER_COLUMNS) {
    if (!types.has(column)) {
      throw new JobFailure('refused', `Generation ${manifest.generation}'s register has no ${column} column. Run pnpm signals:history to rewrite it.`);
    }
  }
  const columns = REGISTER_COLUMNS.map((column) => [column, types.get(column)]);
  const paths = datasetFiles(context.history, manifest, 'sources');
  const rows = [];
  for (const [index, entry] of manifest.sources.files.entries()) {
    for (const row of await readFileRows(context, entry, paths[index], columns, null)) rows.push(row);
  }
  return rows;
}

/**
 * Everything the report is made from, read from one generation: the families
 * in the analyzer's reading order, their rows in the analyzer's order, index
 * coverage, and the archives behind them.
 */
async function readReportInputs(context) {
  const { manifest } = context;
  const register = await readRegister(context);
  const unreadable = register.filter((row) => row.state === 'unreadable');
  if (unreadable.length > 0) {
    const [first] = unreadable;
    throw new JobFailure('refused', `Generation ${manifest.generation} lists ${unreadable.length} archive${unreadable.length === 1 ? '' : 's'} it could not read (first: ${first.path} — ${first.reason}). A report day that cannot be read is unknown, so no report was written, as the analyzer writes none.`);
  }
  const downloads = path.resolve(REPO_ROOT, manifest.downloadsFolder);
  // The analyzer reads archives in path order (scripts/signal-downloads.mjs);
  // the families meet it in that order and its summary lists them so.
  const kept = register
    .filter((row) => row.state === 'read')
    .map((row) => ({ row, file: path.join(downloads, ...row.path.split('/')) }))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  const families = new Map();
  const archives = kept.map(({ row, file }) => {
    if (row.envelope === null) {
      throw new JobFailure('refused', `Generation ${manifest.generation} does not record ${row.path}'s envelope. Run pnpm signals:history to rewrite it.`);
    }
    if (!families.has(row.family)) families.set(row.family, null);
    const envelope = JSON.parse(row.envelope);
    return {
      file: path.relative(REPO_ROOT, file),
      integration: row.integration,
      report: row.report,
      reportDate: envelope.reportDate,
      ...(row.integration === 'clarity' ? { collectedAt: envelope.collectedAt } : {}),
      providerRows: envelope.providerRows,
      providerTruncated: envelope.providerTruncated,
      flattenedRows: row.rows,
    };
  });

  const named = manifest.datasets.map((dataset) => dataset.name).filter((name) => name !== INDEX_COVERAGE_FAMILY);
  const unmatched = [...named.filter((name) => !families.has(name)), ...[...families.keys()].filter((name) => !named.includes(name))];
  if (unmatched.length > 0) {
    throw new JobFailure('refused', `Generation ${manifest.generation}'s datasets and its register disagree about ${unmatched.join(', ')}.`);
  }
  let coverage = [];
  for (const dataset of manifest.datasets) {
    if (/[\\/\0]/.test(dataset.name)) {
      throw new JobFailure('refused', `Generation ${manifest.generation} holds a family named ${JSON.stringify(dataset.name)}, which is not a file name.`);
    }
    const whole = dataset.name === INDEX_COVERAGE_FAMILY || resolvesAcrossReportDays(dataset.name);
    const order = whole ? ['file_row_number'] : ['report_date', 'file_row_number'];
    if (JSON.stringify(dataset.rowOrder) !== JSON.stringify(order)) {
      throw new JobFailure('refused', `Generation ${manifest.generation} orders ${dataset.name} by ${dataset.rowOrder.join(', ')}; these archive rules order it by ${order.join(', ')}.`);
    }
    const rows = await readDataset(context, dataset, dataset.name);
    if (dataset.name === INDEX_COVERAGE_FAMILY) coverage = rows;
    // A family resolved across report days is stored resolved, in order.
    // Every other family's files hold its report days one after another, so
    // the rules' own stable sort by report date puts them in the analyzer's
    // order.
    else families.set(dataset.name, whole ? rows : resolveFamily(dataset.name, rows));
  }
  return { families, coverage, archives, input: downloads };
}

// ─── The job: a child process with its own limits ─────────────────────────────

async function syncFile(file) {
  const handle = await fs.open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFolder(folder) {
  const handle = await fs.open(folder, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Some file systems cannot flush a folder; the files themselves are flushed.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

/** The report folder the link at `output` names now, or null. */
async function linkedReport(output) {
  let stat;
  try {
    stat = await fs.lstat(output);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const reports = reportsFolder(output);
  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(output), await fs.readlink(output));
    if (path.dirname(target) === reports && REPORT_FOLDER.test(path.basename(target))) return target;
  }
  throw new JobFailure('refused', `${shown(output)} is not a report link this command made. It never replaces a folder it did not write: give --out a new path.`);
}

/**
 * The generation a run reads — `generation`, or the newest — once it is one
 * these archive rules can report on.
 */
async function pinnedGeneration(history, asset, generation) {
  const manifest = generation === null
    ? await readCurrentGeneration(history)
    : await readGeneration(history, generation).catch(async (error) => {
      if (error?.code === 'ENOENT') throw new JobFailure('refused', await absentGeneration(history, generation));
      throw error;
    });
  if (!manifest) throw new JobFailure('refused', `${shown(history)} holds no published generation. Run pnpm signals:history first.`);
  if (manifest.asset === null) throw new JobFailure('refused', `${shown(history)} holds no site's provider archive yet. Run pnpm signals:history first.`);
  if (manifest.asset !== asset) throw new JobFailure('refused', `${shown(history)} holds ${manifest.asset}'s history, not ${asset}'s.`);
  const derivation = await derivationOf(manifest.derivation.partitionBy);
  if (manifest.derivation.id !== derivation.id) {
    throw new JobFailure('refused', `Generation ${manifest.generation} was written by other archive rules (derivation ${manifest.derivation.id}; this checkout's is ${derivation.id}). Run pnpm signals:history, which rewrites it under these rules, then analyze again.`);
  }
  if (typeof manifest.downloadsFolder !== 'string') {
    throw new JobFailure('refused', `Generation ${manifest.generation} does not name its downloads folder. Run pnpm signals:history to rewrite it.`);
  }
  return manifest;
}

async function runJob(job, stage) {
  // performance.now() counts from this process's start.
  const clock = [performance.now()];
  const lap = () => {
    clock.push(performance.now());
    return Math.round(clock.at(-1) - clock.at(-2)) / 1000;
  };
  const analyzedAt = job.now ?? new Date().toISOString();
  const { asset, history, output, staging, spill, limits } = job;
  let manifest;
  let cost;
  try {
    manifest = await readGeneration(history, job.generation);
    cost = { bytesRead: (await fs.stat(manifestFile(history, manifest.generation))).size, filesRead: 1 };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new JobFailure('refused', await absentGeneration(history, job.generation, true));
    throw error;
  }

  await stage('reading');
  await fs.mkdir(spill, { recursive: true });
  const engine = await openEngine({ readable: [history], spill, limits });
  let inputs;
  try {
    inputs = await readReportInputs({ connection: engine.connection, history, manifest, cost });
  } catch (error) {
    throw engineFailure(error, limits);
  } finally {
    engine.connection.closeSync();
    engine.instance.closeSync();
    await fs.rm(spill, { recursive: true, force: true });
  }
  const secondsReading = lap();

  // Staged whole, within the temporary-disk limit, before anything is visible.
  await fs.mkdir(staging);
  let staged = 0;
  const written = [];
  const write = async (name, text) => {
    staged += Buffer.byteLength(text);
    if (staged > limits.tempDiskMb * MB) {
      throw new JobFailure('temp-disk', `The report needed more than its ${limits.tempDiskMb} MB of temporary disk (${LIMIT_FLAGS.tempDiskMb}).`);
    }
    await fs.writeFile(path.join(staging, name), text, { flag: 'wx' });
    written.push(name);
    if (written.length === 1) await stage('writing');
  };
  const { summary, executive } = await writeReport({
    asset,
    output,
    input: inputs.input,
    analyzedAt,
    valueEventDocument: job.valueEventDocument,
    reclamationTargets: job.reclamationTargets,
    market: job.market,
    families: inputs.families,
    coverage: inputs.coverage,
    archives: inputs.archives,
  }, write);
  for (const [name, text] of Object.entries(job.reportFiles)) await write(name, text);
  await write(REPORT_RECORD, `${JSON.stringify({
    format: REPORT_FORMAT,
    asset,
    generation: manifest.generation,
    generationContent: manifest.content,
    derivation: manifest.derivation.id,
    history: path.relative(REPO_ROOT, history),
    analyzedAt,
    duckdb: engine.version,
  }, null, 2)}\n`);
  // Every file on disk before the link can name it; flushed together, which
  // costs a fraction of one at a time.
  await Promise.all(written.map((name) => syncFile(path.join(staging, name))));
  await syncFolder(staging);
  const secondsAnalyzing = lap();
  await stage('publishing');
  if (process.connected === false) throw new JobFailure('stopped', 'The command that started this job has gone; nothing was published.');

  // One rename makes the report a report folder; one more swaps the link.
  const reports = reportsFolder(output);
  const previous = await linkedReport(output);
  const id = `${String(manifest.generation).padStart(8, '0')}-${analyzedAt.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const folder = path.join(reports, id);
  await fs.rename(staging, folder);
  const link = path.join(reports, `.link-${process.pid}-${randomBytes(4).toString('hex')}`);
  await fs.symlink(path.relative(path.dirname(output), folder), link);
  await fs.rename(link, output);
  await syncFolder(reports);
  await syncFolder(path.dirname(output));

  // The current report and the one before it stay; older ones go.
  for (const name of await fs.readdir(reports)) {
    if (!REPORT_FOLDER.test(name) || name === id || path.join(reports, name) === previous) continue;
    await fs.rm(path.join(reports, name), { recursive: true, force: true });
  }
  const secondsPublishing = lap();

  return {
    ...summary,
    executiveSnapshot: executive,
    report: {
      folder: path.relative(REPO_ROOT, folder),
      generation: manifest.generation,
      generationContent: manifest.content,
      files: written.length,
      rows: summary.datasets.reduce((total, dataset) => total + dataset.rows, 0),
    },
    cost: {
      ...cost,
      // Node's start and this module's imports, before the job began.
      secondsStarting: Math.round(clock[0]) / 1000,
      secondsReading,
      // The rules, and the report rendered and staged.
      secondsAnalyzing,
      secondsPublishing,
      peakMb: Math.round(process.resourceUsage().maxRSS / 1024),
    },
  };
}

/** The child's side: take one job, report each stage and wait to go on. */
function serveJob() {
  let proceed = null;
  const stage = (name) => new Promise((resolve) => {
    proceed = resolve;
    process.send({ type: 'stage', stage: name });
  });
  process.on('disconnect', () => process.exit(1));
  process.on('message', (message) => {
    if (message?.type === 'continue') proceed?.();
    if (message?.type !== 'job') return;
    runJob(message.job, stage).then(
      (result) => process.send({ type: 'result', result }, () => process.exit(0)),
      (error) => process.send({
        type: 'failure',
        kind: error instanceof JobFailure ? error.kind : 'error',
        message: error instanceof Error ? error.message : String(error),
      }, () => process.exit(1)),
    );
  });
}

// ─── The command's side: resolve inputs, take the lock, run and watch the job ─

function takeLock(reports) {
  return holdLock(path.join(reports, '.lock'), (holder) => new JobFailure('refused', holder === null
    ? `Another analysis took ${shown(reports)} first; nothing was changed.`
    : `Another analysis (process ${holder}) is writing ${shown(reports)}; nothing was changed.`));
}

function checkedLimits(limits) {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, flag] of Object.entries(LIMIT_FLAGS)) {
    if (!Number.isInteger(merged[key]) || merged[key] < 1) throw new Error(`${flag} must be a whole number above zero.`);
  }
  return merged;
}

/**
 * Write `asset`'s report from its history folder and publish it at `output`.
 * The result contains the summary, executive snapshot, `report` (the pinned
 * generation it read and published), and bounded-job `cost`.
 *
 * `generation` pins the generation read (default: the newest). `limits`
 * overrides DEFAULT_LIMITS. `now` fixes the analysis clock.
 * `reportFiles` includes the refresh's trend/freshness text in the same bounded
 * staging and atomic publication as the analytical reports.
 * `deps.onStage(stage)` sees each stage — reading, writing, publishing — and
 * may return 'kill' to kill the job there (the tests' interruption).
 */
export async function analyzeSignalHistory({
  asset,
  history,
  output,
  generation = null,
  reclamationTargets = null,
  readValueEvents = readStoredValueEvents,
  configReadOptions = {},
  market = null,
  limits = {},
  now = null,
  reportFiles = {},
}, deps = {}) {
  if (typeof asset !== 'string' || !/^[a-z0-9.-]+$/.test(asset)) {
    throw new Error('asset must be a site id such as example.com.');
  }
  if (generation !== null && (!Number.isInteger(generation) || generation < 1)) {
    throw new Error('--generation must be a generation number: 1 or more.');
  }
  const bounds = checkedLimits(limits);
  // Companion files share the report's staging, disk limit and atomic swap.
  // Only these two panel artifacts may be added; no report file is replaced.
  for (const [name, text] of Object.entries(reportFiles)) {
    if (!['signal-trend-daily.csv', 'freshness.json'].includes(name) || typeof text !== 'string') {
      throw new Error('reportFiles may contain only text for signal-trend-daily.csv and freshness.json.');
    }
  }
  const from = path.resolve(history);
  const to = path.resolve(output);
  const reports = reportsFolder(to);
  if (!(await fs.stat(from).then((stat) => stat.isDirectory(), () => false))) {
    throw new Error(`${history} is not a history folder.`);
  }
  if ([to, reports].some((target) => inside(from, target) || inside(target, from))) {
    throw new Error('The history folder and the report must not contain each other.');
  }
  // Outside inputs resolve here, before any job starts or anything is replaced.
  const manifest = await pinnedGeneration(from, asset, generation);
  const openTargets = reclamationTargets
    ? reclamationTargetList(JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, reclamationTargets), 'utf8')))
    : null;
  const valueEventDocument = await readValueEvents(configReadOptions);

  await linkedReport(to);
  await fs.mkdir(reports, { recursive: true });
  const releaseLock = await takeLock(reports);
  const started = performance.now();
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const staging = path.join(reports, `.staging-${token}`);
  const spill = path.join(reports, `.staging-${token}-spill`);
  const unchanged = `Nothing was published; ${shown(to)} is unchanged.`;
  try {
    // Left by a job that died: no live job owns them while this lock is held.
    for (const name of await fs.readdir(reports)) {
      if (name.startsWith('.staging-') || name.startsWith('.link-')) await fs.rm(path.join(reports, name), { recursive: true, force: true });
    }
    await linkedReport(to);

    const child = fork(MODULE, ['--job'], {
      execArgv: [`--max-old-space-size=${bounds.memoryMb}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      stderr = `${stderr}${text}`.slice(-8192);
    });
    let outcome = null;
    let timedOut = false;
    let killedAt = null;
    let channelError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, bounds.timeLimitSeconds * 1000);
    // `close` follows every message the job sent, and its exit.
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    child.on('error', (error) => {
      channelError = error;
    });
    child.on('message', async (message) => {
      if (message?.type === 'stage') {
        if ((await deps.onStage?.(message.stage)) === 'kill') {
          killedAt = message.stage;
          child.kill('SIGKILL');
        } else if (child.connected) child.send({ type: 'continue' });
      } else if (message?.type === 'result' || message?.type === 'failure') outcome = message;
    });
    child.send({
      type: 'job',
      job: {
        asset,
        history: from,
        output: to,
        generation: manifest.generation,
        staging,
        spill,
        limits: bounds,
        now,
        reportFiles,
        valueEventDocument,
        market,
        reclamationTargets: openTargets,
      },
    });
    const { code, signal } = await exited;
    clearTimeout(timer);

    if (outcome?.type === 'result') {
      return { ...outcome.result, cost: { ...outcome.result.cost, secondsTotal: Math.round(performance.now() - started) / 1000 } };
    }
    if (outcome?.type === 'failure') {
      const limited = ['duckdb-memory', 'temp-disk'].includes(outcome.kind);
      throw new JobFailure(outcome.kind, limited ? `${outcome.message} ${unchanged}` : outcome.message);
    }
    if (timedOut) {
      throw new JobFailure('time', `The analysis took longer than its ${bounds.timeLimitSeconds}-second limit (${LIMIT_FLAGS.timeLimitSeconds}) and was stopped. ${unchanged}`);
    }
    if (killedAt !== null) throw new JobFailure('stopped', `The analysis was stopped while ${killedAt}. ${unchanged}`);
    if (/heap out of memory|allocation failed/i.test(stderr) || signal === 'SIGABRT') {
      throw new JobFailure('memory', `The analysis needed more than its ${bounds.memoryMb} MB memory limit (${LIMIT_FLAGS.memoryMb}) and was stopped. ${unchanged}`);
    }
    const last = channelError?.message ?? stderr.trim().split('\n').at(-1) ?? '';
    throw new JobFailure('error', `The analysis stopped unexpectedly (${signal ?? `exit ${code}`})${last ? `: ${last}` : ''}. ${unchanged}`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(spill, { recursive: true, force: true });
    await releaseLock();
  }
}

// ─── The command line ─────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage:
  pnpm signals:analyze-history -- --asset example.com --history <history folder> --out <report link>

Writes the site's report — one CSV per report family, index-coverage.csv,
executive.json and summary.json — from one
generation of the history files signals:history publishes, and publishes it
whole at --out. Reads the installation's stored settings.

Options:
  --asset <id>                 required site id
  --history <folder>           required: the site's history folder
  --out <path>                 required: the link to the newest report; the
                               reports themselves are kept in <out>.reports/
  --generation <n>             read generation n (default: the newest)
  --reclamation-targets <path> open-target row array from reclamation:open-targets
  --memory-mb <n>              JavaScript memory limit (default ${DEFAULT_LIMITS.memoryMb})
  --duckdb-memory-mb <n>       DuckDB memory limit (default ${DEFAULT_LIMITS.duckdbMemoryMb})
  --temp-disk-mb <n>           temporary disk limit (default ${DEFAULT_LIMITS.tempDiskMb})
  --time-limit-seconds <n>     time limit (default ${DEFAULT_LIMITS.timeLimitSeconds})
`);
}

export function parseArgs(argv) {
  const options = { asset: null, history: null, output: null, generation: null, reclamationTargets: null, limits: {} };
  const limitOf = Object.fromEntries(Object.entries(LIMIT_FLAGS).map(([key, flag]) => [flag, key]));
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
    if (arg === '--asset') options.asset = value;
    else if (arg === '--history') options.history = path.resolve(REPO_ROOT, value);
    else if (arg === '--out') options.output = path.resolve(REPO_ROOT, value);
    else if (arg === '--reclamation-targets') options.reclamationTargets = path.resolve(REPO_ROOT, value);
    else if (arg === '--generation') options.generation = Number(value);
    else if (Object.hasOwn(limitOf, arg)) options.limits[limitOf[arg]] = Number(value);
    else throw new Error(`Unknown option: ${arg}`);
    index++;
  }
  if (!options.asset || !/^[a-z0-9.-]+$/.test(options.asset)) {
    throw new Error('--asset is required and must be a site id such as example.com.');
  }
  if (!options.history || !options.output) throw new Error('--history and --out are both required.');
  if (options.generation !== null && (!Number.isInteger(options.generation) || options.generation < 1)) {
    throw new Error('--generation must be a generation number: 1 or more.');
  }
  checkedLimits(options.limits);
  return options;
}

/** The line a published report prints. */
export function describeReport(result, output) {
  const { report, cost } = result;
  return `Generation ${report.generation} → ${shown(output)}: ${report.files} files, ${report.rows} rows, `
    + `${result.executive.insightCount} findings. Read ${(cost.bytesRead / MB).toFixed(1)} MB in `
    + `${cost.secondsTotal.toFixed(1)} s, peak ${cost.peakMb} MB.`;
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === MODULE;
if (isEntrypoint && process.argv[2] === '--job' && typeof process.send === 'function') {
  serveJob();
} else if (isEntrypoint) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) usage();
    else {
      // One read of the stored settings answers both questions the rules ask.
      const snapshot = await readConfigSnapshot();
      const result = await analyzeSignalHistory({
        ...options,
        readValueEvents: async () => storedValueEvents(snapshot),
        market: storedSearchMarket(snapshot, options.asset),
      });
      console.log(describeReport(result, options.output));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
