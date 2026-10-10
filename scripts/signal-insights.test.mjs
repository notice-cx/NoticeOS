import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutiveSnapshot,
  claritySnapshot,
  buildSearchPageTrends,
  buildSearchQueryTrends,
} from './signal-insights.mjs';

const clarityRow = (over = {}) => ({ asset: 'meals.example', report_date: '2026-09-21',
  collected_at: '2026-09-21T12:00:00.000Z', provider_truncated: false,
  metric: 'ScriptErrorCount', url: 'https://meals.example/planner', sessions_count: '114', sub_total: '19', ...over });
const clarityOf = (input, archives = []) => claritySnapshot('meals.example', new Map([['clarity-url-3d', input]]), archives);

test('Clarity Overview keeps one named page and one unattributed bucket, never an inferred site audience', () => {
  const block = clarityOf([clarityRow(), clarityRow({ url: 'https://meals.example/recipes', sub_total: '4', sessions_count: '12' }),
    clarityRow({ metric: 'Traffic', url: '', total_session_count: '0' }),
    clarityRow({ metric: 'Traffic', url: 'https://meals.example/planner', total_session_count: '400' })]);
  assert.deepEqual(block, { source: 'clarity', reportDate: '2026-09-21', collectedAt: '2026-09-21T12:00:00.000Z',
    windowHours: 72, truncated: false, page: { url: 'https://meals.example/planner', sessions: 114, scriptErrors: 19 }, unattributedSessions: 0 });
});

test('Clarity Overview selects one latest collection, not overlapping snapshots or same-day revisions added together', () => {
  const block = clarityOf([clarityRow({ report_date: '2026-09-20', sub_total: '999' }), clarityRow({ sub_total: '900' }),
    clarityRow({ collected_at: '2026-09-21T15:00:00.000Z', sessions_count: '0', sub_total: '0', provider_truncated: true })]);
  assert.deepEqual(block.page, { url: 'https://meals.example/planner', sessions: 0, scriptErrors: 0 });
  assert.equal(block.collectedAt, '2026-09-21T15:00:00.000Z');
  assert.equal(block.truncated, true);
});

test('Clarity Overview does not reuse older facts after the latest empty export', () => {
  const block = clarityOf([clarityRow()], [{ integration: 'clarity', report: 'url-3d', reportDate: '2026-09-21',
    collectedAt: '2026-09-21T16:00:00.000Z', flattenedRows: 0, providerTruncated: true }]);
  assert.equal(block.page, null); assert.equal(block.unattributedSessions, null);
  assert.equal(block.collectedAt, '2026-09-21T16:00:00.000Z'); assert.equal(block.truncated, true);
});

test('Clarity Overview withholds old facts when a same-day report has no usable collection timestamp', () => {
  for (const collectedAt of [undefined, null, '', 'not-a-date']) {
    const block = clarityOf([clarityRow()], [{ integration: 'clarity', report: 'url-3d', reportDate: '2026-09-21',
      collectedAt, flattenedRows: 0, providerTruncated: false }]);
    assert.equal(block.collectedAt, null);
    assert.equal(block.page, null);
    assert.equal(block.unattributedSessions, null);
  }
});

test('Clarity Overview withholds duplicate rows, malformed counts and unsafe page selectors', () => {
  for (const count of ['', '-1', '1.5', 'Infinity', '0x10', true, {}, 9007199254740992]) {
    const block = clarityOf([clarityRow({ sessions_count: count, sub_total: count })]);
    assert.equal(block.page, null);
  }
  const block = clarityOf([clarityRow(), clarityRow(), clarityRow({ metric: 'Traffic', url: '', total_session_count: '7' }),
    clarityRow({ metric: 'Traffic', url: '', total_session_count: '7' }), clarityRow({ url: 'javascript:alert(1)' }),
    clarityRow({ url: 'https://user:password@meals.example/planner' }), clarityRow({ asset: 'other.example' })]);
  assert.equal(block.page, null); assert.equal(block.unattributedSessions, null);
  assert.equal(clarityOf([]), null);
  assert.equal(clarityOf([clarityRow({ report_date: '2026-99-99' })]), null);
});

test('Clarity Overview preserves a missing metric as unknown beside an explicitly reported zero', () => {
  const block = clarityOf([clarityRow({ sessions_count: '', sub_total: '0' })]);
  assert.deepEqual(block.page, { url: 'https://meals.example/planner', sessions: null, scriptErrors: 0 });
});

/** Consecutive reported dates, the grain every flattened family carries. */
function reportedDates(count, start = 1) {
  return Array.from({ length: count }, (_, index) =>
    `2026-07-${String(start + index).padStart(2, '0')}`,
  );
}

function cardFor(families, key, asset = 'meals.example') {
  return buildExecutiveSnapshot({
    asset,
    families,
    archives: [{}],
  }).items.find((item) => item.key === key);
}

test('builds bounded evidence findings and never treats missing reports as deprecation evidence', () => {
  const base = {
    report_date: '2026-07-28',
    collected_at: '2026-07-29T12:15:00.000Z',
  };
  const families = new Map([
    [
      'gsc-page-query',
      [
        {
          ...base,
          page: 'https://meals.example/meal-plan',
          query: 'weekly meal plan',
          impressions: 700,
          clicks: 21,
          ctr: 0.03,
          position: 6,
        },
      ],
    ],
    [
      'gsc-search-appearance-pages',
      [
        {
          ...base,
          row_grain: 'searchAppearance',
          searchAppearance: 'RECIPE_FEATURE',
          impressions: 900,
          clicks: 45,
          ctr: 0.05,
          position: 4,
        },
        {
          ...base,
          row_grain: 'page',
          searchAppearance: 'RECIPE_FEATURE',
          page: 'https://meals.example/recipes/soup',
          impressions: 8000,
          clicks: 800,
          ctr: 0.1,
          position: 2,
        },
      ],
    ],
    [
      'ga4-page-events',
      [
        {
          ...base,
          unifiedPagePathScreen: '/calculator',
          eventName: 'js_error',
          eventCount: 60,
          totalUsers: 40,
          keyEvents: 0,
        },
        {
          ...base,
          unifiedPagePathScreen: '/calculator',
          eventName: 'page_view',
          eventCount: 600,
          totalUsers: 500,
          keyEvents: 0,
        },
        {
          ...base,
          unifiedPagePathScreen: '/calculator',
          eventName: 'calculation_complete',
          eventCount: 150,
          totalUsers: 100,
          keyEvents: 20,
        },
      ],
    ],
    [
      'bing-webmaster-queries',
      [
        {
          ...base,
          provider_date: '2026-07-27',
          query: 'weekly meal plan',
          impressions: 140,
          clicks: 7,
          avg_impression_position: 8,
        },
      ],
    ],
    [
      'bing-webmaster-crawl-issues',
      [
        {
          ...base,
          url: 'https://meals.example/old-plan',
          http_code: 404,
          issues: 4,
          issue_names: 'Code4xx',
          in_links: 3,
        },
      ],
    ],
  ]);

  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}, {}, {}],
    generatedAt: '2026-07-29T13:00:00.000Z',
  });
  assert.equal(snapshot.items[0].kind, 'warning');
  assert.equal(snapshot.items[0].key, 'javascript-errors');
  assert.equal(
    snapshot.items.find((item) => item.key === 'bing-crawl-issues')?.primary.value,
    '1',
  );
  assert.match(
    snapshot.items.find((item) => item.key === 'bing-search-opportunity')?.summary,
    /\/meal-plan is the matching Google-visible page/,
  );
  assert.equal(
    snapshot.items.find((item) => item.key === 'bing-search-opportunity')?.windowStart,
    '2026-07-27',
  );
  assert.equal(
    snapshot.items.find((item) => item.key === 'search-striking-distance')?.primary.value,
    '700',
  );
  assert.equal(
    snapshot.items.find((item) => item.key === 'search-appearance-leader')?.primary.value,
    '900',
    'page-detail rows are not added to search-appearance totals',
  );
  assert.ok(
    snapshot.methodology.some((line) => line.includes('Missing provider rows remain unknown')),
  );
  assert.ok(
    snapshot.methodology.some((line) => line.includes('latest snapshot')),
  );
  assert.ok(
    snapshot.items.every(
      (item) =>
        item.sources.length > 0 &&
        item.evidence.length > 0 &&
        item.caveat.length > 0,
    ),
  );
  assert.ok(
    snapshot.items.every((item) => !item.title.toLowerCase().includes('deprecat')),
  );
});

test('uses only the latest Bing snapshot instead of adding repeated weekly rows', () => {
  const families = new Map([
    [
      'bing-webmaster-queries',
      [
        {
          report_date: '2026-07-27',
          query: 'healthy recipes',
          impressions: 500,
          clicks: 10,
          avg_impression_position: 9,
        },
        {
          report_date: '2026-07-28',
          query: 'healthy recipes',
          impressions: 520,
          clicks: 12,
          avg_impression_position: 8,
        },
      ],
    ],
  ]);
  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}, {}],
  });
  const item = snapshot.items.find(
    (candidate) => candidate.key === 'bing-search-opportunity',
  );
  assert.equal(item?.primary.value, '520');
  assert.equal(item?.windowStart, '2026-07-28');
  assert.equal(item?.windowEnd, '2026-07-28');
});

test('compares stored DataForSEO snapshots and summarizes current search intelligence', () => {
  const families = new Map([
    [
      'dataforseo-ranked-keywords',
      [
        {
          report_date: '2026-07-21',
          keyword: 'weekly meal plan',
          url: 'https://meals.example/meal-plan',
          result_type: 'organic',
          rank_group: 14,
          search_volume: 500,
          keyword_difficulty: 30,
          cpc: 2,
          etv: 10,
          provider_cost_usd: 0.011,
        },
        {
          report_date: '2026-07-28',
          keyword: 'weekly meal plan',
          url: 'https://meals.example/meal-plan',
          result_type: 'organic',
          rank_group: 7,
          search_volume: 500,
          keyword_difficulty: 30,
          cpc: 2,
          etv: 25,
          intent: 'informational',
          serp_features: 'organic|ai_overview',
          provider_cost_usd: 0.011,
        },
        {
          report_date: '2026-07-28',
          keyword: 'healthy meal ideas',
          url: 'https://meals.example/healthy-meals',
          result_type: 'ai_overview_reference',
          rank_group: 2,
          search_volume: 900,
          keyword_difficulty: 38,
          intent: 'informational',
          provider_cost_usd: 0.011,
        },
      ],
    ],
    [
      'dataforseo-backlinks-summary',
      [
        {
          report_date: '2026-07-28',
          rank: 400,
          backlinks: 800,
          referring_domains: 240,
          provider_cost_usd: 0.02,
        },
      ],
    ],
    [
      'dataforseo-backlinks-new-lost',
      [
        {
          report_date: '2026-07-28',
          provider_date: '2026-08-02',
          new_referring_domains: 8,
          lost_referring_domains: 2,
          provider_cost_usd: 0.02,
        },
      ],
    ],
    [
      'dataforseo-llm-mentions-google',
      [
        {
          report_date: '2026-07-28',
          row_grain: 'platform-summary',
          mentions: 7,
          ai_search_volume: 900,
          provider_cost_usd: 0.1,
        },
      ],
    ],
    [
      'dataforseo-llm-mentions-chatgpt',
      [
        {
          report_date: '2026-07-28',
          row_grain: 'platform-summary',
          mentions: 4,
          ai_search_volume: 600,
          provider_cost_usd: 0.1,
        },
      ],
    ],
  ]);
  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}, {}, {}, {}, {}, {}],
  });
  const gain = snapshot.items.find(
    (item) => item.key === 'dataforseo-ranking-gain',
  );
  assert.equal(gain?.primary.value, '↑ 7');
  assert.match(gain?.summary ?? '', /stored weekly snapshots/);
  assert.equal(snapshot.searchIntelligence.rankings.top10, 1);
  assert.equal(snapshot.searchIntelligence.backlinks.referringDomains, 240);
  assert.equal(snapshot.searchIntelligence.ai.googleMentions, 7);
  assert.equal(snapshot.searchQueries.dataforseo.observedAt, '2026-07-28');
  assert.equal(
    snapshot.searchQueries.dataforseo.queries.find(
      (row) => row.query === 'weekly meal plan',
    ).positionImprovement,
    7,
  );
  assert.deepEqual(
    snapshot.searchQueries.dataforseo.queries.find(
      (row) => row.query === 'healthy meal ideas',
    ),
    {
      query: 'healthy meal ideas',
      monthlySearches: 900,
      organicPosition: null,
      previousOrganicPosition: null,
      positionImprovement: null,
      keywordDifficulty: 38,
      estimatedVisits: null,
      page: '/healthy-meals',
      intent: 'informational',
      aiOverview: 'cited',
      aiCitationPosition: 2,
      // No panel in this fixture: no device read this term at all, which is
      // unknown — never "no overview", and never a device row full of nulls.
      aioDevices: [],
    },
  );
  const backlinks = snapshot.items.find(
    (item) => item.key === 'dataforseo-backlink-growth',
  );
  assert.equal(
    backlinks?.windowEnd,
    '2026-07-28',
    'a provider week ending in the future is capped at the stored snapshot date',
  );
  assert.ok(
    snapshot.methodology.some((line) =>
      line.includes('without repulling it'),
    ),
  );
});

test('joins tracked-panel AI Overview evidence onto the queries it covers, and only those', () => {
  const rankedRow = (keyword, searchVolume) => ({
    report_date: '2026-07-28',
    keyword,
    url: `https://meals.example/${keyword.replaceAll(' ', '-')}`,
    result_type: 'organic',
    rank_group: 6,
    search_volume: searchVolume,
    keyword_difficulty: 20,
    intent: 'informational',
    provider_cost_usd: 0.011,
  });
  const panelRow = (query, aioPresent, aioCitesUs, device = 'desktop') => ({
    report_date: '2026-07-28',
    row_grain: 'tracked-query-device',
    query,
    device,
    best_rank: 6,
    aio_present: aioPresent,
    aio_cites_us: aioCitesUs,
    provider_cost_usd: 0.004,
  });
  const families = new Map([
    [
      'dataforseo-ranked-keywords',
      [
        rankedRow('walled term', 900),
        rankedRow('cited term', 800),
        rankedRow('clear term', 700),
        rankedRow('unreadable term', 600),
        rankedRow('untracked term', 500),
        rankedRow('split term', 400),
      ],
    ],
    [
      'dataforseo-serp-panel',
      [
        // Casing and padding differ from the ranking inventory's spelling: the
        // join is on the normalized query, same as every other query merge.
        panelRow('  Walled Term ', true, false),
        panelRow('cited term', true, true),
        panelRow('clear term', false, false),
        // The asynchronous overview never loaded. Empty cells stay unknown.
        panelRow('unreadable term', '', ''),
        // On the panel but outside the ranking inventory: the panel is
        // additive, so this contributes no row of its own.
        panelRow('panel only term', true, true),
        // The pair the second device was bought for: an overview consumes the
        // click on the phone and there is none on the desktop. Written desktop
        // first, so a reader that carried both cannot be passing by luck of
        // collection order.
        panelRow('split term', false, false, 'desktop'),
        panelRow('split term', true, false, 'mobile'),
        // A row from before the collector sent a device. Desktop by
        // construction, never an unnamed surface.
        panelRow('legacy term', true, true, ''),
      ],
    ],
  ]);

  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}, {}],
  });
  const byQuery = new Map(
    snapshot.searchQueries.dataforseo.queries.map((row) => [row.query, row]),
  );
  assert.equal(byQuery.size, 6, 'the panel adds no queries of its own');
  assert.equal(byQuery.has('panel only term'), false);
  assert.deepEqual(
    ['walled term', 'cited term', 'clear term', 'unreadable term', 'untracked term'].map(
      (query) => byQuery.get(query).aioDevices,
    ),
    [
      [{ device: 'desktop', aioPresent: true, aioCitesUs: false }],
      [{ device: 'desktop', aioPresent: true, aioCitesUs: true }],
      [{ device: 'desktop', aioPresent: false, aioCitesUs: false }],
      [{ device: 'desktop', aioPresent: null, aioCitesUs: null }],
      // Not on the panel at all: no reading, not a reading of nulls.
      [],
    ],
  );
  // The disagreeing pair reaches the row as BOTH states, phone first — one
  // reading per surface, and neither stands for the other.
  assert.deepEqual(byQuery.get('split term').aioDevices, [
    { device: 'mobile', aioPresent: true, aioCitesUs: false },
    { device: 'desktop', aioPresent: false, aioCitesUs: false },
  ]);
  assert.match(
    snapshot.searchQueries.dataforseo.caveat,
    /dataforseo\/serp-panel panel observed 2026-07-28, read on each device separately/,
  );
  assert.doesNotMatch(
    snapshot.searchQueries.dataforseo.caveat,
    /desktop panel/,
  );
  // An archive that names no device is desktop, never blank: the collector
  // wrote one device literal before it sent a device, so no stored row can be
  // else.
  assert.deepEqual(
    snapshot.serpPanel.queries.find((row) => row.query === 'legacy term').device,
    'desktop',
  );
  // Each panel row is its own metered call — BOTH devices are billed, so panel
  // cost adds per row rather than per term. Halving it would put a wrong number
  // on a rendered surface.
  assert.ok(
    Math.abs(snapshot.searchIntelligence.costUsd - (0.011 + 8 * 0.004)) < 1e-9,
  );
});

test('carries the whole tracked panel in the snapshot, and no block without one', () => {
  const panelRow = (query, overrides = {}) => ({
    report_date: '2026-07-28',
    row_grain: 'tracked-query-device',
    query,
    device: 'desktop',
    tracked_depth: 20,
    best_rank: '',
    best_url: '',
    second_rank: '',
    second_url: '',
    aio_present: '',
    aio_cites_us: '',
    top3_domains: '',
    organic_results: '',
    serp_features: '',
    provider_cost_usd: 0.004,
    ...overrides,
  });
  const families = new Map([
    [
      'dataforseo-serp-panel',
      [
        // An earlier run of the same panel: a weekly family is revised, never
        // added up, so only the latest snapshot describes the panel today.
        panelRow('cited term', { report_date: '2026-07-21', best_rank: 9 }),
        // The cluster this query measures, as the collection recorded it. A
        // mixed panel is normal input: this one term carries a label and the
        // rest do not.
        panelRow('cited term', {
          query_label: '  Calculator seam ',
          best_rank: 3,
          best_url: 'https://meals.example/cited',
          second_rank: 8,
          second_url: 'https://meals.example/second',
          aio_present: true,
          aio_cites_us: true,
          top3_domains: 'usda.gov|meals.example|healthline.com',
          organic_results: 18,
          serp_features: 'images|people_also_ask',
        }),
        // Ranks nowhere inside the depth the run paid for. Null, never zero and
        // never "does not rank".
        panelRow('walled term', {
          aio_present: true,
          aio_cites_us: false,
          top3_domains: 'reddit.com|nih.gov|wikipedia.org',
          organic_results: 20,
          serp_features: 'ai_overview|people_also_ask',
        }),
        // Billed, unanswered after the bounded retry ladder: every observation
        // stays unknown and the panel carries its settled degradation.
        panelRow('unreadable term', {
          provider_status: 'Internal SE Server Error.',
          provider_attempts: 3,
        }),
        // The same term on both surfaces — two observations of two different
        // result pages, so two rows that never merge here. The Tower groups
        // them back into one term for every count it states.
        panelRow('split term', {
          device: 'mobile',
          best_rank: '',
          aio_present: true,
          aio_cites_us: false,
          top3_domains: 'calculator.net|omnicalculator.com|meals.gov',
          organic_results: 19,
          serp_features: 'ai_overview',
        }),
        panelRow('split term', {
          device: 'desktop',
          best_rank: 4,
          best_url: 'https://meals.example/split',
          aio_present: false,
          aio_cites_us: false,
          top3_domains: 'meals.example|calculator.net|healthline.com',
          organic_results: 20,
          serp_features: 'images',
        }),
      ],
    ],
    // Deliberately no ranked-keyword family: the block is the whole panel, not
    // the intersection the enrichment join produces.
    ['gsc-page-query', []],
  ]);

  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}],
  });
  assert.equal(snapshot.serpPanel.reportDate, '2026-07-28');
  assert.equal(snapshot.serpPanel.trackedDepth, 20);
  // A site that saved no market: the block names none.
  assert.equal(snapshot.serpPanel.market, null);
  // A site that saved one: the block carries it, for the Tower's caption.
  const uk = { locationCode: 2826, languageCode: 'en' };
  assert.deepEqual(
    buildExecutiveSnapshot({ asset: 'meals.example', families, archives: [{}], market: uk }).serpPanel.market,
    uk,
  );
  assert.deepEqual(snapshot.serpPanel.queries, [
    {
      query: 'cited term',
      device: 'desktop',
      label: 'Calculator seam',
      bestRank: 3,
      bestUrl: 'https://meals.example/cited',
      aioPresent: true,
      aioCitesUs: true,
      composition: {
        top3Domains: ['usda.gov', 'meals.example', 'healthline.com'],
        organicResults: 18,
        secondRank: 8,
        secondUrl: 'https://meals.example/second',
        serpFeatures: ['images', 'people_also_ask'],
      },
    },
    {
      query: 'walled term',
      device: 'desktop',
      label: null,
      bestRank: null,
      bestUrl: null,
      aioPresent: true,
      aioCitesUs: false,
      composition: {
        top3Domains: ['reddit.com', 'nih.gov', 'wikipedia.org'],
        organicResults: 20,
        secondRank: null,
        secondUrl: null,
        serpFeatures: ['ai_overview', 'people_also_ask'],
      },
    },
    {
      query: 'unreadable term',
      device: 'desktop',
      label: null,
      bestRank: null,
      bestUrl: null,
      aioPresent: null,
      aioCitesUs: null,
      composition: null,
      providerStatus: 'Internal SE Server Error.',
      providerAttempts: 3,
    },
    // One term, two devices, two rows: walled on the phone and clear on the
    // desktop. A block that kept one row per term would have reported whichever
    // surface its tie-break landed on.
    {
      query: 'split term',
      device: 'mobile',
      label: null,
      bestRank: null,
      bestUrl: null,
      aioPresent: true,
      aioCitesUs: false,
      composition: {
        top3Domains: ['calculator.net', 'omnicalculator.com', 'meals.gov'],
        organicResults: 19,
        secondRank: null,
        secondUrl: null,
        serpFeatures: ['ai_overview'],
      },
    },
    {
      query: 'split term',
      device: 'desktop',
      label: null,
      bestRank: 4,
      bestUrl: 'https://meals.example/split',
      aioPresent: false,
      aioCitesUs: false,
      composition: {
        top3Domains: ['meals.example', 'calculator.net', 'healthline.com'],
        organicResults: 20,
        secondRank: null,
        secondUrl: null,
        serpFeatures: ['images'],
      },
    },
  ]);

  assert.equal(
    'serpPanel' in
      buildExecutiveSnapshot({
        asset: 'meals.example',
        families: new Map([['gsc-page-query', []]]),
        archives: [{}],
      }),
    false,
    'no panel is a missing key, not an empty scoreboard',
  );
});

test('excludes GA4 not-set values from the leading AI landing-page claim', () => {
  const families = new Map([
    [
      'ga4-landing-page-acquisition',
      [
        {
          report_date: '2026-07-28',
          sessionDefaultChannelGroup: 'AI Assistant',
          sessionSourceMedium: 'chatgpt.com / ai-assistant',
          landingPage: '(not set)',
          sessions: 20,
          keyEvents: 0,
        },
        {
          report_date: '2026-07-28',
          sessionDefaultChannelGroup: 'AI Assistant',
          sessionSourceMedium: 'chatgpt.com / ai-assistant',
          landingPage: '/calculator',
          sessions: 4,
          keyEvents: 1,
        },
      ],
    ],
  ]);
  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}],
  });
  const item = snapshot.items.find((candidate) => candidate.key === 'ai-referral-floor');
  assert.match(item.summary, /\/calculator was the most common identified landing page/);
  assert.doesNotMatch(item.summary, /\(not set\)/);
});

const formerProductStages = [
  {
    "eventName": "builder_item_open",
    "label": "Opened an item",
    "group": "primary"
  },
  {
    "eventName": "builder_add_to_order",
    "label": "Added to an order",
    "group": "primary",
    "compareTo": "builder_item_open",
    "comparisonLabel": "Added of opened"
  },
  {
    "eventName": "order_share_open",
    "label": "Opened sharing",
    "group": "sharing"
  },
  {
    "eventName": "order_share_complete",
    "label": "Completed a share",
    "group": "sharing"
  },
  {
    "eventName": "builder_deeplink_arrival",
    "label": "Opened an order link",
    "group": "sharing"
  },
  {
    "eventName": "guide_next_click",
    "label": "Followed a guide",
    "group": "supporting"
  },
  {
    "eventName": "builder_search",
    "label": "Searched a builder",
    "group": "supporting"
  },
  {
    "eventName": "view_search_results",
    "label": "Used site search",
    "group": "supporting"
  },
  {
    "eventName": "affiliate_click",
    "label": "Clicked an affiliate",
    "group": "supporting"
  }
];
const stagesFor = (asset) => ({ assets: { [asset]: { productUseStages: formerProductStages } } });

test('preserves former Product use counts, labels and comparison with a saved declaration', () => {
  const families = new Map([
    [
      'ga4-events-28d',
      [
        {
          report_date: '2026-07-28',
          window_start: '2026-07-01',
          window_end: '2026-07-28',
          eventName: 'builder_item_open',
          eventCount: 999,
          totalUsers: 999,
        },
        {
          report_date: '2026-07-29',
          window_start: '2026-07-02',
          window_end: '2026-07-29',
          eventName: 'builder_item_open',
          eventCount: 649,
          totalUsers: 233,
        },
        {
          report_date: '2026-07-29',
          window_start: '2026-07-02',
          window_end: '2026-07-29',
          eventName: 'builder_add_to_order',
          eventCount: 179,
          totalUsers: 85,
        },
        {
          report_date: '2026-07-29',
          window_start: '2026-07-02',
          window_end: '2026-07-29',
          eventName: 'order_share_open',
          eventCount: 1,
          totalUsers: 1,
        },
        {
          report_date: '2026-07-29',
          window_start: '2026-07-02',
          window_end: '2026-07-29',
          eventName: 'builder_deeplink_arrival',
          eventCount: 10,
          totalUsers: 9,
        },
      ],
    ],
  ]);

  const snapshot = buildExecutiveSnapshot({
    asset: 'orders.example',
    valueEvents: stagesFor('orders.example'),
    families,
    archives: [{}, {}],
  });
  assert.equal(snapshot.productUse.days, 28);
  assert.equal(snapshot.productUse.windowStart, '2026-07-02');
  assert.equal(snapshot.productUse.build[0].users, 233);
  assert.equal(snapshot.productUse.build[1].users, 85);
  assert.equal(snapshot.productUse.sharing[0].users, 1);
  assert.equal(
    snapshot.productUse.sharing[1].users,
    null,
    'a missing GA4 event row remains absent rather than becoming a numeric zero',
  );
  assert.equal(snapshot.productUse.sharing[2].users, 9);
  const metrics = [...snapshot.productUse.build, ...snapshot.productUse.sharing, ...snapshot.productUse.supporting];
  assert.deepEqual(metrics.map(({ eventName, label }) => ({ eventName, label })), formerProductStages.map(({ eventName, label }) => ({ eventName, label })));
  assert.deepEqual(metrics.map(({ users }) => users), [233, 85, 1, null, 9, null, null, null, null]);
  assert.equal(Math.round(snapshot.productUse.build[1].users / snapshot.productUse.build[0].users * 100), 36);
  assert.equal(snapshot.productUse.build[1].comparisonLabel, 'Added of opened');
  assert.equal(snapshot.productUse.build[1].compareTo, 'builder_item_open');
  assert.match(snapshot.productUse.caveat, /not a same-person sequence/);
  assert.match(snapshot.productUse.caveat, /does not prove nobody performed the action/);
});

test('Product use follows only the selected asset declaration over retained facts', () => {
  const window = { report_date: '2026-07-29', window_start: '2026-07-02', window_end: '2026-07-29' };
  const families = new Map([['ga4-events-28d', [
    { ...window, eventName: 'document_open', eventCount: 40, totalUsers: 30 },
    { ...window, eventName: 'document_share', eventCount: 0, totalUsers: 0 },
  ]]]);
  const declaration = { assets: { 'example.com': { productUseStages: [
    { eventName: 'document_open', label: 'Opened a document', group: 'primary' },
    { eventName: 'document_share', label: 'Shared a document', group: 'sharing', compareTo: 'document_open', comparisonLabel: 'Shared of opened' },
    { eventName: 'document_search', label: 'Searched documents', group: 'supporting' },
  ] } } };
  const read = (asset, valueEvents = declaration) => buildExecutiveSnapshot({ asset, families, valueEvents, archives: [{}] }).productUse;
  assert.equal(read('other.example'), null, 'another asset cannot adopt a declaration');
  assert.equal(read('example.com', { assets: {} }), null, 'generic defaults select no product events');
  assert.equal(read('example.com').build[0].users, 30);
  assert.equal(read('example.com').sharing[0].users, 0, 'observed zero stays zero');
  assert.equal(read('example.com').supporting[0].users, null, 'absent row is unknown');
  assert.equal(read('example.com').build[0].key, 'document_open');
  assert.equal(read('example.com').sharing[0].compareTo, 'document_open');
  assert.equal(buildExecutiveSnapshot({ asset: 'example.com', families: new Map(), valueEvents: declaration, archives: [{}] }).productUse, null);
});

test('builds page decisions from two complete weeks, joining each page its leading query', () => {
  const dates = reportedDates(14);
  const pageRows = dates.flatMap((report_date, index) => {
    const week = index < 7 ? 'previous' : 'current';
    return [
      // Lost clicks with impressions holding: the recover shape.
      {
        report_date,
        page: 'https://meals.example/calculator',
        clicks: week === 'previous' ? 12 : 3,
        impressions: 400,
        position: 5,
      },
      // Shown far more and taken no more: the harvest shape.
      {
        report_date,
        page: 'https://meals.example/recipes',
        clicks: 1,
        impressions: week === 'previous' ? 100 : 300,
        position: week === 'previous' ? 9 : 7,
      },
      // Reported in the current week only: unknown, never a page that went
      // from zero — GSC page exports are top rows.
      ...(week === 'current'
        ? [
            {
              report_date,
              page: 'https://meals.example/new-page',
              clicks: 40,
              impressions: 900,
              position: 4,
            },
          ]
        : []),
    ];
  });
  const families = new Map([
    ['gsc-page', pageRows],
    [
      'gsc-page-query',
      dates.slice(7).flatMap((report_date) => [
        {
          report_date,
          page: 'https://meals.example/recipes',
          query: 'free meal plans',
          impressions: 30,
          clicks: 0,
          position: 7,
        },
        {
          report_date,
          page: 'https://meals.example/recipes',
          query: 'recipe ideas',
          impressions: 5,
          clicks: 1,
          position: 6,
        },
        // Grounding traffic on the same page: excluded from the join, and the
        // lane states what it removed rather than dropping it in silence.
        {
          report_date,
          page: 'https://meals.example/recipes',
          query: '"1 medium banana" meals',
          impressions: 900,
          clicks: 0,
          position: 3,
        },
      ]),
    ],
    [
      'dataforseo-serp-panel',
      [
        {
          report_date: '2026-07-14',
          query: 'free meal plans',
          device: 'mobile',
          aio_present: 'true',
          aio_cites_us: 'false',
        },
        {
          report_date: '2026-07-14',
          query: 'free meal plans',
          device: 'desktop',
          aio_present: 'false',
          aio_cites_us: 'false',
        },
      ],
    ],
  ]);

  const pages = buildSearchPageTrends(families);
  assert.equal(pages.provider, 'google');
  assert.equal(pages.currentStart, '2026-07-08');
  assert.equal(pages.currentEnd, '2026-07-14');
  assert.equal(pages.previousStart, '2026-07-01');
  assert.equal(pages.previousEnd, '2026-07-07');
  assert.deepEqual(
    pages.pages.map((row) => row.path),
    ['/calculator', '/recipes'],
    'a page reported in only one week is unknown, not a page that appeared from nothing',
  );

  const calculator = pages.pages[0];
  assert.equal(calculator.currentClicks, 21);
  assert.equal(calculator.previousClicks, 84);
  assert.equal(calculator.clickDelta, -63);
  assert.equal(calculator.clickDeltaPercent, -75);
  assert.equal(calculator.currentPosition, 5);
  assert.equal(calculator.positionImprovement, 0);
  assert.equal(
    calculator.leadingQuery,
    null,
    'a page the page/query export does not cover has no leading query, rather than a query it ranks for nothing on',
  );

  const recipes = pages.pages[1];
  assert.equal(recipes.currentImpressions, 2100);
  assert.equal(recipes.previousImpressions, 700);
  assert.equal(recipes.impressionDelta, 1400);
  assert.equal(recipes.clickDelta, 0);
  assert.equal(recipes.leadingQuery.query, 'free meal plans');
  assert.equal(
    recipes.leadingQuery.impressions,
    210,
    'the leading query is the largest by impressions on the decontaminated series — the quoted-literal query is far larger and is not it',
  );
  // The panel reading rides along per device, unfolded: an overview consumes the
  // click on the phone and not on the desktop, and the surface decides.
  assert.deepEqual(recipes.leadingQuery.aioDevices, [
    { device: 'mobile', aioPresent: true, aioCitesUs: false },
    { device: 'desktop', aioPresent: false, aioCitesUs: false },
  ]);

  // The exclusion is stated under its own label, because only the join was
  // decontaminated — the totals above it cannot be.
  const grounding = pages.evidence[0];
  assert.equal(
    grounding.label,
    'Grounding queries excluded from the leading-query join',
  );
  assert.equal(grounding.value, '6,300');
  assert.match(grounding.detail, /are NOT decontaminated/);
  assert.match(pages.caveat, /understates movement at the export boundary/);

  // Fewer than fourteen reported dates cannot support the comparison at all.
  assert.equal(
    buildSearchPageTrends(
      new Map([['gsc-page', pageRows.filter((row) => row.report_date < '2026-07-13')]]),
    ),
    null,
  );
  // A clean series still carries the row, at zero: the check proves it ran.
  const clean = buildSearchPageTrends(
    new Map([
      ['gsc-page', pageRows],
      [
        'gsc-page-query',
        dates.slice(7).map((report_date) => ({
          report_date,
          page: 'https://meals.example/recipes',
          query: 'free meal plans',
          impressions: 30,
          clicks: 0,
          position: 7,
        })),
      ],
    ]),
  );
  assert.equal(clean.evidence[0].value, '0');
  assert.match(clean.evidence[0].detail, /No quoted-literal queries in this window/);
});

test('ranks only queries present in equal comparison windows and keeps providers separate', () => {
  const dates = Array.from({ length: 14 }, (_, index) =>
    `2026-07-${String(index + 1).padStart(2, '0')}`,
  );
  const googleRows = dates.flatMap((report_date, index) => [
    {
      report_date,
      query: 'weekly meal plan',
      impressions: index < 7 ? 10 : 20,
      position: index < 7 ? 8 : 6,
    },
    ...(index >= 7
      ? [
          {
            report_date,
            query: 'new top-row query',
            impressions: 500,
            position: 4,
          },
        ]
      : []),
  ]);
  const bingLatest = dates.map((provider_date, index) => ({
    report_date: '2026-07-28',
    provider_date,
    query: 'weekly meal plan',
    impressions: index < 7 ? 5 : 8,
    avg_impression_position: index < 7 ? 9 : 7,
  }));
  const families = new Map([
    ['gsc-query', googleRows],
    [
      'bing-webmaster-queries',
      [
        {
          report_date: '2026-07-27',
          provider_date: '2026-07-14',
          query: 'weekly meal plan',
          impressions: 9999,
          avg_impression_position: 1,
        },
        ...bingLatest,
      ],
    ],
  ]);

  const trends = buildSearchQueryTrends(families);
  assert.equal(trends.google.daysPerWindow, 7);
  assert.equal(trends.google.movers.length, 1);
  assert.equal(trends.google.movers[0].query, 'weekly meal plan');
  assert.equal(trends.google.movers[0].currentImpressions, 140);
  assert.equal(trends.google.movers[0].previousImpressions, 70);
  assert.equal(trends.google.movers[0].positionImprovement, 2);
  assert.equal(trends.bing.currentStart, '2026-07-08');
  assert.equal(trends.bing.movers[0].currentImpressions, 56);
  assert.equal(trends.bing.movers[0].previousImpressions, 35);
  assert.equal(trends.dataforseo, null);

  const sparse = buildSearchQueryTrends(
    new Map([
      [
        'gsc-query',
        googleRows.filter((row) => row.report_date < '2026-07-14'),
      ],
    ]),
  );
  assert.equal(
    sparse,
    null,
    'fewer than two complete seven-date windows does not support a ranking',
  );
});

test('keeps quoted-literal grounding queries out of both providers movers and says so', () => {
  const dates = reportedDates(14);
  const googleRows = dates.flatMap((report_date, index) => [
    {
      report_date,
      query: 'weekly meal plan',
      impressions: index < 7 ? 10 : 20,
      clicks: index < 7 ? 1 : 2,
      position: index < 7 ? 8 : 6,
    },
    {
      // The largest absolute mover in the series by an order of magnitude, and
      // it never took a click: a machine re-verifying a retrieved claim.
      report_date,
      query: '"1 medium banana" "3/4 cup" meals',
      impressions: index < 7 ? 100 : 300,
      clicks: 0,
      position: 4,
    },
  ]);
  const bingRows = dates.flatMap((provider_date, index) => [
    {
      report_date: '2026-07-28',
      provider_date,
      query: 'weekly meal plan',
      impressions: index < 7 ? 5 : 8,
      clicks: 1,
      avg_impression_position: index < 7 ? 9 : 7,
    },
    {
      // Same signature, same lane, same treatment. Bing's archive measures
      // ~1/1000th of Google's rate for it, but a rate is not a guarantee, and
      // the row is what proves the check ran on this run.
      report_date: '2026-07-28',
      provider_date,
      query: '"1 medium banana" "3/4 cup" meals',
      impressions: index < 7 ? 40 : 120,
      clicks: 0,
      avg_impression_position: 3,
    },
  ]);

  const trends = buildSearchQueryTrends(
    new Map([
      ['gsc-query', googleRows],
      ['bing-webmaster-queries', bingRows],
    ]),
  );
  assert.deepEqual(
    trends.google.movers.map((mover) => mover.query),
    ['weekly meal plan'],
    'the quoted query outranks every real mover on absolute change and must not be one',
  );
  assert.deepEqual(trends.google.evidence, [
    {
      label: 'Grounding queries excluded',
      value: '2,800',
      detail: '93.0% of captured impressions · 1 quoted-literal queries · 0 clicks',
    },
  ]);
  assert.deepEqual(
    trends.bing.movers.map((mover) => mover.query),
    ['weekly meal plan'],
    'the Bing lane reads the same decontaminated series',
  );
  assert.deepEqual(trends.bing.evidence, [
    {
      label: 'Grounding queries excluded',
      value: '1,120',
      detail: '92.5% of captured impressions · 1 quoted-literal queries · 0 clicks',
    },
  ]);

  // Nothing excluded still states the check ran, at zero — on both lanes.
  const clean = buildSearchQueryTrends(
    new Map([
      ['gsc-query', googleRows.filter((row) => !row.query.includes('"'))],
      ['bing-webmaster-queries', bingRows.filter((row) => !row.query.includes('"'))],
    ]),
  );
  const noCheckFired = {
    label: 'Grounding queries excluded',
    value: '0',
    detail: 'No quoted-literal queries in this window',
  };
  assert.deepEqual(clean.google.evidence, [noCheckFired]);
  assert.deepEqual(clean.bing.evidence, [noCheckFired]);
});

test('the Bing exclusion is measured over the ranked snapshot, not the whole revisable archive', () => {
  // The family is a revisable weekly snapshot and every Bing lane reads only its
  // latest `report_date`. If the exclusion counted superseded snapshots too, the
  // evidence row would describe rows nobody ranked — a true number about the
  // wrong population, which is the failure this whole evidence shape exists to
  // prevent.
  const dates = reportedDates(14);
  const snapshot = (report_date, factor) =>
    dates.flatMap((provider_date, index) => [
      {
        report_date,
        provider_date,
        query: 'weekly meal plan',
        impressions: (index < 7 ? 5 : 8) * factor,
        clicks: 1,
        avg_impression_position: 9,
      },
      {
        report_date,
        provider_date,
        query: '"1 medium banana" "3/4 cup" meals',
        impressions: 10 * factor,
        clicks: 0,
        avg_impression_position: 3,
      },
    ]);

  const trends = buildSearchQueryTrends(
    new Map([
      // A superseded snapshot ten times the size of the live one.
      ['bing-webmaster-queries', [...snapshot('2026-07-21', 10), ...snapshot('2026-07-28', 1)]],
    ]),
  );
  assert.deepEqual(trends.bing.evidence, [
    {
      label: 'Grounding queries excluded',
      value: '140',
      detail: '60.6% of captured impressions · 1 quoted-literal queries · 0 clicks',
    },
  ]);
});

// ---------------------------------------------------------------------------
// Rules transferred from a site's manual-analysis history. Each rule is pinned
// firing, silent below its threshold, and silent when its report family is
// absent.
// ---------------------------------------------------------------------------

function acquisitionRows(split, date = '2026-07-28') {
  return Object.entries(split).map(([sessionDefaultChannelGroup, sessions]) => ({
    report_date: date,
    sessionDefaultChannelGroup,
    sessions,
  }));
}

test('warns on single-channel concentration only above the 85% line and the session floor', () => {
  const concentrated = new Map([
    [
      'ga4-traffic-acquisition',
      acquisitionRows({ 'Organic Search': 900, Direct: 60, Referral: 40 }),
    ],
  ]);
  const item = cardFor(concentrated, 'concentration-risk');
  assert.equal(item?.kind, 'warning');
  assert.equal(item.primary.value, '90.0%');
  assert.match(item.summary, /900 of 1,000 sessions/);
  assert.match(item.summary, /85% single-channel line/);
  assert.deepEqual(
    item.evidence.at(-1),
    { label: 'Rule', value: 'concentration-risk', detail: 'rule: concentration-risk' },
  );
  assert.ok(
    item.evidence.some((row) => row.label === 'Direct' && row.value === '60'),
    'the top-three channel split travels with the card',
  );

  assert.equal(
    cardFor(
      new Map([
        [
          'ga4-traffic-acquisition',
          acquisitionRows({ 'Organic Search': 800, Direct: 200 }),
        ],
      ]),
      'concentration-risk',
    ),
    undefined,
    '80% is below the devaluation line and stays quiet',
  );
  assert.equal(
    cardFor(
      new Map([
        [
          'ga4-traffic-acquisition',
          acquisitionRows({ 'Organic Search': 90, Direct: 5 }),
        ],
      ]),
      'concentration-risk',
    ),
    undefined,
    '95 sessions is a sampling artifact, not a portfolio structure claim',
  );
  assert.equal(
    cardFor(new Map(), 'concentration-risk'),
    undefined,
    'a missing traffic-acquisition family is not a concentration finding',
  );
});

test('recommends consolidating a query only when two pages each hold a fifth of real volume', () => {
  const pageQueryRows = (pages, query = 'weekly meal plan') =>
    reportedDates(3).flatMap((report_date) =>
      pages.map(([page, impressions]) => ({
        report_date,
        page,
        query,
        impressions,
        clicks: 1,
        position: 6,
      })),
    );

  const split = new Map([
    [
      'gsc-page-query',
      pageQueryRows([
        ['https://meals.example/', 60],
        ['https://meals.example/meal-plan', 40],
      ]),
    ],
  ]);
  const item = cardFor(split, 'query-cannibalization');
  assert.equal(item?.kind, 'recommendation');
  assert.equal(item.primary.value, '300');
  assert.match(item.title, /2 of the property’s own pages compete/);
  assert.match(item.summary, /300 impressions across 3 reported dates/);
  assert.equal(item.evidence[0].label, '/');
  assert.equal(item.evidence[0].value, '180');
  assert.match(item.evidence[0].detail, /60\.0% of the query/);
  assert.equal(item.evidence.at(-1).detail, 'rule: query-cannibalization');

  assert.equal(
    cardFor(
      new Map([
        [
          'gsc-page-query',
          pageQueryRows([
            ['https://meals.example/', 95],
            ['https://meals.example/meal-plan', 5],
          ]),
        ],
      ]),
      'query-cannibalization',
    ),
    undefined,
    'a 5% second page is a long tail, not a competing page',
  );
  assert.equal(
    cardFor(
      new Map([
        [
          'gsc-page-query',
          pageQueryRows([
            ['https://meals.example/', 15],
            ['https://meals.example/meal-plan', 10],
          ]),
        ],
      ]),
      'query-cannibalization',
    ),
    undefined,
    '75 impressions is below the volume floor worth a canonical decision',
  );
  assert.equal(
    cardFor(new Map(), 'query-cannibalization'),
    undefined,
    'a missing page/query family is not a cannibalization finding',
  );
});

test('reports page-grain click movers from two complete weeks and only above the click floor', () => {
  const pageRows = (perDay) =>
    reportedDates(14).flatMap((report_date, index) =>
      Object.entries(perDay).map(([page, [previous, current]]) => ({
        report_date,
        page,
        clicks: index < 7 ? previous : current,
        impressions: 100,
      })),
    );

  const moved = new Map([
    [
      'gsc-page',
      pageRows({
        'https://meals.example/recipes': [1, 5],
        'https://meals.example/calculator': [6, 2],
      }),
    ],
  ]);
  const item = cardFor(moved, 'page-movers');
  assert.equal(item?.kind, 'insight');
  assert.equal(item.windowStart, '2026-07-01');
  assert.equal(item.windowEnd, '2026-07-14');
  assert.equal(item.primary.value, '+0', 'gains and losses of 28 clicks cancel out');
  assert.match(item.summary, /\/recipes gained 28 clicks/);
  assert.match(item.summary, /\/calculator lost 28/);
  assert.deepEqual(item.evidence[0], {
    label: '/recipes',
    value: '+28 clicks',
    detail: '7 → 35 clicks',
  });
  assert.deepEqual(item.evidence[1], {
    label: '/calculator',
    value: '−28 clicks',
    detail: '42 → 14 clicks',
  });
  assert.equal(item.evidence.at(-1).detail, 'rule: page-movers');

  assert.equal(
    cardFor(
      new Map([['gsc-page', pageRows({ 'https://meals.example/recipes': [2, 3] })]]),
      'page-movers',
    ),
    undefined,
    'seven clicks across a week is weather, not movement',
  );
  const oneWeek = new Map([
    [
      'gsc-page',
      pageRows({ 'https://meals.example/recipes': [1, 5] }).filter(
        (row) => row.report_date <= '2026-07-10',
      ),
    ],
  ]);
  assert.equal(
    cardFor(oneWeek, 'page-movers'),
    undefined,
    'fewer than fourteen reported dates cannot support a week-over-week claim',
  );
  assert.equal(
    cardFor(new Map(), 'page-movers'),
    undefined,
    'a missing page family is not a movement finding',
  );
});

test('warns when attribution is unreliable or a tracked event collapses', () => {
  const eventRows = ([previous, current], eventName = 'form_start') =>
    reportedDates(14).map((report_date, index) => ({
      report_date,
      eventName,
      eventCount: index < 7 ? previous : current,
      totalUsers: 10,
    }));

  const unattributed = new Map([
    [
      'ga4-traffic-acquisition',
      acquisitionRows({ 'Organic Search': 500, Direct: 350, Unassigned: 150 }),
    ],
  ]);
  const shareOnly = cardFor(unattributed, 'measurement-integrity');
  assert.equal(shareOnly?.kind, 'warning');
  assert.equal(shareOnly.title, '15.0% of sessions are unattributed');
  assert.match(shareOnly.summary, /150 of 1,000 sessions \(15\.0%\)/);
  assert.deepEqual(shareOnly.sources, ['ga4/traffic-acquisition']);

  const notSet = new Map([
    [
      'ga4-traffic-sources',
      [
        { report_date: '2026-07-28', sessionSourceMedium: 'google / organic', sessions: 800 },
        { report_date: '2026-07-28', sessionSourceMedium: '(not set)', sessions: 200 },
        { report_date: '2026-07-28', sessionSourceMedium: '(direct) / (none)', sessions: 500 },
      ],
    ],
  ]);
  const mediumShare = cardFor(notSet, 'measurement-integrity');
  assert.equal(mediumShare?.primary.value, '13.3%');
  assert.match(
    mediumShare.evidence[0].detail,
    /\(not set\) source \/ medium/,
    'a real referrer with an unknown medium is not counted as an unattributed session',
  );

  const collapsed = cardFor(
    new Map([['ga4-events', eventRows([150, 5])]]),
    'measurement-integrity',
  );
  assert.equal(collapsed?.title, 'Form Start all but stopped firing');
  assert.equal(collapsed.primary.value, '−96.7%');
  assert.match(collapsed.summary, /form_start fired 35 times/);
  assert.deepEqual(collapsed.sources, ['ga4/events']);
  assert.equal(collapsed.evidence.at(-1).detail, 'rule: measurement-integrity');

  const both = cardFor(
    new Map([
      [
        'ga4-traffic-acquisition',
        acquisitionRows({ 'Organic Search': 500, Direct: 350, Unassigned: 150 }),
      ],
      ['ga4-events', eventRows([150, 5])],
    ]),
    'measurement-integrity',
  );
  assert.equal(both?.title, 'Two measurement faults bound every other number here');
  assert.deepEqual(both.sources, ['ga4/traffic-acquisition', 'ga4/events']);

  assert.equal(
    cardFor(
      new Map([
        [
          'ga4-traffic-acquisition',
          acquisitionRows({ 'Organic Search': 600, Direct: 350, Unassigned: 50 }),
        ],
        ['ga4-events', eventRows([150, 100])],
      ]),
      'measurement-integrity',
    ),
    undefined,
    '5% unattributed and a 33% event dip are both inside normal variation',
  );
  assert.equal(
    cardFor(new Map([['ga4-events', eventRows([50, 1])]]), 'measurement-integrity'),
    undefined,
    'an event that never ran at 100/day cannot evidence tracking breakage',
  );
  assert.equal(
    cardFor(new Map(), 'measurement-integrity'),
    undefined,
    'missing GA4 families are not a measurement finding',
  );
});

// GA4 attribution rows as the analyzer writes them: provisional=1 on a day GA4
// was still attributing when it was collected, 0 once a collection two days
// later confirmed it.
function markedRows(input, provisional) {
  return input.map((row) => ({ ...row, provisional }));
}

function withoutMark(input) {
  return input.map(({ provisional: _provisional, ...row }) => row);
}

const SETTLED_DATES = ['2026-09-17', '2026-09-18', '2026-09-19'];
const UNSETTLED_DATES = ['2026-09-20', '2026-09-21'];
const SETTLED_SPLIT = { 'Organic Search': 900, Direct: 60, Referral: 30, Unassigned: 10 };
// A day as read at D+1, while GA4 was still attributing.
const UNSETTLED_SPLIT = {
  'Organic Search': 1_096,
  'Cross-network': 1_321,
  Direct: 60,
  Unassigned: 3_380,
};

test('a provisional-only attribution spike raises no finding, and settled findings are unchanged', () => {
  const settled = SETTLED_DATES.flatMap((date) =>
    markedRows(acquisitionRows(SETTLED_SPLIT, date), 0),
  );
  const unsettled = UNSETTLED_DATES.flatMap((date) =>
    markedRows(acquisitionRows(UNSETTLED_SPLIT, date), 1),
  );
  const families = new Map([['ga4-traffic-acquisition', [...settled, ...unsettled]]]);
  const unmarked = new Map([
    ['ga4-traffic-acquisition', withoutMark([...settled, ...unsettled])],
  ]);

  // The spike. Read as final, the two unsettled days alone put 46% of sessions
  // in Unassigned and pull organic search under the concentration line.
  assert.equal(
    cardFor(unmarked, 'measurement-integrity')?.title,
    '46.1% of sessions are unattributed',
    'read as final, the unsettled days raise a measurement fault',
  );
  assert.equal(cardFor(unmarked, 'concentration-risk'), undefined);

  assert.equal(
    cardFor(families, 'measurement-integrity'),
    undefined,
    'settled days hold 1% Unassigned: no measurement fault is raised from GA4 processing lag',
  );

  // The settled finding: the card the settled days raise on their own, plus
  // one row naming what was set aside.
  const settledOnly = cardFor(
    new Map([['ga4-traffic-acquisition', settled]]),
    'concentration-risk',
  );
  assert.equal(settledOnly?.primary.value, '90.0%');
  assert.deepEqual(
    settledOnly,
    cardFor(
      new Map([['ga4-traffic-acquisition', withoutMark(settled)]]),
      'concentration-risk',
    ),
    'a provisional=0 mark reads exactly as a row from before the column existed',
  );
  const beside = cardFor(families, 'concentration-risk');
  assert.equal(beside?.windowEnd, '2026-09-19', 'the window ends at the last settled day');
  const setAside = beside.evidence.find((row) => row.label === 'Provisional days set aside');
  assert.equal(setAside?.value, '2');
  assert.match(
    setAside.detail,
    /^2026-09-20, 2026-09-21 — GA4 was still attributing these days when collected/,
  );
  assert.equal(beside.evidence.at(-1).detail, 'rule: concentration-risk');
  assert.deepEqual(
    { ...beside, evidence: beside.evidence.filter((row) => row !== setAside) },
    settledOnly,
    'apart from naming the set-aside days, the finding is the settled days’ own',
  );

  assert.equal(
    cardFor(
      new Map([
        ['ga4-traffic-acquisition', markedRows([...settled, ...unsettled], '')],
      ]),
      'measurement-integrity',
    )?.key,
    'measurement-integrity',
    'an empty mark (collection date unreadable) is not a provisional mark: the row reads as before',
  );
});

test('no attribution rule fires from unsettled days alone', () => {
  const targets = [{ domain: 'genesee.cce.cornell.edu', status: 'clicked' }];
  const unsettledFamilies = (mark) =>
    new Map([
      [
        'ga4-traffic-acquisition',
        mark(UNSETTLED_DATES.flatMap((date) => acquisitionRows(UNSETTLED_SPLIT, date))),
      ],
      [
        'ga4-traffic-sources',
        mark(
          UNSETTLED_DATES.flatMap((date) =>
            trafficSourceRows(
              {
                'google / organic': 1_096,
                '(not set)': 3_380,
                'genesee.cce.cornell.edu / referral': 12,
              },
              date,
            ),
          ),
        ),
      ],
      [
        'ga4-landing-page-acquisition',
        mark(
          UNSETTLED_DATES.map((report_date) => ({
            report_date,
            sessionDefaultChannelGroup: 'AI Assistant',
            sessionSourceMedium: 'chatgpt.com / ai-assistant',
            landingPage: '/calculator',
            sessions: 20,
            keyEvents: 1,
          })),
        ),
      ],
    ]);
  const snapshot = (families) =>
    buildExecutiveSnapshot({
      asset: 'meals.example',
      families,
      archives: [{}],
      reclamationTargets: targets,
    });

  // Every attribution rule fires when the same rows are read as final…
  assert.deepEqual(
    snapshot(unsettledFamilies((input) => input))
      .items.map((item) => item.key)
      .sort(),
    ['ai-referral-floor', 'measurement-integrity', 'reclamation-match'],
  );
  // …and none does while GA4 is still attributing them. CSV-read rows carry the
  // mark as the string '1', which counts the same.
  for (const provisional of [1, '1']) {
    const result = snapshot(unsettledFamilies((input) => markedRows(input, provisional)));
    assert.deepEqual(result.items, [], `provisional=${JSON.stringify(provisional)} raises nothing`);
    assert.deepEqual(result.suppressedItems, []);
  }
});

test('a settled day’s (data not available) sessions count as unattributed, and nothing else moves', () => {
  // GA4 writes `(data not available)` in sessionSourceMedium where it could not
  // attach a source — docs/20 names it beside Unassigned as the settled-day
  // share that says the two-day settle rule is too short.
  const settledSplit = {
    'google / organic': 850,
    '(direct) / (none)': 30,
    '(data not available)': 120,
  };
  const settled = SETTLED_DATES.flatMap((date) =>
    markedRows(trafficSourceRows(settledSplit, date), 0),
  );
  // A day as read at D+1: 1,321 `(data not available)` sessions on a day GA4
  // was still attributing.
  const unsettled = UNSETTLED_DATES.flatMap((date) =>
    markedRows(
      trafficSourceRows(
        { 'google / organic': 1_096, '(data not available)': 1_321, '(not set)': 3_380 },
        date,
      ),
      1,
    ),
  );

  const raised = cardFor(
    new Map([['ga4-traffic-sources', [...settled, ...unsettled]]]),
    'measurement-integrity',
  );
  assert.equal(raised?.title, '12.0% of sessions are unattributed');
  assert.match(
    raised.summary,
    /360 of 3,000 sessions \(12\.0%\) carry no usable acquisition attribution — GA4 reported them as \(data not available\) source \/ medium\./,
    'only the three settled days are counted; the unsettled days’ 11,594 sessions are not',
  );
  assert.deepEqual(raised.evidence[0], {
    label: 'Unattributed sessions',
    value: '360',
    detail: '12.0% of 3,000 · (data not available) source / medium',
  });
  const setAside = raised.evidence.find((row) => row.label === 'Provisional days set aside');
  assert.match(setAside?.detail ?? '', /^2026-09-20, 2026-09-21 — /);
  assert.equal(raised.windowEnd, '2026-09-19', 'the window ends at the last settled day');
  assert.deepEqual(raised.sources, ['ga4/traffic-sources']);

  // The control: the same settled days with a real source in that slot are
  // clean, so it is the `(data not available)` value that raised the card.
  const attributed = SETTLED_DATES.flatMap((date) =>
    markedRows(
      trafficSourceRows(
        { 'google / organic': 850, '(direct) / (none)': 30, 'bing / organic': 120 },
        date,
      ),
      0,
    ),
  );
  assert.equal(
    cardFor(new Map([['ga4-traffic-sources', [...attributed, ...unsettled]]]), 'measurement-integrity'),
    undefined,
    'settled days with no unattributed sessions raise nothing, however many the unsettled days carry',
  );

  // Both values on the same settled days are named together.
  const both = cardFor(
    new Map([
      [
        'ga4-traffic-sources',
        SETTLED_DATES.flatMap((date) =>
          markedRows(
            trafficSourceRows(
              { 'google / organic': 880, '(not set)': 60, '(data not available)': 60 },
              date,
            ),
            0,
          ),
        ),
      ],
    ]),
    'measurement-integrity',
  );
  assert.equal(both?.primary.value, '12.0%');
  assert.equal(
    both.evidence[0].detail,
    '12.0% of 3,000 · (not set) or (data not available) source / medium',
  );

  // Settled-only output for every other row is what it was before: no
  // `(data not available)` session, no change to count, label or evidence.
  const notSetOnly = cardFor(
    new Map([
      [
        'ga4-traffic-sources',
        [
          ...SETTLED_DATES.flatMap((date) =>
            markedRows(
              trafficSourceRows({ 'google / organic': 880, '(not set)': 120 }, date),
              0,
            ),
          ),
          ...unsettled,
        ],
      ],
    ]),
    'measurement-integrity',
  );
  assert.deepEqual(notSetOnly.evidence[0], {
    label: 'Unattributed sessions',
    value: '360',
    detail: '12.0% of 3,000 · (not set) source / medium',
  });
  const unassignedOnly = cardFor(
    new Map([
      [
        'ga4-traffic-acquisition',
        SETTLED_DATES.flatMap((date) =>
          markedRows(acquisitionRows({ 'Organic Search': 880, Unassigned: 120 }, date), 0),
        ),
      ],
    ]),
    'measurement-integrity',
  );
  assert.deepEqual(unassignedOnly.evidence[0], {
    label: 'Unattributed sessions',
    value: '360',
    detail: '12.0% of 3,000 · Unassigned channel',
  });
});

test('recommends a locale review for a country clicking at half the rest-of-property rate', () => {
  const countryRows = (split) =>
    Object.entries(split).map(([country, [impressions, clicks]]) => ({
      report_date: '2026-07-28',
      row_grain: 'country',
      country,
      impressions,
      clicks,
      position: 7,
    }));

  // The shape of the origin case: a 6.5%-share country clicking at just under
  // half the rate the rest of the property earns. Overall CTR here is 1.9%, so
  // comparing against the property total instead would put the gate at 0.97%
  // and miss a 0.97% country by a hair — the comparator has to exclude it.
  const originShape = new Map([
    [
      'gsc-country',
      countryRows({ usa: [26000, 520], deu: [2000, 40], kor: [1950, 19] }),
    ],
    [
      'gsc-page-country',
      [
        {
          report_date: '2026-07-28',
          row_grain: 'page+country',
          country: 'kor',
          page: 'https://meals.example/ko/calculator',
          impressions: 1500,
          clicks: 14,
        },
      ],
    ],
  ]);
  const item = cardFor(originShape, 'query-language-drift');
  assert.equal(item?.kind, 'recommendation');
  assert.equal(item.primary.value, '1.0%');
  assert.match(item.title, /Review the KOR locale: 6\.5% of impressions/);
  assert.match(item.summary, /against the 2\.0% the rest of the property earns/);
  assert.ok(
    item.evidence.some(
      (row) =>
        row.label === 'CTR excluding KOR' &&
        row.value === '2.0%' &&
        row.detail === '560 clicks / 28,000 impressions',
    ),
    'the comparator excludes the country being judged',
  );
  assert.deepEqual(item.sources, ['gsc/country', 'gsc/page-country']);
  assert.ok(
    item.evidence.some(
      (row) => row.label === 'Leading KOR page' && row.value === '/ko/calculator',
    ),
  );
  assert.equal(item.evidence.at(-1).detail, 'rule: query-language-drift');

  assert.equal(
    cardFor(
      new Map([['gsc-country', countryRows({ usa: [8000, 160], kor: [2000, 30] })]]),
      'query-language-drift',
    ),
    undefined,
    'a country clicking above half the rest-of-property rate is not drifting',
  );
  assert.equal(
    cardFor(
      new Map([['gsc-country', countryRows({ usa: [50000, 1000], kor: [1500, 3] })]]),
      'query-language-drift',
    ),
    undefined,
    'a country under 5% of impressions is too small a slice to call a locale problem',
  );
  assert.equal(
    cardFor(
      new Map([['gsc-country', countryRows({ usa: [2000, 40], kor: [500, 1] })]]),
      'query-language-drift',
    ),
    undefined,
    '500 impressions is too few clicks for the ratio to mean anything',
  );
  assert.equal(
    cardFor(new Map(), 'query-language-drift'),
    undefined,
    'a missing country family is not a locale finding',
  );
});

test('recommends a mobile snippet review only when mobile CTR halves desktop above the floor', () => {
  const deviceRows = (split) =>
    Object.entries(split).map(([device, [impressions, clicks]]) => ({
      report_date: '2026-07-28',
      row_grain: 'device',
      device,
      impressions,
      clicks,
      position: 8,
    }));

  const gapped = new Map([
    ['gsc-device', deviceRows({ MOBILE: [20000, 100], DESKTOP: [5000, 100] })],
  ]);
  const item = cardFor(gapped, 'device-ctr-gap');
  assert.equal(item?.kind, 'recommendation');
  assert.equal(item.primary.value, '0.5%');
  assert.match(item.title, /Mobile results click at 0\.5% against desktop’s 2\.0%/);
  assert.equal(item.evidence.at(-1).detail, 'rule: device-ctr-gap');

  assert.equal(
    cardFor(
      new Map([
        ['gsc-device', deviceRows({ MOBILE: [20000, 300], DESKTOP: [5000, 100] })],
      ]),
      'device-ctr-gap',
    ),
    undefined,
    'a mobile CTR above half of desktop is not a presentation gap',
  );
  assert.equal(
    cardFor(
      new Map([
        ['gsc-device', deviceRows({ MOBILE: [20000, 100], DESKTOP: [500, 10] })],
      ]),
      'device-ctr-gap',
    ),
    undefined,
    'a desktop side below the impression floor cannot be the comparison',
  );
  assert.equal(
    cardFor(new Map(), 'device-ctr-gap'),
    undefined,
    'a missing device family is not a CTR finding',
  );
});

test('lists prune candidates only for a property with enough pages and enough window', () => {
  // Thin pages report one impression on their first `thinDates` dates only; a
  // date a page is absent from is unknown, not a zero.
  const pageRows = (pageCount, dateCount, thinDates = 1) =>
    reportedDates(dateCount).flatMap((report_date, dateIndex) =>
      Array.from({ length: pageCount }, (_, index) => ({
        report_date,
        page: `https://meals.example/page-${String(index).padStart(3, '0')}`,
        impressions: index < 40 ? (dateIndex < thinDates ? 1 : 0) : 50,
        clicks: index < 40 ? 0 : 2,
      })),
    );

  const item = cardFor(new Map([['gsc-page', pageRows(120, 14)]]), 'prune-candidates');
  assert.equal(item?.kind, 'discovery');
  assert.equal(item.primary.value, '40');
  assert.match(item.title, /40 reported pages captured almost no search impressions/);
  assert.match(item.summary, /40 of 120 reported pages \(33\.3%\)/);
  assert.match(
    item.summary,
    /also required the page to have no internal links; that half is not in this archive/,
    'the card states the half of the rule it cannot check',
  );
  assert.match(item.caveat, /nothing here is a deprecation recommendation/);
  assert.equal(item.evidence.filter((row) => row.value === '1').length, 5);
  assert.equal(item.evidence.at(-1).detail, 'rule: prune-candidates');

  assert.equal(
    cardFor(new Map([['gsc-page', pageRows(120, 14, 5)]]), 'prune-candidates'),
    undefined,
    'the floor is five impressions across the window, not five on any one date',
  );
  assert.equal(
    cardFor(new Map([['gsc-page', pageRows(50, 14)]]), 'prune-candidates'),
    undefined,
    'below a hundred reported pages an operator reads the list directly',
  );
  assert.equal(
    cardFor(new Map([['gsc-page', pageRows(120, 3)]]), 'prune-candidates'),
    undefined,
    'three reported dates below five impressions is the ordinary long tail',
  );
  assert.equal(
    cardFor(new Map(), 'prune-candidates'),
    undefined,
    'a missing page family is not a prune finding',
  );
});

test('caps the page at eight cards and keeps the most severe ones', () => {
  const families = new Map([
    [
      'ga4-traffic-acquisition',
      acquisitionRows({ 'Organic Search': 860, Unassigned: 110, Direct: 30 }),
    ],
    [
      'ga4-page-events',
      [
        {
          report_date: '2026-07-28',
          unifiedPagePathScreen: '/calculator',
          eventName: 'js_error',
          eventCount: 60,
          totalUsers: 40,
        },
        {
          report_date: '2026-07-28',
          unifiedPagePathScreen: '/calculator',
          eventName: 'calculation_complete',
          eventCount: 150,
          totalUsers: 100,
          keyEvents: 20,
        },
      ],
    ],
    [
      'gsc-page-query',
      [
        {
          report_date: '2026-07-28',
          page: 'https://meals.example/',
          query: 'weekly meal plan',
          impressions: 400,
          clicks: 4,
          position: 6,
        },
        {
          report_date: '2026-07-28',
          page: 'https://meals.example/meal-plan',
          query: 'weekly meal plan',
          impressions: 300,
          clicks: 3,
          position: 7,
        },
      ],
    ],
    [
      'gsc-country',
      [
        { report_date: '2026-07-28', country: 'usa', impressions: 8000, clicks: 160 },
        { report_date: '2026-07-28', country: 'kor', impressions: 2000, clicks: 4 },
      ],
    ],
    [
      'gsc-device',
      [
        { report_date: '2026-07-28', device: 'MOBILE', impressions: 20000, clicks: 100 },
        { report_date: '2026-07-28', device: 'DESKTOP', impressions: 5000, clicks: 100 },
      ],
    ],
    [
      'gsc-image-page-query',
      [
        {
          report_date: '2026-07-28',
          page: 'https://meals.example/recipes/soup',
          query: 'soup',
          impressions: 900,
          clicks: 0,
        },
      ],
    ],
    [
      'gsc-search-appearance-pages',
      [
        {
          report_date: '2026-07-28',
          row_grain: 'searchAppearance',
          searchAppearance: 'RECIPE_FEATURE',
          impressions: 900,
          clicks: 45,
          position: 4,
        },
      ],
    ],
  ]);
  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}],
  });

  assert.equal(snapshot.items.length, 8, 'ten rules fire; the page still shows eight');
  assert.deepEqual(
    snapshot.items.map((item) => item.kind),
    [
      'warning',
      'warning',
      'warning',
      'recommendation',
      'recommendation',
      'recommendation',
      'recommendation',
      'recommendation',
    ],
    'the cut falls from the bottom of the severity order, never the top',
  );
  assert.deepEqual(
    snapshot.items.slice(0, 3).map((item) => item.key),
    ['measurement-integrity', 'concentration-risk', 'javascript-errors'],
    'a broken ruler outranks every finding measured with it',
  );
  assert.ok(
    !snapshot.items.some(
      (item) => item.kind === 'discovery' || item.kind === 'insight',
    ),
    'the search-appearance discovery and the calculation-complete insight are what the cap drops',
  );
  assert.deepEqual(
    snapshot.suppressedItems.map((item) => item.key),
    ['search-appearance-leader', 'feature-usage-calculation_complete'],
    'a card the cut drops is still named: the system may decide not to show it, never not to mention it',
  );
  assert.ok(
    snapshot.suppressedItems.every(
      (item) => item.title.length > 0 && item.kind.length > 0,
    ),
  );
  assert.ok(
    snapshot.items.every((item) => item.evidence.length > 0 && item.caveat.length > 0),
  );
});

// ---------------------------------------------------------------------------
// Guards found wrong on real archive rows. Each one is pinned firing, silent on
// the artifact it recognizes, and silent when its family is absent.
// ---------------------------------------------------------------------------

/** One page/query row per reported date, the grain every GSC rule reads. */
function pageQueryRows(query, pages, dates = 3) {
  return reportedDates(dates).flatMap((report_date) =>
    pages.map(([page, impressions, clicks, position]) => ({
      report_date,
      page,
      query,
      impressions,
      clicks,
      position,
    })),
  );
}

test('sets aside one-SERP-block queries rather than recommending consolidation (F1)', () => {
  // The origin case: byte-identical impressions at the same position with no
  // clicks anywhere — one AI Overview or sitelink block crediting three of the
  // property's URLs at the block's own position.
  const block = new Map([
    [
      'gsc-page-query',
      pageQueryRows('where to find free diet plans', [
        ['https://meals.example/', 142, 0, 1.2],
        ['https://meals.example/calculator', 138, 0, 1.0],
        ['https://meals.example/recipes', 138, 0, 1.0],
      ]),
    ],
  ]);
  assert.equal(
    cardFor(block, 'query-cannibalization'),
    undefined,
    'one block crediting three URLs is not three pages competing',
  );

  // Each half of the guard is sufficient on its own. Divergent counts and
  // positions, but no click anywhere: a block consumed the click inline, so
  // there is none to redistribute.
  assert.equal(
    cardFor(
      new Map([
        [
          'gsc-page-query',
          pageQueryRows('where to find free meal plans', [
            ['https://meals.example/meal-plans', 200, 0, 5.5],
            ['https://meals.example/', 60, 0, 11],
          ]),
        ],
      ]),
      'query-cannibalization',
    ),
    undefined,
    'zero clicks across every competing page is the same artifact by a different signature',
  );

  // Genuinely divergent: two pages, two positions, both taking clicks.
  const genuine = new Map([
    [
      'gsc-page-query',
      pageQueryRows('weekly meal plan', [
        ['https://meals.example/meal-plan', 200, 6, 3],
        ['https://meals.example/recipes', 100, 2, 9],
      ]),
    ],
  ]);
  const item = cardFor(genuine, 'query-cannibalization');
  assert.match(item?.title ?? '', /2 of the property’s own pages compete/);
  assert.ok(
    !item.evidence.some((row) => row.label === 'Single-SERP-block queries set aside'),
    'nothing was set aside, so nothing is claimed to have been',
  );

  // Both shapes present: the block is larger, and the card still recommends the
  // real one while naming what it declined to recommend.
  const mixed = new Map([
    [
      'gsc-page-query',
      [
        ...pageQueryRows('where to find free diet plans', [
          ['https://meals.example/', 142, 0, 1.2],
          ['https://meals.example/calculator', 138, 0, 1.0],
        ]),
        ...pageQueryRows('weekly meal plan', [
          ['https://meals.example/meal-plan', 60, 6, 3],
          ['https://meals.example/recipes', 40, 2, 9],
        ]),
      ],
    ],
  ]);
  const mixedItem = cardFor(mixed, 'query-cannibalization');
  assert.match(mixedItem?.title ?? '', /compete for “weekly meal plan”/);
  const setAside = mixedItem.evidence.find(
    (row) => row.label === 'Single-SERP-block queries set aside',
  );
  assert.equal(setAside?.value, '1');
  assert.match(setAside.detail, /where to find free diet plans/);
  assert.match(setAside.detail, /no clicks on any competing page/);
  assert.match(mixedItem.caveat, /one SERP block/);
});

test('excludes quoted-literal grounding queries from the CTR rules and says so (F2)', () => {
  const families = new Map([
    [
      'gsc-page-query',
      [
        ...pageQueryRows('"1 medium banana" "3/4 cup" meals', [
          ['https://meals.example/recipes/ambrosia', 400, 0, 4.3],
        ]),
        ...pageQueryRows('my plate', [
          ['https://meals.example/', 200, 12, 5.9],
        ]),
      ],
    ],
  ]);
  const item = cardFor(families, 'search-striking-distance');
  assert.match(
    item?.title ?? '',
    /Move “my plate” into the top results/,
    'the quoted query outranks it on impressions and must not be the recommendation',
  );
  assert.ok(
    !item.evidence.some((row) => String(row.value).includes('"3/4 cup"')),
    'nor the runner-up',
  );
  assert.deepEqual(item.evidence.at(-1), {
    label: 'Grounding queries excluded',
    value: '1,200',
    detail: '66.7% of captured impressions · 1 quoted-literal queries · 0 clicks',
  });

  // Nothing excluded still states the check ran, at zero.
  const clean = cardFor(
    new Map([
      ['gsc-page-query', pageQueryRows('my plate', [['https://meals.example/', 200, 12, 5.9]])],
    ]),
    'search-striking-distance',
  );
  assert.deepEqual(clean.evidence.at(-1), {
    label: 'Grounding queries excluded',
    value: '0',
    detail: 'No quoted-literal queries in this window',
  });
});

test('withholds a striking-distance term whose tracked overview does not cite us (F1)', () => {
  const panelRow = (query, aioPresent, aioCitesUs, device = 'desktop') => ({
    report_date: '2026-07-28',
    row_grain: 'tracked-query-device',
    query,
    device,
    best_rank: '',
    aio_present: aioPresent,
    aio_cites_us: aioCitesUs,
    provider_cost_usd: 0.004,
  });
  // The observed zero-click block query outscores the real candidate: it takes
  // no clicks at all, which is exactly what the rule rewards.
  const pageQueries = [
    ...pageQueryRows('where to find free meal plans', [
      ['https://meals.example/meal-plans', 500, 0, 5],
    ]),
    ...pageQueryRows('my plate', [['https://meals.example/', 200, 12, 5.9]]),
  ];
  const panelled = (panelRows) =>
    new Map([
      ['gsc-page-query', pageQueries],
      ['dataforseo-serp-panel', panelRows],
    ]);
  const aiRow = (item) =>
    item.evidence.find((row) => row.label === 'AI Overview on this term');

  // 1. Observed overview, observed non-citation. The largest candidate on the
  // page is withheld, and the card states what it declined to recommend.
  const walled = cardFor(
    panelled([panelRow('where to find free meal plans', true, false)]),
    'search-striking-distance',
  );
  assert.match(
    walled?.title ?? '',
    /Move “my plate” into the top results/,
    'a click consumed inside the block is not an opportunity a title rewrite can take',
  );
  assert.ok(
    !walled.evidence.some((row) =>
      String(row.value).includes('where to find free meal plans'),
    ),
    'nor the runner-up',
  );
  const withheldRow = walled.evidence.find(
    (row) => row.label === 'AI Overview terms withheld',
  );
  assert.equal(withheldRow?.value, '1');
  assert.match(withheldRow.detail, /where to find free meal plans/);
  assert.match(withheldRow.detail, /does not cite this property/);
  assert.deepEqual(walled.sources, ['gsc/page-query', 'dataforseo/serp-panel']);
  assert.match(walled.caveat, /withheld rather than recommended/);

  // 2. The same term with an overview that cites us, and with no overview at
  // all: both are positive observations, and neither withholds.
  for (const [panelRows, expected] of [
    [
      [panelRow('where to find free meal plans', true, true)],
      {
        label: 'AI Overview on this term',
        value: 'Cites this property',
        detail:
          'An AI Overview holds this result page and cites this property · tracked panel observed 2026-07-28',
      },
    ],
    [
      [panelRow('where to find free meal plans', false, false)],
      {
        label: 'AI Overview on this term',
        value: 'None observed',
        detail: 'No AI Overview on the live result page · tracked panel observed 2026-07-28',
      },
    ],
  ]) {
    const item = cardFor(panelled(panelRows), 'search-striking-distance');
    assert.match(item?.title ?? '', /Move “where to find free meal plans”/);
    assert.deepEqual(aiRow(item), expected);
    assert.ok(
      !item.evidence.some((row) => row.label === 'AI Overview terms withheld'),
      'nothing was withheld, so nothing is claimed to have been',
    );
  }

  // 3. The three-state contract survives the gate. A billed-but-unanswered
  // panel row and a term nobody tracked are the same fact — unknown — and an
  // unknown term is offered exactly as it was before the panel existed.
  const unknownState = {
    label: 'AI Overview on this term',
    value: 'Unknown',
    detail:
      'Not on the tracked panel, or its overview did not load — unknown, never “no overview”',
  };
  const unreadable = cardFor(
    panelled([panelRow('where to find free meal plans', '', '')]),
    'search-striking-distance',
  );
  assert.match(unreadable?.title ?? '', /Move “where to find free meal plans”/);
  assert.deepEqual(aiRow(unreadable), unknownState);

  const untracked = cardFor(
    panelled([panelRow('some other tracked term', true, false)]),
    'search-striking-distance',
  );
  assert.match(untracked?.title ?? '', /Move “where to find free meal plans”/);
  assert.deepEqual(aiRow(untracked), unknownState);

  // 4. No panel at all: the rule behaves as it did before the panel existed,
  // states the unknown, and claims no panel source.
  const unpanelled = cardFor(
    new Map([['gsc-page-query', pageQueries]]),
    'search-striking-distance',
  );
  assert.match(unpanelled?.title ?? '', /Move “where to find free meal plans”/);
  assert.deepEqual(aiRow(unpanelled), unknownState);
  assert.deepEqual(unpanelled.sources, ['gsc/page-query']);

  // 5. The devices DISAGREE: an overview consumes the click on the phone and
  // the desktop page is clear. ANY uncited surface withholds; a clear desktop
  // does not give a phone searcher's click back, and requiring both surfaces
  // to agree would let the quieter one veto the evidence.
  const splitWalled = cardFor(
    panelled([
      panelRow('where to find free meal plans', false, false, 'desktop'),
      panelRow('where to find free meal plans', true, false, 'mobile'),
    ]),
    'search-striking-distance',
  );
  assert.match(
    splitWalled?.title ?? '',
    /Move “my plate” into the top results/,
    'walled on the phone is walled',
  );
  const splitWithheld = splitWalled.evidence.find(
    (row) => row.label === 'AI Overview terms withheld',
  );
  assert.equal(splitWithheld?.value, '1');
  // The surface is named, so the operator can see WHERE the click goes.
  assert.match(splitWithheld.detail, /holds that result page on phone/);

  // 6. A term the devices disagree about, where neither reading withholds:
  // BOTH states are rendered, not one folded verdict.
  const splitStated = cardFor(
    panelled([
      panelRow('where to find free meal plans', false, false, 'desktop'),
      panelRow('where to find free meal plans', true, true, 'mobile'),
    ]),
    'search-striking-distance',
  );
  assert.match(splitStated?.title ?? '', /Move “where to find free meal plans”/);
  assert.deepEqual(aiRow(splitStated), {
    label: 'AI Overview on this term',
    value: 'Phone: cites us · Desktop: none',
    detail:
      'The result pages disagree by surface — an overview that consumes the click on one device does not clear it on the other · tracked panel observed 2026-07-28',
  });
});

test('surfaces grounding traffic as its own discovery above the share and volume floors (F2)', () => {
  const grounded = (impressions) =>
    pageQueryRows('"1 medium banana" "3/4 cup" meals', [
      ['https://meals.example/recipes/ambrosia', impressions, 0, 4.3],
    ]);
  const human = (impressions) =>
    pageQueryRows('my plate', [['https://meals.example/', impressions, 12, 5.9]]);

  const families = new Map([
    [
      'gsc-page-query',
      [...grounded(400), ...human(1000)],
    ],
    [
      'dataforseo-llm-mentions-google',
      [
        {
          report_date: '2026-07-30',
          row_grain: 'platform-summary',
          mentions: 177,
          ai_search_volume: 67600,
        },
      ],
    ],
  ]);
  const item = cardFor(families, 'llm-grounding-traffic');
  assert.equal(item?.kind, 'discovery');
  assert.equal(item.primary.value, '1,200');
  assert.match(item.title, /28\.6% of captured search impressions are machine grounding/);
  assert.ok(
    item.evidence.some(
      (row) => row.label === '/recipes/ambrosia' && row.value === '1,200',
    ),
    'the grounded pages are named — they are the pages already inside AI answers',
  );
  assert.ok(
    item.evidence.some(
      (row) =>
        row.label === 'Corroborating AI mentions' &&
        row.value === '177' &&
        row.detail.includes('llm-mentions-google'),
    ),
    'the free lane corroborates the paid mention lane rather than repeating it',
  );
  assert.deepEqual(item.sources, ['gsc/page-query', 'dataforseo/llm-mentions-google']);
  assert.match(item.caveat, /NOT counted/, 'the classifier states its own narrowness');
  assert.equal(item.evidence.at(-1).detail, 'rule: llm-grounding-traffic');

  assert.equal(
    cardFor(
      new Map([['gsc-page-query', [...grounded(100), ...human(4000)]]]),
      'llm-grounding-traffic',
    ),
    undefined,
    '2.4% of impressions is not a claim about the property’s demand profile',
  );
  assert.equal(
    cardFor(
      new Map([['gsc-page-query', [...grounded(100), ...human(150)]]]),
      'llm-grounding-traffic',
    ),
    undefined,
    'a large share of a tiny archive is three stray queries, not a finding',
  );
  assert.equal(
    cardFor(new Map(), 'llm-grounding-traffic'),
    undefined,
    'a missing page/query family is not a grounding finding',
  );
});

test('states the decline, refuses a cross-locale join, and caps confidence on a dead Bing query (F3)', () => {
  const bingSeries = (query, weekly, clicks, position = 7) =>
    weekly.map(([provider_date, impressions], index) => ({
      report_date: '2026-07-28',
      provider_date,
      query,
      impressions,
      clicks: index === weekly.length - 1 ? clicks : 0,
      avg_impression_position: position,
    }));
  // The origin series: 2,054 → 372 across ten reported weeks, five clicks total.
  const declining = [
    ['2026-05-22', 474],
    ['2026-05-29', 1700],
    ['2026-06-05', 2054],
    ['2026-06-12', 2254],
    ['2026-06-19', 2054],
    ['2026-06-26', 1614],
    ['2026-07-03', 438],
    ['2026-07-10', 604],
    ['2026-07-17', 261],
    ['2026-07-24', 372],
  ];
  const families = new Map([
    ['bing-webmaster-queries', bingSeries('dri', declining, 5)],
    [
      'gsc-page-query',
      pageQueryRows('dri', [['https://meals.example/es/calculadora-dri', 20, 0, 8]]),
    ],
  ]);
  const item = cardFor(families, 'bing-search-opportunity');
  assert.equal(item?.confidence, 'medium');
  assert.match(item.summary, /The series is declining/);
  assert.match(item.summary, /latest 2 reported periods average 317 impressions against 1,183/);
  assert.match(item.summary, /points at intent mismatch/);
  assert.match(item.summary, /No reliable landing page identified/);
  assert.doesNotMatch(
    item.summary,
    /calculadora/,
    'a Spanish page is not the landing page for an English Bing query',
  );
  assert.deepEqual(
    item.sources,
    ['bing-webmaster/queries'],
    'a join that was not made contributes no source',
  );
  assert.equal(
    item.windowStart,
    '2026-05-22',
    'the window is this query’s own reported periods, not every date in the snapshot',
  );
  assert.equal(item.windowEnd, '2026-07-24');

  // A live series with a non-localized page keeps the join and the confidence.
  const healthy = new Map([
    [
      'bing-webmaster-queries',
      bingSeries(
        'meal plan',
        declining.map(([date]) => [date, 500]),
        60,
      ),
    ],
    [
      'gsc-page-query',
      pageQueryRows('meal plan', [
        ['https://meals.example/es/planes', 900, 0, 8],
        ['https://meals.example/meal-plans', 300, 9, 6],
      ]),
    ],
  ]);
  const live = cardFor(healthy, 'bing-search-opportunity');
  assert.equal(live?.confidence, 'high');
  assert.doesNotMatch(live.summary, /declining/);
  assert.match(live.summary, /\/meal-plans is the matching Google-visible page/);
  assert.ok(
    live.evidence.some(
      (row) => row.label === 'Matching Google page' && row.value === '/meal-plans',
    ),
    'the larger localized page never wins the join, whatever its impressions',
  );
});

test('refuses a Bing landing-page join built on a single captured impression', () => {
  // The F3 leftover: with the locale rule in place "dri" joined /dri-calculator
  // on ONE captured GSC impression, and nothing stopped the card naming it.
  const bingWeeks = (query, impressions, clicks) =>
    reportedDates(6).map((provider_date, index) => ({
      report_date: '2026-07-28',
      provider_date,
      query,
      impressions,
      clicks: index === 5 ? clicks : 0,
      avg_impression_position: 7,
    }));
  const thin = new Map([
    ['bing-webmaster-queries', bingWeeks('dri', 500, 40)],
    [
      'gsc-page-query',
      pageQueryRows('dri', [['https://meals.example/dri-calculator', 1, 0, 8]], 1),
    ],
  ]);
  const declined = cardFor(thin, 'bing-search-opportunity');
  assert.ok(declined, 'the Bing opportunity itself still stands on Bing evidence');
  assert.match(declined.summary, /No reliable landing page identified/);
  assert.match(
    declined.summary,
    /\/dri-calculator at 1 captured GSC impression, under the 10-impression join floor/,
    'the declined candidate is named, and the floor with it',
  );
  assert.deepEqual(
    declined.sources,
    ['bing-webmaster/queries'],
    'a join that was refused contributes no source',
  );
  assert.ok(
    declined.evidence.some(
      (row) =>
        row.label === 'Matching Google page' &&
        row.value === 'none identified' &&
        /Closest candidate declined: \/dri-calculator at 1 captured GSC impression/.test(
          row.detail ?? '',
        ),
    ),
    'the evidence row proves the check ran rather than dropping the candidate',
  );
  assert.match(declined.caveat, /at least 10 times/);

  // The same page over the floor is still offered.
  const solid = new Map([
    ['bing-webmaster-queries', bingWeeks('dri', 500, 40)],
    [
      'gsc-page-query',
      pageQueryRows('dri', [['https://meals.example/dri-calculator', 4, 1, 8]], 3),
    ],
  ]);
  const joined = cardFor(solid, 'bing-search-opportunity');
  assert.match(
    joined.summary,
    /\/dri-calculator is the matching Google-visible page/,
    '12 captured impressions clears the floor and keeps the join',
  );
  assert.deepEqual(joined.sources, ['bing-webmaster/queries', 'gsc/page-query']);
  assert.ok(
    joined.evidence.some(
      (row) =>
        row.label === 'Matching Google page' && row.value === '/dri-calculator',
    ),
  );
});

/** The value-events declaration the operator owns (config/value-events.json). */
function valueEventCard(families, valueEvents, asset = 'meals.example') {
  return buildExecutiveSnapshot({
    asset,
    families,
    archives: [{}],
    valueEvents,
  }).items.find((item) => item.key === 'value-event-not-key-event');
}

const MEALS_VALUE_EVENTS = {
  assets: {
    'meals.example': {
      valueEvents: [
        'calculation_complete',
        'printable_download',
        'sign_up',
        'plan_save_click',
        'auth_complete',
      ],
    },
  },
};

test('warns when a declared value event is not a GA4 key event (F4)', () => {
  const eventRows = (byEvent, dates = 5) =>
    reportedDates(dates).flatMap((report_date) =>
      Object.entries(byEvent).map(([eventName, [eventCount, keyEvents]]) => ({
        report_date,
        eventName,
        eventCount,
        keyEvents,
        totalUsers: 10,
      })),
    );

  // Before a key-event change: the core value event at ~400/day counted zero,
  // one declared event counted correctly.
  const preChange = new Map([
    [
      'ga4-events',
      eventRows({
        calculation_complete: [398, 0],
        printable_download: [52, 0],
        auth_complete: [28, 28],
        page_view: [3033, 0],
      }),
    ],
  ]);
  const item = valueEventCard(preChange, MEALS_VALUE_EVENTS);
  assert.equal(item?.kind, 'warning');
  assert.equal(item.title, '2 declared value events are not GA4 key events');
  assert.equal(item.primary.value, '1,990');
  assert.match(item.summary, /calculation_complete fired 1,990 times/);
  assert.match(item.summary, /GA4 recorded 0 key events for it/);
  assert.match(
    item.summary,
    /auth_complete is configured correctly, which is what makes this a settings gap/,
  );
  assert.ok(
    item.evidence.some(
      (row) => row.label === 'Declared and counted' && row.value === 'auth_complete',
    ),
  );
  assert.equal(
    item.evidence.find((row) => row.label === 'Declared value events')?.value,
    '5',
  );
  assert.match(item.caveat, /going forward only/);
  assert.match(item.caveat, /operator-only by invariant/);
  assert.equal(item.evidence.at(-1).detail, 'rule: value-event-not-key-event');

  // After the change every declared event counts, and the card falls silent.
  assert.equal(
    valueEventCard(
      new Map([
        [
          'ga4-events',
          eventRows({
            calculation_complete: [398, 398],
            printable_download: [52, 52],
            auth_complete: [28, 28],
          }),
        ],
      ]),
      MEALS_VALUE_EVENTS,
    ),
    undefined,
    'the fixed configuration is the silence this card is asking for',
  );
  assert.equal(
    valueEventCard(
      new Map([['ga4-events', eventRows({ calculation_complete: [8, 0] })]]),
      MEALS_VALUE_EVENTS,
    ),
    undefined,
    'eight events a day is not enough volume to call a settings gap',
  );
  assert.equal(
    valueEventCard(
      new Map([['ga4-events', eventRows({ recipe_save: [400, 0] })]]),
      MEALS_VALUE_EVENTS,
    ),
    undefined,
    'an undeclared event is not this rule’s business, however large',
  );
  assert.equal(
    valueEventCard(
      new Map([['ga4-events', eventRows({ calculation_complete: [398, 0] })]]),
      null,
    ),
    undefined,
    'no config is “not declared”, never “nothing to declare”',
  );
  assert.equal(
    valueEventCard(
      new Map([['ga4-events', eventRows({ calculation_complete: [398, 0] })]]),
      MEALS_VALUE_EVENTS,
      'nosh.example',
    ),
    undefined,
    'a property with no declaration of its own stays silent',
  );
  assert.equal(
    valueEventCard(new Map(), MEALS_VALUE_EVENTS),
    undefined,
    'a missing GA4 events family is not a configuration finding',
  );
});

test('names the provider’s observed link inventory on the momentum card (F7)', () => {
  const families = new Map([
    [
      'dataforseo-backlinks-new-lost',
      [
        {
          report_date: '2026-07-30',
          provider_date: '2026-07-27',
          new_referring_domains: 11,
          lost_referring_domains: 0,
        },
      ],
    ],
    [
      'dataforseo-backlinks-summary',
      [
        {
          report_date: '2026-07-30',
          rank: 256,
          backlinks: 404,
          referring_domains: 11,
        },
      ],
    ],
  ]);
  const item = cardFor(families, 'dataforseo-backlink-growth');
  assert.match(
    item?.caveat ?? '',
    /404 backlinks across 11 referring domains/,
    'the operator cannot judge coverage the card does not state',
  );
  assert.match(item.caveat, /no second link observer is wired/);
  assert.ok(
    item.evidence.some(
      (row) =>
        row.label === 'Provider inventory' &&
        row.value === '404 backlinks / 11 referring domains' &&
        row.detail.includes('9.1%'),
    ),
    'one domain moving an eleven-domain inventory is a 9% swing, and the card says so',
  );
});

test('reports a device CTR gap in either direction, on the decontaminated series (F8)', () => {
  const deviceRows = (split) =>
    Object.entries(split).map(([device, [impressions, clicks]]) => ({
      report_date: '2026-07-28',
      row_grain: 'device',
      device,
      impressions,
      clicks,
      position: 8,
    }));
  const grounding = (impressions) =>
    pageQueryRows('"1 medium banana" "3/4 cup" meals', [
      ['https://meals.example/recipes/ambrosia', impressions, 0, 4.3],
    ]);

  // The gap the mobile-only rule could not see: desktop at a quarter of mobile's
  // CTR on double the impressions.
  const desktopWorse = new Map([
    ['gsc-device', deviceRows({ MOBILE: [48674, 688], DESKTOP: [101882, 593] })],
    ['gsc-page-query', grounding(1000)],
  ]);
  const item = cardFor(desktopWorse, 'device-ctr-gap');
  assert.equal(item?.kind, 'recommendation');
  assert.match(item.title, /Desktop results click at 0\.6% against mobile’s 1\.4%/);
  assert.equal(item.primary.label, 'desktop CTR');
  assert.match(
    item.summary,
    /Charging every one of the 3,000 excluded grounding impressions to desktop still leaves 0\.6%/,
  );
  assert.ok(
    item.evidence.some(
      (row) => row.label === 'Desktop CTR excluding grounding traffic',
    ),
  );
  assert.deepEqual(item.sources, ['gsc/device', 'gsc/page-query']);
  assert.match(item.caveat, /no archived family carries query × device/i);
  assert.equal(item.evidence.at(-1).detail, 'rule: device-ctr-gap');

  // Same shape, mobile side: the original direction still fires.
  const mobileWorse = cardFor(
    new Map([['gsc-device', deviceRows({ MOBILE: [20000, 100], DESKTOP: [5000, 100] })]]),
    'device-ctr-gap',
  );
  assert.match(mobileWorse?.title ?? '', /Mobile results click at 0\.5% against desktop’s 2\.0%/);

  // The correction can only quieten the rule: a gap that grounding traffic could
  // account for is not reported.
  assert.equal(
    cardFor(
      new Map([
        ['gsc-device', deviceRows({ MOBILE: [10000, 70], DESKTOP: [10000, 30] })],
        ['gsc-page-query', grounding(1667)],
      ]),
      'device-ctr-gap',
    ),
    undefined,
    'removing the grounding impressions lifts desktop above half of mobile, so there is nothing to claim',
  );
  assert.equal(
    cardFor(new Map(), 'device-ctr-gap'),
    undefined,
    'a missing device family is not a CTR finding',
  );
});

test('surfaces high-demand clusters past the near-win band, one card per page (F10)', () => {
  const rankedRow = (keyword, page, volume, difficulty, position) => ({
    report_date: '2026-07-30',
    keyword,
    url: `https://meals.example${page}`,
    relative_url: page,
    result_type: 'organic',
    intent: 'informational',
    search_volume: volume,
    keyword_difficulty: difficulty,
    rank_group: position,
  });
  const families = new Map([
    [
      'dataforseo-ranked-keywords',
      [
        rankedRow('water consume calculator', '/water-intake-calculator', 22200, 15, 39),
        rankedRow('calculate water intake', '/water-intake-calculator', 22200, 22, 49),
        rankedRow('water daily intake calculator', '/water-intake-calculator', 12100, 6, 37),
        rankedRow('calculate percent weight loss', '/weight-loss-percentage-calculator', 12100, 1, 67),
        rankedRow('figure out percentage of weight loss', '/weight-loss-percentage-calculator', 12100, 18, 93),
      ],
    ],
  ]);
  const snapshot = buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}],
  });
  const clusters = snapshot.items.filter((item) =>
    item.key.startsWith('distant-demand-cluster'),
  );
  assert.deepEqual(
    clusters.map((item) => item.key),
    [
      'distant-demand-cluster/water-intake-calculator',
      'distant-demand-cluster/weight-loss-percentage-calculator',
    ],
    'one card per URL cluster, largest demand first — never one card per keyword',
  );
  assert.equal(clusters[0].primary.value, '56,500');
  assert.equal(clusters[1].primary.value, '24,200');
  assert.match(clusters[0].title, /56,500 monthly searches sit past the near-win band/);
  assert.match(clusters[0].summary, /3 queries at position 37–49/);
  assert.equal(clusters[0].confidence, 'high');
  assert.ok(
    clusters[0].evidence.some(
      (row) =>
        row.label === 'Mapped page' && row.detail.includes('no new inventory required'),
    ),
  );
  assert.equal(clusters[0].evidence.at(-1).detail, 'rule: distant-demand-cluster');

  const silent = (rows, reason) =>
    assert.equal(
      buildExecutiveSnapshot({
        asset: 'meals.example',
        families: new Map([['dataforseo-ranked-keywords', rows]]),
        archives: [{}],
      }).items.filter((item) => item.key.startsWith('distant-demand-cluster')).length,
      0,
      reason,
    );
  silent(
    [rankedRow('protein calculator', '/protein-calculator', 22200, 60, 40)],
    'difficulty 60 at position 40 is a market, not an unguarded position',
  );
  silent(
    [rankedRow('protein calculator', '/protein-calculator', 9000, 10, 40)],
    'under the volume floor this is the ordinary long tail',
  );
  silent(
    [rankedRow('protein calculator', '/protein-calculator', 22200, 10, 15)],
    'position 15 belongs to the near-win rule and must not be reported twice',
  );
  silent(
    [rankedRow('meals', '/', 110000, 10, 26)],
    'a homepage cluster is a brand-term artifact, not a content decision',
  );
  silent(
    [
      {
        ...rankedRow('protein calculator', '/protein-calculator', 22200, 10, 40),
        keyword_difficulty: '',
      },
    ],
    'an unreported difficulty is unknown, and an unknown cannot clear a ceiling',
  );
  silent([], 'a missing ranked-keyword family is not a demand finding');
});

// A site's DataForSEO numbers are asked in the market its settings save, so
// every finding that names a market names that one.
test('search findings name the site’s own saved market, and a neutral one when it saved none', () => {
  const ranked = (reportDate, keyword, page, volume, position, difficulty = 20) => ({
    report_date: reportDate,
    keyword,
    url: `https://meals.example${page}`,
    relative_url: page,
    result_type: 'organic',
    intent: 'informational',
    search_volume: volume,
    keyword_difficulty: difficulty,
    cpc: 1,
    etv: 10,
    rank_group: position,
  });
  const platform = (mentions) => ({
    report_date: '2026-07-30', row_grain: 'platform-summary', mentions, ai_search_volume: 900,
  });
  const families = new Map([
    ['dataforseo-ranked-keywords', [
      ranked('2026-07-23', 'weekly meal plan', '/meal-plan', 500, 14),
      ranked('2026-07-30', 'weekly meal plan', '/meal-plan', 500, 7),
      ranked('2026-07-30', 'water consume calculator', '/water-intake-calculator', 22200, 39, 15),
      ranked('2026-07-30', 'calculate water intake', '/water-intake-calculator', 22200, 49, 22),
    ]],
    ['dataforseo-llm-mentions-google', [platform(7)]],
    ['dataforseo-llm-mentions-chatgpt', [platform(4)]],
  ]);
  const findings = (market) => buildExecutiveSnapshot({ asset: 'meals.example', families, archives: [{}], market });
  const ASSUMED_US = /US\/English|\bUS searches|United States/;
  const namedCards = ['dataforseo-ranking-gain', 'dataforseo-ranking-opportunity', 'dataforseo-llm-visibility', 'distant-demand-cluster/water-intake-calculator'];

  const uk = findings({ locationCode: 2826, languageCode: 'en' });
  assert.doesNotMatch(JSON.stringify(uk), ASSUMED_US);
  for (const key of namedCards) {
    const item = uk.items.find((entry) => entry.key === key);
    assert.ok(item, `${key} fires on this fixture`);
    assert.match(`${item.summary} ${item.caveat}`, /the United Kingdom · English market/, key);
  }
  assert.match(uk.searchQueries.dataforseo.caveat, /DataForSEO estimates for the United Kingdom · English market/);
  assert.ok(uk.methodology.some((line) => line.includes('one live result page in the United Kingdom · English market')));

  const unset = findings(null);
  assert.doesNotMatch(JSON.stringify(unset), ASSUMED_US);
  for (const key of namedCards) {
    const item = unset.items.find((entry) => entry.key === key);
    assert.match(`${item.summary} ${item.caveat}`, /the site’s default market/, key);
  }
});

test('names where the property sits among the domains each AI platform cites', () => {
  const platform = (mentions, aiSearchVolume) => ({
    report_date: '2026-07-30',
    row_grain: 'platform-summary',
    mentions,
    ai_search_volume: aiSearchVolume,
  });
  const sourceDomain = (domain, mentions) => ({
    report_date: '2026-07-30',
    row_grain: 'source-domain',
    source_domain: domain,
    mentions,
  });
  const families = new Map([
    [
      'dataforseo-llm-mentions-google',
      [
        platform(177, 67600),
        sourceDomain('meals.example', 177),
        sourceDomain('www.youtube.com', 70),
      ],
    ],
    [
      'dataforseo-llm-mentions-chatgpt',
      [
        platform(159, 8819),
        sourceDomain('www.healthline.com', 42),
        sourceDomain('diabetes.org', 31),
        sourceDomain('meals.example', 27),
      ],
    ],
  ]);
  const item = cardFor(families, 'dataforseo-llm-visibility');
  assert.match(
    item?.summary ?? '',
    /ranks #1 on Google AI surfaces and #3 on ChatGPT among the cited domains this snapshot returned/,
  );
  assert.ok(
    item.evidence.some(
      (row) =>
        row.label === 'Rank among Google-cited domains' &&
        row.value === '#1 of 2' &&
        row.detail.includes('ahead of youtube.com 70'),
    ),
  );
  assert.ok(
    item.evidence.some(
      (row) =>
        row.label === 'Rank among ChatGPT-cited domains' &&
        row.value === '#3 of 3' &&
        row.detail.includes('behind healthline.com 42, diabetes.org 31'),
    ),
    'who is ahead is the competitive fact; the count alone is not',
  );
  assert.match(item.caveat, /a provider top-N, not the platform’s full citation set/);

  const unranked = cardFor(
    new Map([['dataforseo-llm-mentions-google', [platform(177, 67600)]]]),
    'dataforseo-llm-visibility',
  );
  assert.ok(
    !unranked.evidence.some((row) => row.label.startsWith('Rank among')),
    'no source-domain rows means no rank, not a rank of one',
  );
});

test('keeps a blank LLM-mention platform row unknown instead of reporting zero', () => {
  // DataForSEO returned a platform row with no mentions and no search volume,
  // and executive.json said 0 for both: negative evidence nobody measured. An
  // explicit provider zero is a zero.
  const blank = {
    report_date: '2026-08-03',
    row_grain: 'platform-summary',
    platform: '',
    mentions: '',
    ai_search_volume: '',
    source_domain: '',
    provider_cost_usd: 0.1,
  };
  const zero = { ...blank, platform: 'chat_gpt', mentions: 0, ai_search_volume: 0 };
  const ranked = [
    {
      report_date: '2026-08-03',
      result_type: 'organic',
      keyword: 'area code 555',
      rank_group: 4,
      provider_cost_usd: 0.05,
    },
  ];
  const intelligence = (families) =>
    buildExecutiveSnapshot({ asset: 'areas.example', families, archives: [{}] }).searchIntelligence;

  assert.deepEqual(
    intelligence(
      new Map([
        ['dataforseo-llm-mentions-google', [blank]],
        ['dataforseo-llm-mentions-chatgpt', [zero]],
      ]),
    ).ai,
    { googleMentions: null, googleSearchVolume: null, chatgptMentions: 0, chatgptSearchVolume: 0 },
  );
  // A family nobody collected is just as unknown as a blank one.
  assert.deepEqual(
    intelligence(new Map([['dataforseo-ranked-keywords', ranked]])).ai,
    { googleMentions: null, googleSearchVolume: null, chatgptMentions: null, chatgptSearchVolume: null },
  );

  // A card that fires on the platform that DID report never states the blank
  // one as a zero in its evidence.
  const card = cardFor(
    new Map([
      ['dataforseo-llm-mentions-google', [blank]],
      ['dataforseo-llm-mentions-chatgpt', [{ ...zero, mentions: 5, ai_search_volume: 300 }]],
    ]),
    'dataforseo-llm-visibility',
    'areas.example',
  );
  const evidenceValue = (label) => card.evidence.find((row) => row.label === label)?.value;
  assert.equal(evidenceValue('Google mentions'), 'not reported');
  assert.equal(evidenceValue('ChatGPT mentions'), '5');
});

// --- reclamation match ------------------------------------------------------
/** GA4 reports a referral as `host / referral` in the same source/medium string
 * it uses for `google / organic`. */
function trafficSourceRows(bySourceMedium, date = '2026-07-28') {
  return Object.entries(bySourceMedium).map(([sessionSourceMedium, sessions]) => ({
    report_date: date,
    sessionSourceMedium,
    sessions,
  }));
}

const OPEN_TARGETS = [
  {
    domain: 'genesee.cce.cornell.edu',
    status: 'clicked',
    referring_page: 'https://genesee.cce.cornell.edu/food-nutrition/meals',
    replace_with: 'https://meals.example/food-groups',
  },
  { domain: 'schoolnutrition.org', status: 'queued', referring_page: '' },
  { domain: 'wichealth.org', status: 'sent', referring_page: '' },
];

function reclamationCard(families, reclamationTargets) {
  return buildExecutiveSnapshot({
    asset: 'meals.example',
    families,
    archives: [{}],
    reclamationTargets,
  }).items.find((item) => item.key === 'reclamation-match');
}

test('flags an open reclamation target that starts sending referral traffic', () => {
  const families = new Map([
    [
      'ga4-traffic-sources',
      trafficSourceRows({
        'google / organic': 400,
        'genesee.cce.cornell.edu / referral': 12,
        'blog.schoolnutrition.org / referral': 3,
        'unrelated.example.com / referral': 90,
      }),
    ],
  ]);
  const item = reclamationCard(families, OPEN_TARGETS);
  assert.equal(item?.kind, 'discovery');
  assert.match(item.title, /Reclamation match: genesee\.cce\.cornell\.edu is sending visitors/);
  assert.equal(item.primary.value, '12');
  assert.match(item.summary, /last recorded state: clicked/);
  assert.match(
    item.summary,
    /1 other open target also sent referral traffic/,
    'a subdomain of a pitched domain is the same institution and counts',
  );
  assert.match(
    item.summary,
    /confirm the link is live before marking the target won/,
    'the card asks for the check; it never records the win',
  );
  // Never 'high': a referral host is not a backlink index.
  assert.equal(item.confidence, 'medium');
  assert.equal(item.evidence.at(-1).detail, 'rule: reclamation-match');
  assert.deepEqual(item.sources, ['ga4/traffic-sources']);
  assert.equal(
    item.evidence.find((row) => row.label === 'Open targets checked').value,
    '3',
  );
});

test('reclamation matching is silent without the operator-supplied export', () => {
  const families = new Map([
    [
      'ga4-traffic-sources',
      trafficSourceRows({ 'genesee.cce.cornell.edu / referral': 12 }),
    ],
  ]);
  assert.equal(
    reclamationCard(families, null),
    undefined,
    'no export means the question was never asked, not that nothing matched',
  );
  assert.equal(
    reclamationCard(families, undefined),
    undefined,
    'an absent argument behaves the same as an explicit null',
  );
  assert.equal(
    reclamationCard(families, []),
    undefined,
    'an export with no open targets has nothing to match',
  );
});

test('reclamation matching ignores resolved targets and non-referral traffic', () => {
  const families = new Map([
    [
      'ga4-traffic-sources',
      trafficSourceRows({
        'genesee.cce.cornell.edu / referral': 12,
        'schoolnutrition.org / organic': 40,
      }),
    ],
  ]);
  assert.equal(
    reclamationCard(families, [
      { domain: 'genesee.cce.cornell.edu', status: 'won' },
      { domain: 'schoolnutrition.org', status: 'queued' },
    ]),
    undefined,
    'a won target has nothing left to verify, and organic traffic is not a referral',
  );
  assert.equal(
    reclamationCard(
      new Map([['ga4-traffic-sources', trafficSourceRows({ 'cornell.edu / referral': 30 })]]),
      [{ domain: 'genesee.cce.cornell.edu', status: 'queued' }],
    ),
    undefined,
    'traffic from the parent domain is a different office, never evidence about the pitched subdomain',
  );
  assert.equal(
    reclamationCard(new Map(), OPEN_TARGETS),
    undefined,
    'a missing GA4 traffic-source family is not a match',
  );
});

test('reclamation matching accepts exported rows and quotes provider counts honestly', () => {
  const families = new Map([
    [
      'ga4-traffic-sources',
      trafficSourceRows({ 'wichealth.org / referral': 7 }),
    ],
    [
      'dataforseo-backlinks-new-lost',
      [
        {
          report_date: '2026-07-28',
          provider_date: '2026-07-26',
          new_referring_domains: 4,
          lost_referring_domains: 1,
        },
      ],
    ],
  ]);
  const item = reclamationCard(families, OPEN_TARGETS);
  assert.equal(item?.primary.value, '7');
  assert.deepEqual(item.sources, ['ga4/traffic-sources', 'dataforseo/backlinks-new-lost']);
  const provider = item.evidence.find((row) =>
    row.label.startsWith('New referring domains'),
  );
  assert.equal(provider.value, '4');
  assert.match(
    provider.detail,
    /counts referring domains without naming them/,
    'the provider series can corroborate timing and must never claim the match',
  );
  assert.match(item.caveat, /GA4 names the referring host, not the link/);
});

// ---------------------------------------------------------------------------
// Clarity vs GA4 on the worst page for JavaScript errors
// ---------------------------------------------------------------------------
// Fixture rows carry the real archive shapes: Clarity long by (metric, URL) with
// `sub_total` as the metric's own total, and GA4 `page-events` with `js_error`
// beside `page_view`.

/** GA4 `js_error` rows over `count` reported dates, `perDay` events per page. */
function ga4ErrorRows(perDay, count = 5) {
  return reportedDates(count, 25).flatMap((report_date) =>
    Object.entries(perDay).flatMap(([page, events]) => [
      {
        report_date,
        eventName: 'js_error',
        unifiedPagePathScreen: page,
        eventCount: events,
        totalUsers: Math.max(1, Math.round(events * 0.7)),
      },
      {
        report_date,
        eventName: 'page_view',
        unifiedPagePathScreen: page,
        eventCount: events * 20,
        totalUsers: events * 15,
      },
    ]),
  );
}

function clarityScriptErrorRows(rows, report_date = '2026-08-01') {
  return rows.map((row) => ({
    report_date,
    collected_at: `${report_date}T04:30:00.000Z`,
    data_state: 'provider-snapshot',
    row_grain: 'metric-url',
    metric: 'ScriptErrorCount',
    url: row.url,
    sub_total: row.errors,
    pages_views: row.viewsWithError,
    sessions_count: row.sessions,
    sessions_with_metric_percentage: row.sessionPercent,
  }));
}

test('names the disagreement when Clarity and GA4 rank different worst pages for errors', () => {
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/recipes', errors: 203, viewsWithError: 43, sessions: 238, sessionPercent: 2.94 },
        { url: 'https://meals.example/calculator', errors: 24, viewsWithError: 17, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);

  const item = cardFor(families, 'error-observer-disagreement');
  assert.ok(item, 'two observers naming different pages is itself a finding');
  assert.equal(item.kind, 'warning');
  assert.equal(item.primary.value, '2');
  assert.equal(item.primary.label, 'Pages named worst');
  assert.deepEqual(item.sources, ['clarity/url-3d', 'ga4/page-events']);

  // Both pages, both units, both windows — and never one merged number.
  const byLabel = new Map(item.evidence.map((row) => [row.label, row]));
  assert.equal(byLabel.get('Clarity’s worst page').value, '/recipes');
  assert.equal(
    byLabel.get('Clarity’s worst page').detail,
    '203 script errors · 43 page views with one · 2.9% of 238 sampled sessions · trailing 72 hours ending 2026-08-01',
  );
  assert.equal(byLabel.get('GA4’s worst page').value, '/calculator');
  assert.equal(
    byLabel.get('GA4’s worst page').detail,
    '280 js_error events · 195 reported users · 5 reported dates 2026-07-25–2026-07-29',
  );
  assert.equal(byLabel.get('Clarity on GA4’s page').value, '24 script errors · 17 page views with one · 2.1% of 717 sampled sessions');
  assert.match(
    byLabel.get('Clarity on GA4’s page').detail,
    /ranks #2 of 2 pages Clarity saw an error on/,
  );
  assert.equal(byLabel.get('GA4 on Clarity’s page').value, '70 js_error events · 50 reported users');
  assert.match(
    byLabel.get('GA4 on Clarity’s page').detail,
    /ranks #2 of 2 pages GA4 reported an error on/,
  );

  // The window is the envelope of two different windows, and the card says so
  // rather than presenting either observer's window as shared.
  assert.equal(item.windowStart, '2026-07-25');
  assert.equal(item.windowEnd, '2026-08-01');
  assert.match(item.caveat, /never a combined figure, a ratio between them, or a winner/);
  assert.equal(item.confidence, 'medium');

  // The single-observer card carries the contradiction too — it is the card that
  // would otherwise send the fix to one page on one observer's word.
  const errors = cardFor(families, 'javascript-errors');
  const cross = errors.evidence.find((row) => row.label === 'Clarity cross-check');
  assert.equal(cross.value, 'Different page');
  assert.match(cross.detail, /ranks \/recipes worst instead \(203 script errors\)/);
  assert.deepEqual(errors.sources, ['ga4/page-events', 'clarity/url-3d']);

  // Divergence outranks the finding it bounds.
  const snapshot = buildExecutiveSnapshot({ asset: 'meals.example', families, archives: [{}] });
  const keys = snapshot.items.map((card) => card.key);
  assert.ok(
    keys.indexOf('error-observer-disagreement') < keys.indexOf('javascript-errors'),
    'the operator meets the disagreement before the card that assumes one observer',
  );
  assert.ok(
    snapshot.methodology.some((line) =>
      line.includes('never merges, averages, or ranks the two observers'),
    ),
  );
});

test('agreement between the two observers is stated, not silence', () => {
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/calculator', errors: 203, viewsWithError: 43, sessions: 238, sessionPercent: 2.94 },
        { url: 'https://meals.example/recipes', errors: 24, viewsWithError: 17, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);
  assert.equal(
    cardFor(families, 'error-observer-disagreement'),
    undefined,
    'observers that agree are not a disagreement finding',
  );
  const cross = cardFor(families, 'javascript-errors').evidence.find(
    (row) => row.label === 'Clarity cross-check',
  );
  assert.equal(cross.value, 'Same page');
  assert.match(cross.detail, /also ranks \/calculator worst \(203 script errors\)/);
});

test('one observer cannot disagree, and a silent observer is never read as agreement', () => {
  const ga4Only = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
  ]);
  assert.equal(cardFor(ga4Only, 'error-observer-disagreement'), undefined);
  assert.equal(
    cardFor(ga4Only, 'javascript-errors').evidence.some(
      (row) => row.label === 'Clarity cross-check',
    ),
    false,
    'a property Clarity never read must not carry a row implying it agreed',
  );
  assert.deepEqual(cardFor(ga4Only, 'javascript-errors').sources, ['ga4/page-events']);

  // Clarity alone: GA4 has no js_error rows at all, so there is no second
  // ranking and nothing to reconcile. Absent GA4 is not GA4 reporting zero.
  const clarityOnly = new Map([
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/recipes', errors: 203, viewsWithError: 43, sessions: 238, sessionPercent: 2.94 },
      ]),
    ],
  ]);
  assert.equal(cardFor(clarityOnly, 'error-observer-disagreement'), undefined);
});

test('the disagreement must clear Clarity’s floors, beat the noise, and ignore non-page hosts', () => {
  const ga4 = ga4ErrorRows({ '/calculator': 56, '/recipes': 14 });

  // A single-session URL at a 100% error rate is not a property's worst page.
  const thin = new Map([
    ['ga4-page-events', ga4],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/foods/low-sugar-cereal', errors: 8, viewsWithError: 1, sessions: 6, sessionPercent: 16.67 },
        { url: 'https://meals.example/calculator', errors: 4, viewsWithError: 2, sessions: 574, sessionPercent: 1.22 },
      ]),
    ],
  ]);
  assert.equal(
    cardFor(thin, 'error-observer-disagreement'),
    undefined,
    'below the session and error floors a sampled read contradicts nothing',
  );
  assert.equal(
    cardFor(thin, 'javascript-errors').evidence.some(
      (row) => row.label === 'Clarity cross-check',
    ),
    false,
  );

  // Equal script errors is a tie, and a tie-break is not a disagreement.
  const tied = new Map([
    ['ga4-page-events', ga4],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/recipes', errors: 40, viewsWithError: 12, sessions: 800, sessionPercent: 2.94 },
        { url: 'https://meals.example/calculator', errors: 40, viewsWithError: 12, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);
  assert.equal(cardFor(tied, 'error-observer-disagreement'), undefined);

  // A hairline lead is noise in a read that undercounts 15–25%: Clarity's
  // leader has to at least double its own count for GA4's page.
  const hairline = new Map([
    ['ga4-page-events', ga4],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/recipes', errors: 41, viewsWithError: 12, sessions: 800, sessionPercent: 2.94 },
        { url: 'https://meals.example/calculator', errors: 40, viewsWithError: 12, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);
  assert.equal(cardFor(hairline, 'error-observer-disagreement'), undefined);
  const clear = new Map([
    ['ga4-page-events', ga4],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/recipes', errors: 80, viewsWithError: 12, sessions: 800, sessionPercent: 2.94 },
        { url: 'https://meals.example/calculator', errors: 40, viewsWithError: 12, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);
  assert.ok(cardFor(clear, 'error-observer-disagreement'), 'twice over is a disagreement');

  // `https://Electron` normalizes to a path of `/` and would masquerade as the
  // home page; it is not a page of this property.
  const foreignHost = new Map([
    ['ga4-page-events', ga4],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://Electron', errors: 900, viewsWithError: 300, sessions: 400, sessionPercent: 50 },
        { url: 'https://meals.example/calculator', errors: 24, viewsWithError: 17, sessions: 717, sessionPercent: 2.09 },
      ]),
    ],
  ]);
  assert.equal(cardFor(foreignHost, 'error-observer-disagreement'), undefined);
  assert.equal(
    cardFor(foreignHost, 'javascript-errors').evidence.find(
      (row) => row.label === 'Clarity cross-check',
    ).value,
    'Same page',
  );
});

// ---------------------------------------------------------------------------
// The triage half of the javascript-errors card
// ---------------------------------------------------------------------------
// Fixture rows carry the real `ga4-js-errors` shape: one row per
// (message × source × page) per reported date, with GA4's own `(not set)` token
// on the dates that predate the operator registering the `message` dimension.

function ga4JsErrorRows(input) {
  return input.map((row) => ({
    report_date: row.date,
    collected_at: `${row.date}T12:15:00.000Z`,
    data_state: 'revision-window',
    provider_truncated: 'false',
    eventCount: row.events,
    totalUsers: row.users,
    message: row.message ?? row.bucket,
    message_bucket: row.bucket,
    source: row.source ?? '',
    unifiedPagePathScreen: row.page,
  }));
}

/** The real archive's asymmetry: `source` was registered before `message`, so
 * the early dates carry a bundle position and no message at all. */
const JS_ERROR_ROWS = ga4JsErrorRows([
  { date: '2026-07-26', bucket: '(not set)', events: 120, users: 90, source: 'vendor-react-DO8020zi.js:38:3302', page: '/calculator' },
  { date: '2026-07-28', bucket: 'Load failed', events: 30, users: 24, page: '/calculator' },
  { date: '2026-07-28', bucket: 'Failed to fetch dynamically imported module: <url>', events: 18, users: 15, source: 'vendor-react-DO8020zi.js:40:41289', page: '/recipes' },
  { date: '2026-07-29', bucket: 'Load failed', events: 12, users: 10, page: '/portions' },
  { date: '2026-07-29', bucket: 'Importing a module script failed.', events: 4, users: 4, source: 'vendor-react-DO8020zi.js:40:41315', page: '/calculator' },
]);

test('the error card names WHAT is thrown, not only where — and never ranks GA4’s absence token', () => {
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    ['ga4-js-errors', JS_ERROR_ROWS],
  ]);
  const item = cardFor(families, 'javascript-errors');
  const byLabel = new Map(item.evidence.map((row) => [row.label, row]));

  // `(not set)` outweighs every real bucket three to one in this fixture. It is
  // GA4's token for a parameter that was never registered, so it may never be
  // named as an error to go and fix.
  assert.equal(byLabel.get('Leading error').value, 'Load failed');
  assert.equal(
    byLabel.get('Leading error').detail,
    '42 events · 34 reported users · #1 of 3 distinct messages over 2026-07-28–2026-07-29',
  );
  assert.equal(
    item.evidence.some((row) => row.value === '(not set)'),
    false,
    'GA4’s absence token is not an error message and must never rank as one',
  );

  // Where the leading message is thrown. This one carries no position at all,
  // which is unknown — never "thrown by no bundle".
  assert.equal(byLabel.get('Leading error position').value, 'Not reported');
  assert.match(
    byLabel.get('Leading error position').detail,
    /GA4 recorded no source parameter for any event carrying this message — unknown, not an error without a position\. Fires most on \/calculator \(30 events\)\./,
  );

  // `source` was registered before `message`, so the position ranking covers
  // dates the message ranking cannot — including the 120 untriageable events.
  assert.equal(
    byLabel.get('Busiest source position').value,
    'vendor-react-DO8020zi.js:38:3302',
  );
  assert.equal(
    byLabel.get('Busiest source position').detail,
    '120 of 142 events carrying a position, #1 of 3 over 2026-07-26–2026-07-29 · fires most on /calculator (120 events). ' +
      'GA4 answers for this parameter on dates that carry no message, so it covers the whole window.',
  );

  // The excluded events are accounted for, not dropped.
  assert.equal(byLabel.get('Errors without a message').value, '120');
  assert.equal(
    byLabel.get('Errors without a message').detail,
    '65.2% of the 184 events this family reported in 2026-07-26–2026-07-29. ' +
      'GA4 reports the message parameter from 2026-07-28 and backfills nothing, so earlier events are permanently untriageable.',
  );

  // The actionable half reaches the sentence an operator reads first.
  assert.match(item.summary, /The most frequent message is “Load failed”\./);
  assert.deepEqual(item.sources, ['ga4/page-events', 'ga4/js-errors']);
  assert.match(item.caveat, /masked buckets, never as raw text/);
  assert.match(item.caveat, /backfills nothing, so an event reported before that registration/);

  // The leading PAGE is untouched — this rule adds the missing half, it does not
  // relitigate which page is worst (that is error-observer-disagreement's job).
  assert.equal(byLabel.get('Leading page').value, '/calculator');
  assert.equal(cardFor(families, 'error-observer-disagreement'), undefined);
});

test('a property whose triage family is absent gets exactly the card it had before', () => {
  const base = [
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'clarity-url-3d',
      clarityScriptErrorRows([
        { url: 'https://meals.example/calculator', errors: 203, viewsWithError: 43, sessions: 238, sessionPercent: 2.94 },
      ]),
    ],
  ];
  const withoutFamily = cardFor(new Map(base), 'javascript-errors');

  // nosh.example's honest zero: registered, queryable, and genuinely no js_error row.
  // The family is present and empty, and that must read exactly like absence
  // here — the card has nothing to triage either way.
  const emptyFamily = cardFor(
    new Map([...base, ['ga4-js-errors', []]]),
    'javascript-errors',
  );
  assert.deepEqual(emptyFamily, withoutFamily);

  // And the three unregistered properties, where the family never arrives at
  // all. An absent triage family is a permanent unknown; it may not change one
  // byte of what this card claims.
  assert.equal(
    withoutFamily.sources.includes('ga4/js-errors'),
    false,
    'a card that read no triage family must not cite one',
  );
  assert.equal(
    withoutFamily.evidence.some((row) => row.label.startsWith('Leading error')),
    false,
  );
  assert.equal(
    withoutFamily.summary,
    '350 js_error events affected 245 reported users. Investigate the leading page before treating its engagement or conversion gaps as a content problem.',
  );
  assert.match(withoutFamily.caveat, /GA4 event counts are aggregate/);
  assert.equal(/masked buckets/.test(withoutFamily.caveat), false);
});

test('messages are counted as masked buckets, and one position is never named twice', () => {
  // Raw text carries each occurrence's URL, so two rows of the same fault look
  // unique. Ranking raw text would return a list of ones and name a URL.
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'ga4-js-errors',
      ga4JsErrorRows([
        {
          date: '2026-07-28',
          message: 'Failed to fetch dynamically imported module: https://meals.example/assets/foods-detail-Bek69ZS2.js',
          bucket: 'Failed to fetch dynamically imported module: <url>',
          events: 16,
          users: 13,
          source: 'vendor-react-DO8020zi.js:40:41289',
          page: '/recipes',
        },
        {
          date: '2026-07-29',
          message: 'Failed to fetch dynamically imported module: https://meals.example/assets/auth-tracker-Fs3_p54o.js',
          bucket: 'Failed to fetch dynamically imported module: <url>',
          events: 14,
          users: 11,
          source: 'vendor-react-DO8020zi.js:40:41289',
          page: '/recipes',
        },
        { date: '2026-07-29', bucket: 'Load failed', events: 6, users: 5, page: '/calculator' },
      ]),
    ],
  ]);
  const item = cardFor(families, 'javascript-errors');
  const byLabel = new Map(item.evidence.map((row) => [row.label, row]));

  assert.equal(
    byLabel.get('Leading error').value,
    'Failed to fetch dynamically imported module: <url>',
  );
  assert.match(byLabel.get('Leading error').detail, /^30 events · 24 reported users/);
  assert.equal(
    JSON.stringify(item).includes('foods-detail-Bek69ZS2'),
    false,
    'the build hash of one occurrence is never a finding',
  );

  // The position is in the summary and in its own row, so the second, whole-
  // family position row would repeat a string the reader already has.
  assert.match(
    item.summary,
    /The most frequent message is “Failed to fetch dynamically imported module: <url>”, thrown at vendor-react-DO8020zi\.js:40:41289\./,
  );
  assert.equal(byLabel.get('Leading error position').value, 'vendor-react-DO8020zi.js:40:41289');
  assert.equal(
    byLabel.has('Busiest source position'),
    false,
    'the property’s busiest position IS this message’s position — say it once',
  );
  assert.equal(byLabel.get('Errors without a message').value, '0');
  assert.match(
    byLabel.get('Errors without a message').detail,
    /Every js_error event this family reported in 2026-07-28–2026-07-29 carries a message\./,
  );
});

test('a family too thin to name a leading error still says the check ran', () => {
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'ga4-js-errors',
      ga4JsErrorRows([
        { date: '2026-07-26', bucket: '(not set)', events: 40, users: 30, page: '/calculator' },
        { date: '2026-07-29', bucket: 'Script error.', events: 3, users: 3, source: 'rh-k.min.js:0:0', page: '/recipes' },
        { date: '2026-07-29', bucket: 'Load failed', events: 2, users: 2, page: '/calculator' },
      ]),
    ],
  ]);
  const item = cardFor(families, 'javascript-errors');
  const byLabel = new Map(item.evidence.map((row) => [row.label, row]));

  // Three events is the long tail of somebody's browser extension. Naming it
  // "the leading error" would spend the card's most actionable line on noise.
  assert.equal(byLabel.has('Leading error'), false);
  assert.equal(byLabel.has('Leading error position'), false);
  assert.equal(
    /The most frequent message is/.test(item.summary),
    false,
    'no bucket cleared the floor, so the card claims no leading message',
  );

  // But the family WAS read, and the reader can tell that from the accounting
  // and the position — silence here would be indistinguishable from a property
  // whose dimensions are unregistered.
  assert.equal(byLabel.get('Errors without a message').value, '40');
  assert.equal(byLabel.get('Busiest source position').value, 'rh-k.min.js:0:0');
  assert.deepEqual(item.sources, ['ga4/page-events', 'ga4/js-errors']);
});

test('the Clarity side reads one trailing snapshot, never overlapping collections added together', () => {
  const families = new Map([
    ['ga4-page-events', ga4ErrorRows({ '/calculator': 56, '/recipes': 14 })],
    [
      'clarity-url-3d',
      [
        // A superseded 72-hour read whose leader was a different page. Adding it
        // to the live one would count the same sessions twice and could invert
        // the ranking the operator is shown.
        ...clarityScriptErrorRows(
          [{ url: 'https://meals.example/portions', errors: 500, viewsWithError: 90, sessions: 300, sessionPercent: 5 }],
          '2026-07-31',
        ),
        ...clarityScriptErrorRows([
          { url: 'https://meals.example/meal-plans', errors: 203, viewsWithError: 43, sessions: 238, sessionPercent: 2.94 },
        ]),
      ],
    ],
  ]);
  const item = cardFor(families, 'error-observer-disagreement');
  assert.equal(item.evidence[0].value, '/meal-plans');
  assert.match(item.evidence[0].detail, /trailing 72 hours ending 2026-08-01/);
  assert.equal(
    item.evidence[2].value,
    'No Clarity row',
    'the live snapshot never mentioned GA4’s page — unseen by a sampled reader',
  );
  assert.match(item.evidence[2].detail, /unseen by a sampled reader, not error-free/);
  assert.equal(
    item.evidence[3].value,
    'No GA4 row',
    'GA4 never reported /meal-plans here — unreported is not zero',
  );
  assert.match(item.evidence[3].detail, /not reported, not zero/);
});

// ---------------------------------------------------------------------------
// PostHog rules. The end-to-end acceptance fixture lives in
// posthog-panel.test.mjs; these pin each rule's four states on flattened rows.
// ---------------------------------------------------------------------------

/** Flattened PostHog rows the way signal-history-analyze.mjs writes them. */
function posthogRows(rowsIn, { reportDate = '2026-09-22', start = '2026-09-09', end = reportDate } = {}) {
  return rowsIn.map((row) => ({
    asset: 'meals.example',
    report_date: reportDate,
    collected_at: '2026-09-23T12:30:04.120Z',
    data_state: 'provider-snapshot',
    provider_truncated: false,
    window_start: start,
    window_end: end,
    ...row,
  }));
}

function productOf(families) {
  return buildExecutiveSnapshot({ asset: 'meals.example', families, archives: [{}] });
}

function checkState(snapshot, key) {
  return snapshot.product?.checks.find((entry) => entry.key === key) ?? null;
}

test('PostHog: a property with no PostHog family has no product block and no product card', () => {
  const snapshot = productOf(new Map());
  assert.equal(snapshot.product, null);
  assert.equal(snapshot.items.some((item) => item.key.startsWith('posthog-')), false);
});

test('PostHog rage clicks: fires over 5% of page visitors, clears under it, and names the floor when thin', () => {
  const element = (people, pagePeople) => ({
    path: '/calculator', tag: 'input', text: '', attr: 'heightFeet', clicks: people * 2,
    people, desktop_clicks: people * 2, mobile_clicks: 0, tablet_clicks: 0, page_people: pagePeople,
  });
  const fired = productOf(new Map([['posthog-rageclicks', posthogRows([element(60, 1_000)])]]));
  assert.equal(checkState(fired, 'posthog-rage-click-cluster').state, 'fired');
  assert.equal(fired.items.find((item) => item.key === 'posthog-rage-click-cluster').primary.value, '6.0%');

  const clear = productOf(new Map([['posthog-rageclicks', posthogRows([element(40, 1_000)])]]));
  assert.equal(checkState(clear, 'posthog-rage-click-cluster').state, 'clear');
  assert.equal(clear.items.some((item) => item.key === 'posthog-rage-click-cluster'), false);

  // 50% of 100 visitors: a small page is not enough data, however high the share.
  const thin = productOf(new Map([['posthog-rageclicks', posthogRows([element(50, 100)])]]));
  const thinCheck = checkState(thin, 'posthog-rage-click-cluster');
  assert.equal(thinCheck.state, 'not-enough-data');
  assert.match(thinCheck.detail, /200 or more visitors/);
  assert.equal(thin.items.some((item) => item.key === 'posthog-rage-click-cluster'), false);

  // A row PostHog could not attribute to a page is not a page.
  const pathless = productOf(new Map([['posthog-rageclicks', posthogRows([{ ...element(90, 1_000), path: '' }])]]));
  assert.equal(checkState(pathless, 'posthog-rage-click-cluster').state, 'clear');
});

test('PostHog errors: a dominant message WITH a source file is a real concentration, not noise', () => {
  const snapshot = productOf(
    new Map([
      [
        'posthog-exceptions',
        posthogRows([
          { type: 'TypeError', message: 'x is undefined', count: 900, people: 300, has_source_file: true },
          { type: 'Error', message: 'other', count: 100, people: 80, has_source_file: true },
        ]),
      ],
    ]),
  );
  const item = snapshot.items.find((entry) => entry.key === 'posthog-error-concentration');
  assert.equal(item.title, 'One error is 90% of 1,000 exceptions');
  assert.equal(item.confidence, 'high');
  assert.equal(snapshot.product.exceptions.noise, null);
});

test('PostHog errors: no dominant message clears, and too few exceptions is not enough data', () => {
  const spread = productOf(
    new Map([
      [
        'posthog-exceptions',
        posthogRows([
          { type: 'Error', message: 'a', count: 400, people: 90, has_source_file: false },
          { type: 'Error', message: 'b', count: 350, people: 120, has_source_file: true },
          { type: 'Error', message: 'c', count: 250, people: 40, has_source_file: true },
        ]),
      ],
    ]),
  );
  const spreadCheck = checkState(spread, 'posthog-error-concentration');
  assert.equal(spreadCheck.state, 'clear');
  assert.match(spreadCheck.detail, /reaches 120 people/);
  assert.deepEqual(spread.product.exceptions.top.map((row) => row.message), ['b', 'a', 'c']);

  const few = productOf(
    new Map([['posthog-exceptions', posthogRows([{ type: 'Error', message: 'a', count: 60, people: 3, has_source_file: false }])]]),
  );
  assert.equal(checkState(few, 'posthog-error-concentration').state, 'not-enough-data');
  assert.equal(few.items.some((item) => item.key === 'posthog-error-concentration'), false);

  // Unknown source-file state is never classified as noise.
  const unknown = productOf(
    new Map([['posthog-exceptions', posthogRows([{ type: 'Error', message: 'a', count: 900, people: 30, has_source_file: '' }])]]),
  );
  const unknownCard = unknown.items.find((item) => item.key === 'posthog-error-concentration');
  assert.match(unknownCard.summary, /could not say whether it carries a source file/);
  assert.equal(unknownCard.confidence, 'medium');
});

test('PostHog once-only events: fires on first_* and *_created over 10%, clears within it, thin below 30 people', () => {
  const events = (rowsIn) => productOf(new Map([['posthog-events', posthogRows(rowsIn)]]));
  const fired = events([{ event: 'plan_created', count: 140, people: 100 }]);
  assert.equal(checkState(fired, 'posthog-once-event-repeats').state, 'fired');
  assert.match(fired.items.find((item) => item.key === 'posthog-once-event-repeats').title, /^plan_created fires 1\.4 times/);

  assert.equal(checkState(events([{ event: 'plan_created', count: 109, people: 100 }]), 'posthog-once-event-repeats').state, 'clear');
  assert.equal(checkState(events([{ event: 'meal_logged', count: 900, people: 100 }]), 'posthog-once-event-repeats').state, 'clear');
  const thin = checkState(events([{ event: 'first_login', count: 90, people: 20 }]), 'posthog-once-event-repeats');
  assert.equal(thin.state, 'not-enough-data');
  assert.match(thin.detail, /30 or more people/);
});

test('PostHog speed: only segments with 500 measurements on a top page are judged', () => {
  const segment = (path, os, measurements, lcp, inp) => ({
    path, device: 'Desktop', os, measurements, lcp_p75: lcp, inp_p75: inp, cls_p75: 0.05, fcp_p75: 900,
  });
  const vitals = (rowsIn) => productOf(new Map([['posthog-web-vitals', posthogRows(rowsIn)]]));

  const thin = vitals([segment('/calculator', 'Chrome OS', 499, 6_000, 900)]);
  const thinCheck = checkState(thin, 'posthog-slow-segment');
  assert.equal(thinCheck.state, 'not-enough-data');
  assert.match(thinCheck.detail, /500 measurements/);
  assert.equal(thin.items.some((item) => item.key === 'posthog-slow-segment'), false);

  const clear = vitals([segment('/calculator', 'Mac OS X', 5_000, 2_500, 200)]);
  assert.equal(checkState(clear, 'posthog-slow-segment').state, 'clear', 'exactly on the good line is good');
  assert.equal(clear.product.vitals.segments[0].lcpRating, 'good');

  const lcpOnly = vitals([segment('/', 'Windows', 800, 4_001, 150)]);
  const item = lcpOnly.items.find((entry) => entry.key === 'posthog-slow-segment');
  assert.deepEqual(item.primary, { value: '4,001 ms', label: 'LCP at p75' });
  assert.equal(item.confidence, 'medium', 'under 5,000 measurements');
  assert.equal(lcpOnly.product.vitals.segments[0].lcpRating, 'poor');

  // A sixth page is not a top page, however slow.
  const pages = ['/a', '/b', '/c', '/d', '/e'].map((path) => segment(path, 'Mac OS X', 10_000, 1_000, 100));
  const outside = vitals([...pages, segment('/f', 'Chrome OS', 600, 9_000, 900)]);
  assert.equal(checkState(outside, 'posthog-slow-segment').state, 'clear');
});

test('PostHog funnels: the largest drop, compared with the read seven days earlier when one exists', () => {
  const steps = (people, reportDate) =>
    posthogRows(
      people.map((count, index) => ({
        funnel_id: 'signup', name: 'Signup', step: index + 1,
        event: index === 0 ? '$pageview' : `step_${index + 1}`, path: index === 0 ? '/join' : '', people: count,
      })),
      { reportDate, start: '2026-09-16', end: reportDate },
    );

  const alone = productOf(new Map([['posthog-funnels', steps([1_000, 800, 200], '2026-09-22')]]));
  const card = alone.items.find((item) => item.key === 'posthog-funnel-drop-signup');
  assert.match(card.title, /^Signup: the biggest loss is step_2 → step_3, where 25% continue$/);
  assert.match(card.summary, /No read of this funnel ended on 2026-09-15, so there is no week-over-week comparison yet\./);
  assert.equal(card.kind, 'insight');
  assert.equal(alone.product.funnels[0].prior, null);
  assert.equal(alone.product.funnels[0].steps[0].path, '/join');
  assert.equal(alone.product.funnels[0].steps[1].path, null);

  const worse = productOf(
    new Map([['posthog-funnels', [...steps([1_000, 800, 320], '2026-09-15'), ...steps([1_000, 800, 200], '2026-09-22')]]]),
  );
  const worseCard = worse.items.find((item) => item.key === 'posthog-funnel-drop-signup');
  assert.equal(worseCard.kind, 'warning', '40% → 25% is fifteen points worse');
  assert.match(worseCard.summary, /down 15\.0 points/);
  assert.equal(worse.product.funnels[0].prior.stepConversion, 0.4);

  const thin = productOf(new Map([['posthog-funnels', steps([90, 40, 10], '2026-09-22')]]));
  const thinCheck = checkState(thin, 'posthog-funnel-drop');
  assert.equal(thinCheck.state, 'not-enough-data');
  assert.match(thinCheck.detail, /100 people/);
  assert.equal(thin.product.funnels.length, 1, 'a thin funnel is still shown, just not ranked');
});

test('PostHog product block stays bounded at the contract’s row limits', () => {
  const long = 'x'.repeat(200);
  const families = new Map([
    ['posthog-events', posthogRows(Array.from({ length: 500 }, (_, index) => ({ event: `first_event_${index}`, count: 500, people: 100 })))],
    ['posthog-exceptions', posthogRows(Array.from({ length: 100 }, (_, index) => ({ type: 'Error', message: `${long}${index}`, count: 1_000 - index, people: 50 + index, has_source_file: false, top_path: `/${long}` })))],
    ['posthog-rageclicks', posthogRows(Array.from({ length: 100 }, (_, index) => ({ path: `/page-${index}`, tag: 'input', text: long.slice(0, 80), attr: `field${index}`, clicks: 500, people: 300, page_people: 1_000 })))],
    ['posthog-web-vitals', posthogRows(Array.from({ length: 300 }, (_, index) => ({ path: `/page-${index % 20}`, device: 'Desktop', os: `os-${index}`, measurements: 5_000, lcp_p75: 5_000, inp_p75: 600, cls_p75: 0.3, fcp_p75: 2_000 })))],
    ['posthog-funnels', posthogRows(Array.from({ length: 20 }, (_, funnel) => Array.from({ length: 10 }, (__, step) => ({ funnel_id: `f${funnel}`, name: `Funnel ${funnel}`, step: step + 1, event: `e${step}`, path: '', people: 10_000 - step * 900 }))).flat())],
    ['posthog-web-daily', posthogRows(Array.from({ length: 400 }, (_, index) => ({ date: new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10), pageviews: 1, people: 1, sessions: 1 })))],
  ]);
  const snapshot = productOf(families);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot.product));
  assert.ok(bytes < 60_000, `product block is ${bytes} bytes`);
  assert.equal(snapshot.product.webDaily.days.length, 90);
  assert.equal(snapshot.product.vitals.segments.length, 12);
  assert.equal(snapshot.product.exceptions.top.length, 5);
  assert.equal(snapshot.product.rageClicks.clusters.length, 5);
  assert.equal(snapshot.product.funnels.length, 10);
  assert.equal(snapshot.product.onceEvents.length, 5);
  assert.ok(snapshot.product.exceptions.top.every((row) => row.message.length <= 200));
  // The display cut still names every product card it drops.
  const productCards = [...snapshot.items, ...snapshot.suppressedItems].filter((item) => item.key.startsWith('posthog-'));
  // Once-only, rage clicks and speed fire; no exception message dominates the
  // spread of a hundred, so that rule clears; funnels cap at three cards.
  assert.equal(productCards.length, 6);
  assert.equal(checkState(snapshot, 'posthog-error-concentration').state, 'clear');
});
