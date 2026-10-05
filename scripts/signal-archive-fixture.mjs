#!/usr/bin/env node
// SYNTHETIC PROVIDER ARCHIVES FOR THE ARCHIVE READERS' PROOFS (bead ro-ujb9.67.1).
//
// Signal archives in the downloads layout `signals:refresh` and
// `signals:download` write — `<integration>/<report>/<reportDate>.json` beside a
// `manifest.json` — built from nothing real. Every provider family the analyzer
// flattens is here, and so is every case its rules exist for:
//
//   * duplicate delivery — a report day delivered a second time under another
//     file name (`extra/`), identical or corrected;
//   * revisions — overlapping Bing AI exports, Bing crawl series, PostHog
//     daily windows and Bing sitemap snapshots, and GA4 attribution days
//     re-confirmed by a later collection;
//   * missing and truncated reports — gaps between report days, archives with
//     no pages or no result, an unanswered SERP call, a PostHog window
//     answered with no rows, truncated provider reads;
//   * time zones — offset timestamps in collections and Bing dates, and the
//     PostHog project's own zone;
//   * deterministic ordering — ties broken only by where a file sits.
//
//   writeArchiveFixture(dir)        the archive above, for asset FIXTURE_ASSET
//   fixtureArchives()               the same archives in memory, as
//   fixtureManifest()                 [path, archive] pairs, and its manifest
//   writeGrowingArchive(dir, days)  one daily family over `days` days, for the
//                                   growing-history benchmark
// The historical report reference in scripts/fixture-archive-analysis/ stays
// frozen. Current report tests publish these archives into history and invoke
// the sole bounded analyzer through test-fixtures/signal-report.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The invented site every archive here belongs to (db/fixtures/invented-sites.json). */
export const FIXTURE_ASSET = 'meals.example';

/** The clock an analysis of the fixture reads. */
export const FIXTURE_ANALYZED_AT = '2026-09-22T06:00:00.000Z';

function envelope(integration, report, reportDate, fields) {
  return {
    schemaVersion: 1,
    provider: integration,
    asset: FIXTURE_ASSET,
    integration,
    report,
    reportDate,
    collectedAt: `${nextDay(reportDate)}T12:15:00.000Z`,
    dataState: 'provider-snapshot',
    providerTruncated: false,
    ...fields,
  };
}

function nextDay(day) {
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) ? new Date(time + 86_400_000).toISOString().slice(0, 10) : '2026-09-22';
}

function days(start, count) {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(first + index * 86_400_000).toISOString().slice(0, 10),
  );
}

/** A number that varies by day and key, without randomness. */
function wave(base, day, key, spread) {
  return base + ((day * 7 + key * 13) % spread);
}

const QUERIES = [
  'meal planner',
  'weekly meal plan',
  'high protein, "easy" dinners',
  '"how many cups in a quart"',
  'meal prep ideas',
  'crème brûlée calories',
];
const PAGES = [
  'https://meals.example/',
  'https://meals.example/planner',
  'https://meals.example/recipes/soup',
  'https://meals.example/guides/protein',
];

function gscRow(keys, day, key) {
  const impressions = wave(120, day, key, 90);
  const clicks = wave(3, day, key + 2, 17);
  return {
    keys,
    clicks,
    impressions,
    ctr: clicks / impressions,
    position: Math.round((2.5 + key * 1.7 + (day % 5) * 0.3) * 10) / 10,
  };
}

function gscArchives() {
  const files = [];
  // Sixteen report days with one missing (09-12): a gap is never a zero.
  const reportDays = days('2026-09-05', 16).filter((day) => day !== '2026-09-12');
  reportDays.forEach((reportDate, dayIndex) => {
    files.push([`gsc/query/${reportDate}.json`, envelope('gsc', 'query', reportDate, {
      dataState: 'provider-final',
      providerRows: QUERIES.length,
      pages: [{
        request: { dimensions: ['query'] },
        response: { rows: QUERIES.map((query, index) => gscRow([query], dayIndex, index)) },
      }],
    })]);
    files.push([`gsc/page/${reportDate}.json`, envelope('gsc', 'page', reportDate, {
      dataState: 'provider-final',
      providerRows: PAGES.length,
      pages: [{
        request: { dimensions: ['page'] },
        response: { rows: PAGES.map((page, index) => gscRow([page], dayIndex, index)) },
      }],
    })]);
  });
  for (const [dayIndex, reportDate] of ['2026-09-19', '2026-09-20'].entries()) {
    files.push([`gsc/page-query/${reportDate}.json`, envelope('gsc', 'page-query', reportDate, {
      dataState: 'provider-final',
      providerRows: 6,
      // The provider cut this read at its row limit.
      providerTruncated: dayIndex === 1,
      pages: [{
        request: { dimensions: ['page', 'query'] },
        response: {
          rows: [
            gscRow([PAGES[1], QUERIES[0]], dayIndex, 0),
            gscRow([PAGES[1], QUERIES[1]], dayIndex, 1),
            gscRow([PAGES[3], QUERIES[1]], dayIndex, 2),
            gscRow([PAGES[2], QUERIES[2]], dayIndex, 3),
            gscRow([PAGES[0], QUERIES[3]], dayIndex, 4),
            // Fewer keys than dimensions: the missing one stays empty.
            { keys: [PAGES[0]], clicks: 1, impressions: 9 },
          ],
        },
      }],
    })]);
  }
  files.push([`gsc/device/2026-09-20.json`, envelope('gsc', 'device', '2026-09-20', {
    providerRows: 3,
    pages: [
      {
        request: { dimensions: ['device'] },
        response: {
          rows: ['DESKTOP', 'MOBILE', 'TABLET'].map((device, index) => gscRow([device], 3, index)),
        },
      },
      // No dimension at all: the property's own total.
      { request: { dimensions: [] }, response: { rows: [gscRow([], 3, 0)] } },
      // A page the provider answered with nothing.
      { request: { dimensions: ['device'] }, response: {} },
    ],
  })]);
  files.push([`gsc/search-appearance-pages/2026-09-20.json`, envelope('gsc', 'search-appearance-pages', '2026-09-20', {
    providerRows: 3,
    pages: [
      {
        request: { dimensions: ['searchAppearance'] },
        response: { rows: [gscRow(['RECIPE'], 2, 0)] },
      },
      {
        request: {
          dimensions: ['page'],
          dimensionFilterGroups: [{
            groupType: 'and',
            filters: [
              { dimension: 'searchAppearance', operator: 'equals', expression: 'RECIPE' },
              // Not an equality: not a column.
              { dimension: 'country', operator: 'contains', expression: 'us' },
              // Already a dimension: the row's own key wins.
              { dimension: 'page', operator: 'equals', expression: 'https://meals.example/elsewhere' },
            ],
          }],
        },
        response: { rows: [gscRow([PAGES[2]], 2, 1), gscRow([PAGES[3]], 2, 2)] },
      },
    ],
  })]);
  // A week of countries, one of them searched in a language the page is not
  // described in: a large share clicking at a fraction of everyone else's CTR.
  const countries = [['usa', 400, 24], ['gbr', 120, 7], ['kor', 190, 1], ['can', 60, 3]];
  for (const [dayIndex, reportDate] of days('2026-09-14', 7).entries()) {
    files.push([`gsc/country/${reportDate}.json`, envelope('gsc', 'country', reportDate, {
      dataState: 'provider-final',
      providerRows: countries.length,
      pages: [{
        request: { dimensions: ['country'] },
        response: {
          rows: countries.map(([country, impressions, clicks], index) => ({
            keys: [country],
            clicks: clicks + (dayIndex % 2),
            impressions: impressions + dayIndex * 3 + index,
            ctr: (clicks + (dayIndex % 2)) / (impressions + dayIndex * 3 + index),
            position: 6.1 + index,
          })),
        },
      }],
    })]);
  }
  // A report day whose archive holds no pages at all: it adds nothing.
  files.push([`gsc/country/2026-09-21.json`, envelope('gsc', 'country', '2026-09-21', { providerRows: 0 })]);
  files.push([`gsc/page-country/2026-09-20.json`, envelope('gsc', 'page-country', '2026-09-20', {
    dataState: 'provider-final',
    providerRows: 3,
    pages: [{
      request: { dimensions: ['page', 'country'] },
      response: {
        rows: [
          gscRow([PAGES[3], 'kor'], 6, 0),
          gscRow([PAGES[1], 'kor'], 6, 1),
          gscRow([PAGES[1], 'usa'], 6, 2),
        ],
      },
    }],
  })]);
  return files;
}

function ga4Page(dimensions, metrics, rows, dateRange) {
  return {
    request: dateRange ? { dateRanges: [dateRange] } : {},
    response: {
      dimensionHeaders: dimensions.map((name) => ({ name })),
      metricHeaders: metrics.map((name) => ({ name })),
      rows: rows.map(([dimensionValues, metricValues]) => ({
        dimensionValues: dimensionValues.map((value) => ({ value })),
        metricValues: metricValues.map((value) => ({ value: String(value) })),
      })),
    },
  };
}

function ga4Archives() {
  const files = [];
  const ga4 = (report, reportDate, pages, fields = {}) => [
    `ga4/${report}/${reportDate}.json`,
    envelope('ga4', report, reportDate, {
      provider: 'google',
      dataState: 'revision-window',
      providerRows: pages.reduce((total, page) => total + page.response.rows.length, 0),
      pages,
      ...fields,
    }),
  ];
  for (const [index, day] of ['2026-09-18', '2026-09-19', '2026-09-20'].entries()) {
    files.push(ga4('pages-screens', day, [ga4Page(
      ['unifiedPagePathScreen'],
      ['screenPageViews', 'activeUsers', 'keyEvents'],
      [
        [['/planner'], [wave(400, index, 1, 60), wave(210, index, 1, 30), 12 + index]],
        [['/recipes/soup'], [wave(150, index, 2, 40), wave(90, index, 2, 20), 1]],
        // Fewer values than headers: the missing metric stays empty.
        [['/guides/protein'], [33]],
      ],
      { startDate: day, endDate: day },
    )]));
  }
  files.push(ga4('events', '2026-09-20', [ga4Page(
    ['eventName'],
    ['eventCount', 'totalUsers', 'keyEvents'],
    [
      [['page_view'], [5120, 2100, 0]],
      [['calculation_complete'], [410, 260, 410]],
      [['plan_save_click'], [52, 40, 0]],
      [['sign_up'], [9, 9, 9]],
      [['trial_started'], [4, 4, 4]],
    ],
    { startDate: '2026-09-20', endDate: '2026-09-20' },
  )]));
  files.push(ga4('events-28d', '2026-09-20', [ga4Page(
    ['eventName'],
    ['eventCount', 'totalUsers'],
    [[['calculation_complete'], [9800, 4100]], [['plan_save_click'], [1300, 950]]],
    { startDate: '2026-08-24', endDate: '2026-09-20' },
  )]));
  files.push(ga4('js-errors', '2026-09-20', [ga4Page(
    ['customEvent:message', 'customEvent:source', 'unifiedPagePathScreen'],
    ['eventCount', 'totalUsers'],
    [
      [["TypeError: x is null at https://meals.example/planner?step=2 line 42", 'https://meals.example/assets/index-a1b2c3d4e5f6.js', '/planner'], [125, 88]],
      [["TypeError: x is null at https://meals.example/recipes line 907", 'https://meals.example/assets/index-a1b2c3d4e5f6.js', '/recipes/soup'], [31, 24]],
      [['Error: first line\nsecond line, "quoted"', '(not set)', '/planner'], [4, 4]],
      [['(not set)', '(not set)', '/plan'], [9, 7]],
    ],
  )]));
  const channels = (unassigned) => [ga4Page(
    ['sessionDefaultChannelGroup'],
    ['sessions', 'engagedSessions'],
    [[['Organic Search'], [1840, 1210]], [['Direct'], [660, 300]], [['Unassigned'], [unassigned, 3]]],
  )];
  // Collected at D+1, re-confirmed unchanged at D+2 by the manifest: settled.
  files.push(ga4('traffic-acquisition', '2026-09-18', channels(120), { collectedAt: '2026-09-19T12:15:00.000Z' }));
  // Collected with an offset: the date written in the timestamp is the one read.
  files.push(ga4('traffic-acquisition', '2026-09-19', channels(131), { collectedAt: '2026-09-21T01:30:00+09:00' }));
  // Collected at D+1 and never since: still provisional.
  files.push(ga4('traffic-acquisition', '2026-09-20', channels(3380), { collectedAt: '2026-09-21T12:15:00.000Z' }));
  // Neither date can be read: unknown, never a guess.
  files.push(ga4('traffic-acquisition', 'latest', channels(99), { collectedAt: 'not recorded' }));
  files.push(ga4('traffic-sources', '2026-09-20', [ga4Page(
    ['sessionSource', 'sessionMedium'],
    ['sessions'],
    [[['google', 'organic'], [1800]], [['(direct)', '(none)'], [660]], [['chatgpt.com', 'referral'], [44]]],
  )], { collectedAt: '2026-09-22T12:15:00.000Z' }));
  files.push(ga4('landing-page-acquisition', '2026-09-20', [ga4Page(
    ['landingPage', 'sessionDefaultChannelGroup'],
    ['sessions', 'keyEvents'],
    [[['/planner', 'Organic Search'], [900, 40]], [['/', 'Direct'], [400, 3]]],
  )], { collectedAt: '2026-09-21T12:15:00.000Z' }));
  files.push(ga4('landing-pages', '2026-09-20', [ga4Page(
    ['landingPage'],
    ['sessions', 'newUsers'],
    [[['/planner'], [950, 700]], [['/recipes/soup'], [240, 200]]],
  )]));
  files.push(ga4('page-events', '2026-09-20', [ga4Page(
    ['unifiedPagePathScreen', 'eventName'],
    ['eventCount', 'totalUsers'],
    [[['/planner', 'calculation_complete'], [400, 250]], [['/planner', 'plan_save_click'], [50, 38]]],
  )]));
  return files;
}

const legacyDate = (day, offset = '') => `/Date(${Date.parse(`${day}T00:00:00.000Z`)}${offset})/`;

function bingArchive(report, reportDate, method, rows, fields = {}) {
  return envelope('bing-webmaster', report, reportDate, {
    provider: 'microsoft',
    providerRows: rows.length,
    pages: [{ request: { method, siteUrl: 'https://meals.example/' }, response: { d: rows } }],
    ...fields,
  });
}

function crawlDay(date, inIndex, crawled) {
  return {
    __type: 'CrawlStats:#Microsoft.Bing.Webmaster.Api',
    Date: date,
    InIndex: inIndex,
    CrawledPages: crawled,
    CrawlErrors: 3,
    BlockedByRobotsTxt: 0,
    InLinks: 12,
  };
}

function bingAiArchive(report, exportDate, rows) {
  return envelope('bing-webmaster', report, exportDate, {
    provider: 'microsoft',
    collectedAt: `${exportDate}T13:00:00.000Z`,
    providerRows: rows.length,
    pages: [{
      request: { source: 'operator-export', exportDate, file: `export-${exportDate}.csv`, parser: 'bing-ai-export/1' },
      response: { csvBase64: 'aWdub3JlZA==', rows },
    }],
  });
}

function bingArchives() {
  const files = [];
  files.push(['bing-webmaster/rank-traffic/2026-09-20.json', bingArchive('rank-traffic', '2026-09-20', 'GetRankAndTrafficStats',
    days('2026-09-14', 7).map((day, index) => ({
      __type: 'RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api',
      Date: legacyDate(day, '-0700'),
      Clicks: wave(20, index, 1, 9),
      Impressions: wave(700, index, 2, 120),
    })),
  )]);
  for (const reportDate of ['2026-09-14', '2026-09-21']) {
    files.push([`bing-webmaster/queries/${reportDate}.json`, bingArchive('queries', reportDate, 'GetQueryStats',
      QUERIES.slice(0, 4).map((query, index) => ({
        __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api',
        Query: query,
        Clicks: wave(4, reportDate === '2026-09-14' ? 0 : 1, index, 11),
        Impressions: wave(90, reportDate === '2026-09-14' ? 0 : 1, index, 70),
        AvgClickPosition: 3 + index,
        AvgImpressionPosition: 4.5 + index,
        Date: legacyDate(reportDate),
      })),
    )]);
  }
  files.push(['bing-webmaster/pages/2026-09-21.json', bingArchive('pages', '2026-09-21', 'GetPageStats',
    PAGES.map((page, index) => ({
      __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api',
      // The page report names its page `Query`.
      Query: page,
      Clicks: wave(3, 1, index, 9),
      Impressions: wave(60, 1, index, 50),
    })),
  )]);
  for (const [index, reportDate] of ['2026-09-20', '2026-09-21'].entries()) {
    files.push([`bing-webmaster/crawl-issues/${reportDate}.json`, bingArchive('crawl-issues', reportDate, 'GetCrawlIssues', [
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', Url: 'https://meals.example/old-page', HttpCode: 404, Issues: 20, InLinks: 3 + index },
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', Url: 'https://meals.example/moved', HttpCode: 301, Issues: 257, InLinks: 7 },
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', Url: 'https://meals.example/fine', HttpCode: 200, Issues: 0, InLinks: 1 },
      { __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api', Url: 'https://meals.example/odd', HttpCode: 200, Issues: 'x', InLinks: 0 },
      // Not a row.
      null,
    ])]);
  }
  // Bing re-sends a trailing series every collection: overlapping days are
  // revisions of one day.
  files.push(['bing-webmaster/crawl-stats/2026-09-19.json', bingArchive('crawl-stats', '2026-09-19', 'GetCrawlStats', [
    crawlDay(legacyDate('2026-09-16'), 2600, 400),
    crawlDay(legacyDate('2026-09-17'), 2610, 402),
    // An offset date that crosses midnight: read in UTC.
    crawlDay('2026-09-17T20:00:00-07:00', 2620, 405),
  ])]);
  files.push(['bing-webmaster/crawl-stats/2026-09-20.json', bingArchive('crawl-stats', '2026-09-20', 'GetCrawlStats', [
    crawlDay(legacyDate('2026-09-17', '-0700'), 2611, 402),
    crawlDay(legacyDate('2026-09-18'), 2621, 405),
    crawlDay(legacyDate('2026-09-19'), 2640, 380),
    // Undated: never placed on a day.
    crawlDay(null, 1, 1),
  ])]);
  files.push(['bing-webmaster/crawl-stats/2026-09-21.json', bingArchive('crawl-stats', '2026-09-21', 'GetCrawlStats', [
    crawlDay(legacyDate('2026-09-18'), 2622, 405),
    crawlDay(legacyDate('2026-09-19'), 2641, 381),
    crawlDay(legacyDate('2026-09-20'), 2655, 377),
  ])]);
  const feed = (urlCount, lastCrawled, submitted, url = 'https://meals.example/sitemap.xml') => ({
    __type: 'Feed:#Microsoft.Bing.Webmaster.Api',
    Url: url,
    UrlCount: urlCount,
    Status: 'Success',
    Type: 'Sitemap',
    LastCrawled: lastCrawled,
    Submitted: submitted,
  });
  files.push(['bing-webmaster/feeds/2026-09-20.json', bingArchive('feeds', '2026-09-20', 'GetFeeds', [
    feed(2900, legacyDate('2026-09-19', '+0100'), 1_783_796_353_525),
  ])]);
  files.push(['bing-webmaster/feeds/2026-09-21.json', bingArchive('feeds', '2026-09-21', 'GetFeeds', [
    feed(2970, '2026-09-20T23:30:00-04:00', 1_783_796_353_525),
    feed(40, 'not a date', null, 'https://meals.example/news-sitemap.xml'),
  ])]);
  files.push(['bing-webmaster/ai-overview/2026-08-04.json', bingAiArchive('ai-overview', '2026-08-04', [
    { date: '2026-07-10', citations: 9000, citedPages: 40 },
    { date: '2026-07-11', citations: 9100, citedPages: 41 },
    { citations: 5, citedPages: 1 },
  ])]);
  files.push(['bing-webmaster/ai-overview/2026-09-01.json', bingAiArchive('ai-overview', '2026-09-01', [
    { date: '2026-07-11', citations: 9250, citedPages: 43 },
    { date: '2026-08-30', citations: 11000, citedPages: 52 },
    // The same day twice inside one export: the later row is the one kept.
    { date: '2026-08-31', citations: 10100, citedPages: 50 },
    { date: '2026-08-31', citations: 10120, citedPages: 51 },
    { citations: 7, citedPages: 2 },
  ])]);
  files.push(['bing-webmaster/ai-queries/2026-09-01.json', bingAiArchive('ai-queries', '2026-09-01', [
    { query: 'how much protein should i eat daily', intent: 'Learn and Solve', topic: 'Protein', citations: 42488, citationSharePercent: 27.24 },
    { query: 'meal plan', intent: '', topic: '', citations: 2627, citationSharePercent: 24.25 },
  ])]);
  files.push(['bing-webmaster/ai-pages/2026-09-01.json', bingAiArchive('ai-pages', '2026-09-01', [
    { page: 'https://meals.example/guides/protein', citations: 294996 },
  ])]);
  return files;
}

function clarityArchives() {
  return ['2026-09-20', '2026-09-21'].map((reportDate, index) => [
    `clarity/url-3d/${reportDate}.json`,
    envelope('clarity', 'url-3d', reportDate, {
      provider: 'microsoft',
      collectedAt: `${reportDate}T04:30:00.000Z`,
      providerRows: 5,
      pages: [{
        request: { numOfDays: 3, dimension1: 'URL' },
        response: [
          {
            metricName: 'ScriptErrorCount',
            information: [
              { sessionsCount: String(114 + index), sessionsWithMetricPercentage: 11.4, pagesViews: '14', subTotal: '19', Url: 'https://meals.example/planner' },
              { sessionsCount: '12', sessionsWithMetricPercentage: 2.5, pagesViews: '3', subTotal: '4', Url: 'https://meals.example/recipes/soup' },
            ],
          },
          { metricName: 'ScrollDepth', information: [{ averageScrollDepth: 67.78, Url: 'https://meals.example/planner' }] },
          // The unattributed aggregate really comes back with Url: null.
          { metricName: 'Traffic', information: [{ totalSessionCount: '0', totalBotSessionCount: '1', distinctUserCount: '245', Url: null }, 'not a row'] },
          // A block with no metric name is not a block.
          { information: [{ subTotal: '1' }] },
        ],
      }],
    }),
  ]);
}

function posthogArchive(family, reportDate, window, rows, fields = {}) {
  const truncated = fields.bodyTruncated ?? false;
  const { bodyTruncated, bodyCollectedAt, ...rest } = fields;
  return envelope('posthog', family, reportDate, {
    propertyRef: '100001',
    collectedAt: `${nextDay(reportDate)}T12:30:04.120Z`,
    providerRows: rows.length,
    pages: [{
      request: { host: 'us', projectId: '100001', family, window, rowLimit: 100 },
      response: {
        provider: 'posthog',
        family,
        projectTimeZone: 'America/Los_Angeles',
        window,
        collectedAt: bodyCollectedAt ?? `${nextDay(reportDate)}T12:30:04.120Z`,
        rowLimit: 100,
        truncated,
        rows,
      },
    }],
    ...rest,
  });
}

function posthogArchives() {
  const daily = (day, index, bump = 0) => ({
    date: day,
    pageviews: wave(900, index, 1, 80) + bump,
    people: wave(300, index, 2, 40) + bump,
    sessions: wave(420, index, 3, 50) + bump,
  });
  const files = [];
  files.push(['posthog/web-daily/2026-09-20.json', posthogArchive('web-daily', '2026-09-20',
    { start: '2026-08-24', end: '2026-09-20' },
    days('2026-09-17', 4).map((day, index) => daily(day, index)),
  )]);
  files.push(['posthog/web-daily/2026-09-21.json', posthogArchive('web-daily', '2026-09-21',
    { start: '2026-08-25', end: '2026-09-21' },
    [
      // Late events landed on days the earlier window already carried.
      ...days('2026-09-18', 4).map((day, index) => daily(day, index + 1, 5)),
      // A row PostHog dated nothing cannot be placed on a day.
      { date: '', pageviews: 1, people: 1, sessions: 1 },
    ],
  )]);
  const window = { start: '2026-09-15', end: '2026-09-21' };
  files.push(['posthog/events/2026-09-21.json', posthogArchive('events', '2026-09-21', window, [
    { event: '$pageview', count: 5200, people: 2100, firstSeen: '2026-09-15T00:01:00Z', lastSeen: '2026-09-21T23:59:00Z' },
    { event: 'first_plan_created', count: 480, people: 400, firstSeen: '2026-09-15T08:00:00Z', lastSeen: '2026-09-21T22:00:00Z' },
  ])]);
  // A bare contract body at the top level, written by hand: it flattens the same
  // way. No `providerRows` on it, so none in the summary either.
  files.push(['posthog/events/2026-09-14.json', {
    schemaVersion: 1,
    provider: 'posthog',
    integration: 'posthog',
    report: 'events',
    asset: FIXTURE_ASSET,
    reportDate: '2026-09-14',
    collectedAt: '2026-09-15T12:30:00.000Z',
    dataState: 'provider-snapshot',
    projectTimeZone: 'America/Los_Angeles',
    window: { start: '2026-09-08', end: '2026-09-14' },
    rowLimit: 100,
    truncated: false,
    rows: [{ event: '$pageview', count: 4800, people: 1990, firstSeen: '2026-09-08T00:02:00Z', lastSeen: '2026-09-14T23:58:00Z' }],
  }]);
  // PostHog answered with no rows for the earlier window: collected, nothing
  // found, and no rows. (A family with no rows at all writes its header alone;
  // posthog-panel.test.mjs pins that file for every PostHog family.)
  files.push(['posthog/exceptions/2026-09-14.json', posthogArchive('exceptions', '2026-09-14', { start: '2026-09-08', end: '2026-09-14' }, [])]);
  files.push(['posthog/exceptions/2026-09-21.json', posthogArchive('exceptions', '2026-09-21', window, [
    { type: 'TypeError', message: "Cannot read properties of null (reading 'plan')", count: 140, people: 90, sessions: 110, maxPerSession: 3, hasSourceFile: true, topPath: '/planner', topBrowser: 'Safari' },
    { type: 'Error', message: 'Script error.', count: 60, people: 55, sessions: 58, maxPerSession: 1, hasSourceFile: false, topPath: '/', topBrowser: 'Chrome' },
    { type: 'RangeError', message: 'Invalid time value', count: 12, people: 9, sessions: 10, maxPerSession: 2, hasSourceFile: null, topPath: '/recipes/soup', topBrowser: null },
  ])]);
  // Cut at the row limit, said only by the body.
  files.push(['posthog/rageclicks/2026-09-21.json', posthogArchive('rageclicks', '2026-09-21', window, [
    { path: '/planner', tag: 'button', text: 'Save', attr: 'save-plan', clicks: 90, people: 30, desktopClicks: 60, mobileClicks: 30, tabletClicks: 0, pagePeople: 400 },
  ], { bodyTruncated: true })]);
  files.push(['posthog/web-vitals/2026-09-21.json', posthogArchive('web-vitals', '2026-09-21', window, [
    { path: '/planner', device: 'Mobile', os: 'iOS', lcpP75: 3100, inpP75: null, clsP75: 0.02, fcpP75: 1400, measurements: 820 },
    { path: '/planner', device: 'Desktop', os: 'Mac OS X', lcpP75: 1900, inpP75: 90, clsP75: 0.01, fcpP75: 900, measurements: 610 },
  ])]);
  // No collection time on the envelope: the body's is read.
  const funnels = posthogArchive('funnels', '2026-09-21', window, [
    { funnelId: 'plan', name: 'Plan saved', step: 1, event: '$pageview', path: '/planner', people: 900 },
    { funnelId: 'plan', name: 'Plan saved', step: 2, event: 'plan_save_click', path: '/planner', people: 120 },
  ], { bodyCollectedAt: '2026-09-22T12:31:00.000Z' });
  delete funnels.collectedAt;
  files.push(['posthog/funnels/2026-09-21.json', funnels]);
  // A family the contract does not name: its own fields, as they arrived.
  files.push(['posthog/paths/2026-09-21.json', posthogArchive('paths', '2026-09-21', window, [
    { fromPath: '/', toPath: '/planner', people: 300 },
  ])]);
  return files;
}

function dataForSeoArchive(report, reportDate, result, cost, fields = {}) {
  return envelope('dataforseo', report, reportDate, {
    collectedAt: `${nextDay(reportDate)}T12:45:00.000Z`,
    providerRows: 1,
    pages: [{
      request: { path: `/fixture/${report}` },
      response: { status_code: 20000, cost, tasks: [{ status_code: 20000, result: result === null ? null : [result] }] },
    }],
    ...fields,
  });
}

function rankedItem(keyword, volume, rank, url, changes = {}) {
  return {
    keyword_data: {
      keyword,
      keyword_info: { search_volume: volume, cpc: 1.25, competition_level: 'MEDIUM' },
      keyword_properties: { keyword_difficulty: 28 },
      search_intent_info: { main_intent: 'informational' },
      serp_info: { serp_item_types: ['organic', 'people_also_ask', 'ai_overview'] },
    },
    ranked_serp_element: {
      serp_item: {
        type: 'organic',
        rank_group: rank,
        rank_absolute: rank + 1,
        title: `Title for ${keyword}`,
        url,
        relative_url: new URL(url).pathname,
        etv: volume * 0.05,
        estimated_paid_traffic_cost: volume * 0.07,
        rank_changes: changes,
        backlinks_info: { backlinks: 12, referring_domains: 8 },
      },
    },
  };
}

function serpPage(keyword, items, { device = null, label, unanswered = false, itemTypes } = {}) {
  return {
    request: {
      path: '/serp/google/organic/live/advanced',
      attempts: unanswered ? 3 : 1,
      ...(label === undefined ? {} : { label }),
      body: { keyword, depth: 20, load_async_ai_overview: true, ...(device ? { device } : {}) },
    },
    response: {
      status_code: 20000,
      cost: 0.004,
      tasks: [unanswered
        ? { status_code: 40501, status_message: 'Invalid Field: keyword.', result: null }
        : { status_code: 20000, result: [{ keyword, items, ...(itemTypes ? { item_types: itemTypes } : {}) }] }],
    },
  };
}

function dataForSeoArchives() {
  const files = [];
  files.push(['dataforseo/ranked-keywords/2026-09-07.json', dataForSeoArchive('ranked-keywords', '2026-09-07', {
    items: [
      rankedItem('weekly meal plan', 2400, 14, 'https://meals.example/planner'),
      rankedItem('meal prep ideas', 900, 9, 'https://meals.example/recipes/soup'),
    ],
  }, 0.011)]);
  files.push(['dataforseo/ranked-keywords/2026-09-14.json', dataForSeoArchive('ranked-keywords', '2026-09-14', {
    items: [
      rankedItem('weekly meal plan', 2400, 8, 'https://meals.example/planner', { previous_rank_absolute: 15, is_up: true }),
      rankedItem('meal prep ideas', 900, 12, 'https://meals.example/recipes/soup', { previous_rank_absolute: 10, is_down: true }),
      rankedItem('meal planner', 5400, 4, 'https://meals.example/', { is_new: true }),
      // No keyword data: not a ranking.
      { ranked_serp_element: { serp_item: { type: 'organic', rank_group: 1 } } },
    ],
  }, 0.012)]);
  const summary = (backlinks, domains) => ({
    target: 'meals.example', rank: 412, backlinks, backlinks_spam_score: 2, referring_domains: domains, referring_pages: 700, broken_backlinks: 4,
  });
  files.push(['dataforseo/backlinks-summary/2026-09-07.json', dataForSeoArchive('backlinks-summary', '2026-09-07', summary(780, 231), 0.02)]);
  files.push(['dataforseo/backlinks-summary/2026-09-14.json', dataForSeoArchive('backlinks-summary', '2026-09-14', summary(800, 240), 0.02)]);
  // Billed, unanswered: no rows, and the family keeps its earlier ones.
  files.push(['dataforseo/backlinks-summary/2026-09-21.json', dataForSeoArchive('backlinks-summary', '2026-09-21', null, 0.02)]);
  files.push(['dataforseo/keyword-ideas/2026-09-14.json', dataForSeoArchive('keyword-ideas', '2026-09-14', {
    items: [
      { keyword: 'meal plan for two', keyword_info: { search_volume: 880, cpc: 0.9, competition_level: 'LOW' }, keyword_properties: { keyword_difficulty: 12 }, search_intent_info: { main_intent: 'commercial' } },
      { keyword: 'cheap meal plan', keyword_info: { search_volume: 1300 }, search_intent_info: { main_intent: { label: 'informational' } } },
      null,
    ],
  }, 0.03)]);
  files.push(['dataforseo/serp-competitors/2026-09-14.json', dataForSeoArchive('serp-competitors', '2026-09-14', {
    items: [
      { domain: 'recipes.example', intersections: 120, avg_position: 6.2, sum_position: 744, metrics: { organic: { count: 120, etv: 3400, pos_1: 5, pos_2_3: 11 } }, full_domain_metrics: { organic: { count: 91_000 } } },
      null,
    ],
  }, 0.03)]);
  files.push(['dataforseo/backlinks-referring-domains/2026-09-14.json', dataForSeoArchive('backlinks-referring-domains', '2026-09-14', {
    items: [{ domain: 'blog.example.org', rank: 220, backlinks: 14, first_seen: '2026-01-02 00:00:00 +00:00', lost_date: null }],
  }, 0.02)]);
  files.push(['dataforseo/backlinks-anchors/2026-09-14.json', dataForSeoArchive('backlinks-anchors', '2026-09-14', {
    items: [{ anchor: 'meal planner, free', rank: 100, backlinks: 40, referring_domains: 12 }],
  }, 0.02)]);
  files.push(['dataforseo/backlinks-new-lost/2026-09-14.json', dataForSeoArchive('backlinks-new-lost', '2026-09-14', {
    items: [
      { date: '2026-09-07 00:00:00 +00:00', new_backlinks: 9, lost_backlinks: 5, new_referring_domains: 6, lost_referring_domains: 2 },
      { date: '2026-09-14 00:00:00 +00:00', new_backlinks: 12, lost_backlinks: 3, new_referring_domains: 8, lost_referring_domains: 1 },
    ],
  }, 0.02)]);
  files.push(['dataforseo/llm-mentions-google/2026-09-14.json', dataForSeoArchive('llm-mentions-google', '2026-09-14', {
    aggregated_metrics: {
      platform: [{ key: 'google', mentions: 7, ai_search_volume: 900 }],
      sources_domain: [{ key: 'meals.example', mentions: 7, ai_search_volume: 900 }, null],
    },
  }, 0.1)]);
  // A platform answered with no figures at all: unknown, never zero.
  files.push(['dataforseo/llm-mentions-chatgpt/2026-09-14.json', dataForSeoArchive('llm-mentions-chatgpt', '2026-09-14', {
    aggregated_metrics: { platform: [{ key: 'chat_gpt' }], sources_domain: [] },
  }, 0.1)]);
  // A DataForSEO report the analyzer has no rule for. No collector writes
  // `on-page-summary` (workers/ingest/src/dataforseo-dumps.ts names none), and
  // the DataForSEO flattener has no branch for it, so every archive of it —
  // this one included — flattens to no rows and writes an empty file. That
  // empty file is the honest output, and it is here to pin that fall-through.
  files.push(['dataforseo/on-page-summary/2026-09-14.json', dataForSeoArchive('on-page-summary', '2026-09-14', { pages: 40 }, 0.01)]);
  const panel = (reportDate, pages) => envelope('dataforseo', 'serp-panel', reportDate, {
    propertyRef: 'meals.example',
    collectedAt: `${nextDay(reportDate)}T12:45:00.000Z`,
    providerRows: pages.length,
    providerTruncated: true,
    pages,
  });
  // Before labels and before devices: every page reads desktop, no label.
  files.push(['dataforseo/serp-panel/2026-09-07.json', panel('2026-09-07', [
    serpPage('meal planner', [
      { type: 'organic', rank_group: 2, domain: 'www.meals.example', url: 'https://meals.example/', links: [] },
      { type: 'organic', rank_group: 1, domain: 'recipes.example' },
    ]),
    serpPage('weekly meal plan', [{ type: 'organic', rank_group: 9, domain: 'meals.example', url: 'https://meals.example/planner' }]),
  ])]);
  files.push(['dataforseo/serp-panel/2026-09-14.json', panel('2026-09-14', [
    serpPage('meal planner', [
      {
        type: 'ai_overview',
        asynchronous_ai_overview: true,
        items: [{ type: 'ai_overview_element', text: 'A plan is…' }],
        references: [{ domain: 'reference.example' }, { url: 'https://blog.meals.example/portions' }],
      },
      { type: 'organic', rank_group: 1, domain: 'reference.example' },
      { type: 'organic', rank_group: 2, domain: 'www.meals.example', url: 'https://meals.example/', links: [] },
      { type: 'organic', rank_group: 3, domain: 'recipes.example' },
      { type: 'organic', rank_group: 5, domain: 'meals.example', url: 'https://meals.example/planner' },
    ], { device: 'mobile', label: 'Head terms' }),
    serpPage('meal planner', [
      { type: 'organic', rank_group: 3, domain: 'meals.example', url: 'https://meals.example/', links: [{ type: 'link_element', url: 'https://meals.example/planner' }] },
    ], { device: 'desktop', label: 'Head terms' }),
    serpPage('weekly meal plan', [
      { type: 'ai_overview', references: [{ domain: 'reference.example' }], items: [{ type: 'ai_overview_element', text: 'Plan ahead…' }] },
      { type: 'organic', rank_group: 1, domain: 'reference.example' },
    ], { device: 'mobile', label: 'Head terms', itemTypes: ['organic', 'ai_overview', 'people_also_ask'] }),
    // The overview never loaded: unknown, never "no overview".
    serpPage('meal prep ideas', [
      { type: 'ai_overview', asynchronous_ai_overview: true },
      { type: 'organic', rank_group: 1, domain: 'recipes.example' },
    ], { device: 'desktop', label: '' }),
    // Billed, unanswered: one row, every observation unknown.
    serpPage('crème brûlée calories', [], { device: 'mobile', unanswered: true }),
  ])]);
  return files;
}

/**
 * The same report days delivered a second time under other names, the way a
 * hand-assembled input can hold them. Paths decide ties: archives are read in
 * path order, and of two with the same report date the one read later wins.
 * `extra/` sorts after `bing-webmaster/` (the copy wins) and before `posthog/`
 * (the original wins), so both directions are covered. In a family no rule
 * resolves (GSC), both copies are kept, in path order: `extra/` rows before
 * `gsc/` ones, `late/` rows after them.
 */
function duplicateDeliveries(archives) {
  const byPath = new Map(archives);
  const copy = (from, to, change) => {
    const archive = structuredClone(byPath.get(from));
    change?.(archive);
    return [to, archive];
  };
  return [
    // The same bytes twice.
    copy('gsc/query/2026-09-20.json', 'extra/gsc-query-2026-09-20.json'),
    // A corrected re-delivery of a day already held.
    copy('bing-webmaster/crawl-stats/2026-09-20.json', 'extra/bing-crawl-stats-2026-09-20.json', (archive) => {
      archive.pages[0].response.d[0].InIndex = 2615;
    }),
    copy('bing-webmaster/ai-overview/2026-09-01.json', 'extra/bing-ai-overview-2026-09-01.json', (archive) => {
      archive.pages[0].response.rows[1].citations = 11050;
    }),
    copy('posthog/web-daily/2026-09-21.json', 'extra/posthog-web-daily-2026-09-21.json', (archive) => {
      archive.pages[0].response.rows[3].pageviews += 100;
    }),
    // A country day delivered twice, read before the original.
    copy('gsc/country/2026-09-20.json', 'extra/gsc-country-2026-09-20.json'),
    // A later re-pull of a country day with revised figures, read after it.
    copy('gsc/country/2026-09-18.json', 'late/gsc-country-2026-09-18.json', (archive) => {
      archive.collectedAt = '2026-09-22T12:15:00.000Z';
      for (const row of archive.pages[0].response.rows) row.clicks += 2;
    }),
  ];
}

/** The manifest.json beside the fixture's archives. */
export function fixtureManifest() {
  const row = (integration, report, reportDate, finishedAt) => ({
    integration, report, reportDate, objectKey: `raw/${integration}/${report}/${reportDate}.json.gz`, finishedAt,
  });
  return {
    downloadedAt: '2026-09-22T05:00:00.000Z',
    source: 'panel-refresh',
    asset: FIXTURE_ASSET,
    objects: [
      // The unchanged D+2 collection that settled 09-18.
      row('ga4', 'traffic-acquisition', '2026-09-18', '2026-09-20T12:16:02.000Z'),
      row('ga4', 'traffic-acquisition', '2026-09-20', '2026-09-21T12:16:02.000Z'),
      // A confirmation older than the archive's own collection.
      row('ga4', 'traffic-sources', '2026-09-20', '2026-09-21T12:16:02.000Z'),
      // A report day with no archive on disk.
      row('ga4', 'traffic-acquisition', '2026-09-17', '2026-09-19T12:16:02.000Z'),
      // No finish time: not a confirmation.
      { integration: 'ga4', report: 'landing-page-acquisition', reportDate: '2026-09-20' },
    ],
  };
}

/** Every archive of the fixture, as [relative path, archive] pairs. */
export function fixtureArchives() {
  const archives = [
    ...gscArchives(),
    ...ga4Archives(),
    ...bingArchives(),
    ...clarityArchives(),
    ...posthogArchives(),
    ...dataForSeoArchives(),
  ];
  return [...archives, ...duplicateDeliveries(archives)];
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

/** Write the whole fixture into `dir` (created). */
export async function writeArchiveFixture(dir) {
  for (const [relative, archive] of fixtureArchives()) await writeJson(path.join(dir, relative), archive);
  await writeJson(path.join(dir, 'manifest.json'), fixtureManifest());
  // Not archives: never read.
  await fs.writeFile(path.join(dir, 'notes.txt'), 'hand-assembled for the proofs\n');
  await fs.writeFile(path.join(dir, 'gsc', 'query', '2026-09-04.json.gz'), 'not json');
}

/**
 * One GSC page-query archive per day for `count` days ending 2026-09-21, each
 * `rows` rows — a retained history that grows by one report day at a time.
 * Every value is a function of its day and row, so any two runs over the same
 * `count` read the same archive.
 */
export async function writeGrowingArchive(dir, count, rows = 200) {
  const first = new Date(Date.parse('2026-09-21T00:00:00.000Z') - (count - 1) * 86_400_000);
  for (const [dayIndex, reportDate] of days(first.toISOString().slice(0, 10), count).entries()) {
    const archive = envelope('gsc', 'page-query', reportDate, {
      dataState: 'provider-final',
      providerRows: rows,
      pages: [{
        request: { dimensions: ['page', 'query'] },
        response: {
          rows: Array.from({ length: rows }, (_, index) => gscRow(
            [`https://meals.example/page-${index % 50}`, `query ${index}`],
            dayIndex,
            index,
          )),
        },
      }],
    });
    await writeJson(path.join(dir, 'gsc', 'page-query', `${reportDate}.json`), archive);
  }
}

/** The frozen value-event declarations every archive proof reads (bead ro-ujb9.97). */
export async function fixtureValueEvents() {
  return {
    body: JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'scripts', 'fixture-config', 'value-events.json'), 'utf8')),
    version: 1,
  };
}
