import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeArchiveFixture } from './test-fixtures/signal-report.mjs';
import { POSTHOG_FAMILIES as FLATTENER_FAMILIES } from './signal-archive.mjs';
import { freshnessReport } from './signal-panels-refresh.mjs';
import { parseArgs as parseDownloadArgs } from './signal-dumps-download.mjs';
import { POSTHOG_FAMILIES, POSTHOG_FAMILY_ROWS } from '../packages/contract/src/posthog-families.mjs';

// PostHog in the panel dir, end to end: archives in the shared contract's
// shape → posthog-<family>.csv → executive.json.
//
// The fixture is the contract's acceptance set: a site's first manual PostHog
// read, a fifteen-day window. Every archive is the standard envelope the
// collector writes (integration `posthog`, report = family, reportDate =
// window end) with the contract body as `pages[0].response`.

// The frozen copy, never the checkout's own config/.
const fixtureValueEvents = async () => ({
  body: JSON.parse(await fs.readFile(new URL('./fixture-config/value-events.json', import.meta.url), 'utf8')),
  version: 1,
});

const COLLECTED_AT = '2026-09-23T12:30:04.120Z';

function posthogArchive(family, { reportDate = '2026-09-22', window, rows, truncated = false, rowLimit = 100 }) {
  return {
    schemaVersion: 1,
    provider: 'posthog',
    integration: 'posthog',
    report: family,
    asset: 'meals.example',
    credentialRef: 'posthog-meals.example',
    propertyRef: '596607',
    reportDate,
    collectedAt: COLLECTED_AT,
    dataState: 'provider-snapshot',
    providerRows: rows.length,
    providerTruncated: truncated,
    pages: [
      {
        request: { host: 'us', projectId: '596607', family, window, rowLimit, query: 'SELECT …' },
        response: {
          provider: 'posthog',
          family,
          asset: 'meals.example',
          host: 'us',
          projectId: '596607',
          projectTimeZone: 'America/New_York',
          window,
          collectedAt: COLLECTED_AT,
          rowLimit,
          truncated,
          rows,
        },
      },
    ],
  };
}

function calendarDays(start, count) {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(first + index * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A manual fifteen-day read: the window is the BODY's, never assumed from the
 * report date. */
const FORTNIGHT = { start: '2026-09-08', end: '2026-09-22' };

function acceptanceArchives() {
  const rage = (attr, text, tag, people, clicks) => ({
    path: '/calculator',
    tag,
    text,
    attr,
    clicks,
    people,
    desktopClicks: Math.round(clicks * 0.996),
    mobileClicks: clicks - Math.round(clicks * 0.996),
    tabletClicks: 0,
    pagePeople: 18_826,
  });
  const vitals = (path, device, os, measurements, lcpP75, inpP75) => ({
    path,
    device,
    os,
    lcpP75,
    inpP75,
    clsP75: 0.02,
    fcpP75: 1_200,
    measurements,
  });
  const funnel = (people) =>
    [
      { event: '$pageview', path: '/calculator' },
      { event: 'calculator_started', path: null },
      { event: 'calculator_completed', path: null },
      { event: 'plan_saved', path: null },
    ].map((step, index) => ({
      funnelId: 'calculator',
      name: 'Calculator',
      step: index + 1,
      event: step.event,
      path: step.path,
      people: people[index],
    }));
  return {
    'web-daily.json': posthogArchive('web-daily', {
      window: { start: '2026-08-26', end: '2026-09-22' },
      rowLimit: 28,
      // A weekday/weekend rhythm with a slow climb, the shape a real site has.
      rows: calendarDays('2026-08-26', 28).map((date, index) => {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        const people = (weekday === 0 || weekday === 6 ? 4_600 : 6_200) + index * 25;
        return { date, pageviews: people * 5, people, sessions: Math.round(people * 1.5) };
      }),
    }),
    'events.json': posthogArchive('events', {
      window: FORTNIGHT,
      rowLimit: 500,
      rows: [
        { event: '$pageview', count: 420_000, people: 81_000, firstSeen: '2026-09-08', lastSeen: '2026-09-22' },
        { event: 'first_meal_logged', count: 1_597, people: 527, firstSeen: '2026-09-08', lastSeen: '2026-09-22' },
        { event: 'account_created', count: 301, people: 298, firstSeen: '2026-09-08', lastSeen: '2026-09-22' },
      ],
    }),
    'exceptions.json': posthogArchive('exceptions', {
      window: FORTNIGHT,
      rows: [
        { type: 'TypeError', message: 'Load failed', count: 40_975, people: 1_314, sessions: 2_900, maxPerSession: 402, hasSourceFile: false, topPath: '/calculator', topBrowser: 'Safari' },
        { type: 'Error', message: 'Script error.', count: 5_000, people: 1_438, sessions: 1_700, maxPerSession: 12, hasSourceFile: false, topPath: '/', topBrowser: 'Chrome' },
        { type: 'TypeError', message: "Cannot read properties of undefined (reading 'default')", count: 1_900, people: 264, sessions: 300, maxPerSession: 30, hasSourceFile: true, topPath: '/calculator', topBrowser: 'Chrome' },
        { type: 'TypeError', message: 'm._result.default', count: 765, people: 117, sessions: 130, maxPerSession: 9, hasSourceFile: true, topPath: '/my', topBrowser: 'Firefox' },
      ],
    }),
    'rageclicks.json': posthogArchive('rageclicks', {
      window: FORTNIGHT,
      rows: [
        rage('heightFeet', null, 'input', 1_493, 2_400),
        rage('heightInches', null, 'input', 1_041, 1_500),
        rage('age', null, 'input', 987, 1_200),
        rage('weight', null, 'input', 757, 900),
        rage(null, 'Next', 'button', 215, 250),
        rage(null, 'Female', 'label', 185, 110),
        rage(null, 'Male', 'label', 134, 95),
        rage(null, 'Calculate My Plan', 'button', 120, 80),
        // A small page: a high share of a few people is not a pattern.
        { path: '/about', tag: 'a', text: 'Contact', attr: null, clicks: 60, people: 30, desktopClicks: 60, mobileClicks: 0, tabletClicks: 0, pagePeople: 150 },
      ],
    }),
    'web-vitals.json': posthogArchive('web-vitals', {
      window: FORTNIGHT,
      rowLimit: 300,
      rows: [
        vitals('/calculator', 'Desktop', 'Chrome OS', 22_298, 3_844, 744),
        vitals('/calculator', 'Desktop', 'Windows', 12_500, 2_146, 224),
        vitals('/calculator', 'Desktop', 'Mac OS X', 11_139, 1_655, 136),
        vitals('/calculator', 'Mobile', 'iOS', 30_000, 1_709, 144),
        vitals('/', 'Desktop', 'Windows', 9_000, 3_256, 150),
        vitals('/', 'Mobile', 'iOS', 14_000, 1_645, 120),
        // Under the measurement floor: never judged.
        vitals('/about', 'Desktop', 'Linux', 120, 5_000, 900),
        // No INP measurements at all: the percentile is null, never 0.
        { ...vitals('/', 'Tablet', 'Android', 600, 2_000, null), clsP75: null },
      ],
    }),
    'funnels.json': posthogArchive('funnels', {
      window: { start: '2026-09-16', end: '2026-09-22' },
      rows: funnel([18_826, 15_864, 15_394, 1_232]),
    }),
    'funnels-prior.json': posthogArchive('funnels', {
      reportDate: '2026-09-15',
      window: { start: '2026-09-09', end: '2026-09-15' },
      rows: funnel([18_000, 15_100, 14_700, 1_470]),
    }),
  };
}

async function withPanel(archives, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-posthog-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  try {
    await fs.mkdir(input, { recursive: true });
    for (const [name, archive] of Object.entries(archives)) {
      await fs.writeFile(path.join(input, name), JSON.stringify(archive));
    }
    const summary = await analyzeArchiveFixture({
      readValueEvents: fixtureValueEvents,
      asset: 'meals.example',
      input,
      output,
    });
    const read = async (name) => fs.readFile(path.join(output, name), 'utf8');
    const executive = JSON.parse(await read('executive.json'));
    await run({ summary, executive, read, output });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** RFC 4180 enough for the fixture: quoted cells, doubled quotes. */
function csvRows(csv) {
  const [header, ...lines] = csv.trim().split('\n');
  const headers = header.split(',');
  return lines.map((line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          cell += '"';
          index++;
        } else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') {
        cells.push(cell);
        cell = '';
      } else cell += char;
    }
    cells.push(cell);
    return Object.fromEntries(headers.map((name, index) => [name, cells[index]]));
  });
}

test('the download tool can be narrowed to PostHog archives', () => {
  const options = parseDownloadArgs(['--asset', 'meals.example', '--integration', 'posthog', '--report', 'web-vitals']);
  assert.equal(options.integration, 'posthog');
  assert.equal(options.report, 'web-vitals');
  assert.throws(() => parseDownloadArgs(['--asset', 'meals.example', '--integration', 'hotjar']), /posthog/);
});

test('flattens all six PostHog families to posthog-<family>.csv, one row per contract row', async () => {
  await withPanel(acceptanceArchives(), async ({ summary, read }) => {
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [
        { name: 'posthog-events', rows: 3 },
        { name: 'posthog-exceptions', rows: 4 },
        // Two archives, one row per configured step each: the week before is
        // kept beside this one, never merged into it.
        { name: 'posthog-funnels', rows: 8 },
        { name: 'posthog-rageclicks', rows: 9 },
        { name: 'posthog-web-daily', rows: 28 },
        { name: 'posthog-web-vitals', rows: 8 },
      ],
    );

    const vitals = csvRows(await read('posthog-web-vitals.csv'));
    const chromeOs = vitals.find((row) => row.os === 'Chrome OS');
    assert.equal(chromeOs.path, '/calculator');
    assert.equal(chromeOs.lcp_p75, '3844');
    assert.equal(chromeOs.inp_p75, '744');
    assert.equal(chromeOs.measurements, '22298');
    // The window comes from the BODY: this read is fifteen days, not fourteen.
    assert.equal(chromeOs.window_start, '2026-09-08');
    assert.equal(chromeOs.window_end, '2026-09-22');
    assert.equal(chromeOs.report_date, '2026-09-22');
    assert.equal(chromeOs.collected_at, COLLECTED_AT);
    assert.equal(chromeOs.project_time_zone, 'America/New_York');
    assert.equal(chromeOs.row_grain, 'page-device-os');
    assert.equal(chromeOs.provider_truncated, 'false');
    // An unmeasured percentile is EMPTY — unknown, never a zero.
    const tablet = vitals.find((row) => row.device === 'Tablet');
    assert.equal(tablet.inp_p75, '');
    assert.equal(tablet.cls_p75, '');

    const exceptions = csvRows(await read('posthog-exceptions.csv'));
    const loadFailed = exceptions.find((row) => row.message === 'Load failed');
    assert.equal(loadFailed.count, '40975');
    assert.equal(loadFailed.max_per_session, '402');
    assert.equal(loadFailed.has_source_file, 'false');
    assert.ok(exceptions.some((row) => row.message === "Cannot read properties of undefined (reading 'default')"));

    const rage = csvRows(await read('posthog-rageclicks.csv'));
    const heightFeet = rage.find((row) => row.attr === 'heightFeet');
    assert.equal(heightFeet.people, '1493');
    assert.equal(heightFeet.page_people, '18826');
    assert.equal(heightFeet.row_grain, 'page-element');
    assert.equal(rage.find((row) => row.text === 'Next').attr, '', 'a null attribute stays empty');

    const events = csvRows(await read('posthog-events.csv'));
    const firstMeal = events.find((row) => row.event === 'first_meal_logged');
    assert.equal(firstMeal.count, '1597');
    assert.equal(firstMeal.people, '527');
    assert.equal(firstMeal.first_seen, '2026-09-08');
    assert.equal(firstMeal.last_seen, '2026-09-22');

    const funnels = csvRows(await read('posthog-funnels.csv'));
    assert.deepEqual(
      funnels
        .filter((row) => row.report_date === '2026-09-22')
        .map((row) => [row.funnel_id, row.name, row.step, row.event, row.path, row.people]),
      [
        ['calculator', 'Calculator', '1', '$pageview', '/calculator', '18826'],
        ['calculator', 'Calculator', '2', 'calculator_started', '', '15864'],
        ['calculator', 'Calculator', '3', 'calculator_completed', '', '15394'],
        ['calculator', 'Calculator', '4', 'plan_saved', '', '1232'],
      ],
    );

    const daily = csvRows(await read('posthog-web-daily.csv'));
    assert.equal(daily[0].date, '2026-08-26');
    assert.equal(daily.at(-1).date, '2026-09-22');
    assert.equal(daily[0].row_grain, 'day');
    assert.equal(daily[0].row_limit, '28');

    assert.ok(summary.caveats.some((line) => line.startsWith('PostHog families')));
    assert.ok(summary.caveats.some((line) => /block it/.test(line) && /bots/.test(line) && /consent/.test(line)));
  });
});

test('the PostHog acceptance archives produce the five product cards', async () => {
  await withPanel(acceptanceArchives(), async ({ executive }) => {
    const byKey = new Map([
      ...executive.items.map((item) => [item.key, item]),
    ]);
    const named = new Set([...byKey.keys(), ...executive.suppressedItems.map((item) => item.key)]);
    for (const key of [
      'posthog-rage-click-cluster',
      'posthog-error-concentration',
      'posthog-once-event-repeats',
      'posthog-slow-segment',
      'posthog-funnel-drop-calculator',
    ]) {
      assert.ok(named.has(key), `${key} fires on the acceptance set`);
    }

    const rage = byKey.get('posthog-rage-click-cluster');
    assert.equal(rage.kind, 'warning');
    assert.match(rage.title, /^Rage clicks cluster on \/calculator: 3 elements/);
    assert.equal(rage.primary.value, '7.9%');
    assert.deepEqual(rage.sources, ['posthog/rageclicks']);
    assert.equal(rage.windowStart, '2026-09-08');
    assert.equal(rage.windowEnd, '2026-09-22');
    assert.ok(rage.evidence.some((row) => row.label === '/calculator · heightFeet input'));
    // weight (757 of 18,826 = 4.0%) is under the line and is not named.
    assert.ok(!rage.evidence.some((row) => row.label.includes('weight')));
    // /about is over the share but under the 200-visitor floor.
    assert.ok(!rage.evidence.some((row) => row.label.includes('/about')));

    const noise = byKey.get('posthog-error-concentration');
    assert.equal(noise.title, '84% of 48,640 errors are one message with no source file — probably third-party noise');
    assert.equal(noise.kind, 'warning');
    assert.equal(noise.confidence, 'medium');
    assert.match(noise.summary, /from 1,314 people and up to 402 in one session/);
    assert.match(noise.summary, /“Error: Script error\.” \(1,438 people\)/);
    assert.deepEqual(
      noise.evidence.filter((row) => row.label.endsWith('by people')).map((row) => row.value),
      [
        'Error: Script error.',
        "TypeError: Cannot read properties of undefined (reading 'default')",
        'TypeError: m._result.default',
      ],
    );

    const once = byKey.get('posthog-once-event-repeats');
    assert.equal(once.title, 'first_meal_logged fires 3.0 times per person — its name promises once');
    assert.deepEqual(once.primary, { value: '3.0×', label: 'Events per person' });
    // account_created at 301 for 298 people is inside the 10% line.
    assert.ok(!once.evidence.some((row) => row.label === 'account_created'));

    const speed = byKey.get('posthog-slow-segment');
    assert.equal(speed.title, 'Chrome OS Desktop visitors to /calculator wait past Google’s lines');
    assert.deepEqual(speed.primary, { value: '744 ms', label: 'INP at p75' });
    assert.equal(speed.confidence, 'high');
    assert.match(speed.summary, /LCP 3,844 ms \(needs improvement\) · INP 744 ms \(poor\)/);
    assert.match(speed.summary, /Mac OS X Desktop visitors on the same page are inside both/);
    // The /about segment is past both lines but under 500 measurements.
    assert.ok(!speed.evidence.some((row) => row.label.startsWith('/about')));
    assert.ok(speed.evidence.some((row) => row.label === '/calculator · Windows Desktop'));

    const funnel = [...byKey.values(), ...executive.suppressedItems].find(
      (item) => item.key === 'posthog-funnel-drop-calculator',
    );
    assert.match(funnel.title, /calculator_completed → plan_saved, where 8% continue/);
    const shown = byKey.get('posthog-funnel-drop-calculator');
    if (shown) {
      // The read ending 2026-09-15 exists, so the week before is stated.
      assert.match(shown.summary, /2026-09-09–2026-09-15 the same step kept 10\.0%/);
      assert.equal(shown.kind, 'insight', 'two points worse is under the five-point line');
    }
  });
});

test('the executive product block carries the Tower section, bounded', async () => {
  await withPanel(acceptanceArchives(), async ({ executive }) => {
    const { product } = executive;
    assert.equal(product.source, 'posthog');
    assert.equal(product.observedAt, '2026-09-22');
    assert.equal(product.collectedAt, COLLECTED_AT);
    assert.deepEqual(
      product.checks.map((entry) => [entry.key, entry.state]),
      [
        ['posthog-slow-segment', 'fired'],
        ['posthog-rage-click-cluster', 'fired'],
        ['posthog-error-concentration', 'fired'],
        ['posthog-funnel-drop', 'fired'],
        ['posthog-once-event-repeats', 'fired'],
      ],
    );
    assert.deepEqual(
      product.families.map((reading) => [reading.family, reading.windowStart, reading.windowEnd]),
      [
        ['web-daily', '2026-08-26', '2026-09-22'],
        ['events', '2026-09-08', '2026-09-22'],
        ['exceptions', '2026-09-08', '2026-09-22'],
        ['rageclicks', '2026-09-08', '2026-09-22'],
        ['web-vitals', '2026-09-08', '2026-09-22'],
        ['funnels', '2026-09-16', '2026-09-22'],
      ],
    );
    assert.equal(product.webDaily.days.length, 28);
    // 2026-08-26 is a Wednesday.
    assert.deepEqual(product.webDaily.days[0], { date: '2026-08-26', people: 6_200, pageviews: 31_000, sessions: 9_300 });

    const [calculator] = product.funnels;
    assert.deepEqual(calculator.steps.map((step) => step.people), [18_826, 15_864, 15_394, 1_232]);
    assert.equal(calculator.conversion, 1_232 / 18_826);
    assert.deepEqual(calculator.largestDrop, { fromStep: 3, toStep: 4, lostPeople: 14_162, stepConversion: 1_232 / 15_394 });
    assert.equal(calculator.prior.conversion, 1_470 / 18_000);
    assert.equal(calculator.prior.stepConversion, 1_470 / 14_700);

    const [worst] = product.vitals.segments;
    assert.equal(worst.os, 'Chrome OS');
    assert.equal(worst.inpRating, 'poor');
    assert.equal(worst.lcpRating, 'needs-improvement');
    assert.equal(worst.clsRating, 'good');
    assert.equal(product.vitals.minMeasurements, 500);
    assert.deepEqual(product.vitals.lines.lcp, { good: 2500, poor: 4000 });
    assert.equal(product.vitals.unmeasuredSegments, 1);
    const tablet = product.vitals.segments.find((row) => row.device === 'Tablet');
    assert.equal(tablet.inpP75, null);
    assert.equal(tablet.inpRating, null);

    assert.equal(product.exceptions.total, 48_640);
    assert.equal(product.exceptions.noise.message, 'Load failed');
    assert.equal(product.exceptions.noise.share, 40_975 / 48_640);
    assert.deepEqual(product.exceptions.top.map((row) => row.people), [1_438, 264, 117]);

    assert.deepEqual(
      product.rageClicks.clusters.map((row) => row.element),
      ['heightFeet input', 'heightInches input', 'age input'],
    );
    assert.equal(product.onceEvents[0].event, 'first_meal_logged');
    assert.match(product.caveat, /consent/);

    // The snapshot is pushed to a store capped at 1 MB per row
    // (INSIGHT_PAYLOAD_MAX_BYTES); the product block is a few kilobytes of it.
    assert.ok(Buffer.byteLength(JSON.stringify(executive)) < 1_000_000);
    assert.ok(Buffer.byteLength(JSON.stringify(product)) < 20_000);
  });
});

/**
 * The Tower's tests and gallery render the product block this producer really
 * emits for the acceptance set, not a hand-typed lookalike — so a field renamed
 * here fails the Tower's parser test the same day. Regenerate after an
 * intentional change with `WRITE_POSTHOG_FIXTURE=1 node --test
 * scripts/posthog-panel.test.mjs`.
 */
const TOWER_FIXTURE = new URL('../apps/tower/src/routes/kitchen-sink/posthog-product.json', import.meta.url);

test('the Tower fixture is the product block this producer emits', async () => {
  await withPanel(acceptanceArchives(), async ({ executive }) => {
    const emitted = `${JSON.stringify(executive.product, null, 2)}\n`;
    if (process.env.WRITE_POSTHOG_FIXTURE === '1') {
      await fs.mkdir(new URL('.', TOWER_FIXTURE), { recursive: true });
      await fs.writeFile(TOWER_FIXTURE, emitted);
    }
    assert.equal(await fs.readFile(TOWER_FIXTURE, 'utf8'), emitted);
  });
});

test('an empty PostHog family writes its header and reads as collected-with-nothing', async () => {
  await withPanel(
    { 'rageclicks.json': posthogArchive('rageclicks', { window: FORTNIGHT, rows: [] }) },
    async ({ summary, executive, read }) => {
      assert.deepEqual(summary.datasets.map(({ name, rows }) => ({ name, rows })), [
        { name: 'posthog-rageclicks', rows: 0 },
      ]);
      const csv = await read('posthog-rageclicks.csv');
      // Header only — PostHog answered with no rows, which is a different file
      // from a family nobody collected (no file at all).
      assert.equal(csv.trim().split('\n').length, 1);
      assert.ok(csv.startsWith('asset,report_date,collected_at,data_state,provider_truncated,'));
      for (const column of ['page_people', 'desktop_clicks', 'window_start', 'row_grain']) {
        assert.ok(csv.includes(column), `header carries ${column}`);
      }
      await assert.rejects(read('posthog-exceptions.csv'), /ENOENT/);

      assert.deepEqual(
        executive.product.checks.map((entry) => [entry.key, entry.state]),
        [
          ['posthog-slow-segment', 'not-collected'],
          ['posthog-rage-click-cluster', 'clear'],
          ['posthog-error-concentration', 'not-collected'],
          ['posthog-funnel-drop', 'not-collected'],
          ['posthog-once-event-repeats', 'not-collected'],
        ],
      );
      // The nominal fourteen days ending on the report date: the empty body
      // left no row to carry its own window.
      assert.deepEqual(executive.product.families, [
        { family: 'rageclicks', reportDate: '2026-09-22', windowStart: '2026-09-09', windowEnd: '2026-09-22', rows: 0, truncated: false },
      ]);
      assert.deepEqual(executive.product.rageClicks.clusters, []);
      assert.equal(executive.product.webDaily, null);
      assert.equal(executive.items.some((item) => item.key.startsWith('posthog-')), false);
    },
  );
});

// The flattener reads the contract's family list rather than keeping its own,
// and the CSV it writes is pinned.
test('the flattener flattens exactly the contract families and fields', () => {
  assert.deepEqual([...FLATTENER_FAMILIES.keys()], [...POSTHOG_FAMILIES]);
  for (const family of POSTHOG_FAMILIES) {
    // The same object, not an equal copy: there is no second list to drift.
    assert.equal(FLATTENER_FAMILIES.get(family), POSTHOG_FAMILY_ROWS[family], family);
  }
});

/** Each family's CSV header as the flattener writes it: the base columns, then
 * the metadata and contract fields sorted by name. */
const POSTHOG_CSV_HEADERS = {
  'web-daily': 'asset,report_date,collected_at,data_state,provider_truncated,date,pageviews,people,project_time_zone,row_grain,row_limit,sessions,window_end,window_start',
  events: 'asset,report_date,collected_at,data_state,provider_truncated,count,event,first_seen,last_seen,people,project_time_zone,row_grain,row_limit,window_end,window_start',
  exceptions: 'asset,report_date,collected_at,data_state,provider_truncated,count,has_source_file,max_per_session,message,people,project_time_zone,row_grain,row_limit,sessions,top_browser,top_path,type,window_end,window_start',
  rageclicks: 'asset,report_date,collected_at,data_state,provider_truncated,attr,clicks,desktop_clicks,mobile_clicks,page_people,path,people,project_time_zone,row_grain,row_limit,tablet_clicks,tag,text,window_end,window_start',
  'web-vitals': 'asset,report_date,collected_at,data_state,provider_truncated,cls_p75,device,fcp_p75,inp_p75,lcp_p75,measurements,os,path,project_time_zone,row_grain,row_limit,window_end,window_start',
  funnels: 'asset,report_date,collected_at,data_state,provider_truncated,event,funnel_id,name,path,people,project_time_zone,row_grain,row_limit,step,window_end,window_start',
};

test('every PostHog CSV keeps its column order, with rows and without', async () => {
  assert.deepEqual(Object.keys(POSTHOG_CSV_HEADERS), [...POSTHOG_FAMILIES]);
  await withPanel(acceptanceArchives(), async ({ read }) => {
    for (const family of POSTHOG_FAMILIES) {
      const header = (await read(`posthog-${family}.csv`)).split('\n')[0];
      assert.equal(header, POSTHOG_CSV_HEADERS[family], family);
    }
  });
  const empty = Object.fromEntries(
    POSTHOG_FAMILIES.map((family) => [`${family}.json`, posthogArchive(family, { window: FORTNIGHT, rows: [] })]),
  );
  await withPanel(empty, async ({ read }) => {
    for (const family of POSTHOG_FAMILIES) {
      assert.equal(await read(`posthog-${family}.csv`), `${POSTHOG_CSV_HEADERS[family]}\n`, family);
    }
  });
});

test('a truncated PostHog read is marked on every row and states its total as a floor', async () => {
  const rows = acceptanceArchives()['exceptions.json'].pages[0].response.rows;
  await withPanel(
    { 'exceptions.json': posthogArchive('exceptions', { window: FORTNIGHT, truncated: true, rows }) },
    async ({ executive, read }) => {
      const flattened = csvRows(await read('posthog-exceptions.csv'));
      assert.ok(flattened.every((row) => row.provider_truncated === 'true'));
      assert.ok(flattened.every((row) => row.row_limit === '100'));
      const card = executive.items.find((item) => item.key === 'posthog-error-concentration');
      assert.match(card.summary, /the total is a floor/);
      assert.equal(executive.product.exceptions.truncated, true);
      assert.equal(executive.product.families[0].truncated, true);
    },
  );
});

test('re-sent PostHog days resolve to the newest archive, never summed', async () => {
  const day = (date, people) => ({ date, pageviews: people * 5, people, sessions: people * 2 });
  await withPanel(
    {
      'older.json': posthogArchive('web-daily', {
        reportDate: '2026-09-21',
        window: { start: '2026-09-20', end: '2026-09-21' },
        rows: [day('2026-09-20', 100), day('2026-09-21', 90)],
      }),
      'newer.json': posthogArchive('web-daily', {
        reportDate: '2026-09-22',
        window: { start: '2026-09-21', end: '2026-09-22' },
        rows: [day('2026-09-21', 120), day('2026-09-22', 80)],
      }),
    },
    async ({ executive, read }) => {
      const rows = csvRows(await read('posthog-web-daily.csv'));
      assert.deepEqual(
        rows.map((row) => [row.date, row.people, row.report_date]),
        [
          ['2026-09-20', '100', '2026-09-21'],
          ['2026-09-21', '120', '2026-09-22'],
          ['2026-09-22', '80', '2026-09-22'],
        ],
      );
      assert.deepEqual(executive.product.webDaily.days.map((row) => row.people), [100, 120, 80]);
    },
  );
});

test('a bare contract body at the archive top level flattens the same way', async () => {
  const envelope = acceptanceArchives()['events.json'];
  const body = envelope.pages[0].response;
  await withPanel(
    {
      'events.json': {
        schemaVersion: 1,
        integration: 'posthog',
        report: 'events',
        asset: 'meals.example',
        reportDate: '2026-09-22',
        collectedAt: COLLECTED_AT,
        dataState: 'provider-snapshot',
        providerTruncated: false,
        ...body,
      },
    },
    async ({ read }) => {
      const rows = csvRows(await read('posthog-events.csv'));
      assert.equal(rows.length, 3);
      assert.equal(rows[1].window_start, '2026-09-08');
    },
  );
});

test('freshness.json lists PostHog as a collected source with its newest report date', () => {
  const freshness = freshnessReport({
    asset: 'meals.example',
    refreshedAt: '2026-09-23T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'gsc', report: 'query', reportDate: '2026-09-20' },
      { integration: 'posthog', report: 'web-daily', reportDate: '2026-09-21' },
      { integration: 'posthog', report: 'funnels', reportDate: '2026-09-22' },
      { integration: 'posthog', report: 'web-vitals', reportDate: '2026-09-15' },
    ],
  });
  const posthog = freshness.sources.find((source) => source.key === 'posthog');
  assert.deepEqual(posthog, {
    key: 'posthog',
    integration: 'posthog',
    collected: true,
    newestReportDate: '2026-09-22',
    ageDays: 1,
    fresh: true,
    reports: [
      { report: 'funnels', newestReportDate: '2026-09-22' },
      { report: 'web-daily', newestReportDate: '2026-09-21' },
      { report: 'web-vitals', newestReportDate: '2026-09-15' },
    ],
  });
  assert.equal(freshness.fresh, true);
  assert.deepEqual(freshness.uncollected, [], 'PostHog is collected by a cron, not dropped by hand');

  const stalled = freshnessReport({
    asset: 'meals.example',
    refreshedAt: '2026-10-10T13:10:00.000Z',
    maxAgeDays: 7,
    manifest: [
      { integration: 'gsc', report: 'query', reportDate: '2026-10-09' },
      { integration: 'posthog', report: 'web-daily', reportDate: '2026-09-22' },
    ],
  });
  assert.deepEqual(stalled.stale, ['posthog']);
  assert.equal(stalled.fresh, false);
});
