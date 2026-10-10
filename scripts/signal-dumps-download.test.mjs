import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_DOOR } from './ingest-door.mjs';
import { archiveRows, manifestConfirmations, parseArchive, reportDayKey } from './signal-archive.mjs';
import { readDownloadsManifest } from './signal-downloads.mjs';
import { REMOTE_REFUSED, downloadSignalDumps, parseArgs } from './signal-dumps-download.mjs';

const ROW = {
  integration: 'gsc',
  report: 'query',
  reportDate: '2026-08-01',
  finishedAt: '2026-08-02T12:15:00.000Z',
  objectKey: 'signals/nosh.example/aaa.json.gz',
  contentSha256: 'a'.repeat(64),
  providerRows: 31,
  providerTruncated: 0,
};

const ARCHIVE = { schemaVersion: 1, rows: [{ query: 'nom', clicks: 3 }] };

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-download-'));
  return {
    dir,
    options: {
      asset: 'nosh.example',
      from: null,
      to: null,
      integration: null,
      report: null,
      out: path.join(dir, 'downloads'),
      door: 'http://door.test',
    },
  };
}

/** The loopback ingest, as far as this script can tell. */
function stubDoor({ manifest = [ROW], objects = { [ROW.objectKey]: ARCHIVE } } = {}) {
  const calls = [];
  const get = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/signal-archives') {
      return { ok: true, status: 200, json: async () => ({ asset: 'nosh.example', manifest }) };
    }
    if (parsed.pathname === '/api/panel-object') {
      const key = parsed.searchParams.get('key');
      if (!(key in objects)) {
        return { ok: false, status: 404, text: async () => '{"error":"unknown_object"}' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(objects[key]) };
    }
    return { ok: false, status: 404, text: async () => '{"error":"not_found"}' };
  };
  return { get, calls };
}

test('parseArgs: local by default, aimed at the loopback door', () => {
  const options = parseArgs(['--asset', 'meals.example']);
  assert.equal(options.door, DEFAULT_DOOR);
  assert.equal(options.asset, 'meals.example');
});

test('parseArgs: the documented filters still parse', () => {
  const options = parseArgs([
    '--asset', 'meals.example',
    '--from', '2026-07-01',
    '--to', '2026-07-31',
    '--integration', 'gsc',
    '--report', 'page-query',
  ]);
  assert.equal(options.from, '2026-07-01');
  assert.equal(options.to, '2026-07-31');
  assert.equal(options.integration, 'gsc');
  assert.equal(options.report, 'page-query');
});

test('parseArgs: rejects a malformed asset, integration, report and date', () => {
  assert.throws(() => parseArgs(['--asset', 'NOT VALID']), /property id/);
  assert.throws(() => parseArgs(['--asset', 'nosh.example', '--integration', 'ga5']), /--integration must/);
  assert.throws(() => parseArgs(['--asset', 'nosh.example', '--report', 'page_query']), /--report must/);
  assert.throws(() => parseArgs(['--asset', 'nosh.example', '--from', '07-01-2026']), /YYYY-MM-DD/);
});

test('writes the archive and the manifest where the docs say', async () => {
  const { dir, options } = await scratch();
  const { get, calls } = stubDoor();

  const result = await downloadSignalDumps(options, { get, token: 'op' });

  const destination = path.join(options.out, 'nosh.example', 'gsc', 'query', '2026-08-01.json');
  assert.deepEqual(result.files, [destination]);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), ARCHIVE);

  const manifest = JSON.parse(
    await fs.readFile(path.join(options.out, 'nosh.example', 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.source, 'local');
  assert.equal(manifest.asset, 'nosh.example');
  // The row has to name its property: manifest.json is read by anything that
  // opens the panel dir, and the route answers per-asset without repeating it.
  assert.equal(manifest.objects[0].asset, 'nosh.example');
  assert.equal(manifest.objects[0].objectKey, ROW.objectKey);

  // Every call is an operator-authed door read. No wrangler, no second runtime.
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ['/api/signal-archives', '/api/panel-object'],
  );
  for (const call of calls) assert.equal(call.headers.authorization, 'Bearer op');

  await fs.rm(dir, { recursive: true, force: true });
});

test('an operator’s filters travel to the route, and none are invented', async () => {
  const { dir, options } = await scratch();
  const { get, calls } = stubDoor({ manifest: [] });

  await downloadSignalDumps(
    { ...options, from: '2026-07-01', to: '2026-07-31', integration: 'gsc' },
    { get, token: 'op' },
  );

  const query = new URL(calls[0].url).searchParams;
  assert.equal(query.get('asset'), 'nosh.example');
  assert.equal(query.get('from'), '2026-07-01');
  assert.equal(query.get('to'), '2026-07-31');
  assert.equal(query.get('integration'), 'gsc');
  // An unset filter is absent, not empty: the route would 400 on `report=`.
  assert.equal(query.has('report'), false);

  await fs.rm(dir, { recursive: true, force: true });
});

// The panel refresh writes the same bytes at the same path, so a hand download
// and a standing refresh must leave a directory nobody can tell apart.
test('writes the same trailing-newline JSON the panel refresh writes', async () => {
  const { dir, options } = await scratch();
  const { get } = stubDoor();
  await downloadSignalDumps(options, { get, token: 'op' });
  const raw = await fs.readFile(
    path.join(options.out, 'nosh.example', 'gsc', 'query', '2026-08-01.json'),
    'utf8',
  );
  assert.ok(raw.endsWith('\n'));
  await fs.rm(dir, { recursive: true, force: true });
});

// A truncated body would flatten into a CSV that reads as real missing rows.
test('refuses to write an archive that is not JSON', async () => {
  const { dir, options } = await scratch();
  const get = async (url) => {
    if (new URL(url).pathname === '/api/signal-archives') {
      return { ok: true, status: 200, json: async () => ({ manifest: [ROW] }) };
    }
    return { ok: true, status: 200, text: async () => '{"rows": [' };
  };
  await assert.rejects(downloadSignalDumps(options, { get, token: 'op' }));
  await assert.rejects(
    fs.access(path.join(options.out, 'nosh.example', 'gsc', 'query', '2026-08-01.json')),
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('a non-200 from the door fails loudly and carries the body', async () => {
  const { dir, options } = await scratch();
  const get = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"unauthorized"}',
  });
  await assert.rejects(downloadSignalDumps(options, { get, token: 'op' }), /HTTP 401.*unauthorized/s);
  await fs.rm(dir, { recursive: true, force: true });
});

// The common failure is simply that the OS is not running, and the sentence has
// to say so.
test('a door that does not answer names os:up', async () => {
  const { dir, options } = await scratch();
  const get = async () => {
    throw new Error('fetch failed');
  };
  await assert.rejects(downloadSignalDumps(options, { get, token: 'op' }), /os:up/);
  await fs.rm(dir, { recursive: true, force: true });
});

// A GA4 attribution day collected at D+1 is settled only by the
// record file's D+2 confirmation; a filtered download of another integration
// must not forget it, or the day reads provisional again.
test('a filtered download keeps the report days an earlier download recorded, so a settled GA4 day stays settled', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { dir, options } = await scratch();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ga4Row = {
    integration: 'ga4',
    report: 'traffic-acquisition',
    reportDate: '2026-09-21',
    // The unchanged D+2 re-collection: it confirms the D+1 bytes without a new object.
    finishedAt: '2026-09-23T12:16:02.000Z',
    objectKey: 'signals/nosh.example/ga4.json.gz',
    contentSha256: 'c'.repeat(64),
    providerRows: 1,
    providerTruncated: 0,
  };
  const ga4Archive = {
    schemaVersion: 1,
    asset: 'nosh.example',
    integration: 'ga4',
    report: 'traffic-acquisition',
    reportDate: '2026-09-21',
    collectedAt: '2026-09-22T12:15:00.000Z',
    dataState: 'provider-snapshot',
    providerTruncated: false,
    pages: [{
      request: {},
      response: {
        dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
        metricHeaders: [{ name: 'sessions' }],
        rows: [{ dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '10' }] }],
      },
    }],
  };
  const everything = [ga4Row, ROW];
  const objects = { [ga4Row.objectKey]: ga4Archive, [ROW.objectKey]: ARCHIVE };
  // The route answers with the rows the filters select.
  const get = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/signal-archives') {
      const integration = parsed.searchParams.get('integration');
      const manifest = everything.filter((row) => integration === null || row.integration === integration);
      return { ok: true, status: 200, json: async () => ({ asset: 'nosh.example', manifest }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(objects[parsed.searchParams.get('key')]) };
  };
  const ga4Day = reportDayKey(ga4Row);
  const settledFlag = async () => {
    const confirmations = manifestConfirmations(await readDownloadsManifest(path.join(options.out, 'nosh.example')));
    const text = await fs.readFile(path.join(options.out, 'nosh.example', 'ga4', 'traffic-acquisition', '2026-09-21.json'), 'utf8');
    return { confirmations, provisional: archiveRows(parseArchive(text, { asset: 'nosh.example', source: 'test' }), confirmations)[0].provisional };
  };

  await downloadSignalDumps(options, { get, token: 'op' });
  assert.equal((await settledFlag()).provisional, 0);

  const filtered = await downloadSignalDumps({ ...options, integration: 'gsc' }, { get, token: 'op' });
  assert.deepEqual(filtered.rows.map((row) => row.integration), ['gsc']);

  const manifest = await readDownloadsManifest(path.join(options.out, 'nosh.example'));
  const kept = manifest.objects.find((row) => reportDayKey(row) === ga4Day);
  assert.equal(kept?.finishedAt, ga4Row.finishedAt);
  assert.equal(manifest.filters.integration, 'gsc');
  assert.deepEqual(manifest.objects.map(reportDayKey).sort(), [ga4Day, reportDayKey(ROW)].sort());
  const { confirmations, provisional } = await settledFlag();
  assert.equal(confirmations.get(ga4Day), ga4Row.finishedAt);
  assert.equal(provisional, 0);
});

test('nothing matched writes nothing at all', async () => {
  const { dir, options } = await scratch();
  const { get } = stubDoor({ manifest: [] });
  const result = await downloadSignalDumps(options, { get, token: 'op' });
  assert.deepEqual(result, { rows: [], files: [] });
  await assert.rejects(fs.access(path.join(options.out, 'nosh.example', 'manifest.json')));
  await fs.rm(dir, { recursive: true, force: true });
});

// The report runs are in the installation's own store,
// reached only through its ingest: --remote reads nothing and says so.
test('--remote is refused before anything is read', () => {
  assert.throws(() => parseArgs(['--asset', 'meals.example', '--remote']), (error) => error.message === REMOTE_REFUSED);
});
