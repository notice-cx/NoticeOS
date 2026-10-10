import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  INDEX_COVERAGE_FAMILY,
  INDEX_COVERAGE_SOURCES,
  archiveFamily,
  archiveRows,
  indexCoverageRows,
  manifestConfirmations,
  parseArchive,
  reportDayKey,
  resolveFamily,
  resolvesAcrossReportDays,
} from './signal-archive.mjs';
import { FIXTURE_ASSET, fixtureManifest, writeArchiveFixture } from './signal-archive-fixture.mjs';
import { archiveFiles, readDownloadsManifest } from './signal-downloads.mjs';
import {
  DERIVATION_FILES,
  KEEP_GENERATIONS_DAYS,
  LINEAGE_COLUMNS,
  copyToParquet,
  datasetFiles,
  describeRun,
  keptGenerations,
  listGenerations,
  parseArgs,
  publishSignalHistory,
  readCurrentGeneration,
  readGeneration,
} from './signal-history.mjs';

// The provider history published as Parquet, one complete generation at a
// time, incrementally, read back with DuckDB; how long a generation is kept,
// and the files removed once no kept generation names them. Synthetic archives
// only (scripts/signal-archive-fixture.mjs).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_ANALYSIS = path.join(REPO_ROOT, 'scripts', 'fixture-archive-analysis');

let duck;
let connection;
before(async () => {
  duck = await DuckDBInstance.create(':memory:');
  connection = await duck.connect();
});
after(() => {
  connection.closeSync();
  duck.closeSync();
});

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'in');
  await writeArchiveFixture(input);
  return { root, input, output: path.join(root, 'out') };
}

function publish(input, output, deps) {
  return publishSignalHistory({ asset: FIXTURE_ASSET, input, output }, deps);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

function sqlList(files) {
  return files.map((file) => `'${file.replaceAll("'", "''")}'`).join(', ');
}

/** A dataset's rows as DuckDB reads them, in the order its manifest states. */
async function datasetRows(output, manifest, name) {
  const dataset = name === 'sources' ? manifest.sources : manifest.datasets.find((entry) => entry.name === name);
  if (dataset.files.length === 0) return [];
  const order = name === 'sources' ? 'filename, file_row_number' : dataset.rowOrder.join(', ');
  const reader = await connection.runAndReadAll(
    `SELECT * EXCLUDE (file_row_number, filename) FROM read_parquet([${sqlList(datasetFiles(output, manifest, name))}], file_row_number = true, filename = true) ORDER BY ${order}`,
  );
  return reader.getRowObjectsJS();
}

/** Every file and folder under `root` with its size and modification time. */
async function tree(root) {
  const entries = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = await fs.stat(target);
      entries.push(`${path.relative(root, target)} ${stat.size} ${stat.mtimeMs}`);
      if (entry.isDirectory()) await walk(target);
    }
  }
  await walk(root);
  return entries.sort();
}

async function inputHashes(input) {
  const hashes = {};
  for (const file of await archiveFiles(input)) hashes[path.relative(input, file)] = sha256(await fs.readFile(file));
  hashes['manifest.json'] = sha256(await fs.readFile(path.join(input, 'manifest.json')));
  return hashes;
}

/**
 * The oracle: the shared rules over the same folder, in the analyzer's reading
 * order, keeping the archive read last for each report day (the reader's rule
 * the archive rules leave to it). Families of rows without lineage.
 */
async function sharedReading(input) {
  const confirmations = manifestConfirmations(await readDownloadsManifest(input));
  const read = [];
  for (const file of await archiveFiles(input)) {
    try {
      read.push({ file, archive: parseArchive(await fs.readFile(file, 'utf8'), { asset: FIXTURE_ASSET, source: file }) });
    } catch {
      // Unreadable: no rows.
    }
  }
  const last = new Map(read.map(({ file, archive }) => [reportDayKey(archive), file]));
  const families = new Map();
  for (const { file, archive } of read) {
    if (last.get(reportDayKey(archive)) !== file) continue;
    const family = archiveFamily(archive);
    families.set(family, [...(families.get(family) ?? []), ...archiveRows(archive, confirmations)]);
  }
  for (const [family, rows] of families) families.set(family, resolveFamily(family, rows));
  const coverage = indexCoverageRows(families);
  if (coverage.length > 0) families.set(INDEX_COVERAGE_FAMILY, coverage);
  return families;
}

/** A row as its dataset stores it: typed, empty as null, text for text. */
function stored(row, schema) {
  return Object.fromEntries(
    schema.columns
      .filter(([column]) => !LINEAGE_COLUMNS.includes(column))
      .map(([column, type]) => {
        const value = row[column];
        if (value === '' || value === undefined || value === null) return [column, null];
        return [column, type === 'VARCHAR' ? String(value) : value];
      }),
  );
}

function withoutLineage(row) {
  return Object.fromEntries(Object.entries(row).filter(([column]) => !LINEAGE_COLUMNS.includes(column)));
}

/** RFC 4180, as the analyzer writes it. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  return rows;
}

test('every dataset holds exactly the rows the shared archive rules give, typed, in their order', async (t) => {
  const { input, output } = await workspace(t);
  const result = await publish(input, output);
  assert.equal(result.published, true);
  assert.equal(result.generation, 1);
  const manifest = await readCurrentGeneration(output);
  const expected = await sharedReading(input);
  assert.deepEqual(manifest.datasets.map((dataset) => dataset.name), [...expected.keys()].sort());
  for (const dataset of manifest.datasets) {
    const rows = await datasetRows(output, manifest, dataset.name);
    const reference = expected.get(dataset.name);
    // No column is lost: the schema names every column a row carries.
    const columns = new Set(dataset.schema.columns.map(([column]) => column));
    for (const row of reference) for (const column of Object.keys(row)) assert.ok(columns.has(column), `${dataset.name}.${column}`);
    assert.equal(dataset.rows, reference.length, dataset.name);
    assert.deepEqual(rows.map(withoutLineage), reference.map((row) => stored(row, dataset.schema)), dataset.name);
  }
});

test('read as text, a dataset is the analyzer’s CSV, but for a report day delivered twice', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const manifest = await readCurrentGeneration(output);
  const sources = await datasetRows(output, manifest, 'sources');
  const extraRows = new Map();
  for (const row of sources.filter((entry) => entry.state === 'superseded')) {
    extraRows.set(row.family, (extraRows.get(row.family) ?? 0) + row.rows);
  }
  // Where the rules resolve a day, the second delivery changes nothing: the
  // copy read last wins either way. Where they keep every row, the analyzer
  // counts the day twice and the dataset once.
  const countedTwice = [...extraRows.keys()].filter((family) => !resolvesAcrossReportDays(family)).sort();
  assert.deepEqual(countedTwice, ['bing-webmaster-crawl-stats', 'gsc-country', 'gsc-query']);
  for (const dataset of manifest.datasets) {
    const csv = parseCsv(await fs.readFile(path.join(EXPECTED_ANALYSIS, `${dataset.name}.csv`), 'utf8'));
    const [header = [], ...lines] = csv;
    const rows = await datasetRows(output, manifest, dataset.name);
    if (countedTwice.includes(dataset.name)) {
      assert.equal(lines.length, rows.length + extraRows.get(dataset.name), dataset.name);
      continue;
    }
    assert.equal(rows.length, lines.length, dataset.name);
    if (lines.length === 0) continue;
    assert.deepEqual(
      dataset.schema.columns.map(([column]) => column).filter((column) => !LINEAGE_COLUMNS.includes(column)),
      header,
      dataset.name,
    );
    rows.forEach((row, index) => {
      assert.deepEqual(header.map((column) => String(row[column] ?? '')), lines[index], `${dataset.name} row ${index}`);
    });
  }
  // gsc-query: the analyzer counts 2026-09-20 twice (96 rows); the dataset once.
  assert.equal(manifest.datasets.find((dataset) => dataset.name === 'gsc-query').rows, 90);
});

test('every row names its source archive, its hash, family, report day, schema and derivation', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const manifest = await readCurrentGeneration(output);
  const objectKeys = new Map(fixtureManifest().objects.map((row) => [reportDayKey(row), row.objectKey ?? null]));
  let traced = 0;
  for (const dataset of manifest.datasets) {
    for (const row of await datasetRows(output, manifest, dataset.name)) {
      const bytes = await fs.readFile(path.join(input, row.source_path));
      assert.equal(row.source_sha256, sha256(bytes), row.source_path);
      const archive = JSON.parse(bytes.toString('utf8'));
      assert.equal(`${archive.integration}-${archive.report}`, row.source_family);
      assert.equal(
        row.source_family === dataset.name || (dataset.name === INDEX_COVERAGE_FAMILY && INDEX_COVERAGE_SOURCES.includes(row.source_family)),
        true,
      );
      assert.equal(archive.reportDate, row.report_date);
      assert.equal(row.source_object_key, objectKeys.get(reportDayKey(archive)) ?? null);
      assert.equal(row.schema_id, dataset.schema.id);
      assert.equal(row.derivation_id, manifest.derivation.id);
      traced += 1;
    }
  }
  assert.equal(traced, manifest.datasets.reduce((total, dataset) => total + dataset.rows, 0));
  // A GA4 day the manifest names carries its object key.
  const ga4 = await datasetRows(output, manifest, 'ga4-traffic-acquisition');
  assert.equal(ga4.find((row) => row.report_date === '2026-09-20').source_object_key, 'raw/ga4/traffic-acquisition/2026-09-20.json.gz');
  // Each file says what it holds, for a reader that finds it without a manifest.
  const file = datasetFiles(output, manifest, 'gsc-query')[0];
  const meta = (await connection.runAndReadAll(
    `SELECT decode(key) AS key, decode(value) AS value FROM parquet_kv_metadata('${file}') WHERE decode(key) LIKE 'noticeos_%' ORDER BY 1`,
  )).getRowObjectsJS();
  const gscQuery = manifest.datasets.find((dataset) => dataset.name === 'gsc-query');
  assert.deepEqual(meta, [
    { key: 'noticeos_dataset', value: 'gsc-query' },
    { key: 'noticeos_derivation_id', value: manifest.derivation.id },
    { key: 'noticeos_fingerprint', value: gscQuery.files[0].fingerprint },
    { key: 'noticeos_schema_id', value: gscQuery.schema.id },
  ]);
});

test('a second run over the same archive writes nothing', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await tree(output);
  const again = await publish(input, output);
  assert.equal(again.published, false);
  assert.equal(again.generation, 1);
  assert.deepEqual(again.written, []);
  // Every archive is hashed; none is parsed.
  assert.deepEqual([again.archivesFound, again.archivesParsed], [105, 0]);
  assert.deepEqual(await tree(output), first);
});

test('a late correction rewrites only the period it falls in; the previous generation still reads as it was', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  const firstRows = await datasetRows(output, first, 'gsc-query');
  const day = path.join(input, 'gsc', 'query', '2026-09-14.json');
  const archive = await readJson(day);
  archive.pages[0].response.rows[0].clicks += 1000;
  await writeJson(day, archive);

  const result = await publish(input, output);
  assert.equal(result.published, true);
  const second = await readCurrentGeneration(output);
  assert.equal(second.generation, 2);
  assert.equal(second.previous, 1);
  // One dataset file changed, and the register period that lists the archive.
  assert.deepEqual(result.written.map((file) => file.split('/').slice(0, 3).join('/')).sort(), [
    'data/gsc-query/2026-09',
    'data/sources/2026-09',
  ]);
  // The changed archive once to learn its columns, then that month's fifteen
  // report days of the family to write the file: nothing else.
  assert.equal(result.archivesParsed, 1 + 15);
  for (const dataset of second.datasets) {
    const was = first.datasets.find((entry) => entry.name === dataset.name);
    if (dataset.name === 'gsc-query') assert.notDeepEqual(dataset.files, was.files);
    else assert.deepEqual(dataset.files, was.files, dataset.name);
  }
  const corrected = (await datasetRows(output, second, 'gsc-query')).find((row) => row.report_date === '2026-09-14' && row.query === 'meal planner');
  const original = firstRows.find((row) => row.report_date === '2026-09-14' && row.query === 'meal planner');
  assert.equal(corrected.clicks, original.clicks + 1000);
  assert.equal(corrected.source_sha256, sha256(await fs.readFile(day)));
  // Generation 1 is untouched and still reads its own rows.
  assert.deepEqual(await readGeneration(output, 1), first);
  assert.deepEqual(await datasetRows(output, first, 'gsc-query'), firstRows);
});

test('a later confirmation settles a provisional GA4 day with no new archive bytes', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  const provisional = async (manifest) => Object.fromEntries(
    (await datasetRows(output, manifest, 'ga4-traffic-acquisition'))
      .filter((row) => row.sessionDefaultChannelGroup === 'Direct')
      .map((row) => [row.report_date, row.provisional]),
  );
  assert.deepEqual(await provisional(first), { '2026-09-18': 0, '2026-09-19': 0, '2026-09-20': 1, latest: null });

  const manifestFile = path.join(input, 'manifest.json');
  const downloads = await readJson(manifestFile);
  downloads.objects.find((row) => row.report === 'traffic-acquisition' && row.reportDate === '2026-09-20').finishedAt = '2026-09-22T12:16:02.000Z';
  await writeJson(manifestFile, downloads);

  const result = await publish(input, output);
  assert.equal(result.published, true);
  const second = await readCurrentGeneration(output);
  assert.deepEqual(await provisional(second), { '2026-09-18': 0, '2026-09-19': 0, '2026-09-20': 0, latest: null });
  // Only that day's period, and the register that records the confirmation.
  assert.deepEqual(result.written.map((file) => file.split('/').slice(0, 3).join('/')).sort(), [
    'data/ga4-traffic-acquisition/2026-09',
    'data/sources/2026-09',
  ]);
  assert.equal(result.archivesParsed, 1 + 3);
  const register = await datasetRows(output, second, 'sources');
  assert.equal(register.find((row) => row.path === 'ga4/traffic-acquisition/2026-09-20.json').confirmed_at, '2026-09-22T12:16:02.000Z');
});

test('an incremental build and a full rebuild of the same archive are the same, through every kind of change', async (t) => {
  const { root, input, output } = await workspace(t);
  const gscDay = (reportDate, clicks) => ({
    schemaVersion: 1,
    asset: FIXTURE_ASSET,
    integration: 'gsc',
    report: 'query',
    reportDate,
    collectedAt: `${reportDate}T23:00:00.000Z`,
    dataState: 'provider-final',
    providerTruncated: false,
    pages: [{ request: { dimensions: ['query'] }, response: { rows: [{ keys: ['meal planner'], clicks, impressions: 90, ctr: clicks / 90, position: 3.1 }] } }],
  });
  const steps = [
    ['the archive as delivered', async () => {}],
    ['a new day and a new month', async () => {
      await writeJson(path.join(input, 'gsc', 'query', '2026-09-22.json'), gscDay('2026-09-22', 4));
      await writeJson(path.join(input, 'gsc', 'query', '2026-10-01.json'), gscDay('2026-10-01', 6));
    }],
    ['a late correction', async () => {
      await writeJson(path.join(input, 'gsc', 'query', '2026-09-22.json'), gscDay('2026-09-22', 5));
    }],
    ['a confirmation', async () => {
      const file = path.join(input, 'manifest.json');
      const downloads = await readJson(file);
      downloads.objects.find((row) => row.report === 'traffic-acquisition' && row.reportDate === '2026-09-20').finishedAt = '2026-09-22T12:16:02.000Z';
      await writeJson(file, downloads);
    }],
    ['an unreadable archive and a missing one', async () => {
      await fs.writeFile(path.join(input, 'gsc', 'page', '2026-09-22.json'), '{"schemaVersion": 1, "asset"');
      await fs.rm(path.join(input, 'gsc', 'page', '2026-09-10.json'));
    }],
    ['a new column', async () => {
      const file = path.join(input, 'bing-webmaster', 'crawl-stats', '2026-09-21.json');
      const archive = await readJson(file);
      archive.pages[0].response.d[0].AllowedByRobotsTxt = 17;
      await writeJson(file, archive);
    }],
    ['a changed type', async () => {
      const file = path.join(input, 'gsc', 'query', '2026-10-01.json');
      const archive = await readJson(file);
      archive.pages[0].response.rows[0].position = 'n/a';
      await writeJson(file, archive);
    }],
    ['an archive removed', async () => {
      await fs.rm(path.join(input, 'gsc', 'query', '2026-10-01.json'));
    }],
  ];
  const schemaIds = [];
  let previousStep = null;
  for (const [index, [label, change]] of steps.entries()) {
    await change();
    const incremental = await publish(input, output);
    const rebuild = path.join(root, `rebuild-${index}`);
    await publish(input, rebuild);
    const kept = await readCurrentGeneration(output);
    const fresh = await readCurrentGeneration(rebuild);
    assert.equal(incremental.published, true, label);
    assert.equal(kept.content, fresh.content, label);
    const files = (manifest) => [
      ...manifest.sources.files.map((file) => file.path),
      ...manifest.datasets.flatMap((dataset) => dataset.files.map((file) => file.path)),
    ];
    assert.deepEqual(files(kept), files(fresh), label);
    // A file's name is the hash of its rows; the rows of every dataset this
    // step changed are compared as DuckDB reads them too.
    for (const dataset of kept.datasets) {
      const was = previousStep?.datasets.find((entry) => entry.name === dataset.name);
      if (was && isDeepStrictEqual(was.files, dataset.files)) continue;
      assert.deepEqual(await datasetRows(output, kept, dataset.name), await datasetRows(rebuild, fresh, dataset.name), `${label}: ${dataset.name}`);
    }
    assert.deepEqual(await datasetRows(output, kept, 'sources'), await datasetRows(rebuild, fresh, 'sources'), label);
    schemaIds.push(Object.fromEntries(kept.datasets.map((dataset) => [dataset.name, dataset.schema.id])));
    previousStep = kept;
  }
  // The new column and the changed type each made a new schema, and nothing else did.
  const changed = (from, to) => Object.keys(schemaIds[to]).filter((name) => schemaIds[from][name] !== schemaIds[to][name]).sort();
  assert.deepEqual(changed(4, 5), ['bing-webmaster-crawl-stats']);
  assert.deepEqual(changed(5, 6), ['gsc-query']);
  assert.deepEqual(changed(1, 2), []);
});

test('a schema change is a new schema id on every file of the family; the old generation keeps the old one', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  const file = path.join(input, 'bing-webmaster', 'crawl-stats', '2026-09-21.json');
  const archive = await readJson(file);
  archive.pages[0].response.d[0].AllowedByRobotsTxt = 17;
  await writeJson(file, archive);
  await publish(input, output);
  const second = await readCurrentGeneration(output);
  const was = first.datasets.find((dataset) => dataset.name === 'bing-webmaster-crawl-stats');
  const now = second.datasets.find((dataset) => dataset.name === 'bing-webmaster-crawl-stats');
  assert.notEqual(now.schema.id, was.schema.id);
  assert.deepEqual(
    now.schema.columns.filter(([column]) => !was.schema.columns.some(([name]) => name === column)),
    [['allowed_by_robots_txt', 'DOUBLE']],
  );
  for (const [generation, dataset] of [[first, was], [second, now]]) {
    const rows = await datasetRows(output, generation, dataset.name);
    assert.deepEqual([...new Set(rows.map((row) => row.schema_id))], [dataset.schema.id]);
    const described = (await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_parquet([${sqlList(datasetFiles(output, generation, dataset.name))}])`,
    )).getRowObjectsJS();
    assert.deepEqual(described.map((column) => [column.column_name, column.column_type]), dataset.schema.columns);
  }
  // Only rows collected with the field carry it.
  const rows = await datasetRows(output, second, 'bing-webmaster-crawl-stats');
  assert.deepEqual(rows.filter((row) => row.allowed_by_robots_txt !== null).map((row) => [row.report_date, row.allowed_by_robots_txt]), [['2026-09-21', 17]]);
});

test('an interrupted run changes nothing a reader sees, and the next run finishes it', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  for (const day of ['2026-09-22', '2026-09-23']) {
    const next = await readJson(path.join(input, 'gsc', 'page', '2026-09-20.json'));
    next.reportDate = day;
    await writeJson(path.join(input, 'gsc', 'page', `${day}.json`), next);
  }
  const next = await readJson(path.join(input, 'bing-webmaster', 'feeds', '2026-09-21.json'));
  next.reportDate = '2026-09-22';
  await writeJson(path.join(input, 'bing-webmaster', 'feeds', '2026-09-22.json'), next);

  // The run dies while it writes its third new file: two have landed.
  let files = 0;
  const dying = async (...args) => {
    files += 1;
    if (files === 3) throw new Error('killed');
    await copyToParquet(...args);
  };
  await assert.rejects(publish(input, output, { writeFile: dying }), /killed/);
  assert.deepEqual(await readCurrentGeneration(output), first);
  for (const dataset of first.datasets) await datasetRows(output, first, dataset.name);
  const leftBehind = (await tree(output)).filter((entry) => entry.includes('.parquet') && !entry.includes('.tmp'));
  const named = new Set([
    ...first.sources.files.map((file) => file.path),
    ...first.datasets.flatMap((dataset) => dataset.files.map((file) => file.path)),
  ]);
  const orphans = leftBehind.map((entry) => entry.split(' ')[0]).filter((file) => !named.has(file));
  assert.equal(orphans.length, 2);
  assert.equal((await tree(output)).some((entry) => entry.includes('.tmp')), false);

  // The next run publishes, and the files the dead run finished are its own.
  const before = new Map((await tree(output)).map((entry) => [entry.split(' ')[0], entry]));
  const result = await publish(input, output);
  assert.equal(result.generation, 2);
  for (const orphan of orphans) {
    assert.equal(result.written.includes(orphan), false);
    assert.equal((await tree(output)).includes(before.get(orphan)), true, `${orphan} was not rewritten`);
  }
  const second = await readCurrentGeneration(output);
  const reference = await sharedReading(input);
  for (const dataset of second.datasets) {
    assert.deepEqual((await datasetRows(output, second, dataset.name)).map(withoutLineage), reference.get(dataset.name).map((row) => stored(row, dataset.schema)), dataset.name);
  }
});

test('a locked history reclaims only dead writers’ spill directories', async (t) => {
  const { root, input, output } = await workspace(t);
  await fs.mkdir(output);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const deadLink = spawnSync(process.execPath, ['-e', '']).pid;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(deadLink, 0), { code: 'ESRCH' });
  const stale = path.join(output, `.spill-${dead}`);
  const own = path.join(output, `.spill-${process.pid}`);
  const live = path.join(output, `.spill-${process.ppid}`);
  const unknown = path.join(output, '.spill-unrecognized');
  const external = path.join(root, 'external');
  for (const folder of [stale, own, live, unknown, external]) {
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'sentinel'), 'retained unless owned and dead');
  }
  const linked = path.join(output, `.spill-${deadLink}`);
  await fs.symlink(external, linked, 'dir');
  let checked = false;
  const result = await publish(input, output, { writeFile: async (...args) => {
    if (!checked) {
      checked = true;
      assert.equal(JSON.parse(await fs.readFile(path.join(output, '.lock'), 'utf8')).pid, process.pid);
      await assert.rejects(fs.access(stale), { code: 'ENOENT' });
      for (const folder of [own, live, unknown, linked, external]) await fs.access(path.join(folder, 'sentinel'));
    }
    await copyToParquet(...args);
  } });
  assert.equal(checked, true);
  for (const dataset of result.manifest.datasets) await datasetRows(output, result.manifest, dataset.name);
  for (const folder of [live, unknown, linked, external]) await fs.access(path.join(folder, 'sentinel'));
  // Only this run's ordinary finally removes its own scratch.
  await assert.rejects(fs.access(own), { code: 'ENOENT' });
});

test('a writer without the history lock cannot reclaim spill directories', async (t) => {
  const { input, output } = await workspace(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const stale = path.join(output, `.spill-${dead}`);
  let checked = false;
  await publish(input, output, { writeFile: async (...args) => {
    if (!checked) {
      checked = true;
      await fs.mkdir(stale);
      await fs.writeFile(path.join(stale, 'sentinel'), 'interrupted writer');
      await assert.rejects(publish(input, output), /Another signals:history run/);
      await fs.access(path.join(stale, 'sentinel'));
    }
    await copyToParquet(...args);
  } });
  assert.equal(checked, true);
  await fs.access(stale);
  assert.equal((await publish(input, output)).published, false);
  await assert.rejects(fs.access(stale), { code: 'ENOENT' });
});

test('one run at a time writes a history: a second is refused and changes nothing, and no generation is published over another', async (t) => {
  const { input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  const day = path.join(input, 'gsc', 'query', '2026-09-14.json');
  const archive = await readJson(day);
  archive.pages[0].response.rows[0].clicks += 1;
  await writeJson(day, archive);
  let raced = false;
  const racing = async (...args) => {
    if (!raced) {
      raced = true;
      // While this run writes its first file, a second run is refused.
      const during = await tree(output);
      await assert.rejects(publish(input, output), {
        message: `Another signals:history run (process ${process.pid}) is writing ${output}; nothing was changed.`,
      });
      assert.deepEqual(await tree(output), during);
      // A writer that ignored the lock publishes generation 2 first.
      await writeJson(path.join(output, 'generations', '00000002.json'), { ...first, generation: 2, previous: 1 });
    }
    await copyToParquet(...args);
  };
  await assert.rejects(publish(input, output, { writeFile: racing }), /Another run published generation 2 first/);
  assert.deepEqual(await listGenerations(output), [1, 2]);
  await assert.rejects(fs.access(path.join(output, '.lock')), /ENOENT/);
  // A lock whose run died is taken over.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await fs.writeFile(path.join(output, '.lock'), `${JSON.stringify({ pid: dead })}\n`);
  assert.equal((await publish(input, output)).generation, 3);
  assert.equal((await tree(output)).some((entry) => entry.startsWith('.lock')), false);
});

const DAY = 86_400_000;
const FIRST_RUN = Date.parse('2026-09-22T06:00:00.000Z');
/** The clock of the run `days` days after the first. */
const runDay = (days) => new Date(FIRST_RUN + days * DAY).toISOString();

/** A new GSC query report day, so the next run publishes a new generation. */
async function addQueryDay(input, reportDate) {
  const archive = await readJson(path.join(input, 'gsc', 'query', '2026-09-20.json'));
  archive.reportDate = reportDate;
  archive.collectedAt = `${reportDate}T23:00:00.000Z`;
  for (const row of archive.pages[0].response.rows) row.clicks += 1;
  await writeJson(path.join(input, 'gsc', 'query', `${reportDate}.json`), archive);
}

/** The report date `days` after 2026-09-21. */
const reportDay = (days) => new Date(Date.parse('2026-09-21T00:00:00.000Z') + days * DAY).toISOString().slice(0, 10);

/** Every file a generation lists, by its path under the history folder. */
function namedFiles(manifest) {
  return [manifest.sources, ...manifest.datasets].flatMap((dataset) => dataset.files);
}

/** Every data file on disk, by its path under the history folder. */
async function dataFiles(output) {
  const found = [];
  for (const entry of await fs.readdir(path.join(output, 'data'), { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) found.push(path.relative(output, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  }
  return found.sort();
}

/**
 * Every generation `output` lists reads whole: each file it names is there,
 * holds the bytes it recorded, and DuckDB reads the rows it recorded. Each
 * distinct file is read once. Returns the generations read.
 */
async function everyListedGenerationReads(output) {
  const read = new Set();
  const generations = await listGenerations(output);
  for (const generation of generations) {
    for (const entry of namedFiles(await readGeneration(output, generation))) {
      if (read.has(entry.path)) continue;
      const file = path.join(output, entry.path);
      assert.equal(sha256(await fs.readFile(file)), entry.sha256, `generation ${generation}: ${entry.path}`);
      const [{ rows }] = (await connection.runAndReadAll(`SELECT count(*)::INTEGER AS rows FROM read_parquet(${sqlList([file])})`)).getRowObjectsJS();
      assert.equal(rows, entry.rows, `generation ${generation}: ${entry.path}`);
      read.add(entry.path);
    }
  }
  return generations;
}

test('the history keeps every generation published less than 30 days ago, and the newest whatever its age', () => {
  assert.equal(KEEP_GENERATIONS_DAYS, 30);
  const now = runDay(40);
  const ago = (ms) => new Date(Date.parse(now) - ms).toISOString();
  assert.deepEqual(keptGenerations([
    { generation: 1, publishedAt: ago(40 * DAY) },
    { generation: 2, publishedAt: ago(30 * DAY) },
    { generation: 3, publishedAt: ago(30 * DAY - 1) },
    // A generation whose time cannot be read is never judged old.
    { generation: 4, publishedAt: 'not a time' },
    { generation: 5, publishedAt: ago(0) },
  ], now), [3, 4, 5]);
  assert.deepEqual(keptGenerations([{ generation: 6, publishedAt: ago(500 * DAY) }, { generation: 7, publishedAt: ago(400 * DAY) }], now), [7]);
  assert.deepEqual(keptGenerations([], now), []);
});

test('forty daily runs keep exactly the thirty generations of the last 30 days; every file they name reads, and no other data file remains', async (t) => {
  const { input, output } = await workspace(t);
  const window = KEEP_GENERATIONS_DAYS;
  for (let day = 0; day < window + 10; day++) {
    if (day > 0) await addQueryDay(input, reportDay(day));
    const downloads = [await inputHashes(input), await tree(input)];
    const result = await publish(input, output, { now: () => runDay(day) });
    assert.equal(result.generation, day + 1);
    // Generation g was published on day g - 1; on day d it is kept while d - (g - 1) < 30.
    const kept = Array.from({ length: day + 1 }, (_, index) => index + 1).filter((generation) => day - (generation - 1) < window);
    assert.deepEqual(await listGenerations(output), kept, `day ${day}`);
    assert.deepEqual(result.keptGenerations, kept, `day ${day}`);
    assert.deepEqual(result.removedGenerations, day >= window ? [day - window + 1] : [], `day ${day}`);
    assert.deepEqual([await inputHashes(input), await tree(input)], downloads, `day ${day}: the downloads folder is only read`);
  }
  assert.deepEqual(await listGenerations(output), Array.from({ length: window }, (_, index) => index + 11));
  assert.deepEqual(await everyListedGenerationReads(output), Array.from({ length: window }, (_, index) => index + 11));
  const named = new Set();
  for (const generation of await listGenerations(output)) for (const entry of namedFiles(await readGeneration(output, generation))) named.add(entry.path);
  assert.deepEqual(await dataFiles(output), [...named].sort());
  assert.equal((await tree(output)).some((entry) => entry.includes('.tmp') || entry.startsWith('.lock')), false);

  // Nothing new for 45 days: the newest is kept whatever its age, and alone.
  const downloads = [await inputHashes(input), await tree(input)];
  const idle = await publish(input, output, { now: () => runDay(window + 10 + 45) });
  assert.equal(idle.published, false);
  assert.deepEqual(idle.removedGenerations, Array.from({ length: window - 1 }, (_, index) => index + 11));
  assert.deepEqual(await listGenerations(output), [40]);
  await everyListedGenerationReads(output);
  assert.deepEqual(await dataFiles(output), namedFiles(await readGeneration(output, 40)).map((entry) => entry.path).sort());
  assert.deepEqual([await inputHashes(input), await tree(input)], downloads);
  assert.match(describeRun(idle, output).join('\n'), /^Nothing changed since generation 40: no file written\.\nRemoved 29 generations published 30 or more days ago and \d+ files no kept generation names; 1 generation kept\.$/m);
});

test('a removal interrupted at any point leaves every listed generation readable and the rest untouched, and the next run finishes it', async (t) => {
  const { root, input, output } = await workspace(t);
  // Generations 1-4 on days 0-3; generation 5, on day 31, no longer keeps 1 and 2.
  for (let day = 0; day < 4; day++) {
    if (day > 0) await addQueryDay(input, reportDay(day));
    await publish(input, output, { now: () => runDay(day) });
  }
  await addQueryDay(input, reportDay(10));
  // What runs that died left, which no generation names …
  const parquet = datasetFiles(output, await readGeneration(output, 1), 'gsc-query')[0];
  const planted = {
    'data/gsc-query/2026-11/0123456789abcdef0123456789abcdef.parquet': parquet,
    'data/retired-family/2026-08/fedcba9876543210fedcba9876543210.parquet': parquet,
    'data/gsc-query/2026-09/.0123456789abcdef0123456789abcdef.4242.0badcafe.tmp': null,
    'generations/.00000005.json.4242.0badcafe.tmp': null,
  };
  // … and files that are not the writer's, which stay.
  const foreign = ['notes.txt', 'data/README.md', 'data/gsc-query/notes.txt', 'generations/README.md', 'data/gsc-query/2026-09/copy.parquet'];
  for (const [relative, from] of Object.entries(planted)) {
    await fs.mkdir(path.dirname(path.join(output, relative)), { recursive: true });
    if (from) await fs.copyFile(from, path.join(output, relative));
    else await fs.writeFile(path.join(output, relative), 'half');
  }
  for (const relative of foreign) await fs.writeFile(path.join(output, relative), 'not the writer\'s');
  const snapshot = path.join(root, 'snapshot');
  await fs.cp(output, snapshot, { recursive: true });
  const paths = async (folder) => (await tree(folder)).map((entry) => entry.split(' ')[0]);
  const fresh = async (name) => {
    const copy = path.join(root, name);
    await fs.cp(snapshot, copy, { recursive: true });
    return copy;
  };

  // Uninterrupted: every removal point, in order.
  const whole = await fresh('whole');
  const points = [];
  const result = await publish(input, whole, { now: () => runDay(31), beforeRemove: (relative) => points.push(relative) });
  assert.equal(result.generation, 5);
  assert.deepEqual(result.removedGenerations, [1, 2]);
  // The manifests first, then each file no kept generation names — the
  // September files of generations 1 and 2, which later ones replaced, and what
  // runs that died left — and the folders left empty.
  assert.deepEqual(points.map((relative) => relative.replace(/\/[0-9a-f]{32}\.parquet$/, '/<file>.parquet')), [
    'generations/00000001.json',
    'generations/00000002.json',
    'generations/.00000005.json.4242.0badcafe.tmp',
    'data/gsc-query/2026-09/.0123456789abcdef0123456789abcdef.4242.0badcafe.tmp',
    'data/gsc-query/2026-09/<file>.parquet',
    'data/gsc-query/2026-09/<file>.parquet',
    'data/gsc-query/2026-11/<file>.parquet',
    'data/gsc-query/2026-11',
    'data/retired-family/2026-08/<file>.parquet',
    'data/retired-family/2026-08',
    'data/retired-family',
    'data/sources/2026-09/<file>.parquet',
    'data/sources/2026-09/<file>.parquet',
  ]);
  for (const relative of Object.keys(planted)) assert.ok(points.includes(relative), relative);
  const finished = await paths(whole);
  for (const relative of foreign) assert.ok(finished.includes(relative.split('/').join(path.sep)), relative);
  assert.deepEqual(await everyListedGenerationReads(whole), [3, 4, 5]);
  const named = new Set();
  for (const generation of [3, 4, 5]) for (const entry of namedFiles(await readGeneration(whole, generation))) named.add(entry.path);
  assert.deepEqual((await dataFiles(whole)).filter((file) => file.endsWith('.parquet') && !file.endsWith('copy.parquet')), [...named].sort());

  // Interrupted before each removal in turn.
  for (const [index, point] of points.entries()) {
    const copy = await fresh(`interrupted-${index}`);
    let seen = 0;
    const dying = (relative) => {
      if (seen++ === index) throw new Error(`interrupted at ${relative}`);
    };
    await assert.rejects(publish(input, copy, { now: () => runDay(31), beforeRemove: dying }), {
      message: `Generation 5 published, but removing what the history no longer keeps stopped: interrupted at ${point}. Every generation still listed reads; the next run finishes the removal.`,
    });
    const listed = await everyListedGenerationReads(copy);
    for (const generation of [3, 4, 5]) assert.ok(listed.includes(generation), `${point}: generation ${generation}`);
    for (const relative of foreign) assert.equal(await fs.readFile(path.join(copy, relative), 'utf8'), 'not the writer\'s', `${point}: ${relative}`);
    const again = await publish(input, copy, { now: () => runDay(31) });
    assert.equal(again.published, false, point);
    assert.deepEqual(await paths(copy), finished, point);
  }

  // An older manifest that cannot be read stops the removal before anything goes.
  const unreadable = await fresh('unreadable');
  await fs.writeFile(path.join(unreadable, 'generations', '00000001.json'), '{"format"');
  const before = await paths(unreadable);
  await assert.rejects(publish(input, unreadable, { now: () => runDay(31) }), /^Error: Generation 5 published, but removing what the history no longer keeps stopped: generations\/00000001\.json cannot be read \(.+\), so which files it names is unknown and nothing was removed\. Every generation still listed reads; the next run finishes the removal\.$/);
  const added = (await paths(unreadable)).filter((entry) => !before.includes(entry));
  assert.equal(added.every((entry) => entry.startsWith(`generations${path.sep}00000005`) || entry.startsWith(`data${path.sep}`)), true, added.join(', '));
  // Nothing that was there has gone.
  for (const entry of before) await fs.access(path.join(unreadable, entry));
});

test('unreadable, superseded and missing archives are listed in the register and add no rows', async (t) => {
  const { input, output } = await workspace(t);
  await fs.writeFile(path.join(input, 'gsc', 'page', '2026-09-22.json'), 'not json');
  await writeJson(path.join(input, 'gsc', 'page', '2026-09-23.json'), { schemaVersion: 1, asset: 'other.example', integration: 'gsc', report: 'page', reportDate: '2026-09-23' });
  const result = await publish(input, output);
  assert.deepEqual(result.unreadable, [
    { path: 'gsc/page/2026-09-22.json', reason: 'not JSON' },
    { path: 'gsc/page/2026-09-23.json', reason: 'Unsupported or wrong-property signal archive: gsc/page/2026-09-23.json' },
  ]);
  assert.deepEqual(result.missing, [{ integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-17' }]);
  const manifest = await readCurrentGeneration(output);
  const register = await datasetRows(output, manifest, 'sources');
  const byState = (state) => register.filter((row) => row.state === state);
  assert.deepEqual(byState('unreadable').map((row) => [row.path, row.report_date, row.rows]), [
    ['gsc/page/2026-09-22.json', null, null],
    ['gsc/page/2026-09-23.json', null, null],
  ]);
  assert.deepEqual(byState('missing').map((row) => [row.family, row.report_date, row.object_key, row.path]), [
    ['ga4-traffic-acquisition', '2026-09-17', 'raw/ga4/traffic-acquisition/2026-09-17.json.gz', null],
  ]);
  assert.deepEqual(byState('superseded').map((row) => [row.path, row.superseded_by]), [
    ['bing-webmaster/ai-overview/2026-09-01.json', 'extra/bing-ai-overview-2026-09-01.json'],
    ['bing-webmaster/crawl-stats/2026-09-20.json', 'extra/bing-crawl-stats-2026-09-20.json'],
    ['extra/gsc-country-2026-09-20.json', 'gsc/country/2026-09-20.json'],
    ['extra/gsc-query-2026-09-20.json', 'gsc/query/2026-09-20.json'],
    ['extra/posthog-web-daily-2026-09-21.json', 'posthog/web-daily/2026-09-21.json'],
    ['gsc/country/2026-09-18.json', 'late/gsc-country-2026-09-18.json'],
  ]);
  // Every archive under the folder is in the register, once; the notes and the
  // compressed copy are not archives.
  const found = (await archiveFiles(input)).map((file) => path.relative(input, file).split(path.sep).join('/'));
  assert.deepEqual(register.filter((row) => row.path !== null).map((row) => row.path).sort(), found.sort());
  const gscPage = await datasetRows(output, manifest, 'gsc-page');
  assert.equal(gscPage.some((row) => ['2026-09-22', '2026-09-23'].includes(row.report_date)), false);
  assert.equal(register.every((row) => row.derivation_id === manifest.derivation.id && row.schema_id === manifest.sources.schema.id), true);
});

test('the register keeps each archive’s own envelope, and the manifest names the downloads folder it read', async (t) => {
  const { root, input, output } = await workspace(t);
  await publish(input, output);
  const first = await readCurrentGeneration(output);
  assert.equal(first.downloadsFolder, path.relative(REPO_ROOT, input));
  const register = await datasetRows(output, first, 'sources');
  for (const row of register) {
    if (row.state !== 'read' && row.state !== 'superseded') {
      assert.equal(row.envelope, null, row.path ?? row.family);
      continue;
    }
    const archive = await readJson(path.join(input, row.path));
    assert.equal(row.envelope, JSON.stringify({
      reportDate: archive.reportDate,
      ...(archive.integration === 'clarity' ? { collectedAt: archive.collectedAt } : {}),
      providerRows: archive.providerRows,
      providerTruncated: archive.providerTruncated,
    }), row.path);
  }
  // A body written by hand states neither count: the envelope says so, rather
  // than a zero or a false.
  assert.equal(register.find((row) => row.path === 'posthog/events/2026-09-14.json').envelope, '{"reportDate":"2026-09-14"}');

  // The same archive in a moved folder: a generation naming the new folder,
  // with the same content and not one file rewritten.
  const moved = path.join(root, 'moved');
  await fs.rename(input, moved);
  const result = await publish(moved, output);
  assert.equal(result.published, true);
  assert.deepEqual(result.written, []);
  const second = await readCurrentGeneration(output);
  assert.equal(second.generation, 2);
  assert.equal(second.content, first.content);
  assert.equal(second.downloadsFolder, path.relative(REPO_ROOT, moved));
  assert.equal((await publish(moved, output)).published, false);
});

test('the raw archive is only read: every byte under the downloads folder is unchanged', async (t) => {
  const { input, output } = await workspace(t);
  const hashes = await inputHashes(input);
  const listing = await tree(input);
  await publish(input, output);
  await publish(input, output);
  assert.deepEqual(await inputHashes(input), hashes);
  assert.deepEqual(await tree(input), listing);
});

test('the derivation covers every file that decides a row', async () => {
  // Every relative import of a derivation file is itself a derivation file.
  for (const relative of DERIVATION_FILES) {
    const text = await fs.readFile(path.join(REPO_ROOT, relative), 'utf8');
    for (const [, specifier] of text.matchAll(/^import[^'"]*from\s+'(\.[^']+)'/gm)) {
      const target = path.relative(REPO_ROOT, path.resolve(path.dirname(path.join(REPO_ROOT, relative)), specifier)).split(path.sep).join('/');
      assert.ok(DERIVATION_FILES.includes(target), `${relative} imports ${target}`);
    }
  }
});

test('it refuses what would mix or misplace a history', async (t) => {
  const { root, input, output } = await workspace(t);
  await assert.rejects(publishSignalHistory({ asset: FIXTURE_ASSET, input, output: path.join(input, 'history') }), /must not contain each other/);
  await assert.rejects(publishSignalHistory({ asset: FIXTURE_ASSET, input: root, output }), /must not contain each other/);
  await assert.rejects(publishSignalHistory({ asset: 'Not A Site', input, output }), /site id/);
  await assert.rejects(publishSignalHistory({ asset: FIXTURE_ASSET, input: path.join(root, 'nowhere'), output }), /not a folder/);
  await publish(input, output);
  await assert.rejects(publishSignalHistory({ asset: 'other.example', input, output }), /holds meals\.example's history/);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--in', 'a']), /--in and --out are both required/);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--in', 'a', '--out', 'b', '--bogus', 'x']), /Unknown option: --bogus/);
  assert.throws(() => parseArgs(['--asset', 'example.com', '--in']), /--in needs a value/);
  assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('the command publishes, then says nothing changed', async (t) => {
  const { input, output } = await workspace(t);
  const run = () => spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'signal-history.mjs'), '--asset', FIXTURE_ASSET, '--in', input, '--out', output], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const lines = first.stdout.trim().split('\n');
  assert.match(lines[0], /^Generation 1 published → .*generations\/00000001\.json: 45 datasets, 49 files written, 0 kept\.$/);
  assert.ok(lines.includes('Named by the downloads manifest, no archive: ga4 traffic-acquisition 2026-09-17'));
  assert.ok(lines.includes('Superseded by gsc/query/2026-09-20.json: extra/gsc-query-2026-09-20.json'));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout.split('\n')[0], 'Nothing changed since generation 1: no file written.');
  const quiet = { published: false, generation: 3, written: [], kept: 0, unreadable: [{ path: 'a.json', reason: 'not JSON' }], superseded: [], missing: [], keptGenerations: [2, 3], removedGenerations: [], removedFiles: 0 };
  assert.deepEqual(describeRun(quiet, output), [
    'Nothing changed since generation 3: no file written.',
    'Unreadable, no rows: a.json — not JSON',
  ]);
  assert.deepEqual(describeRun({ ...quiet, unreadable: [], removedGenerations: [1], removedFiles: 1 }, output), [
    'Nothing changed since generation 3: no file written.',
    'Removed 1 generation published 30 or more days ago and 1 file no kept generation names; 2 generations kept.',
  ]);
});
