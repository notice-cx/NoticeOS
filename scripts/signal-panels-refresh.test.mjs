import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_DOOR,
  FRESHNESS_FILE,
  REFRESH_DEFAULTS,
  TREND_FILE,
  archivePath,
  dayAge,
  freshnessReport,
  mergeManifest,
  parseArgs,
  parseRoster,
  refreshAsset as realRefreshAsset,
  refreshPanels as realRefreshPanels,
  selectAssets,
  trendCsv,
} from './signal-panels-refresh.mjs';

import { fixtureRefreshDeps } from './signal-panel-fixture.mjs';
const refreshAsset = (asset, options, deps) => realRefreshAsset(asset, options, fixtureRefreshDeps(deps));
const refreshPanels = (options, deps) => realRefreshPanels(options, fixtureRefreshDeps(deps));

const ROSTER = JSON.stringify({
  refresh: { windowDays: 35, freshnessMaxAgeDays: 7 },
  assets: {
    'root-os': { enabled: false, reason: 'not-applicable' },
    'northwind.example': { enabled: true, reason: 'live-lanes' },
    'ferns.example': { enabled: true, reason: 'live-lanes' },
    'puffin.example': { enabled: false, reason: 'no-lane-yet' },
  },
});

test('parseArgs: defaults point at the loopback ingest door', () => {
  const options = parseArgs([]);
  assert.equal(options.door, DEFAULT_DOOR);
  assert.equal(options.asset, null);
  assert.equal(options.all, false);
  assert.equal(options.publish, true);
  assert.equal(parseArgs(['--no-publish']).publish, false);
  assert.match(options.analysisRoot, /signal-dumps\/reports$/);
  assert.match(options.historyRoot, /signal-dumps\/history$/);
  assert.deepEqual(parseArgs(['--memory-mb', '256', '--duckdb-memory-mb', '32', '--temp-disk-mb', '64', '--time-limit-seconds', '5']).limits,
    { memoryMb: 256, duckdbMemoryMb: 32, tempDiskMb: 64, timeLimitSeconds: 5 });
  for (const value of ['0', '1.5', 'NaN']) {
    assert.throws(() => parseArgs(['--memory-mb', value]), /whole numbers above zero/);
  }
});

test('parseArgs: rejects a malformed asset id and a bad window', () => {
  assert.throws(() => parseArgs(['--asset', 'NOT VALID']), /property id/);
  assert.throws(() => parseArgs(['--window-days', 'soon']), /positive number/);
  assert.throws(() => parseArgs(['--window-days', '0']), /positive number/);
});

test('parseRoster: reads the roster the config declares', () => {
  const roster = parseRoster(ROSTER);
  assert.equal(roster.windowDays, 35);
  assert.equal(roster.freshnessMaxAgeDays, 7);
  assert.deepEqual(
    roster.assets.map((entry) => [entry.asset, entry.enabled]),
    [
      ['root-os', false],
      ['northwind.example', true],
      ['ferns.example', true],
      ['puffin.example', false],
    ],
  );
});

// A config typo must cost freshness bookkeeping, never the pass — a refresh that
// refuses to run is a panel that silently goes stale.
test('parseRoster: a broken or empty roster degrades to the defaults', () => {
  for (const raw of ['', 'not json', '{}', '{"assets": null}']) {
    const roster = parseRoster(raw);
    assert.equal(roster.windowDays, REFRESH_DEFAULTS.windowDays);
    assert.equal(roster.freshnessMaxAgeDays, REFRESH_DEFAULTS.freshnessMaxAgeDays);
    assert.deepEqual(roster.assets, []);
  }
});

test('selectAssets: only the enabled entries by default', () => {
  const chosen = selectAssets(parseRoster(ROSTER), { asset: null, all: false });
  assert.deepEqual(chosen.map((entry) => entry.asset), ['northwind.example', 'ferns.example']);
});

test('selectAssets: --all includes the deliberately skipped ones', () => {
  const chosen = selectAssets(parseRoster(ROSTER), { asset: null, all: true });
  assert.equal(chosen.length, 4);
});

// An operator naming a property means that property, roster flag or not.
test('selectAssets: --asset overrides the enabled flag', () => {
  const chosen = selectAssets(parseRoster(ROSTER), { asset: 'puffin.example', all: false });
  assert.deepEqual(chosen.map((entry) => entry.asset), ['puffin.example']);
});

test('archivePath: writes where signal-dumps-download writes', () => {
  assert.equal(
    archivePath('/root', 'northwind.example', { integration: 'gsc', report: 'query', reportDate: '2026-08-01' }),
    path.join('/root', 'northwind.example', 'gsc', 'query', '2026-08-01.json'),
  );
});

// History outside the window stays on disk, so it must stay in the manifest —
// otherwise the manifest claims the property has no history while the files sit
// right beside it.
test('mergeManifest: keeps older rows and lets the newer revision win', () => {
  const merged = mergeManifest(
    [
      { integration: 'gsc', report: 'query', reportDate: '2026-01-01', objectKey: 'old-history' },
      { integration: 'gsc', report: 'query', reportDate: '2026-08-01', objectKey: 'stale' },
    ],
    [{ integration: 'gsc', report: 'query', reportDate: '2026-08-01', objectKey: 'fresh' }],
  );
  assert.deepEqual(merged.map((row) => row.objectKey), ['old-history', 'fresh']);
});

test('mergeManifest: drops rows that cannot identify an archive', () => {
  assert.deepEqual(mergeManifest([null, { integration: 'gsc' }, 7], []), []);
});

test('trendCsv: long form, one row per date/integration/metric', () => {
  const csv = trendCsv([
    { date: '2026-08-01', integration: 'gsc', metric: 'clicks', value: 12, provisional: 0 },
    { date: '2026-08-02', integration: 'gsc', metric: 'clicks', value: 3, provisional: 1 },
  ]);
  assert.equal(
    csv,
    'date,integration,metric,value,provisional\n' +
      '2026-08-01,gsc,clicks,12,0\n' +
      '2026-08-02,gsc,clicks,3,1\n',
  );
});

test('trendCsv: an empty series still writes its header', () => {
  assert.equal(trendCsv([]), 'date,integration,metric,value,provisional\n');
});

test('dayAge: whole days between report date and now', () => {
  assert.equal(dayAge('2026-08-01', '2026-08-03T14:00:00.000Z'), 2);
  assert.equal(dayAge('2026-08-03', '2026-08-03T00:30:00.000Z'), 0);
  assert.equal(dayAge('nope', '2026-08-03T00:30:00.000Z'), null);
});

test('freshnessReport: per-integration, newest report date wins', () => {
  const report = freshnessReport({
    asset: 'northwind.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'gsc', report: 'query', reportDate: '2026-08-01' },
      { integration: 'gsc', report: 'page', reportDate: '2026-07-28' },
      { integration: 'bing-webmaster', report: 'queries', reportDate: '2026-08-02' },
    ],
  });
  assert.equal(report.fresh, true);
  assert.deepEqual(report.sources, [
    {
      key: 'bing-webmaster',
      integration: 'bing-webmaster',
      collected: true,
      newestReportDate: '2026-08-02',
      ageDays: 1,
      fresh: true,
      reports: [{ report: 'queries', newestReportDate: '2026-08-02' }],
    },
    {
      key: 'gsc',
      integration: 'gsc',
      collected: true,
      newestReportDate: '2026-08-01',
      ageDays: 2,
      fresh: true,
      // Each family's own newest day, so a reader can tell a whole collection
      // from part of one.
      reports: [
        { report: 'page', newestReportDate: '2026-07-28' },
        { report: 'query', newestReportDate: '2026-08-01' },
      ],
    },
  ]);
  assert.deepEqual(report.stale, []);
  assert.deepEqual(report.uncollected, []);
});

// The Bing AI Performance exports arrive by hand and share their integration
// id with six API-collected families, so the nightly collection would vouch
// for a file that could be six months old. Every other family in the dir goes
// stale loudly when its collector stops; these have no collector to stop, so
// they carry their own age.
test('freshnessReport: a hand-dropped family is aged on its own export, not its integration', () => {
  const report = freshnessReport({
    asset: 'meadow.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'gsc', report: 'query', reportDate: '2026-08-01' },
      // The API families collected last night …
      { integration: 'bing-webmaster', report: 'queries', reportDate: '2026-08-02' },
      { integration: 'bing-webmaster', report: 'crawl-stats', reportDate: '2026-08-02' },
      // … while the AI exports have not been dropped since February.
      { integration: 'bing-webmaster', report: 'ai-queries', reportDate: '2026-02-14' },
      { integration: 'bing-webmaster', report: 'ai-pages', reportDate: '2026-02-14' },
    ],
  });

  // The collected half is genuinely current and still says so.
  assert.equal(report.fresh, true);
  assert.deepEqual(report.stale, []);
  assert.deepEqual(
    report.sources.map((source) => [source.key, source.newestReportDate, source.fresh]),
    [
      ['bing-webmaster', '2026-08-02', true],
      ['gsc', '2026-08-01', true],
    ],
  );

  // The hand-dropped half states its real age, in the file the reader already
  // opens — instead of the reader having to know which families are exempt.
  assert.deepEqual(report.uncollected, [
    {
      key: 'bing-webmaster/ai-pages',
      integration: 'bing-webmaster',
      report: 'ai-pages',
      collected: false,
      newestReportDate: '2026-02-14',
      ageDays: 170,
      fresh: false,
    },
    {
      key: 'bing-webmaster/ai-queries',
      integration: 'bing-webmaster',
      report: 'ai-queries',
      collected: false,
      newestReportDate: '2026-02-14',
      ageDays: 170,
      fresh: false,
    },
  ]);
  assert.deepEqual(report.staleUncollected, [
    'bing-webmaster/ai-pages',
    'bing-webmaster/ai-queries',
  ]);
});

// The other direction of the same conflation: an export dropped TODAY must not
// make last night's API collection look fresher than it is.
test('freshnessReport: a fresh hand-drop does not vouch for its integration', () => {
  const report = freshnessReport({
    asset: 'meadow.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'bing-webmaster', report: 'queries', reportDate: '2026-07-01' },
      { integration: 'bing-webmaster', report: 'ai-overview', reportDate: '2026-08-03' },
    ],
  });

  assert.equal(report.fresh, false);
  assert.deepEqual(report.stale, ['bing-webmaster']);
  assert.equal(report.sources[0].newestReportDate, '2026-07-01');
  assert.equal(report.uncollected[0].fresh, true);
});

// A property nobody has ever dropped an export for has no uncollected row at
// all — absence is "nobody dropped it yet", never a stale claim about a file
// that does not exist.
test('freshnessReport: a family never dropped is absent, not stale', () => {
  const report = freshnessReport({
    asset: 'ferns.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [{ integration: 'gsc', report: 'query', reportDate: '2026-08-01' }],
  });
  assert.equal(report.fresh, true);
  assert.deepEqual(report.uncollected, []);
  assert.deepEqual(report.staleUncollected, []);
});

// A property whose GSC is current and whose Bing stalled has a real, partial
// answer; one boolean would throw away the half that still works.
test('freshnessReport: names the integration that went stale', () => {
  const report = freshnessReport({
    asset: 'northwind.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'gsc', report: 'query', reportDate: '2026-08-01' },
      { integration: 'bing-webmaster', report: 'queries', reportDate: '2026-07-01' },
    ],
  });
  assert.equal(report.fresh, false);
  assert.deepEqual(report.stale, ['bing-webmaster']);
});

// An empty panel dir and a collapsed one look identical on disk. "Fresh" with
// nothing to measure would be the exact lie the contract forbids.
test('freshnessReport: nothing collected is not fresh', () => {
  const report = freshnessReport({
    asset: 'puffin.example',
    refreshedAt: '2026-08-03T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [],
  });
  assert.equal(report.fresh, false);
  assert.deepEqual(report.sources, []);
});

// ── refreshAsset, against a stubbed door and a real temp filesystem ──────────

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'panels-refresh-'));
  return {
    dir,
    options: {
      door: 'http://door.test',
      publish: false, // These archive/freshness tests exercise the preview path.
      downloadsRoot: path.join(dir, 'downloads'),
      analysisRoot: path.join(dir, 'analysis'),
    },
  };
}

function stubDoor(source, objects) {
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/panel-source') {
      return { ok: true, status: 200, json: async () => ({ asset: parsed.searchParams.get('asset'), ...source }) };
    }
    if (parsed.pathname === '/api/panel-object') {
      const key = parsed.searchParams.get('key');
      if (!(key in objects)) return { ok: false, status: 404 };
      return { ok: true, status: 200, text: async () => JSON.stringify(objects[key]) };
    }
    return { ok: false, status: 404 };
  };
  return { get, calls };
}

const MANIFEST_ROW = {
  integration: 'gsc',
  report: 'query',
  reportDate: '2026-08-01',
  finishedAt: '2026-08-02T12:15:00.000Z',
  objectKey: 'signals/northwind.example/aaa.json.gz',
  contentSha256: 'a'.repeat(64),
  providerRows: 31,
  providerTruncated: 0,
};

test('refreshAsset: writes the archive, the trend csv and the freshness stamp', async () => {
  const { dir, options } = await scratch();
  const { get } = stubDoor(
    {
      from: '2026-06-29',
      manifest: [MANIFEST_ROW],
      trend: [
        { date: '2026-08-01', integration: 'gsc', metric: 'clicks', value: 12, provisional: 0 },
      ],
    },
    { 'signals/northwind.example/aaa.json.gz': { schemaVersion: 1, pages: [] } },
  );

  let analyzed = null;
  const result = await refreshAsset('northwind.example', options, {
    get,
    token: 'op',
    windowDays: 35,
    freshnessMaxAgeDays: 7,
    analyze: async (input) => {
      analyzed = input;
    },
    now: () => '2026-08-03T13:10:00.000Z',
  });

  assert.equal(result.archivesFetched, 1);
  assert.equal(result.trendRows, 1);
  assert.equal(analyzed.asset, 'northwind.example');
  assert.equal(analyzed.history, path.join(dir, 'history', 'northwind.example'));
  assert.equal(analyzed.generation, 1);
  assert.equal(analyzed.output, path.join(options.analysisRoot, 'northwind.example'));

  const archive = await fs.readFile(
    path.join(options.downloadsRoot, 'northwind.example', 'gsc', 'query', '2026-08-01.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(archive), { schemaVersion: 1, pages: [] });

  const trend = await fs.readFile(path.join(options.analysisRoot, 'northwind.example', TREND_FILE), 'utf8');
  assert.match(trend, /2026-08-01,gsc,clicks,12,0/);

  const freshness = JSON.parse(
    await fs.readFile(path.join(options.analysisRoot, 'northwind.example', FRESHNESS_FILE), 'utf8'),
  );
  assert.equal(freshness.fresh, true);
  assert.equal(freshness.sources[0].integration, 'gsc');

  await fs.rm(dir, { recursive: true, force: true });
});

// This is what keeps a nightly pass O(the new day) instead of O(the window), and
// therefore what makes a daily cadence free.
test('refreshAsset: does not re-fetch an archive it already holds', async () => {
  const { dir, options } = await scratch();
  const objects = { 'signals/northwind.example/aaa.json.gz': { schemaVersion: 1, pages: [] } };
  const source = { from: '2026-06-29', manifest: [MANIFEST_ROW], trend: [] };
  const deps = {
    token: 'op',
    windowDays: 35,
    freshnessMaxAgeDays: 7,
    analyze: async () => {},
    now: () => '2026-08-03T13:10:00.000Z',
  };

  const first = stubDoor(source, objects);
  await refreshAsset('northwind.example', options, { ...deps, get: first.get });

  const second = stubDoor(source, objects);
  const result = await refreshAsset('northwind.example', options, { ...deps, get: second.get });
  assert.equal(result.archivesFetched, 0);
  assert.deepEqual(
    second.calls.filter((url) => url.includes('/api/panel-object')),
    [],
  );

  await fs.rm(dir, { recursive: true, force: true });
});

// A revised archive gets a new object key (the key carries the content hash), so
// the same report day must come down again.
test('refreshAsset: re-fetches a report day the collector revised', async () => {
  const { dir, options } = await scratch();
  const deps = {
    token: 'op',
    windowDays: 35,
    freshnessMaxAgeDays: 7,
    analyze: async () => {},
    now: () => '2026-08-03T13:10:00.000Z',
  };

  const first = stubDoor(
    { from: '2026-06-29', manifest: [MANIFEST_ROW], trend: [] },
    { 'signals/northwind.example/aaa.json.gz': { revision: 1 } },
  );
  await refreshAsset('northwind.example', options, { ...deps, get: first.get });

  const revised = { ...MANIFEST_ROW, objectKey: 'signals/northwind.example/bbb.json.gz' };
  const second = stubDoor(
    { from: '2026-06-29', manifest: [revised], trend: [] },
    { 'signals/northwind.example/bbb.json.gz': { revision: 2 } },
  );
  const result = await refreshAsset('northwind.example', options, { ...deps, get: second.get });
  assert.equal(result.archivesFetched, 1);

  const archive = await fs.readFile(
    path.join(options.downloadsRoot, 'northwind.example', 'gsc', 'query', '2026-08-01.json'),
    'utf8',
  );
  assert.deepEqual(JSON.parse(archive), { revision: 2 });

  await fs.rm(dir, { recursive: true, force: true });
});

// The hand download merges its record file with this lane's rule. These are the
// exact bytes this lane writes: a report day outside this pass's window stays,
// a revised day takes this pass's row.
test('refreshAsset: the record file keeps earlier report days and takes this pass’s revision, byte for byte', async () => {
  const { dir, options } = await scratch();
  const settled = {
    integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-07-01',
    finishedAt: '2026-07-03T12:16:02.000Z', objectKey: 'signals/northwind.example/ga4.json.gz',
    contentSha256: 'c'.repeat(64), providerRows: 4, providerTruncated: 0,
  };
  const revised = {
    ...MANIFEST_ROW, finishedAt: '2026-08-03T12:15:00.000Z',
    objectKey: 'signals/northwind.example/bbb.json.gz', contentSha256: 'b'.repeat(64),
  };
  const deps = { token: 'op', windowDays: 35, freshnessMaxAgeDays: 7, analyze: async () => {} };
  const objects = {
    [settled.objectKey]: { revision: 0 }, [MANIFEST_ROW.objectKey]: { revision: 1 }, [revised.objectKey]: { revision: 2 },
  };
  await refreshAsset('northwind.example', options, {
    ...deps, get: stubDoor({ from: '2026-06-29', manifest: [settled, MANIFEST_ROW], trend: [] }, objects).get,
    now: () => '2026-08-03T13:10:00.000Z',
  });
  await refreshAsset('northwind.example', options, {
    ...deps, get: stubDoor({ from: '2026-07-05', manifest: [revised], trend: [] }, objects).get,
    now: () => '2026-08-04T13:10:00.000Z',
  });

  const expected = {
    downloadedAt: '2026-08-04T13:10:00.000Z',
    source: 'panel-refresh',
    asset: 'northwind.example',
    filters: { from: '2026-07-05', to: null, integration: null, report: null },
    objects: [{ ...settled, asset: 'northwind.example' }, { ...revised, asset: 'northwind.example' }],
  };
  assert.equal(
    await fs.readFile(path.join(options.downloadsRoot, 'northwind.example', 'manifest.json'), 'utf8'),
    `${JSON.stringify(expected, null, 2)}\n`,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// The panel dir is the contract; a half-written archive would flatten into rows
// that read as real provider data.
test('refreshAsset: refuses to write an archive that is not JSON', async () => {
  const { dir, options } = await scratch();
  const get = async (url) => {
    if (new URL(url).pathname === '/api/panel-source') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ asset: 'northwind.example', from: '2026-06-29', manifest: [MANIFEST_ROW], trend: [] }),
      };
    }
    return { ok: true, status: 200, text: async () => '{"pages": [' };
  };
  await assert.rejects(
    refreshAsset('northwind.example', options, {
      get,
      token: 'op',
      windowDays: 35,
      freshnessMaxAgeDays: 7,
      analyze: async () => {},
    }),
  );
  await assert.rejects(
    fs.access(path.join(options.downloadsRoot, 'northwind.example', 'gsc', 'query', '2026-08-01.json')),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('refreshAsset: a non-200 from the door fails loudly', async () => {
  const { dir, options } = await scratch();
  const get = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    refreshAsset('northwind.example', options, {
      get,
      token: 'op',
      windowDays: 35,
      freshnessMaxAgeDays: 7,
      analyze: async () => {},
    }),
    /HTTP 503/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// One property's broken lane must not cost every other property its refresh.
test('refreshPanels: keeps going past a property that failed', async () => {
  const { dir, options } = await scratch();

  const get = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/panel-source') {
      if (parsed.searchParams.get('asset') === 'northwind.example') return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({ asset: parsed.searchParams.get('asset'), from: '2026-06-29', manifest: [], trend: [] }) };
    }
    return { ok: false, status: 404 };
  };

  const { results, failures } = await refreshPanels(
    { ...options, asset: null, all: false, windowDays: null },
    { fetchImpl: savedRoster(JSON.parse(ROSTER)), token: 'op', get, analyze: async () => {}, now: () => '2026-08-03T13:10:00.000Z' },
  );
  assert.deepEqual(failures.map((entry) => entry.asset), ['northwind.example']);
  assert.deepEqual(results.map((entry) => entry.asset), ['ferns.example']);
  // Nothing collected for ferns.example in this stub, so its panel must say so.
  assert.equal(results[0].freshness.fresh, false);

  await fs.rm(dir, { recursive: true, force: true });
});

function savedRoster(body) {
  return async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/config-documents');
    assert.equal(new URL(url).searchParams.get('bodies'), '1');
    assert.equal(init.method, 'GET');
    return Response.json({ ready: true, documents: [
      { file: 'config/signal-panels.json', version: 8, body },
    ] });
  };
}

// The findings name the market each site's saved settings ask DataForSEO in,
// read from the same stored snapshot as the roster.
test('refreshPanels: each site’s analysis gets the search market its saved settings name', async (t) => {
  const { dir, options } = await scratch();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const markets = {};
  const { failures } = await refreshPanels(
    { ...options, asset: null, all: false, windowDays: null },
    {
      token: 'op',
      fetchImpl: async () => Response.json({ ready: true, documents: [
        { file: 'config/signal-panels.json', version: 8, body: { assets: { 'northwind.example': { enabled: true }, 'ferns.example': { enabled: true } } } },
        { file: 'config/integrations.json', version: 3, body: { assets: {
          'northwind.example': { dataforseo: { locationCode: 2276, languageCode: 'de' } },
          'ferns.example': { ga4: { propertyId: '123' } },
        } } },
      ] }),
      get: async (url) => Response.json({ asset: new URL(url).searchParams.get('asset'), manifest: [], trend: [] }),
      analyze: async ({ asset, market }) => { markets[asset] = market; },
      now: () => '2026-09-09T12:00:00.000Z',
    },
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(markets, { 'northwind.example': { locationCode: 2276, languageCode: 'de' }, 'ferns.example': null });
});

test('refreshPanels: stored targets, history and freshness win over a stale export', async (t) => {
  const { dir, options } = await scratch();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rosterFile = path.join(dir, 'roster.json');
  await fs.writeFile(rosterFile, JSON.stringify({
    refresh: { windowDays: 35, freshnessMaxAgeDays: 7 },
    assets: { 'old.example': { enabled: true }, 'current.example': { enabled: false } },
  }));
  const calls = [];
  const { results, failures } = await refreshPanels(
    { ...options, asset: null, all: false, windowDays: null },
    {
      rosterFile, // The retired injection must have no influence on the production reader.
      token: 'op',
      fetchImpl: savedRoster({
        refresh: { windowDays: 14, freshnessMaxAgeDays: 2 },
        assets: { 'old.example': { enabled: false }, 'current.example': { enabled: true } },
      }),
      get: async (url) => {
        const parsed = new URL(url);
        calls.push([parsed.searchParams.get('asset'), parsed.searchParams.get('windowDays')]);
        return Response.json({ asset: 'current.example', manifest: [], trend: [] });
      },
      analyze: async () => {}, now: () => '2026-09-09T12:00:00.000Z',
    },
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, [['current.example', '14']]);
  assert.deepEqual(results.map((row) => [row.asset, row.freshness.maxAgeDays]), [['current.example', 2]]);
  await assert.rejects(fs.access(path.join(options.analysisRoot, 'old.example')));
});

test('refreshPanels: failed, missing or malformed saved settings stop before reading any archives', async (t) => {
  const { dir, options } = await scratch();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const responses = [
    () => Response.json({ ready: false }, { status: 503 }),
    () => Response.json({ ready: true, documents: [] }),
    savedRoster({ assets: null }),
    savedRoster({ assets: [], refresh: {} }),
    savedRoster({ assets: {}, refresh: null }),
    savedRoster({ assets: { 'old.example': { enabled: 'true' } } }),
    savedRoster({ assets: { 'old.example': null } }),
    savedRoster({ assets: {}, refresh: { windowDays: 'invalid' } }),
    savedRoster({ assets: {}, refresh: { freshnessMaxAgeDays: 0 } }),
    () => { throw new Error('offline'); },
  ];
  for (const fetchImpl of responses) {
    await assert.rejects(refreshPanels(
      { ...options, asset: null, all: false, windowDays: null },
      { token: 'op', fetchImpl, get: () => assert.fail('must not read archives without saved settings') },
    ));
  }
  await assert.rejects(fs.access(options.analysisRoot));
  await assert.rejects(fs.access(options.downloadsRoot));
});

test('refreshPanels: an explicitly empty or disabled roster never revives file defaults', async () => {
  for (const assets of [{}, { 'old.example': { enabled: false } }]) {
    const result = await refreshPanels(parseArgs([]), {
      token: 'op', fetchImpl: savedRoster({ assets }),
      get: () => assert.fail('disabled assets must not be refreshed'),
    });
    assert.deepEqual(result, { results: [], failures: [] });
  }
});
