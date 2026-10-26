import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyProductDataAvailability, productCollectionAvailability, productDataColumns } from './product-data-pack.mjs';
import { archivePath, freshnessReport, localProductDataAvailability } from './signal-panels-refresh.mjs';
import { publishSignalHistory, readCurrentGeneration, datasetFiles } from './signal-history.mjs';
import { DuckDBInstance } from '@duckdb/node-api';
import { writeReport } from './signal-history-analyze.mjs';
import { fixtureValueEvents } from './signal-archive-fixture.mjs';
import { archiveRows, parseArchive, archiveFamily } from './signal-archive.mjs';

const archive = (report, response) => ({ schemaVersion: 1, asset: 'example.com', integration: 'product-data', report,
  reportDate: '2026-10-20', collectedAt: '2026-10-26T12:00:00.000Z', dataState: 'provider-snapshot', providerTruncated: false,
  pages: [{ response }] });
const read = (report, response) => {
  const value = parseArchive(JSON.stringify(archive(report, response)), { asset: 'example.com', source: 'fixture' });
  assert.equal(archiveFamily(value), `product-data-${report}`);
  return archiveRows(value, new Map());
};
const generatedAt = '2026-10-20T12:00:00.000Z';

test('product documents retain raw unknown blocks and their own freshness', () => {
  const document = { generatedAt, firstResults: [], newAccountsDaily: null, futureBlock: { rate: null } };
  const [row] = read('metrics', { generatedAt, document });
  assert.deepEqual(JSON.parse(row.document_json), document);
  assert.equal(row.generated_at, generatedAt);
  assert.equal(row.report_date, '2026-10-20');
  assert.equal(row.collected_at, '2026-10-26T12:00:00.000Z');
});

test('normalized block columns keep zeros and nullable values', () => {
  const [row] = read('metrics-first-results', { generatedAt, rows: [{ week: '2026-42', matured: 4, any_result: 0, plan: 0, recipe: 0, log: 0 }] });
  assert.equal(row.matured, 4);
  assert.equal(row.any_result, 0);
  assert.deepEqual(read('metrics-first-results-by-intent', { generatedAt, rows: [] }), []);
  const availability = read('metrics-availability', { generatedAt, rows: [
    { block: 'firstResultsByIntent', state: 'null', row_count: null },
    { block: 'firstResults', state: 'available', row_count: 0 },
    { block: 'newAccountsDaily', state: 'missing', row_count: null },
  ] });
  assert.deepEqual(availability.map(row => [row.state, row.row_count]), [['null', null], ['available', 0], ['missing', null]]);
});

test('malformed block rows fail instead of disappearing from a report', () => {
  assert.throws(() => read('metrics-first-results', { generatedAt, rows: [{ matured: { nested: 3 } }] }), /Malformed product data row/);
});

test('latest local block availability marks an older successful block unknown', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-product-availability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = [
    { integration: 'product-data', report: 'metrics-first-results-by-intent', reportDate: '2026-10-19' },
    { integration: 'product-data', report: 'metrics-availability', reportDate: '2026-10-20' },
  ];
  const latest = archive('metrics-availability', { generatedAt, rows: [
    { block: 'firstResultsByIntent', state: 'null', row_count: null },
    { block: 'firstResults', state: 'available', row_count: 0 },
    { block: 'newAccountsDaily', state: 'missing', row_count: null },
  ] });
  const file = archivePath(root, 'example.com', manifest[1]);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(latest));
  const availability = await localProductDataAvailability(root, 'example.com', manifest);
  const freshness = applyProductDataAvailability(freshnessReport({ asset: 'example.com', manifest,
    maxAgeDays: 7, refreshedAt: '2026-10-26T12:00:00.000Z' }), availability);
  const families = new Map(freshness.families.map(row => [row.family, row]));
  assert.equal(families.get('product-data-metrics-first-results-by-intent').collection.state, 'unknown');
  assert.equal(families.get('product-data-metrics-first-results-by-intent').availability, 'null');
  assert.equal(families.get('product-data-metrics-first-results').collection.state, 'healthy');
  assert.equal(families.get('product-data-metrics-new-accounts-daily').collection.code, 'product_data_unavailable');
});

test('empty product aggregates publish named CSV columns', async () => {
  const output = new Map();
  await writeReport({ asset: 'example.com', output: '/tmp/product-report', input: '/tmp/product-input', analyzedAt: generatedAt,
    valueEventDocument: await fixtureValueEvents('example.com'), reclamationTargets: [], market: { locationCode: 2840, languageCode: 'en' },
    families: new Map([['product-data-metrics-first-results', []], ['product-data-metrics-first-results-by-intent', []], ['product-data-metrics-new-accounts-daily', []]]),
    coverage: [], archives: [],
  }, (name, content) => output.set(name, content));
  for (const report of ['metrics-first-results', 'metrics-first-results-by-intent', 'metrics-new-accounts-daily']) {
    assert.equal(output.get(`product-data-${report}.csv`), `${productDataColumns(report).join(',')}\n`);
  }
});

test('a newer failed acquisition overrides old successful availability without changing source freshness', () => {
  const manifest = [{ integration: 'product-data', report: 'metrics-first-results', reportDate: '2026-10-20' },
    { integration: 'product-data', report: 'metrics-collection', reportDate: '2026-10-26' }];
  const freshness = applyProductDataAvailability(freshnessReport({ asset: 'example.com', manifest,
    maxAgeDays: 2, refreshedAt: '2026-10-26T12:00:00.000Z' }),
  [{ block: 'firstResults', state: 'available', row_count: 1, generated_at: generatedAt, collected_at: '2026-10-21T01:00:00.000Z' }],
  { state: 'failing', code: 'product_data_failed', attempted_at: '2026-10-26T12:00:00.000Z' });
  const family = freshness.families.find(row => row.family === 'product-data-metrics-first-results');
  assert.equal(family.collection.state, 'failing');
  assert.equal(family.collection.lastSuccessAt, '2026-10-21T01:00:00.000Z');
  assert.equal(family.availability, 'available');
  assert.equal(freshness.sources[0].fresh, false);
  assert.equal(freshness.sources[0].newestReportDate, '2026-10-20');
});

test('first empty product archive has queryable numeric and dimension columns in Parquet', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-empty-product-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'downloads');
  const history = path.join(root, 'history');
  const file = path.join(input, 'product-data', 'metrics-first-results', '2026-10-20.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(archive('metrics-first-results', { generatedAt, rows: [] })));
  await publishSignalHistory({ asset: 'example.com', input, output: history });
  const manifest = await readCurrentGeneration(history);
  const dataset = manifest.datasets.find(row => row.name === 'product-data-metrics-first-results');
  assert.ok(dataset.schema.columns.some(([column, type]) => column === 'matured' && type === 'DOUBLE'));
  assert.ok(dataset.schema.columns.some(([column, type]) => column === 'week' && type === 'VARCHAR'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const [parquet] = datasetFiles(history, manifest, dataset.name);
    const result = await connection.runAndReadAll(`SELECT week, matured, any_result FROM read_parquet('${parquet.replaceAll("'", "''")}') WHERE matured >= 0`);
    assert.equal(result.getRowObjects().length, 0);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
});

test('a newly collected stale document determines availability instead of an older collection with a newer source date', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-stale-product-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = [];
  for (const [reportDate, collectedAt, state] of [['2026-10-20', '2026-10-21T00:00:00.000Z', 'available'], ['2026-10-18', '2026-10-26T00:00:00.000Z', 'null']]) {
    const row = { integration: 'product-data', report: 'metrics-availability', reportDate };
    const value = { ...archive(row.report, { generatedAt: `${reportDate}T12:00:00.000Z`, rows: [{ block: 'firstResults', state, row_count: state === 'available' ? 2 : null }] }), reportDate, collectedAt };
    const file = archivePath(root, 'example.com', row);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    manifest.push(row);
  }
  const availability = await localProductDataAvailability(root, 'example.com', manifest);
  assert.equal(availability[0].state, 'null');
  const freshness = applyProductDataAvailability(freshnessReport({ asset: 'example.com', manifest,
    maxAgeDays: 7, refreshedAt: '2026-10-26T12:00:00.000Z' }), availability);
  assert.equal(freshness.sources[0].newestReportDate, '2026-10-18');
  assert.equal(freshness.sources[0].fresh, false);
});

test('a long-lived product history selects the newest collection key even for a stale source document', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-product-long-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = Array.from({ length: 129 }, (_, index) => {
    const day = new Date(Date.UTC(2026, 4, 1 + index)).toISOString().slice(0, 10);
    return { integration: 'product-data', report: 'metrics-availability', reportDate: day,
      objectKey: `raw/asset/product-data/example.com/metrics-availability/${day}/${day.replaceAll('-', '')}T120000000Z-0123456789abcdef.json.gz` };
  });
  const latest = { integration: 'product-data', report: 'metrics-availability', reportDate: '2026-04-01',
    objectKey: 'raw/asset/product-data/example.com/metrics-availability/2026-04-01/20261026T120000000Z-0123456789abcdef.json.gz' };
  manifest.push(latest);
  const file = archivePath(root, 'example.com', latest);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...archive(latest.report, { generatedAt: '2026-04-01T12:00:00.000Z',
    rows: [{ block: 'firstResults', state: 'null', row_count: null }] }), reportDate: latest.reportDate, collectedAt: '2026-10-26T12:00:00.000Z' }));
  const availability = await localProductDataAvailability(root, 'example.com', manifest);
  assert.equal(availability[0].state, 'null');
  assert.equal(availability[0].generated_at, '2026-04-01T12:00:00.000Z');
});

test('latest successful attempt overrides reused old availability objects after an unchanged stale snapshot', () => {
  const manifest = [
    { integration: 'product-data', report: 'metrics-first-results', reportDate: '2026-10-20' },
    { integration: 'product-data', report: 'metrics-availability', reportDate: '2026-10-20' },
    { integration: 'product-data', report: 'metrics-collection', reportDate: '2026-10-26' },
  ];
  const priorAvailability = [{ block: 'firstResults', state: 'available', row_count: 4, generated_at: generatedAt, collected_at: '2026-10-21T12:00:00.000Z' }];
  const attempt = { state: 'healthy', attempted_at: '2026-10-26T12:00:00.000Z', source_generated_at: '2026-10-18T12:00:00.000Z',
    availability_json: JSON.stringify([{ block: 'firstResults', state: 'null', row_count: null }, { block: 'newAccountsDaily', state: 'available', row_count: 0 }]) };
  const freshness = applyProductDataAvailability(freshnessReport({ asset: 'example.com', manifest,
    maxAgeDays: 7, refreshedAt: '2026-10-26T12:00:00.000Z' }), priorAvailability, attempt);
  const families = new Map(freshness.families.map(row => [row.family, row]));
  assert.equal(families.get('product-data-metrics-first-results').availability, 'null');
  assert.equal(families.get('product-data-metrics-first-results').collection.state, 'unknown');
  assert.equal(families.get('product-data-metrics-new-accounts-daily').collection.lastSuccessAt, attempt.attempted_at);
  assert.equal(freshness.sources[0].newestReportDate, '2026-10-18');
  assert.equal(freshness.fresh, false);
  for (const availability_json of ['[]'.repeat(5000), '{}', '[{"block":"firstResults","state":"available","row_count":-1}]', '[{"block":"firstResults","state":"null","row_count":0}]', '[{"block":"firstResults","state":"null","row_count":null,"document":"extra"}]']) {
    assert.throws(() => productCollectionAvailability({ ...attempt, availability_json }));
  }
});
