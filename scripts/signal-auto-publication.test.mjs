import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeSignalHistory } from './signal-history-analyze.mjs';
import { publishExecutiveSnapshot } from './signal-insights-publish.mjs';
import { FRESHNESS_FILE, refreshAsset as realRefreshAsset, refreshPanels as realRefreshPanels } from './signal-panels-refresh.mjs';

import { fixtureRefreshDeps } from './signal-panel-fixture.mjs';
const refreshAsset = (asset, options, deps) => realRefreshAsset(asset, options,
  deps.analyze === analyzeSignalHistory ? deps : fixtureRefreshDeps(deps));
const refreshPanels = (options, deps) => realRefreshPanels(options, fixtureRefreshDeps(deps));

const ASSET = 'nosh.example';
const NOW = '2026-09-06T12:00:00.000Z';
const ROW = { integration: 'gsc', report: 'query', reportDate: '2026-09-04', objectKey: 'fixture-archive', providerRows: 1 };
const snapshot = (over = {}) => ({
  schemaVersion: 1, asset: ASSET, generatedAt: NOW,
  windowStart: '2026-09-04', windowEnd: '2026-09-04', sourceArchiveCount: 1,
  items: [], methodology: ['Absent source reports remain unknown.'], ...over,
});
const completed = (value = snapshot(), over = {}) => ({
  asset: value.asset, analyzedAt: value.generatedAt, archiveCount: value.sourceArchiveCount,
  executiveSnapshot: value, ...over,
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-auto-advice-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { door: 'http://door.test', downloadsRoot: path.join(dir, 'downloads'), analysisRoot: path.join(dir, 'analysis'), publish: true };
  const published = [];
  const calls = [];
  const deps = {
    token: 'op', windowDays: 35, freshnessMaxAgeDays: 7, now: () => NOW,
    get: async (url, init) => {
      calls.push(url);
      const parsed = new URL(url);
      assert.equal(parsed.origin, options.door);
      if (parsed.pathname === '/api/config-documents') {
        assert.equal(init.headers.authorization, 'Bearer op');
        return Response.json({ ready: true, documents: [{ file: 'config/value-events.json', version: 4, body: { assets: {} } }] });
      }
      if (parsed.pathname === '/api/panel-source') return { ok: true, json: async () => ({ asset: parsed.searchParams.get('asset'), manifest: [ROW], trend: [] }) };
      if (parsed.pathname === '/api/panel-object') return { ok: true, text: async () => JSON.stringify({
        schemaVersion: 1, asset: ASSET, integration: 'gsc', report: 'query', reportDate: ROW.reportDate,
        providerRows: 1, providerTruncated: false,
        pages: [{ request: { dimensions: ['query'] }, response: { rows: [{ keys: ['sample query'], clicks: 7, impressions: 100, ctr: 0.07, position: 4 }] } }],
      }) };
      throw new Error(`Unexpected external operation: ${url}`);
    },
    analyze: async () => completed(),
    publish: async (input) => {
      assert.equal(input.door, options.door);
      assert.equal(input.token, 'op');
      assert.equal(input.file, undefined);
      // The whole pass, including its freshness output, finished before POST.
      await fs.access(path.join(options.analysisRoot, input.asset, FRESHNESS_FILE));
      published.push(input.snapshot);
      return { id: 'fixture-snapshot', created: true, itemCount: input.snapshot.items.length };
    },
  };
  return { dir, options, deps, published, calls };
}

test('successful refresh publishes its returned analysis, not an old or concurrently replaced file', async (t) => {
  const f = await fixture(t);
  const result = await refreshAsset(ASSET, f.options, { ...f.deps, analyze: async ({ output }) => {
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'executive.json'), JSON.stringify(snapshot({ generatedAt: '2026-08-05T00:00:00.000Z' })));
    return completed();
  } });
  assert.deepEqual(f.published, [snapshot()]);
  assert.equal(result.publication.status, 'published');
  assert.equal(result.publication.generatedAt, NOW);
  assert.equal(result.publication.itemCount, 0); // No findings != no input data.
});

test('real analyzer output goes through the existing publisher; only the advisory POST is made', async (t) => {
  const f = await fixture(t);
  const posts = [];
  const result = await refreshAsset(ASSET, f.options, {
    ...f.deps, now: () => new Date().toISOString(), analyze: analyzeSignalHistory,
    publish: (input) => publishExecutiveSnapshot({ ...input, post: async (url, init) => {
      posts.push({ url, init });
      const contentSha256 = createHash('sha256').update(init.body).digest('hex');
      return { ok: true, json: async () => ({ id: `insight:${ASSET}:${contentSha256.slice(0, 24)}`, asset: ASSET, contentSha256, generatedAt: input.snapshot.generatedAt, created: true }) };
    } }),
  });
  assert.equal(result.publication.status, 'published');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://door.test/api/insight-snapshot');
  const saved = JSON.parse(await fs.readFile(path.join(f.options.analysisRoot, ASSET, 'executive.json'), 'utf8'));
  assert.deepEqual(JSON.parse(posts[0].init.body), saved);
  assert.equal(saved.sourceArchiveCount, 1);
  assert.equal(saved.windowEnd, ROW.reportDate);
  assert.ok(f.calls.every((url) => new URL(url).origin === 'http://door.test'));
  assert.equal(f.calls.filter((url) => new URL(url).pathname === '/api/config-documents').length, 1);
});

test('an explicit preview updates files but never publishes', async (t) => {
  const f = await fixture(t);
  const result = await refreshAsset(ASSET, { ...f.options, publish: false }, f.deps);
  assert.deepEqual(f.published, []);
  assert.match(result.publication.reason, /local preview/);
});

test('no input archives retain prior advice, while an empty findings list with input publishes', async (t) => {
  const f = await fixture(t);
  const result = await refreshAsset(ASSET, f.options, { ...f.deps,
    get: async () => ({ ok: true, json: async () => ({ asset: ASSET, manifest: [], trend: [] }) }),
    analyze: async () => completed(snapshot({ sourceArchiveCount: 0, windowStart: null, windowEnd: null })),
  });
  assert.equal(result.publication.status, 'skipped');
  assert.match(result.publication.reason, /no archived source reports; prior advice retained/);
  assert.equal(result.freshness.fresh, false);
  assert.deepEqual(f.published, []);
});

test('stale or partial source coverage stays honestly dated when its valid reanalysis is published', async (t) => {
  const f = await fixture(t);
  const old = { ...ROW, reportDate: '2026-07-01' };
  const get = f.deps.get;
  const result = await refreshAsset(ASSET, f.options, { ...f.deps,
    get: async (url) => new URL(url).pathname === '/api/panel-source'
      ? { ok: true, json: async () => ({ asset: ASSET, manifest: [old], trend: [] }) } : get(url),
    analyze: async () => completed(snapshot({ windowStart: old.reportDate, windowEnd: old.reportDate })),
  });
  assert.equal(result.freshness.fresh, false);
  assert.equal(result.publication.status, 'published');
  assert.equal(f.published[0].windowEnd, '2026-07-01');
  assert.deepEqual(f.published[0].methodology, snapshot().methodology);
});

for (const [name, mutate] of [
  ['absent result', () => undefined],
  ['foreign asset', (value) => ({ ...value, asset: 'other.example' })],
  ['missing returned snapshot', (value) => ({ ...value, executiveSnapshot: undefined })],
  ['wrong generation', (value) => ({ ...value, analyzedAt: '2026-08-05T00:00:00.000Z' })],
  ['wrong input count', (value) => ({ ...value, archiveCount: 2 })],
  ['negative input count', () => completed(snapshot({ sourceArchiveCount: -1 }))],
  ['invalid date', () => completed(snapshot({ generatedAt: 'not a date' }))],
  ['old leftover generation', () => completed(snapshot({ generatedAt: '2026-08-05T00:00:00.000Z' }))],
  ['future generation', () => completed(snapshot({ generatedAt: '2027-01-01T00:00:00.000Z' }))],
]) {
  test(`${name} never publishes`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps, analyze: async () => mutate(completed()) }), /no matching completed analysis/);
    assert.deepEqual(f.published, []);
  });
}

for (const body of [{}, { asset: 'other.example', manifest: [], trend: [] }, { asset: ASSET, manifest: 'broken', trend: [] }]) {
  test(`malformed or foreign manifest ${JSON.stringify(body)} cannot refresh advice`, async (t) => {
    const f = await fixture(t);
    let analyzed = false;
    await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps,
      get: async () => ({ ok: true, json: async () => body }),
      analyze: async () => { analyzed = true; return completed(); },
    }), /malformed or belongs to another asset/);
    assert.equal(analyzed, false);
    assert.deepEqual(f.published, []);
  });
}

test('failed downloads and analysis never reach the publisher', async (t) => {
  for (const phase of ['download', 'analysis']) {
    const f = await fixture(t);
    const get = f.deps.get;
    await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps,
      get: async (url) => phase === 'download' && new URL(url).pathname === '/api/panel-object' ? { ok: false, status: 503 } : get(url),
      analyze: async ({ output }) => {
        // A failed run may leave a valid-looking previous output on disk.
        await fs.mkdir(output, { recursive: true });
        await fs.writeFile(path.join(output, 'executive.json'), JSON.stringify(snapshot()));
        throw new Error('analysis did not complete');
      },
    }), phase === 'download' ? /HTTP 503/ : /analysis did not complete/);
    assert.deepEqual(f.published, []);
  }
});

test('a local output-write failure after analysis prevents publication', async (t) => {
  const f = await fixture(t);
  await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps,
    analyze: async ({ output }) => {
      await fs.mkdir(path.join(output, FRESHNESS_FILE), { recursive: true });
      return completed();
    },
  }), /EISDIR/);
  assert.deepEqual(f.published, []);
});

test('publication failure is a failed asset pass, does not stop other enabled assets, and retries safely', async (t) => {
  const f = await fixture(t);
  const roster = { assets: { [ASSET]: { enabled: true }, 'fees.example': { enabled: true }, 'disabled.example': { enabled: false } } };
  const published = [];
  let fail = true;
  const deps = { ...f.deps,
    fetchImpl: async () => Response.json({ ready: true, documents: [
      { file: 'config/signal-panels.json', version: 1, body: roster },
    ] }),
    analyze: async ({ asset }) => completed(snapshot({ asset })),
    publish: async (input) => {
      if (input.asset === ASSET && fail) throw new Error('store unavailable');
      const created = !published.includes(input.asset);
      published.push(input.asset);
      return { id: `fixture:${input.asset}`, created, itemCount: 0 };
    },
  };
  const options = { ...f.options, asset: null, all: false, windowDays: null };
  const first = await refreshPanels(options, deps);
  assert.deepEqual(first.failures, [{ asset: ASSET, message: 'Recommendation publication not confirmed: store unavailable' }]);
  assert.deepEqual(published, ['fees.example']);
  fail = false;
  const retry = await refreshPanels(options, deps);
  assert.deepEqual(retry.failures, []);
  assert.deepEqual(retry.results.map((row) => [row.asset, row.publication.created]), [[ASSET, true], ['fees.example', false]]);
  assert.ok(!published.includes('disabled.example'));
});

test('the real refresh stops publication when its own configuration store is unavailable', async (t) => {
  const f = await fixture(t);
  const output = path.join(f.options.analysisRoot, ASSET);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'executive.json'), 'previous result');
  await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps, analyze: analyzeSignalHistory,
    get: async (url, init) => new URL(url).pathname === '/api/config-documents'
      ? Response.json({ ready: false }, { status: 503 }) : f.deps.get(url, init),
  }), /Configuration database unavailable/);
  assert.deepEqual(f.published, []);
  assert.equal(await fs.readFile(path.join(output, 'executive.json'), 'utf8'), 'previous result');
});
