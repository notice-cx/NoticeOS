import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveRows, parseArchive } from './signal-archive.mjs';
import { freshnessReport } from './signal-panels-refresh.mjs';
import { analyzeArchiveFixture } from './test-fixtures/signal-report.mjs';

function archive(report, date, dimensions, metrics, values) {
  return { schemaVersion: 1, asset: 'meadow.example', integration: 'ga4', report,
    reportDate: date, collectedAt: `${date}T23:00:00.000Z`, dataState: 'provider-snapshot',
    providerRows: 1, providerTruncated: false, pages: [{
      request: { dateRanges: [{ startDate: date, endDate: date }] }, response: {
        dimensionHeaders: dimensions.map((name) => ({ name })),
        metricHeaders: metrics.map((name) => ({ name })),
        rows: [{ dimensionValues: values.map((value) => ({ value })),
          metricValues: metrics.map((_, index) => ({ value: String(index) })) }],
      },
    }],
  };
}

const reports = [
  ['content-groups', ['contentGroup'], ['screenPageViews', 'sessions'], ['(not set)']],
  ['event-source', ['eventName', 'customEvent:source'], ['eventCount', 'totalUsers'], ['plan_save', 'calculator']],
  ['event-state', ['eventName', 'customEvent:state'], ['eventCount', 'totalUsers'], ['plan_save', '(not set)']],
];

test('daily content and parameter archives produce history tables and report CSVs without losing unknown or zero values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-ga4-content-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input);
  for (const [report, dimensions, metrics, values] of reports) {
    for (const date of ['2026-07-27', '2026-07-28']) {
      const envelope = archive(report, date, dimensions, metrics, values);
      const checked = parseArchive(JSON.stringify(envelope), { asset: 'meadow.example', source: 'test' });
      const [row] = archiveRows(checked, new Map());
      assert.equal(row.report_date, date);
      assert.equal(row[metrics[0]], '0');
      assert.equal(row[dimensions.at(-1).replace('customEvent:', '')], values.at(-1));
      await fs.writeFile(path.join(input, `${report}-${date}.json`), JSON.stringify(envelope));
    }
  }
  await analyzeArchiveFixture({ asset: 'meadow.example', input, output,
    now: '2026-07-30T12:00:00.000Z', readValueEvents: async () => ({ body: { assets: {} }, version: 1 }) });
  for (const [report, dimensions, metrics, values] of reports) {
    const csv = await fs.readFile(path.join(output, `ga4-${report}.csv`), 'utf8');
    const [header, ...records] = csv.trim().split(/\r?\n/u).map((line) => line.split(','));
    assert.equal(records.length, 2);
    const rows = records.map((record) => Object.fromEntries(header.map((name, index) => [name, record[index]])));
    assert.deepEqual(rows.map((row) => row.report_date), ['2026-07-27', '2026-07-28']);
    for (const row of rows) {
      assert.equal(row[metrics[0]], '0');
      assert.equal(row[dimensions.at(-1).replace('customEvent:', '')], values.at(-1));
    }
    assert.equal(header.some((name) => name.startsWith('customEvent:')), false);
  }
  await assert.rejects(fs.access(path.join(output, 'ga4-event-action.csv')));
});

test('an uncollected parameter family produces no table or invented zero CSV', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-ga4-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input);
  const [report, dimensions, metrics, values] = reports[0];
  await fs.writeFile(path.join(input, 'content.json'), JSON.stringify(archive(report, '2026-07-28', dimensions, metrics, values)));
  await analyzeArchiveFixture({ asset: 'meadow.example', input, output,
    now: '2026-07-30T12:00:00.000Z', readValueEvents: async () => ({ body: { assets: {} }, version: 1 }) });
  for (const report of ['event-source', 'event-state']) {
    await assert.rejects(fs.access(path.join(output, `ga4-${report}.csv`)));
  }
});


test('content group freshness includes coverage and session counting caveats without changing collection health', () => {
  const report = freshnessReport({ asset: 'meadow.example', maxAgeDays: 7,
    refreshedAt: '2026-07-30T12:00:00.000Z', manifest: [
      { integration: 'ga4', report: 'content-groups', reportDate: '2026-07-28' },
      { integration: 'ga4', report: 'event-source', reportDate: '2026-07-28' },
    ] });
  const groups = report.families.find((row) => row.family === 'ga4-content-groups');
  assert.deepEqual(groups.notes, ['Only page views carrying content_group appear under a section. Landing pages remain unassigned until the initial page view includes it. Sessions can appear in multiple sections; do not sum sessions across sections.']);
  assert.equal(groups.newestReportDate, '2026-07-28');
  assert.equal(groups.collection, null);
  assert.equal(report.fresh, true);
  assert.equal(report.families.find((row) => row.family === 'ga4-event-source').notes, undefined);
});
