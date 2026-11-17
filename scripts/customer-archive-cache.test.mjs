import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { customerArchiveCache } from './customer-archive-cache.mjs';
import { analyzeSignalHistory } from './signal-history-analyze.mjs';
import { publishSignalHistory } from './signal-history.mjs';
import { readCurrentGeneration, readGeneration } from './history-files.mjs';
import { refreshAsset } from './signal-panels-refresh.mjs';

const asset = 'garden.example';
const clock = day => `2026-11-${String(day).padStart(2, '0')}T13:10:00.000Z`;
const dayOf = day => clock(day).slice(0, 10);
const hash = body => createHash('sha256').update(body).digest('hex');

function siteArchive(workspaceId, day, kind, correction = false, queryRows = 80) {
  const integration = kind === 'crawl-issues' ? 'bing-webmaster' : 'gsc';
  const reportDate = dayOf(day);
  const requests = kind === 'crawl-issues' ? [{ request: { method: 'GetCrawlIssues' }, response: { d: [{
    __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', Url: `https://${asset}/guides/${day}`,
    HttpCode: 404, Issues: correction ? 17 : 2, InLinks: 8,
  }] } }] : [{ request: { dimensions: ['query'] }, response: { rows: Array.from({ length: queryRows }, (_, index) => ({
    keys: [`garden planner ${hash(`query-${index}`)}`], clicks: (correction ? 29 : day) + index,
    impressions: 450 + index, ctr: 0.06, position: 3.6,
  })) } }];
  const collectedAt = clock(correction ? day + 1 : day);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, asset, integration, report: kind, reportDate,
    collectedAt, dataState: 'provider-final', providerRows: kind === 'crawl-issues' ? 1 : queryRows,
    providerTruncated: false, pages: requests })}\n`);
  const etag = hash(bytes);
  const objectKey = `workspaces/${workspaceId}/raw/${asset}/${integration}/${kind}/${reportDate}-${etag}.json.gz`;
  return { row: { asset, objectKey, integration, report: kind, reportDate, finishedAt: collectedAt,
    contentSha256: etag, providerRows: kind === 'crawl-issues' ? 1 : queryRows, providerTruncated: 0 }, bytes, etag };
}

async function storageBytes(root) {
  const totals = { logical: 0, allocated: 0 };
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const { size, blocks } = await fs.stat(path.join(entry.parentPath, entry.name));
    totals.logical += size;
    totals.allocated += blocks * 512;
  }
  return totals;
}

async function reportFixture(t, { limitBytes, queryRows }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-bounded-archives-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  const archiveRoot = path.join(root, 'cache');
  const fixtures = new Map(), current = new Map();
  for (let day = 1; day <= 18; day++) for (const kind of ['query', 'crawl-issues']) {
    const object = siteArchive(workspaceId, day, kind, false, queryRows);
    fixtures.set(object.row.objectKey, object);
    current.set(`${day}-${kind}`, object.row);
  }
  const counts = { plainGets: 0, cachedGets: 0, heads: 0, cachedReadBytes: 0 };
  const options = name => ({ door: 'http://source.invalid', analysisRoot: path.join(root, name, 'reports'),
    downloadsRoot: path.join(root, name, 'downloads'), historyRoot: path.join(root, name, 'history') });
  const valueEvents = { body: { assets: {} }, version: 1 };
  function connectCache() {
    return customerArchiveCache({ root: archiveRoot, workspaceId, asset, limitBytes,
      async get(key) {
        counts.cachedGets++;
        const object = fixtures.get(key);
        if (!object) throw new Error('Durable archive unavailable.');
        counts.cachedReadBytes += object.bytes.length;
        return object;
      }, async head(key) { counts.heads++; return fixtures.get(key) ?? null; },
    });
  }
  const published = {};
  async function run(name, day, { from = day - 5, reader } = {}) {
    const selected = [...current.values()].filter(row => row.reportDate >= dayOf(from) && row.reportDate <= dayOf(day));
    return refreshAsset(asset, options(name), {
      now: () => clock(day), windowDays: 5, freshnessMaxAgeDays: 7,
      ...(reader ? { readArchive: row => reader(row.objectKey, row.reportDate) } : {}),
      async get(url) {
        const { pathname, searchParams } = new URL(url);
        if (pathname === '/api/panel-source') return Response.json({ asset, from: dayOf(from), manifest: selected, trend: [] });
        counts.plainGets++;
        const object = fixtures.get(searchParams.get('key'));
        return new Response(object?.bytes, { status: object ? 200 : 404 });
      },
      writeHistory: input => publishSignalHistory(input, { now: () => clock(day) }),
      analyze: input => analyzeSignalHistory({ ...input, now: clock(day), readValueEvents: async () => valueEvents }),
      async publish({ snapshot }) { published[name] = JSON.stringify(snapshot); return { id: hash(published[name]), created: true }; },
    });
  }
  async function footprint() {
    const cache = await storageBytes(archiveRoot);
    const cachedDownloads = await storageBytes(options('cached').downloadsRoot);
    const plainDownloads = await storageBytes(options('plain').downloadsRoot);
    const cachedHistory = await storageBytes(options('cached').historyRoot);
    const plainHistory = await storageBytes(options('plain').historyRoot);
    const cached = {
      logical: cache.logical + cachedDownloads.logical + cachedHistory.logical,
      allocated: cache.allocated + cachedDownloads.allocated + cachedHistory.allocated,
    };
    const plain = {
      logical: plainDownloads.logical + plainHistory.logical, allocated: plainDownloads.allocated + plainHistory.allocated,
    };
    return { cache, cachedDownloads, plainDownloads, cachedHistory, plainHistory, cached, plain };
  }
  return { workspaceId, archiveRoot, current, fixtures, counts, options, connectCache, published, run, footprint };
}

test('a bounded customer report matches retained full downloads across windows, correction and recovery', { timeout: 120000 }, async t => {
  const limits = 36000;
  const { workspaceId, archiveRoot, current, fixtures, counts, options, connectCache, published, run, footprint } =
    await reportFixture(t, { limitBytes: limits, queryRows: 80 });
  const firstRun = performance.now();
  let currentReport = await run('cached', 6, { from: 1, reader: connectCache() });
  const cold = { elapsedMs: Math.round(performance.now() - firstRun), ...counts };
  const plainStart = performance.now();
  const firstPlain = await run('plain', 6, { from: 1 });
  const plainColdMs = Math.round(performance.now() - plainStart);
  assert.equal(published.cached, published.plain);
  assert.deepEqual(currentReport.freshness, firstPlain.freshness);
  const firstPanel = path.join(options('cached').analysisRoot, `${asset}.reports`, currentReport.version, 'executive.json');
  const history = path.join(options('cached').historyRoot, asset);
  const originalHistory = await readCurrentGeneration(history);
  const original = await fs.readFile(firstPanel, 'utf8');
  const windowGets = [];
  for (const day of [12, 18]) {
    const before = { ...counts };
    currentReport = await run('cached', day, { reader: connectCache() });
    const baseline = await run('plain', day);
    windowGets.push({ cached: counts.cachedGets - before.cachedGets, baseline: counts.plainGets - before.plainGets });
    assert.equal(published.cached, published.plain, `day ${day} findings`);
    assert.deepEqual(currentReport.freshness, baseline.freshness, `day ${day} evidence`);
    assert.equal(JSON.parse(published.cached).sourceArchiveCount, day * 2);
    assert.ok((await storageBytes(archiveRoot)).logical <= limits);
  }
  const warmBefore = { ...counts }, warmStart = performance.now();
  await run('cached', 18, { reader: connectCache() });
  const warm = { elapsedMs: Math.round(performance.now() - warmStart), gets: counts.cachedGets - warmBefore.cachedGets,
    heads: counts.heads - warmBefore.heads, bytes: counts.cachedReadBytes - warmBefore.cachedReadBytes };
  assert.equal(warm.gets, 0);
  assert.equal(published.cached, published.plain);

  // A late correction must preserve the old version if its bytes are absent.
  const previous = published.cached;
  const corrected = siteArchive(workspaceId, 17, 'query', true);
  current.set('17-query', corrected.row);
  const expiredKey = current.get('1-query').objectKey;
  const expiredFile = path.join(archiveRoot, `${hash(expiredKey)}.cache`);
  await assert.rejects(fs.access(expiredFile), { code: 'ENOENT' });
  await assert.rejects(run('cached', 18, { reader: connectCache() }), /Durable archive unavailable/u);
  assert.equal(published.cached, previous);
  assert.equal(await fs.readFile(firstPanel, 'utf8'), original);
  assert.deepEqual(await readGeneration(history, originalHistory.generation), originalHistory);
  fixtures.set(corrected.row.objectKey, corrected);
  const repaired = await run('cached', 18, { reader: connectCache() });
  const plain = await run('plain', 18);
  assert.equal(published.cached, published.plain);
  assert.deepEqual(repaired.freshness, plain.freshness);
  assert.equal(await fs.readFile(firstPanel, 'utf8'), original);
  const restoredDownloads = path.join(options('restored').downloadsRoot, asset);
  await fs.mkdir(restoredDownloads, { recursive: true });
  await fs.copyFile(path.join(options('cached').downloadsRoot, asset, 'manifest.json'), path.join(restoredDownloads, 'manifest.json'));
  const evicted = fixtures.get(expiredKey);
  fixtures.delete(expiredKey);
  await assert.rejects(run('restored', 18, { reader: connectCache() }), /Durable archive unavailable/u);
  assert.equal(published.restored, undefined);
  assert.deepEqual(await readGeneration(history, originalHistory.generation), originalHistory);
  fixtures.set(expiredKey, evicted);
  const replay = await run('restored', 18, { reader: connectCache() });
  assert.equal(published.restored, published.plain);
  assert.deepEqual(replay.freshness, plain.freshness);
  const rawFiles = await fs.readdir(options('cached').downloadsRoot, { recursive: true });
  assert.deepEqual(rawFiles.filter(file => file.endsWith('.json')).map(file => path.basename(file)), ['manifest.json']);
  const sizes = await footprint();
  assert.ok(sizes.cache.logical <= limits && sizes.cached.logical < sizes.plain.logical);
  assert.deepEqual(await storageBytes(path.join(options('cached').historyRoot, asset, 'data')),
    await storageBytes(path.join(options('plain').historyRoot, asset, 'data')));
  assert.ok(windowGets.every(({ cached, baseline }) => cached <= 3 * baseline));
  t.diagnostic(`Cold cached ${cold.elapsedMs} ms, ${cold.cachedGets} GET, ${cold.cachedReadBytes} decoded bytes. Cold full downloads ${plainColdMs} ms. Warm cached ${warm.elapsedMs} ms, ${warm.gets} GET and ${warm.heads} HEAD. Rolling-window GETs ${JSON.stringify(windowGets)}. Footprint ${JSON.stringify(sizes)}. ${counts.heads} eviction HEAD checks across the run.`);
});

test('provider-sized query archives use less total local storage without more routine GETs', { timeout: 120000 }, async t => {
  const { counts, connectCache, published, run, footprint } = await reportFixture(t, { queryRows: 2500 });
  const windowGets = [];
  let coldMs, coldDecodedBytes;
  for (const day of [6, 12, 18]) {
    const before = { ...counts }, started = performance.now();
    await run('cached', day, { reader: connectCache() });
    if (day === 6) {
      coldMs = Math.round(performance.now() - started);
      coldDecodedBytes = counts.cachedReadBytes;
    }
    await run('plain', day);
    windowGets.push({ cached: counts.cachedGets - before.cachedGets, baseline: counts.plainGets - before.plainGets });
    assert.equal(published.cached, published.plain);
  }
  const beforeWarm = { ...counts }, started = performance.now();
  await run('cached', 18, { reader: connectCache() });
  const warmMs = Math.round(performance.now() - started);
  assert.equal(counts.cachedGets, beforeWarm.cachedGets);
  assert.equal(counts.heads, beforeWarm.heads);
  const sizes = await footprint();
  assert.ok(sizes.cached.logical < sizes.plain.logical);
  assert.ok(sizes.cached.allocated <= sizes.plain.allocated);
  assert.deepEqual(windowGets, [{ cached: 12, baseline: 12 }, { cached: 12, baseline: 12 }, { cached: 12, baseline: 12 }]);
  t.diagnostic(`Cold cached ${coldMs} ms, 12 GET, ${coldDecodedBytes} decoded bytes. Warm cached ${warmMs} ms, 0 GET and 0 HEAD. Rolling-window GETs ${JSON.stringify(windowGets)}. Footprint ${JSON.stringify(sizes)}.`);
});

test('cache pressure preserves unqualified files and copies whose durable source cannot be proved', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-archive-ownership-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  const first = siteArchive(workspaceId, 1, 'query'), second = siteArchive(workspaceId, 2, 'query');
  const values = new Map([[first.row.objectKey, first], [second.row.objectKey, second]]);
  let gets = 0, headValid = true;
  const options = { root, workspaceId, asset, async get(key) { gets++; return values.get(key); },
    async head(key) { return headValid ? values.get(key) : null; } };
  const read = (cache, fixture) => cache(fixture.row.objectKey, fixture.row.reportDate);
  await read(customerArchiveCache(options), first);
  const managed = path.join(root, `${hash(first.row.objectKey)}.cache`);
  const unknown = path.join(root, `${'3'.repeat(64)}.cache`);
  const held = await fs.readFile(managed);
  await fs.writeFile(unknown, 'unqualified input');
  const rebound = () => customerArchiveCache({ ...options, limitBytes: held.length + 1024 });
  headValid = false;
  assert.deepEqual(await read(rebound(), second), second.bytes);
  assert.deepEqual(await fs.readFile(managed), held);
  assert.equal(await fs.readFile(unknown, 'utf8'), 'unqualified input');
  await assert.rejects(fs.access(path.join(root, `${hash(second.row.objectKey)}.cache`)), { code: 'ENOENT' });
  headValid = true;
  const damaged = Buffer.from(held);
  damaged[damaged.length - 1] ^= 1;
  await fs.writeFile(managed, damaged);
  await read(rebound(), second);
  assert.deepEqual(await fs.readFile(managed), damaged);
  assert.equal(await fs.readFile(unknown, 'utf8'), 'unqualified input');
  const earlier = gets;
  await assert.rejects(read(rebound(), siteArchive(randomUUID(), 2, 'query')), /does not belong/u);
  assert.equal(gets, earlier);
});

test('an interrupted archive write recovers on reopen and leaves unrelated files intact', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-archive-interrupted-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceId = randomUUID();
  const first = siteArchive(workspaceId, 1, 'query'), second = siteArchive(workspaceId, 2, 'query');
  const values = new Map([[first.row.objectKey, first], [second.row.objectKey, second]]);
  let gets = 0, available = false;
  const reopen = () => customerArchiveCache({ root, workspaceId, asset,
    async get(key) { gets++; return values.get(key); },
    async head(key) { return available ? values.get(key) : null; },
  });
  const read = (cache, fixture) => cache(fixture.row.objectKey, fixture.row.reportDate);
  await read(reopen(), first);
  const key = hash(first.row.objectKey);
  const file = path.join(root, `${key}.cache`);
  const marker = path.join(root, `.pending-${key}`);
  const temporary = `${marker}.data`;
  const complete = await fs.readFile(file);
  const header = complete.indexOf(10);
  const interrupted = complete.subarray(0, header + 5);
  await fs.rename(file, temporary);
  await fs.symlink(complete.subarray(0, header).toString(), marker);
  await fs.truncate(temporary, interrupted.length);
  const unknown = path.join(root, '.pending-write');
  await fs.writeFile(unknown, 'unclassified bytes');

  assert.deepEqual(await read(reopen(), second), second.bytes);
  assert.deepEqual(await fs.readFile(temporary), interrupted);
  const beforeWarm = gets;
  await read(reopen(), second);
  assert.equal(gets, beforeWarm);

  available = true;
  assert.deepEqual(await read(reopen(), first), first.bytes);
  await assert.rejects(fs.lstat(marker), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(temporary), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unknown, 'utf8'), 'unclassified bytes');
  const beforeReuse = gets;
  assert.deepEqual(await read(reopen(), first), first.bytes);
  assert.equal(gets, beforeReuse);
});
