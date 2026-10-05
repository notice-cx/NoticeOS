import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { analyzeSignalHistory } from './signal-history-analyze.mjs';
import { publishSignalHistory } from './signal-history.mjs';
import { panelReportPath, panelReportRelativePath } from './signal-panel-paths.mjs';
import { freshnessReport, refreshAsset, trendCsv } from './signal-panels-refresh.mjs';
import { runPanelRefresh } from './runner/panel-refresh.mjs';

const ASSET = 'meals.example';
const NOW = '2026-09-22T06:00:00.000Z';
const DAY = '2026-09-20';
const SOURCE_ROW = { integration: 'gsc', report: 'query', reportDate: DAY,
  objectKey: 'synthetic-query', contentSha256: 'a'.repeat(64), providerRows: 1,
  finishedAt: '2026-09-21T12:15:00.000Z', providerTruncated: 0 };
const TREND = [{ date: DAY, integration: 'gsc', metric: 'clicks', value: 7, provisional: 0 }];
const valueEvents = async () => ({ assets: {} });

function archive(clicks = 7) {
  return { schemaVersion: 1, asset: ASSET, integration: 'gsc', report: 'query', reportDate: DAY,
    providerRows: 1, providerTruncated: false, pages: [{ request: { dimensions: ['query'] },
      response: { rows: [{ keys: ['sample query'], clicks, impressions: 100, ctr: clicks / 100, position: 4 }] } }] };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-panel-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { door: 'http://fixture.invalid', downloadsRoot: path.join(root, 'downloads'),
    historyRoot: path.join(root, 'history'), analysisRoot: path.join(root, 'reports'), publish: true };
  const publications = [];
  const deps = {
    token: 'fixture-operator', windowDays: 35, freshnessMaxAgeDays: 7, now: () => NOW,
    get: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, options.door);
      if (parsed.pathname === '/api/panel-source') return Response.json({ asset: ASSET, manifest: [SOURCE_ROW], trend: TREND });
      if (parsed.pathname === '/api/panel-object') return new Response(JSON.stringify(archive()));
      throw new Error(`Unexpected fixture request: ${url}`);
    },
    analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: valueEvents, now: NOW }),
    publish: async ({ snapshot }) => {
      const output = panelReportPath(ASSET, options.analysisRoot);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'executive.json'), 'utf8')), snapshot);
      await fs.access(path.join(output, 'report.json'));
      await fs.access(path.join(output, 'freshness.json'));
      await fs.access(path.join(output, 'signal-trend-daily.csv'));
      publications.push(snapshot);
      return { id: 'fixture-snapshot', created: true };
    },
  };
  return { root, options, deps, publications, output: panelReportPath(ASSET, options.analysisRoot) };
}

async function published(output) {
  return { link: await fs.readlink(output), files: await Promise.all((await fs.readdir(output)).sort()
    .map(async (name) => [name, await fs.readFile(path.join(output, name), 'utf8')])) };
}

test('cutover leaves old plain analysis intact and publishes equivalent report, trend and freshness from one pinned generation', async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.root, 'analysis', ASSET);
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, 'executive.json'), 'previous plain output');
  assert.equal(panelReportRelativePath(ASSET), `.local/signal-dumps/reports/${ASSET}`);
  // A newer history is published after this refresh pins its input. Its rows
  // must not leak into the analysis of the returned generation.
  const result = await refreshAsset(ASSET, f.options, { ...f.deps,
    analyze: async (input) => {
      assert.equal(input.generation, 1);
      const file = path.join(f.options.downloadsRoot, ASSET, 'gsc', 'query', `${DAY}.json`);
      await fs.writeFile(file, JSON.stringify(archive(99)));
      assert.equal((await publishSignalHistory({ asset: ASSET, input: path.dirname(path.dirname(path.dirname(file))), output: input.history })).generation, 2);
      return f.deps.analyze(input);
    },
  });
  assert.equal(result.publication.status, 'published');
  assert.equal(f.publications.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'report.json'), 'utf8')).generation, 1);
  assert.equal(await fs.readFile(path.join(legacy, 'executive.json'), 'utf8'), 'previous plain output');
  assert.deepEqual(await fs.readdir(legacy), ['executive.json']);
  assert.equal(await fs.readFile(path.join(f.output, 'signal-trend-daily.csv'), 'utf8'), trendCsv(TREND));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.output, 'freshness.json'), 'utf8')),
    freshnessReport({ asset: ASSET, manifest: [{ ...SOURCE_ROW, asset: ASSET }], maxAgeDays: 7, refreshedAt: NOW }));

  // Frozen before retirement against the old command on this exact fixture.
  // These are actual reader files, not a second derivation of the findings.
  const reference = JSON.parse(await fs.readFile(new URL('./fixture-history-analysis.json', import.meta.url), 'utf8'));
  for (const [name, hash] of Object.entries(reference.panelFiles)) {
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(f.output, name))).digest('hex'), hash, name);
  }
});

test('interruption at each stage and exhausted staging/time limits preserve the complete report and previous store snapshot', async (t) => {
  const f = await fixture(t);
  await refreshAsset(ASSET, f.options, f.deps);
  const before = await published(f.output);
  const failingDeps = { ...f.deps, now: () => '2026-09-23T06:00:00.000Z' };
  for (const stage of ['reading', 'writing', 'publishing']) {
    await assert.rejects(refreshAsset(ASSET, f.options, { ...failingDeps,
      analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: valueEvents, now: NOW },
        { onStage: (reached) => reached === stage ? 'kill' : undefined }),
    }), /was stopped/);
    assert.deepEqual(await published(f.output), before, stage);
  }
  // Companion files consume the same staged-disk budget as every report file.
  await assert.rejects(refreshAsset(ASSET, { ...f.options, limits: { tempDiskMb: 1 } }, { ...failingDeps,
    analyze: (input) => f.deps.analyze({ ...input, reportFiles: { ...input.reportFiles, 'signal-trend-daily.csv': 'x'.repeat(1024 * 1024) } }),
  }), /temporary disk/);
  await assert.rejects(refreshAsset(ASSET, { ...f.options, limits: { timeLimitSeconds: 1 } }, { ...failingDeps,
    analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: valueEvents, now: NOW },
      { onStage: () => new Promise(() => {}) }),
  }), /1-second limit/);
  assert.deepEqual(await published(f.output), before);
  assert.equal(f.publications.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output, 'freshness.json'), 'utf8')).refreshedAt, NOW);
  assert.deepEqual((await fs.readdir(`${f.output}.reports`)).filter((name) => name.startsWith('.')), []);
});

test('overlap refuses before reading sources while the bounded analysis and supervisor leave the fixture server responsive', async (t) => {
  const f = await fixture(t);
  let reached;
  const atReading = new Promise((resolve) => { reached = resolve; });
  let proceed;
  const gate = new Promise((resolve) => { proceed = resolve; });
  const server = http.createServer((_request, response) => response.end('fixture healthy'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const state = { skipping: null, running: false };
  const job = runPanelRefresh({ running: true, ready: true }, { state, stopped: () => false, emit: () => {},
    run: async (_command, _args, config) => {
      assert.equal(config.timeoutMs, 15 * 60_000);
      await refreshAsset(ASSET, f.options, { ...f.deps,
        analyze: (input) => analyzeSignalHistory({ ...input, readValueEvents: valueEvents, now: NOW },
          { onStage: (stage) => { if (stage === 'reading') { reached(); return gate; } } }),
      });
      return { code: 0 };
    },
  });
  await atReading;
  try {
    await assert.rejects(refreshAsset(ASSET, f.options, { ...f.deps,
      get: () => { throw new Error('Overlapping pass read a source'); },
    }), /Another panel refresh/);
    assert.equal(await runPanelRefresh({ running: true, ready: true }, { state, stopped: () => false, emit: () => {} }), null);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'fixture healthy');
    assert.equal(f.publications.length, 0);
  } finally { proceed(); }
  assert.equal((await job).code, 0);
  assert.equal(f.publications.length, 1);
  assert.equal(state.running, false);
});

test('explicit plain output is refused without changing its files or publishing a snapshot', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.output, { recursive: true });
  await fs.writeFile(path.join(f.output, 'freshness.json'), 'previous freshness');
  await assert.rejects(refreshAsset(ASSET, f.options, f.deps), /not a report link this command made/);
  assert.equal(await fs.readFile(path.join(f.output, 'freshness.json'), 'utf8'), 'previous freshness');
  assert.deepEqual(await fs.readdir(f.output), ['freshness.json']);
  assert.deepEqual(f.publications, []);
});
