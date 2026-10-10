import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeExportFile,
  importExport,
  importLine,
  parseArgs,
  resolveImport,
} from './bing-ai-import.mjs';

// Three files named exactly as Bing's Export button writes them.
const OVERVIEW = 'meadow.example_AIPerformanceOverviewStats_8_4_2026.csv';
const QUERIES = 'meadow.example_AISearchQueriesReport_8_4_2026.csv';
const PAGES = 'meadow.example_AIPageStatsReport_8_4_2026.csv';

test('reads the property, the export and the date off Bing’s filename', () => {
  assert.deepEqual(describeExportFile(OVERVIEW), {
    asset: 'meadow.example',
    exportName: 'AIPerformanceOverviewStats',
    exportDate: '2026-08-04',
  });
  assert.deepEqual(describeExportFile(QUERIES), {
    asset: 'meadow.example',
    exportName: 'AISearchQueriesReport',
    exportDate: '2026-08-04',
  });
  assert.deepEqual(describeExportFile(PAGES), {
    asset: 'meadow.example',
    exportName: 'AIPageStatsReport',
    exportDate: '2026-08-04',
  });
});

// A single-digit month and day is how Bing writes 8/4; a two-digit one is how it
// writes 12/25. Both are the same filename shape and both must read.
test('reads single- and double-digit month/day the same way', () => {
  assert.equal(
    describeExportFile('ferns.example_AIPageStatsReport_12_25_2026.csv').exportDate,
    '2026-12-25',
  );
});

test('a filename that is not Bing’s is not read at all', () => {
  // The browser's duplicate-download suffix, a re-save, and a date that is not a
  // date. Each returns null rather than a best guess.
  assert.equal(describeExportFile('meadow.example_AIPageStatsReport_8_4_2026 (1).csv'), null);
  assert.equal(describeExportFile('ai-pages.csv'), null);
  assert.equal(describeExportFile('meadow.example_AIPageStatsReport_2_30_2026.csv'), null);
});

test('resolveImport takes the filename when the operator names nothing', () => {
  const resolved = resolveImport(`/Users/operator/Downloads/${QUERIES}`, {
    asset: null,
    exportDate: null,
  });
  assert.deepEqual(resolved, {
    file: `/Users/operator/Downloads/${QUERIES}`,
    basename: QUERIES,
    asset: 'meadow.example',
    exportDate: '2026-08-04',
    exportName: 'AISearchQueriesReport',
  });
});

test('an operator’s flags win over the filename', () => {
  const resolved = resolveImport(`/tmp/${QUERIES}`, {
    asset: 'ferns.example',
    exportDate: '2026-07-12',
  });
  assert.equal(resolved.asset, 'ferns.example');
  assert.equal(resolved.exportDate, '2026-07-12');
});

// The refusal has to carry the fix, because the operator standing here has a
// file whose name a browser mangled and no idea what this tool wants.
test('an unreadable filename is refused with the flags that fix it', () => {
  assert.throws(
    () => resolveImport('/tmp/export (1).csv', { asset: null, exportDate: null }),
    (error) => {
      assert.match(error.message, /--asset <property id> and --export-date <YYYY-MM-DD>/);
      assert.match(error.message, /export \(1\)\.csv/);
      return true;
    },
  );
  assert.throws(
    () => resolveImport('/tmp/export (1).csv', { asset: 'meadow.example', exportDate: null }),
    (error) => {
      assert.match(error.message, /--export-date <YYYY-MM-DD>/);
      assert.doesNotMatch(error.message, /--asset/);
      return true;
    },
  );
});

test('parseArgs collects files and options', () => {
  const options = parseArgs([`~/Downloads/${PAGES}`, '--door', 'http://127.0.0.1:9999']);
  assert.deepEqual(options.files, [`~/Downloads/${PAGES}`]);
  assert.equal(options.door, 'http://127.0.0.1:9999');
  assert.equal(options.refresh, true);
  assert.equal(parseArgs([PAGES, '--no-refresh']).refresh, false);
});

test('parseArgs refuses what it cannot honestly do', () => {
  assert.throws(() => parseArgs([]), /Name at least one exported CSV file/);
  assert.throws(() => parseArgs([PAGES, '--asset', 'NOT VALID']), /--asset must be/);
  assert.throws(() => parseArgs([PAGES, '--export-date', 'yesterday']), /--export-date must be/);
  // One date, one file: stamping several files with one export date is how a
  // series quietly gets the wrong day.
  assert.throws(
    () => parseArgs([PAGES, QUERIES, '--export-date', '2026-08-04']),
    /one file at a time|one at a time/i,
  );
});

test('the file crosses the door as base64, with its name and date', async () => {
  const bytes = Buffer.from('﻿"Page","Citations"\n"https://meadow.example/","33099"\n', 'utf8');
  const calls = [];
  const get = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        imported: true,
        asset: 'meadow.example',
        file: PAGES,
        report: 'ai-pages',
        exportDate: '2026-08-04',
        status: 'success',
        rows: 1,
        objectKey: 'raw/microsoft/bing-webmaster/meadow.example/ai-pages/2026-08-04/x.json.gz',
      }),
    };
  };
  const result = await importExport(resolveImport(`/tmp/${PAGES}`, { asset: null, exportDate: null }), {
    get,
    token: 'operator-token',
    readFile: async () => bytes,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8791/api/bing-ai-export');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer operator-token');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.asset, 'meadow.example');
  assert.equal(sent.file, PAGES);
  assert.equal(sent.exportDate, '2026-08-04');
  // Byte-identical: the BOM the export opens with survives the trip.
  assert.deepEqual(Buffer.from(sent.contentBase64, 'base64'), bytes);
  assert.equal(result.rows, 1);
});

test('a door refusal is raised, not swallowed', async () => {
  const get = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"error":"bing_ai_export_unknown_format"}',
  });
  await assert.rejects(
    importExport(resolveImport(`/tmp/${PAGES}`, { asset: null, exportDate: null }), {
      get,
      token: 't',
      readFile: async () => Buffer.from('x'),
    }),
    /HTTP 422 — .*bing_ai_export_unknown_format/,
  );
});

// A re-import is the operator's honest reaction to "did that land?", so the line
// it prints must not read like a failure.
test('the operator line separates a new archive from one already held', () => {
  const base = {
    file: PAGES,
    asset: 'meadow.example',
    report: 'ai-pages',
    exportDate: '2026-08-04',
    rows: 199,
    objectKey: 'raw/microsoft/bing-webmaster/meadow.example/ai-pages/2026-08-04/x.json.gz',
  };
  assert.match(importLine({ ...base, status: 'success' }), /archived 199 row\(s\) as ai-pages/);
  assert.match(importLine({ ...base, status: 'unchanged' }), /already held 199 row\(s\)/);
});
