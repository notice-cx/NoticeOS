import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {
  INDEX_COVERAGE_FAMILY,
  INDEX_COVERAGE_SOURCES,
  PROVENANCE_COLUMNS,
  archiveFamily,
  archiveRows,
  compareReportDates,
  indexCoverageRows,
  manifestConfirmations,
  parseArchive,
  reportDayKey,
  resolveFamily,
  resolvesAcrossReportDays,
} from './signal-archive.mjs';
import { FIXTURE_ASSET, fixtureArchives, fixtureManifest } from './signal-archive-fixture.mjs';

// Bead ro-ujb9.67.1: the one reading of the provider archive, shared by the
// analyzer and the analytical-file writer. These pin the rules a second reader
// relies on — through the module's own functions, with no analyzer in the way.

const EXPECTED_ANALYSIS = new URL('./fixture-archive-analysis/', import.meta.url);
const NO_MANIFEST = new Map();

function envelope(integration, report, reportDate, pages, fields = {}) {
  return {
    schemaVersion: 1,
    asset: 'meals.example',
    integration,
    report,
    reportDate,
    collectedAt: `${reportDate}T23:00:00.000Z`,
    dataState: 'provider-snapshot',
    providerTruncated: false,
    pages,
    ...fields,
  };
}

function read(archive, confirmations = NO_MANIFEST) {
  const checked = parseArchive(JSON.stringify(archive), { asset: 'meals.example', source: 'test' });
  return archiveRows(checked, confirmations);
}

/** Archives read in the order given, then resolved as one family. */
function readFamily(archives, confirmations = NO_MANIFEST) {
  const rows = archives.flatMap((archive) => read(archive, confirmations));
  return resolveFamily(archiveFamily(archives[0]), rows);
}

function gscQuery(reportDate, rows, fields) {
  return envelope('gsc', 'query', reportDate, [
    { request: { dimensions: ['query'] }, response: { rows } },
  ], fields);
}

function posthogDaily(reportDate, rows, body = {}) {
  return envelope('posthog', 'web-daily', reportDate, [{
    response: {
      projectTimeZone: 'America/Los_Angeles',
      window: { start: '2026-08-25', end: reportDate },
      rowLimit: 100,
      truncated: false,
      rows,
      ...body,
    },
  }]);
}

function bingAiOverview(exportDate, rows) {
  return envelope('bing-webmaster', 'ai-overview', exportDate, [{ response: { rows } }]);
}

function bingCrawlStats(reportDate, rows) {
  return envelope('bing-webmaster', 'crawl-stats', reportDate, [{ response: { d: rows } }]);
}

function ga4Channels(reportDate, collectedAt) {
  return envelope('ga4', 'traffic-acquisition', reportDate, [{
    request: {},
    response: {
      dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
      metricHeaders: [{ name: 'sessions' }],
      rows: [{ dimensionValues: [{ value: 'Direct' }], metricValues: [{ value: '10' }] }],
    },
  }], { collectedAt });
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

test('a second reader using only these rules reads every row the analyzer wrote', async () => {
  // Path order, as the analyzer discovers files; rows in archive order.
  const archives = fixtureArchives().sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const confirmations = manifestConfirmations(fixtureManifest());
  const families = new Map();
  for (const [source, value] of archives) {
    const archive = parseArchive(JSON.stringify(value), { asset: FIXTURE_ASSET, source });
    const family = archiveFamily(archive);
    families.set(family, [...(families.get(family) ?? []), ...archiveRows(archive, confirmations)]);
  }
  for (const [family, rows] of families) families.set(family, resolveFamily(family, rows));
  families.set(INDEX_COVERAGE_FAMILY, indexCoverageRows(families));

  const written = (await fs.readdir(EXPECTED_ANALYSIS)).filter((name) => name.endsWith('.csv'));
  assert.deepEqual([...families.keys()].map((family) => `${family}.csv`).sort(), written.sort());
  for (const [family, rows] of families) {
    const [header = [], ...lines] = parseCsv(await fs.readFile(new URL(`${family}.csv`, EXPECTED_ANALYSIS), 'utf8'));
    assert.equal(lines.length, rows.length, family);
    rows.forEach((row, index) => {
      assert.deepEqual(
        Object.fromEntries(header.map((column) => [column, String(row[column] ?? '')])),
        Object.fromEntries(header.map((column, cell) => [column, lines[index][cell]])),
        `${family} row ${index}`,
      );
      // Every row starts with its provenance, in one order.
      assert.deepEqual(Object.keys(row).slice(0, PROVENANCE_COLUMNS.length), PROVENANCE_COLUMNS, family);
    });
  }
});

test('the rules keep what they are given: a report day delivered twice is the reader’s to drop', () => {
  // The downloads layout holds one file per report day, so a re-delivery
  // replaces the file. A reader that can see both copies must keep one itself:
  // where rows add, the rules would count the day twice.
  const day = gscQuery('2026-09-20', [{ keys: ['meal plan'], clicks: 4, impressions: 90 }]);
  assert.equal(readFamily([day, day]).length, 2);
  // Where a family resolves days, the copy read last is the one kept.
  const first = posthogDaily('2026-09-21', [{ date: '2026-09-21', pageviews: 900, people: 300, sessions: 400 }]);
  const corrected = posthogDaily('2026-09-21', [{ date: '2026-09-21', pageviews: 950, people: 300, sessions: 400 }]);
  assert.deepEqual(readFamily([first, corrected]).map((row) => row.pageviews), [950]);
  assert.deepEqual(readFamily([corrected, first]).map((row) => row.pageviews), [900]);
});

test('a revision of a day is resolved to the newest report, and history it does not reach survives', () => {
  const july = bingAiOverview('2026-07-12', [
    { date: '2026-07-10', citations: 9000, citedPages: 40 },
    { date: '2026-07-11', citations: 9100, citedPages: 41 },
  ]);
  const august = bingAiOverview('2026-08-04', [
    { date: '2026-07-11', citations: 9250, citedPages: 43 },
    // One day twice in one export: the later row is kept.
    { date: '2026-08-03', citations: 1, citedPages: 1 },
    { date: '2026-08-03', citations: 11000, citedPages: 52 },
  ]);
  // Read out of order on purpose: the report date decides, not the reading order.
  const days = readFamily([august, july]);
  assert.deepEqual(days.map((row) => [row.provider_date, row.citations, row.report_date]), [
    ['2026-07-10', 9000, '2026-07-12'],
    ['2026-07-11', 9250, '2026-08-04'],
    ['2026-08-03', 11000, '2026-08-04'],
  ]);

  // PostHog re-sends its trailing window: the newest archive's day wins, and a
  // row it dated nothing is placed on no day.
  const earlier = posthogDaily('2026-09-20', [{ date: '2026-09-19', pageviews: 900, people: 1, sessions: 1 }]);
  const later = posthogDaily('2026-09-21', [
    { date: '2026-09-19', pageviews: 905, people: 1, sessions: 1 },
    { date: '', pageviews: 7, people: 1, sessions: 1 },
  ]);
  assert.deepEqual(readFamily([earlier, later]).map((row) => [row.date, row.pageviews]), [['2026-09-19', 905]]);

  // Bing's crawl series: every collection kept in its own family, one row per
  // measured day in the derived index coverage.
  const legacy = (day) => `/Date(${Date.parse(`${day}T00:00:00.000Z`)})/`;
  const stats = readFamily([
    bingCrawlStats('2026-09-20', [{ Date: legacy('2026-09-18'), InIndex: 2600 }, { Date: null, InIndex: 1 }]),
    bingCrawlStats('2026-09-21', [{ Date: legacy('2026-09-18'), InIndex: 2622 }, { Date: legacy('2026-09-19'), InIndex: 2641 }]),
  ]);
  assert.equal(stats.length, 4);
  const coverage = indexCoverageRows(new Map([['bing-webmaster-crawl-stats', stats]]));
  assert.deepEqual(coverage.map((row) => [row.provider_date, row.pages_in_index]), [['2026-09-18', 2622], ['2026-09-19', 2641]]);
});

test('a GA4 attribution day stays provisional until a collection two days after it confirmed it', () => {
  const day = ga4Channels('2026-09-19', '2026-09-20T12:15:00.000Z');
  assert.equal(read(day)[0].provisional, 1);
  // The manifest's unchanged re-collection at D+2 settles it.
  const confirmations = manifestConfirmations({
    objects: [{ integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-19', finishedAt: '2026-09-21T12:16:02.000Z' }],
  });
  assert.equal(read(day, confirmations)[0].provisional, 0);
  // Neither date readable: unknown, never a guess. No manifest is not an error.
  assert.equal(read(ga4Channels('latest', 'not recorded'))[0].provisional, '');
  assert.deepEqual(manifestConfirmations(null), new Map());
  // Other GA4 families carry no such column.
  assert.equal('provisional' in read({ ...day, report: 'pages-screens' })[0], false);
});

test('missing and truncated reads stay unknown rather than becoming zero', () => {
  // No pages, or a page with no answer: no rows, not a row of zeros.
  assert.deepEqual(read(envelope('gsc', 'country', '2026-09-20', undefined)), []);
  assert.deepEqual(read(envelope('gsc', 'country', '2026-09-20', [{ request: { dimensions: ['country'] }, response: {} }])), []);
  // A billed SERP call the provider could not answer is still one row, all unknown.
  const [unanswered] = read(envelope('dataforseo', 'serp-panel', '2026-09-14', [{
    request: { attempts: 3, body: { keyword: 'meal plan', depth: 20 } },
    response: { cost: 0.004, tasks: [{ status_message: 'Invalid Field: keyword.', result: null }] },
  }], { propertyRef: 'meals.example' }));
  assert.deepEqual(
    [unanswered.best_rank, unanswered.aio_present, unanswered.aio_cites_us, unanswered.provider_status],
    ['', '', '', 'Invalid Field: keyword.'],
  );
  // A read cut at the provider's limit says so on every row, whichever place said it.
  assert.equal(read(gscQuery('2026-09-20', [{ keys: ['a'] }, { keys: ['b'] }], { providerTruncated: true }))
    .every((row) => row.provider_truncated === true), true);
  assert.equal(read(posthogDaily('2026-09-21', [{ date: '2026-09-21' }], { truncated: true }))[0].provider_truncated, true);
  // A value the provider did not send is empty.
  const [row] = read(posthogDaily('2026-09-21', [{ date: '2026-09-21', pageviews: null }]));
  assert.deepEqual([row.pageviews, row.people], ['', '']);
});

test('time zones: a Bing date is read as its UTC day, a collection time as the date it was written with', () => {
  const [crossing, legacy] = read(bingCrawlStats('2026-09-19', [
    { Date: '2026-09-17T20:00:00-07:00', InIndex: 1 },
    { Date: `/Date(${Date.parse('2026-09-17T00:00:00.000Z')}-0700)/`, InIndex: 1 },
  ]));
  assert.equal(crossing.provider_date, '2026-09-18');
  assert.equal(legacy.provider_date, '2026-09-17');
  // 2026-09-21T01:30+09:00 is 09-20 in UTC, but the settle check counts the
  // date the timestamp was written with: two days after 09-19, so settled.
  assert.equal(read(ga4Channels('2026-09-19', '2026-09-21T01:30:00+09:00'))[0].provisional, 0);
  // PostHog's window is in its project's own zone, carried as it came.
  const [daily] = read(posthogDaily('2026-09-21', [{ date: '2026-09-21' }]));
  assert.deepEqual([daily.project_time_zone, daily.window_end], ['America/Los_Angeles', '2026-09-21']);
});

test('ordering is deterministic: report date first, then the order the rows were read', () => {
  const rows = [
    { report_date: '2026-09-21', order: 1 },
    { report_date: '2026-09-20', order: 2 },
    { report_date: '2026-09-21', order: 3 },
    { report_date: '2026-09-20', order: 4 },
  ];
  assert.deepEqual(resolveFamily('gsc-query', rows.map((row) => ({ ...row }))).map((row) => row.order), [2, 4, 1, 3]);
  // The same archives read twice read the same.
  const archives = fixtureArchives().map(([, archive]) => archive).filter((archive) => archive.asset === FIXTURE_ASSET);
  const once = archives.map((archive) => read(archive));
  assert.deepEqual(archives.map((archive) => read(archive)), once);
});

/** The fixture's archives in reading order, each checked and keyed. */
function fixtureReadings() {
  const confirmations = manifestConfirmations(fixtureManifest());
  return fixtureArchives()
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([source, value]) => {
      const archive = parseArchive(JSON.stringify(value), { asset: FIXTURE_ASSET, source });
      return { family: archiveFamily(archive), archive, rows: archiveRows(archive, confirmations) };
    });
}

test('a family that does not resolve across report days reads the same one report day at a time', () => {
  // What lets a writer rewrite one period of a family without the rest: each
  // report day resolved alone, report days in compareReportDates order, is the
  // whole family resolved. A family whose revisions reach across report days
  // must be resolved whole, and says so.
  const byFamily = new Map();
  for (const reading of fixtureReadings()) {
    byFamily.set(reading.family, [...(byFamily.get(reading.family) ?? []), reading]);
  }
  const acrossDays = [];
  for (const [family, readings] of byFamily) {
    const whole = resolveFamily(family, readings.flatMap((reading) => reading.rows.map((row) => ({ ...row }))));
    const days = new Map();
    for (const reading of readings) {
      const day = reading.archive.reportDate;
      days.set(day, [...(days.get(day) ?? []), ...reading.rows.map((row) => ({ ...row }))]);
    }
    const dayByDay = [...days.keys()]
      .sort(compareReportDates)
      .flatMap((day) => resolveFamily(family, days.get(day)));
    // Every row of an archive carries its report date.
    for (const reading of readings) {
      assert.equal(reading.rows.every((row) => row.report_date === reading.archive.reportDate), true, family);
    }
    if (resolvesAcrossReportDays(family)) {
      acrossDays.push(family);
      assert.notDeepEqual(dayByDay, whole, `${family} resolves across report days, so one day at a time differs`);
    } else {
      assert.deepEqual(dayByDay, whole, family);
    }
  }
  assert.deepEqual(acrossDays.sort(), ['bing-webmaster-ai-overview', 'posthog-web-daily']);
});

test('index coverage reads only its sources, each row from exactly one of them', () => {
  const families = new Map();
  for (const reading of fixtureReadings()) {
    families.set(reading.family, [...(families.get(reading.family) ?? []), ...reading.rows]);
  }
  for (const [family, rows] of families) families.set(family, resolveFamily(family, rows));
  const all = indexCoverageRows(families);
  assert.ok(all.length > 0);
  // Only the named sources are read…
  assert.deepEqual(indexCoverageRows(new Map(INDEX_COVERAGE_SOURCES.map((family) => [family, families.get(family)]))), all);
  // …and the rows are each source's own, in the order the sources are named.
  assert.deepEqual(
    INDEX_COVERAGE_SOURCES.flatMap((family) => indexCoverageRows(new Map([[family, families.get(family)]]))),
    all,
  );
});

test('a report day is one (integration, report, report date), for an archive and a manifest row alike', () => {
  const archive = { integration: 'gsc', report: 'query', reportDate: '2026-09-20', pages: [] };
  const row = { integration: 'gsc', report: 'query', reportDate: '2026-09-20', finishedAt: '2026-09-21T00:00:00.000Z' };
  assert.equal(reportDayKey(archive), reportDayKey(row));
  assert.notEqual(reportDayKey(archive), reportDayKey({ ...row, report: 'page' }));
  assert.equal(manifestConfirmations({ objects: [row] }).get(reportDayKey(archive)), row.finishedAt);
});

test('an archive the rules cannot read is refused by name', () => {
  const good = gscQuery('2026-09-20', []);
  const refusal = (value, source = 'raw/gsc/query/2026-09-20.json') => () =>
    parseArchive(typeof value === 'string' ? value : JSON.stringify(value), { asset: 'meals.example', source });
  assert.throws(refusal({ ...good, asset: 'nosh.example' }), { message: 'Unsupported or wrong-property signal archive: raw/gsc/query/2026-09-20.json' });
  assert.throws(refusal({ ...good, schemaVersion: 2 }), /Unsupported or wrong-property/);
  assert.throws(refusal([good]), /Unsupported or wrong-property/);
  assert.throws(refusal({ ...good, integration: 'matomo' }), { message: 'Malformed signal archive: raw/gsc/query/2026-09-20.json' });
  assert.throws(refusal({ ...good, report: 7 }), /Malformed signal archive/);
  assert.throws(refusal(JSON.stringify(good).slice(0, 40)), SyntaxError);
  // The GA4 settle rule cannot be skipped by forgetting the manifest.
  assert.throws(() => archiveRows(good, undefined), TypeError);
});
