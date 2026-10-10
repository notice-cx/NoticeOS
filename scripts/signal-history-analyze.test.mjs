import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_ANALYZED_AT,
  FIXTURE_ASSET,
  fixtureValueEvents,
  writeArchiveFixture,
  writeGrowingArchive,
} from './signal-archive-fixture.mjs';
import { resolvesAcrossReportDays } from './signal-archive.mjs';
import { readJsonFile } from './json-file.mjs';
import { createHash } from 'node:crypto';
import { RETENTION, datasetFiles, publishSignalHistory, readCurrentGeneration } from './signal-history.mjs';
import {
  REPORT_FORMAT,
  REPORT_RECORD,
  analyzeSignalHistory,
  describeReport,
  parseArgs,
  reportsFolder,
} from './signal-history-analyze.mjs';

// The analysis read from a published generation of the
// history files with DuckDB, in a bounded job, proven to write the analyzer's
// files. Synthetic archives only (scripts/signal-archive-fixture.mjs).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(REPO_ROOT, 'scripts', 'signal-history-analyze.mjs');
const EXPECTED_ANALYSIS = path.join(REPO_ROOT, 'scripts', 'fixture-archive-analysis');
const MARKET = { locationCode: 2840, languageCode: 'en' };

/** A site's archive, its history published, and where its report goes. */
async function workspace(t, growing = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-history-analyze-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'downloads');
  if (growing) await writeGrowingArchive(input, growing.days, growing.rows);
  else await writeArchiveFixture(input);
  const history = path.join(root, 'history');
  const published = await publishSignalHistory({ asset: FIXTURE_ASSET, input, output: history });
  return { root, input, history, output: path.join(root, 'report'), published };
}

function analyze(ws, options = {}, deps = {}) {
  return analyzeSignalHistory({
    asset: FIXTURE_ASSET,
    history: ws.history,
    output: ws.output,
    readValueEvents: fixtureValueEvents,
    market: MARKET,
    now: FIXTURE_ANALYZED_AT,
    ...options,
  }, deps);
}

/** Every file in `folder` (a link is followed), by name, with the run's own
 * folders written as the analyzer's fixture writes them. */
async function readFolder(folder, { output = folder, input = null } = {}) {
  const place = (text) => {
    let placed = text.replaceAll(path.relative(REPO_ROOT, output), '<output>');
    if (input) placed = placed.replaceAll(path.relative(REPO_ROOT, input), '<input>');
    return placed;
  };
  const files = new Map();
  for (const name of (await fs.readdir(folder)).sort()) files.set(name, place(await fs.readFile(path.join(folder, name), 'utf8')));
  return files;
}

/** What a reader of the report link sees. */
async function published(ws) {
  return { target: await fs.readlink(ws.output), files: await readFolder(ws.output) };
}

/** Anything a job left beside the reports: staging, a half-made link, a lock. */
async function leftovers(ws) {
  return (await fs.readdir(reportsFolder(ws.output))).filter((name) => name.startsWith('.'));
}

/** One more GSC query day, so the next history run publishes a new generation
 * (at `now`, when given). */
async function addQueryDay(ws, reportDate = '2026-09-21', now = null) {
  const archive = await readJsonFile(path.join(ws.input, 'gsc', 'query', '2026-09-20.json'));
  archive.reportDate = reportDate;
  for (const row of archive.pages[0].response.rows) row.clicks += 3;
  await fs.writeFile(path.join(ws.input, 'gsc', 'query', `${reportDate}.json`), `${JSON.stringify(archive)}\n`);
  return publishSignalHistory({ asset: FIXTURE_ASSET, input: ws.input, output: ws.history }, now ? { now: () => now } : {});
}

test('every report file matches the frozen retired-analyzer reference over one reading of each report day', async (t) => {
  const ws = await workspace(t);
  // The history reads a report day delivered twice once, from the copy read
  // last; a report day the downloads manifest names with no archive is left
  // out, as the analyzer leaves it out.
  assert.equal(ws.published.superseded.length, 6);
  assert.deepEqual(ws.published.missing, [{ integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-17' }]);
  const result = await analyze(ws);

  // Captured from the retired analyzer at the exact reference commit, before
  // deletion, over the same canonical one-copy-per-report-day archive.
  const reference = await readJsonFile(path.join(REPO_ROOT, 'scripts', 'fixture-history-analysis.json'));
  assert.equal(reference.asset, FIXTURE_ASSET);
  assert.equal(reference.analyzedAt, FIXTURE_ANALYZED_AT);
  const ours = await readFolder(ws.output, { output: ws.output, input: ws.input });
  assert.equal(Object.keys(reference.files).length, 47);
  assert.deepEqual([...ours.keys()], [...Object.keys(reference.files), REPORT_RECORD].sort());
  for (const [name, hash] of Object.entries(reference.files)) {
    assert.equal(createHash('sha256').update(ours.get(name)).digest('hex'), hash, name);
  }

  // What it returns is what it wrote, as the analyzer's return is.
  const { executiveSnapshot, report, cost, ...summary } = JSON.parse(JSON.stringify(result));
  assert.deepEqual(summary, await readJsonFile(path.join(ws.output, 'summary.json')));
  assert.deepEqual(executiveSnapshot, await readJsonFile(path.join(ws.output, 'executive.json')));
  assert.deepEqual(report.files, 48);
  assert.ok(cost.bytesRead > 0 && cost.peakMb > 0 && cost.secondsTotal > 0);
  assert.match(describeReport(result, ws.output), /^Generation 1 → .+: 48 files, 345 rows, 8 findings\. Read \d+\.\d MB in \d+\.\d s, peak \d+ MB\.$/);
});

test('retained Clarity generations preserve empty newest revision provenance without reviving older page counts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-clarity-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'downloads'); await fs.mkdir(input);
  const ws = { root, input, history: path.join(root, 'history'), output: path.join(root, 'report') };
  const envelope = { schemaVersion: 1, provider: 'microsoft', asset: FIXTURE_ASSET, integration: 'clarity', report: 'url-3d',
    reportDate: '2026-09-21', dataState: 'provider-snapshot', providerTruncated: false };
  const write = async (name, fields, information) => fs.writeFile(path.join(input, `${name}.json`), JSON.stringify({ ...envelope, ...fields,
    providerRows: information.length, pages: [{ request: { numOfDays: 3, dimension1: 'URL' },
      response: [{ metricName: 'ScriptErrorCount', information }] }] }));
  const page = [{ Url: 'https://meals.example/planner', sessionsCount: '114', subTotal: '19' }];
  await write('old-day', { reportDate: '2026-09-20', collectedAt: '2026-09-20T04:30:00.000Z' }, page);
  await write('current', { collectedAt: '2026-09-21T04:30:00.000Z' }, page);
  await publishSignalHistory({ asset: FIXTURE_ASSET, input, output: ws.history });
  const before = (await analyze(ws)).executiveSnapshot.clarity;
  assert.equal(before.page.scriptErrors, 19);
  await write('current', { collectedAt: '2026-09-21T05:30:00.000Z' }, []);
  await publishSignalHistory({ asset: FIXTURE_ASSET, input, output: ws.history });
  const current = (await analyze(ws)).executiveSnapshot.clarity;
  assert.deepEqual(current, { source: 'clarity', reportDate: '2026-09-21', collectedAt: '2026-09-21T05:30:00.000Z',
    windowHours: 72, truncated: false, page: null, unattributedSessions: null });
  assert.deepEqual((await analyze(ws, { generation: 1 })).executiveSnapshot.clarity, before);
  assert.deepEqual(await leftovers(ws), []);
});

test('over the archive as delivered, the one difference is a report day delivered twice, read once from the copy read last', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const ours = await readFolder(ws.output, { output: ws.output, input: ws.input });
  // The analyzer's own files over this archive, captured before the history
  // existed (scripts/fixture-archive-analysis/).
  const theirs = await readFolder(EXPECTED_ANALYSIS);
  theirs.delete('command-line.json');
  theirs.delete('console.txt');
  const differing = [...theirs.keys()].filter((name) => ours.get(name) !== theirs.get(name));
  assert.deepEqual(differing, ['bing-webmaster-crawl-stats.csv', 'executive.json', 'gsc-country.csv', 'gsc-query.csv', 'summary.json']);

  // The summary differs by the set-aside copies and their rows, nothing else.
  // Where the rules resolve a day across report days, the copy read last won
  // in the analyzer too, so its family keeps its rows.
  const superseded = new Set(ws.published.superseded.map(({ path: file }) => `<input>/${file}`));
  const expected = JSON.parse(theirs.get('summary.json'));
  const removed = expected.archives.filter((archive) => superseded.has(archive.file));
  assert.equal(removed.length, 6);
  expected.archives = expected.archives.filter((archive) => !superseded.has(archive.file));
  expected.archiveCount = expected.archives.length;
  for (const archive of removed) {
    const family = `${archive.integration}-${archive.report}`;
    if (!resolvesAcrossReportDays(family)) expected.datasets.find((dataset) => dataset.name === family).rows -= archive.flattenedRows;
  }
  assert.deepEqual(JSON.parse(ours.get('summary.json')), expected);
  const rows = (summary, name) => summary.datasets.find((dataset) => dataset.name === name).rows;
  const before = JSON.parse(theirs.get('summary.json'));
  assert.deepEqual(
    ['gsc-query', 'gsc-country', 'bing-webmaster-crawl-stats'].map((name) => [name, rows(before, name), rows(expected, name)]),
    [['gsc-query', 96, 90], ['gsc-country', 36, 28], ['bing-webmaster-crawl-stats', 14, 10]],
  );

  // The same findings, in the same order; their figures are the analyzer's
  // over one reading (the test above).
  const executive = [JSON.parse(ours.get('executive.json')), JSON.parse(theirs.get('executive.json'))];
  const keys = ({ items, suppressedItems }) => [items.map((item) => item.key), suppressedItems.map((item) => item.key)];
  assert.deepEqual(keys(executive[0]), keys(executive[1]));
  assert.deepEqual(executive.map((snapshot) => snapshot.sourceArchiveCount), [99, 105]);
});

test('a run names its generation; the same generation gives the same report again, whatever was published since', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const first = await published(ws);
  const manifest = await readCurrentGeneration(ws.history);
  assert.deepEqual(JSON.parse(first.files.get(REPORT_RECORD)), {
    format: REPORT_FORMAT,
    asset: FIXTURE_ASSET,
    generation: 1,
    generationContent: manifest.content,
    derivation: manifest.derivation.id,
    history: path.relative(REPO_ROOT, ws.history),
    analyzedAt: FIXTURE_ANALYZED_AT,
    duckdb: manifest.writer.duckdb,
  });
  await analyze(ws);
  const again = await published(ws);
  assert.notEqual(again.target, first.target);
  assert.deepEqual(again.files, first.files);

  // A new report day is a new generation, and the newest is read by default …
  assert.equal((await addQueryDay(ws)).generation, 2);
  const latest = await analyze(ws);
  assert.equal(latest.report.generation, 2);
  const second = await published(ws);
  assert.notEqual(second.files.get('gsc-query.csv'), first.files.get('gsc-query.csv'));
  // … while generation 1 still reads exactly as it did.
  assert.equal((await analyze(ws, { generation: 1 })).report.generation, 1);
  assert.deepEqual((await published(ws)).files, first.files);

  // The current report and the one before it are kept; older ones are gone.
  const kept = (await fs.readdir(reportsFolder(ws.output))).filter((name) => !name.startsWith('.'));
  assert.deepEqual(kept.sort(), [path.basename(second.target), path.basename((await published(ws)).target)].sort());
  assert.deepEqual(await leftovers(ws), []);
});

test('a generation that lists an archive it could not read is refused, as the analyzer refuses the archive', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const before = await published(ws);
  await fs.writeFile(path.join(ws.input, 'gsc', 'page', '2026-09-22.json'), '{"schemaVersion": 1, "asset"');
  const result = await publishSignalHistory({ asset: FIXTURE_ASSET, input: ws.input, output: ws.history });
  assert.deepEqual(result.unreadable, [{ path: 'gsc/page/2026-09-22.json', reason: 'not JSON' }]);
  await assert.rejects(analyze(ws), {
    message: 'Generation 2 lists 1 archive it could not read (first: gsc/page/2026-09-22.json — not JSON). A report day that cannot be read is unknown, so no report was written, as the analyzer writes none.',
  });
  assert.deepEqual(await published(ws), before);
  assert.deepEqual(await leftovers(ws), []);
});

test('a file changed or missing since its generation was published, or a generation other rules wrote, is refused', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const before = await published(ws);
  const manifest = await readCurrentGeneration(ws.history);
  const file = datasetFiles(ws.history, manifest, 'gsc-query')[0];
  const bytes = await fs.readFile(file);
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(analyze(ws), /^Error: data\/gsc-query\/2026-09\/[0-9a-f]+\.parquet is not the file generation 1 names: its bytes changed after it was published\.$/);
  await fs.rm(file);
  await assert.rejects(analyze(ws), /^Error: Generation 1 names data\/gsc-query\/2026-09\/[0-9a-f]+\.parquet, which is missing\. Nothing was read from it\.$/);
  await fs.writeFile(file, bytes);

  const other = { ...manifest, generation: 2, previous: 1, derivation: { ...manifest.derivation, id: 'another-rule' } };
  await fs.writeFile(path.join(ws.history, 'generations', '00000002.json'), `${JSON.stringify(other)}\n`);
  await assert.rejects(analyze(ws), /^Error: Generation 2 was written by other archive rules \(derivation another-rule; this checkout's is [0-9a-f]{16}\)\. Run pnpm signals:history/);
  await assert.rejects(analyze(ws, { generation: 3 }), /has no generation 3\.$/);
  await assert.rejects(analyze(ws, { asset: 'other.example' }), /holds meals\.example's history, not other\.example's\.$/);
  assert.deepEqual(await published(ws), before);
  // The generation the other rules did not write still reads.
  assert.equal((await analyze(ws, { generation: 1 })).report.generation, 1);
  assert.deepEqual((await published(ws)).files, before.files);
});

test('a generation the history no longer keeps is refused, naming it and the rule, whether asked for or removed while the job reads it', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const before = await published(ws);
  const rule = `the history keeps ${RETENTION}`;
  assert.equal(rule, 'the history keeps every generation published in the last 30 days, and the newest');
  // While the job reads generation 1, a run published 31 days on no longer keeps it.
  const later = new Date(Date.now() + 31 * 86_400_000).toISOString();
  const pruning = {
    onStage: async (stage) => {
      if (stage === 'reading') assert.deepEqual((await addQueryDay(ws, '2026-09-21', later)).removedGenerations, [1]);
    },
  };
  await assert.rejects(analyze(ws, { generation: 1 }, pruning), {
    message: `Generation 1 was removed while this report read it (${rule}). The oldest it keeps is generation 2.`,
  });
  assert.deepEqual(await published(ws), before);
  assert.deepEqual(await leftovers(ws), []);
  await assert.rejects(analyze(ws, { generation: 1 }), {
    message: `Generation 1 is no longer kept (${rule}). The oldest it keeps is generation 2.`,
  });
  // A generation not yet published is not one the history removed.
  await assert.rejects(analyze(ws, { generation: 3 }), /has no generation 3\.$/);
  assert.deepEqual(await published(ws), before);
  assert.equal((await analyze(ws)).report.generation, 2);
});

test('each limit stops the job with a plain message, publishes nothing, and the same history publishes within its limits', async (t) => {
  // 120,000 rows: the fixture's report fits a 64 MB heap; these do not.
  const ws = await workspace(t, { days: 40, rows: 3000 });
  await analyze(ws, { readValueEvents: fixtureValueEvents });
  const before = await published(ws);
  const stall = { onStage: (stage) => (stage === 'reading' ? new Promise((resolve) => setTimeout(resolve, 2500)) : undefined) };
  const cases = [
    [{ memoryMb: 64 }, {}, 'memory', 'The analysis needed more than its 64 MB memory limit (--memory-mb) and was stopped.'],
    [{ duckdbMemoryMb: 1 }, {}, 'duckdb-memory', 'DuckDB needed more than its 1 MB of memory (--duckdb-memory-mb).'],
    [{ tempDiskMb: 1 }, {}, 'temp-disk', 'The report needed more than its 1 MB of temporary disk (--temp-disk-mb).'],
    [{ timeLimitSeconds: 1 }, stall, 'time', 'The analysis took longer than its 1-second limit (--time-limit-seconds) and was stopped.'],
  ];
  for (const [limits, deps, kind, message] of cases) {
    await assert.rejects(analyze(ws, { limits }, deps), (error) => {
      assert.equal(error.kind, kind);
      assert.equal(error.message, `${message} Nothing was published; ${ws.output} is unchanged.`);
      return true;
    });
    assert.deepEqual(await published(ws), before, kind);
    assert.deepEqual(await leftovers(ws), [], kind);
  }
  // DuckDB streams each file: 2 MB of engine memory reads all 120,000 rows.
  const result = await analyze(ws, { limits: { duckdbMemoryMb: 2 } });
  assert.equal(result.report.rows, 120_000);
});

test('a job stopped at any stage leaves the previous report readable and complete, and the next run publishes', async (t) => {
  const ws = await workspace(t);
  await analyze(ws);
  const before = await published(ws);
  await addQueryDay(ws);
  for (const stage of ['reading', 'writing', 'publishing']) {
    await assert.rejects(
      analyze(ws, {}, { onStage: (reached) => (reached === stage ? 'kill' : undefined) }),
      { message: `The analysis was stopped while ${stage}. Nothing was published; ${ws.output} is unchanged.` },
    );
    assert.deepEqual(await published(ws), before, stage);
    assert.deepEqual(await leftovers(ws), [], stage);
  }
  assert.equal((await analyze(ws)).report.generation, 2);
  assert.notDeepEqual((await published(ws)).files, before.files);
});

test('it never replaces a folder it did not write, and one job at a time writes a report link', async (t) => {
  const ws = await workspace(t);
  const panel = path.join(ws.root, 'panel');
  await fs.mkdir(panel);
  await fs.writeFile(path.join(panel, 'gsc-query.csv'), 'written by someone else\n');
  await assert.rejects(analyze({ ...ws, output: panel }), {
    message: `${panel} is not a report link this command made. It never replaces a folder it did not write: give --out a new path.`,
  });
  assert.deepEqual(await fs.readdir(panel), ['gsc-query.csv']);
  await assert.rejects(fs.access(reportsFolder(panel)), /ENOENT/);
  await assert.rejects(analyze({ ...ws, output: path.join(ws.history, 'report') }), /must not contain each other/);

  // A live job's lock refuses a second job.
  const reports = reportsFolder(ws.output);
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, '.lock'), `${JSON.stringify({ pid: process.pid })}\n`);
  await assert.rejects(analyze(ws), { message: `Another analysis (process ${process.pid}) is writing ${reports}; nothing was changed.` });
  // A dead job's lock, staging and half-made link are cleared, and the run publishes.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await fs.writeFile(path.join(reports, '.lock'), `${JSON.stringify({ pid: dead })}\n`);
  await fs.mkdir(path.join(reports, `.staging-${dead}-0000`));
  await fs.writeFile(path.join(reports, `.staging-${dead}-0000`, 'gsc-query.csv'), 'half\n');
  await fs.symlink('nowhere', path.join(reports, `.link-${dead}-0000`));
  assert.equal((await analyze(ws)).report.generation, 1);
  assert.deepEqual(await leftovers(ws), []);
});

test('the command line answers help and each refusal before it reads anything', () => {
  const run = (...args) => spawnSync(process.execPath, [MODULE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
  });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pnpm signals:analyze-history -- --asset example\.com --history <history folder> --out <report link>/);
  const base = ['--asset', 'example.com', '--history', 'h', '--out', 'o'];
  for (const [args, message] of [
    [[], '--asset is required and must be a site id such as example.com.'],
    [['--asset', 'example.com', '--history', 'h'], '--history and --out are both required.'],
    [[...base, '--generation', '0'], '--generation must be a generation number: 1 or more.'],
    [[...base, '--memory-mb', '1.5'], '--memory-mb must be a whole number above zero.'],
    [[...base, '--time-limit-seconds'], '--time-limit-seconds needs a value.'],
    [['--asset', 'example.com', '--bogus', 'x'], 'Unknown option: --bogus'],
  ]) {
    const answer = run(...args);
    assert.equal(answer.status, 1, args.join(' '));
    assert.equal(answer.stderr, `${message}\n`, args.join(' '));
  }
  assert.deepEqual(parseArgs([...base, '--generation', '2', '--duckdb-memory-mb', '64', '--temp-disk-mb', '9']), {
    asset: 'example.com',
    history: path.join(REPO_ROOT, 'h'),
    output: path.join(REPO_ROOT, 'o'),
    generation: 2,
    reclamationTargets: null,
    limits: { duckdbMemoryMb: 64, tempDiskMb: 9 },
  });
});
