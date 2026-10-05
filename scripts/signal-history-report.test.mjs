import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { storedSearchMarket } from './signal-history-analyze.mjs';
import { analyzeArchiveFixture } from './test-fixtures/signal-report.mjs';

// Explicit fixture input: these archive regressions never require a live store,
// and never the checkout's own config/value-events.json either (bead
// ro-ujb9.97) — the frozen copy in scripts/fixture-config/.
const fixtureValueEvents = async () => ({
  body: JSON.parse(await fs.readFile(new URL('./fixture-config/value-events.json', import.meta.url), 'utf8')),
  version: 1,
});

test('an unsupported reclamation export refuses before reading settings or replacing analysis', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-reclamation-shape-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'input'));
  const file = path.join(root, 'targets.json');
  const output = path.join(root, 'analysis');
  await fs.mkdir(output);
  const kept = path.join(output, 'executive.json');
  await fs.writeFile(kept, 'last completed analysis');
  const row = { domain: 'example.org', status: 'queued' };
  for (const value of [null, {}, 'targets', { results: [row] }, [{ results: [row], success: true }], [row, { results: [] }], [null], [[]]]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(analyzeArchiveFixture({
      asset: 'meals.example',
      input: path.join(root, 'input'),
      output,
      reclamationTargets: file,
      readValueEvents: async () => assert.fail('invalid input must fail before settings are read'),
    }), /Reclamation targets must be a row array; export them with pnpm reclamation:open-targets\./u);
    assert.equal(await fs.readFile(kept, 'utf8'), 'last completed analysis');
    assert.deepEqual(await fs.readdir(output), ['executive.json']);
  }
});

test('flattens GA4, GSC, BWT, and DataForSEO archives without inventing missing rows', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-signal-dumps-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    await fs.writeFile(
      path.join(input, 'gsc.json'),
      JSON.stringify({
        schemaVersion: 1,
        asset: 'meals.example',
        integration: 'gsc',
        report: 'query',
        reportDate: '2026-07-28',
        collectedAt: '2026-07-29T12:15:00.000Z',
        dataState: 'provider-final',
        providerRows: 1,
        providerTruncated: false,
        pages: [
          {
            request: { dimensions: ['query'] },
            response: {
              rows: [
                {
                  keys: ['high protein, "easy"'],
                  clicks: 7,
                  impressions: 90,
                  ctr: 7 / 90,
                  position: 4.2,
                },
              ],
            },
          },
          {
            request: {
              dimensions: ['page'],
              dimensionFilterGroups: [
                {
                  groupType: 'and',
                  filters: [
                    {
                      dimension: 'searchAppearance',
                      operator: 'equals',
                      expression: 'RECIPE',
                    },
                  ],
                },
              ],
            },
            response: {
              rows: [
                {
                  keys: ['https://meals.example/recipes/soup'],
                  clicks: 4,
                  impressions: 50,
                  ctr: 4 / 50,
                  position: 2.1,
                },
              ],
            },
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'ga4.json'),
      JSON.stringify({
        schemaVersion: 1,
        asset: 'meals.example',
        integration: 'ga4',
        report: 'pages-screens',
        reportDate: '2026-07-28',
        collectedAt: '2026-07-29T12:15:00.000Z',
        dataState: 'revision-window',
        providerRows: 1,
        providerTruncated: false,
        pages: [
          {
            request: {},
            response: {
              dimensionHeaders: [{ name: 'unifiedPagePathScreen' }],
              metricHeaders: [{ name: 'screenPageViews' }],
              rows: [
                {
                  dimensionValues: [{ value: '/meal-plan' }],
                  metricValues: [{ value: '42' }],
                },
              ],
            },
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'bing.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'microsoft',
        asset: 'meals.example',
        integration: 'bing-webmaster',
        report: 'crawl-issues',
        reportDate: '2026-07-28',
        collectedAt: '2026-07-29T12:15:00.000Z',
        dataState: 'provider-snapshot',
        providerRows: 1,
        providerTruncated: false,
        pages: [
          {
            request: {
              method: 'GetCrawlIssues',
              siteUrl: 'https://meals.example/',
            },
            response: {
              d: [
                {
                  __type: 'UrlWithCrawlIssues:#Microsoft.Bing.Webmaster.Api',
                  Url: 'https://meals.example/old-page',
                  HttpCode: 404,
                  Issues: 20,
                  InLinks: 3,
                },
              ],
            },
          },
        ],
      }),
    );
    const dataForSeoArchive = (report, result, cost) => ({
      schemaVersion: 1,
      provider: 'dataforseo',
      asset: 'meals.example',
      integration: 'dataforseo',
      report,
      reportDate: '2026-07-28',
      collectedAt: '2026-07-29T12:45:00.000Z',
      dataState: 'provider-snapshot',
      providerRows: 1,
      providerTruncated: false,
      pages: [
        {
          request: { path: `/fixture/${report}` },
          response: {
            status_code: 20000,
            cost,
            tasks: [
              {
                status_code: 20000,
                result: [result],
              },
            ],
          },
        },
      ],
    });
    await Promise.all([
      fs.writeFile(
        path.join(input, 'dataforseo-ranked.json'),
        JSON.stringify(
          dataForSeoArchive(
            'ranked-keywords',
            {
              items_count: 1,
              items: [
                {
                  keyword_data: {
                    keyword: 'easy weekly meal plan',
                    keyword_info: {
                      search_volume: 500,
                      cpc: 2.5,
                      competition_level: 'MEDIUM',
                    },
                    keyword_properties: { keyword_difficulty: 28 },
                    search_intent_info: { main_intent: 'commercial' },
                    serp_info: {
                      serp_item_types: [
                        'organic',
                        'people_also_ask',
                      ],
                    },
                  },
                  ranked_serp_element: {
                    serp_item: {
                      type: 'organic',
                      rank_group: 7,
                      rank_absolute: 8,
                      title: 'Meal plan',
                      url: 'https://meals.example/meal-plan',
                      relative_url: '/meal-plan',
                      etv: 21.5,
                      estimated_paid_traffic_cost: 53.75,
                      rank_changes: {
                        previous_rank_absolute: 10,
                        is_up: true,
                      },
                      backlinks_info: {
                        backlinks: 12,
                        referring_domains: 8,
                      },
                    },
                  },
                },
              ],
            },
            0.011,
          ),
        ),
      ),
      fs.writeFile(
        path.join(input, 'dataforseo-backlinks.json'),
        JSON.stringify(
          dataForSeoArchive(
            'backlinks-summary',
            {
              target: 'meals.example',
              rank: 412,
              backlinks: 800,
              backlinks_spam_score: 2,
              referring_domains: 240,
              referring_pages: 700,
              broken_backlinks: 4,
            },
            0.02,
          ),
        ),
      ),
      fs.writeFile(
        path.join(input, 'dataforseo-backlink-movement.json'),
        JSON.stringify(
          dataForSeoArchive(
            'backlinks-new-lost',
            {
              items_count: 1,
              items: [
                {
                  date: '2026-07-27 00:00:00 +00:00',
                  new_backlinks: 12,
                  lost_backlinks: 5,
                  new_referring_domains: 8,
                  lost_referring_domains: 2,
                  new_referring_main_domains: 7,
                  lost_referring_main_domains: 2,
                },
              ],
            },
            0.02,
          ),
        ),
      ),
      ...[
        ['google', 7, 900],
        ['chatgpt', 4, 600],
      ].map(([platform, mentions, aiSearchVolume]) =>
        fs.writeFile(
          path.join(input, `dataforseo-llm-${platform}.json`),
          JSON.stringify(
            dataForSeoArchive(
              `llm-mentions-${platform}`,
              {
                aggregated_metrics: {
                  platform: [
                    {
                      key: platform === 'chatgpt' ? 'chat_gpt' : platform,
                      mentions,
                      ai_search_volume: aiSearchVolume,
                    },
                  ],
                  sources_domain: [
                    {
                      key: 'meals.example',
                      mentions,
                      ai_search_volume: aiSearchVolume,
                    },
                  ],
                },
              },
              0.1,
            ),
          ),
        ),
      ),
    ]);
    // One archive, one provider call per tracked query PER DEVICE. Each page
    // exercises a different AI Overview state, including the two that must never
    // collapse into "no overview".
    //
    // `device` is omitted from most of these bodies on purpose: that is the
    // shape of every archive written before 2026-08-04, and those rows must come
    // back as `desktop` — the collector had no other literal in it — rather than
    // as an unknown device.
    const serpPage = (
      keyword,
      items,
      taskOverrides = {},
      device = null,
      resultOverrides = {},
    ) => ({
      request: {
        path: '/serp/google/organic/live/advanced',
        attempts:
          Number(taskOverrides.status_code) !== 20000 &&
          taskOverrides.status_code !== undefined
            ? 3
            : 1,
        body: {
          keyword,
          depth: 20,
          load_async_ai_overview: true,
          ...(device ? { device } : {}),
        },
      },
      response: {
        status_code: 20000,
        cost: 0.004,
        tasks: [
          {
            status_code: 20000,
            result: [{ keyword, items, ...resultOverrides }],
            ...taskOverrides,
          },
        ],
      },
    });
    await fs.writeFile(
      path.join(input, 'dataforseo-serp-panel.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'dataforseo',
        asset: 'meals.example',
        integration: 'dataforseo',
        report: 'serp-panel',
        propertyRef: 'meals.example',
        reportDate: '2026-07-28',
        collectedAt: '2026-07-29T12:45:00.000Z',
        dataState: 'provider-snapshot',
        providerRows: 4,
        providerTruncated: true,
        pages: [
          serpPage('meals calculator', [
            {
              type: 'ai_overview',
              asynchronous_ai_overview: true,
              items: [{ type: 'ai_overview_element', text: 'A plate is…' }],
              references: [
                { domain: 'meals.gov' },
                { url: 'https://blog.meals.example/portions' },
              ],
            },
            { type: 'organic', rank_group: 1, domain: 'meals.gov' },
            {
              type: 'organic',
              rank_group: 2,
              domain: 'www.meals.example',
              url: 'https://meals.example/calculator',
              // Read and carrying no sitelink block: an observation, so `false`.
              links: [],
            },
            { type: 'organic', rank_group: 3, domain: 'wadairy.org' },
            // The property's SECOND slot on the same result page (`ro-463`) —
            // the double listing GSC can only ever show as split impressions.
            {
              type: 'organic',
              rank_group: 5,
              domain: 'meals.example',
              url: 'https://meals.example/calculator/dri',
            },
          ]),
          serpPage(
            'food groups',
            [
              {
                type: 'ai_overview',
                references: [{ domain: 'nih.gov' }, { domain: 'wadairy.org' }],
                items: [{ type: 'ai_overview_element', text: 'Five groups…' }],
              },
              { type: 'organic', rank_group: 1, domain: 'nih.gov' },
            ],
            {},
            null,
            // A feature the provider NAMED and returned no block for. It was on
            // the page, so `serp_features` carries it — the same call
            // `aiOverviewState` makes about a declared overview.
            { item_types: ['organic', 'ai_overview', 'people_also_ask'] },
          ),
          // No overview anywhere in a page that parsed: an observation, so false.
          serpPage('meals worksheets', [
            {
              type: 'organic',
              rank_group: 4,
              domain: 'meals.example',
              url: 'https://meals.example/worksheets',
              links: [
                { type: 'link_element', title: 'Printables', url: 'https://meals.example/worksheets/print' },
              ],
            },
          ]),
          // The asynchronous overview never delivered content. Unknown, and the
          // header comment says why it must not read as false.
          serpPage('canada food guide', [
            { type: 'ai_overview', asynchronous_ai_overview: true },
            { type: 'organic', rank_group: 1, domain: 'canada.ca' },
          ]),
          // Billed, unanswered: still one row, entirely unknown.
          serpPage('dri calculator', [], {
            status_code: 40501,
            status_message: 'Invalid Field: keyword.',
            result: null,
          }),
          // The device pair, in collection order (mobile, then desktop), for a
          // term the ranked-keyword inventory also carries. The two surfaces
          // disagree — an overview consumes the click on the phone and there is
          // none on the desktop — which is the whole reason ro-o1n bought the
          // second device, and is exactly what a single-device panel could not
          // have said.
          serpPage(
            'easy weekly meal plan',
            [
              {
                type: 'ai_overview',
                references: [{ domain: 'nih.gov' }],
                items: [{ type: 'ai_overview_element', text: 'Plan ahead…' }],
              },
              { type: 'organic', rank_group: 5, domain: 'nih.gov' },
            ],
            {},
            'mobile',
          ),
          serpPage(
            'easy weekly meal plan',
            [
              {
                type: 'organic',
                rank_group: 7,
                domain: 'meals.example',
                url: 'https://meals.example/meal-plan',
              },
            ],
            {},
            'desktop',
          ),
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents,
      asset: 'meals.example',
      input,
      output,
    });
    assert.equal(summary.archiveCount, 9);
    assert.equal(summary.executive.insightCount, 4);
    assert.deepEqual(summary.executiveSnapshot,
      JSON.parse(await fs.readFile(path.join(output, 'executive.json'), 'utf8')));
    assert.equal(summary.executiveSnapshot.generatedAt, summary.analyzedAt);
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8')).executiveSnapshot, undefined);
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [
        { name: 'bing-webmaster-crawl-issues', rows: 1 },
        { name: 'dataforseo-backlinks-new-lost', rows: 1 },
        { name: 'dataforseo-backlinks-summary', rows: 1 },
        { name: 'dataforseo-llm-mentions-chatgpt', rows: 2 },
        { name: 'dataforseo-llm-mentions-google', rows: 2 },
        { name: 'dataforseo-ranked-keywords', rows: 1 },
        { name: 'dataforseo-serp-panel', rows: 7 },
        { name: 'ga4-pages-screens', rows: 1 },
        { name: 'gsc-query', rows: 2 },
      ],
    );
    const panel = (
      await fs.readFile(path.join(output, 'dataforseo-serp-panel.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const columns = panel[0].split(',');
    // An unlabelled panel flattens to exactly the columns it always had, plus
    // `device`: the cluster column exists only where an archived observation
    // carried one, so a property that never labelled a panel gains nothing to
    // explain away. The device column is unconditional, because every page was
    // read on one and the archive has always said which.
    assert.ok(!columns.includes('query_label'));
    const panelRows = panel.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(columns.map((name, index) => [name, cells[index]]));
    });
    const byQuery = new Map(panelRows.map((row) => [row.query, row]));
    // A subdomain result is still this property holding the position.
    assert.equal(byQuery.get('meals calculator').best_rank, '2');
    assert.equal(
      byQuery.get('meals calculator').best_url,
      'https://meals.example/calculator',
    );
    assert.equal(byQuery.get('meals calculator').aio_present, 'true');
    assert.equal(byQuery.get('meals calculator').aio_cites_us, 'true');
    assert.equal(
      byQuery.get('meals calculator').top3_domains,
      'meals.gov|meals.example|wadairy.org',
    );
    assert.equal(byQuery.get('meals calculator').organic_results, '4');
    // The property's second slot on the same page, bounded like the first
    // (`ro-463`): rank and URL together, because a rank nobody can attribute to
    // a page is a fact with no next step.
    assert.equal(byQuery.get('meals calculator').second_rank, '5');
    assert.equal(
      byQuery.get('meals calculator').second_url,
      'https://meals.example/calculator/dri',
    );
    // Our result was read and carried no sitelink block: an OBSERVATION.
    assert.equal(byQuery.get('meals calculator').sitelinks_us, 'false');
    assert.equal(byQuery.get('meals calculator').serp_features, 'ai_overview');
    // An overview that fires and cites other people.
    assert.equal(byQuery.get('food groups').aio_present, 'true');
    assert.equal(byQuery.get('food groups').aio_cites_us, 'false');
    // No result inside the tracked depth is empty, never a rank of 0.
    assert.equal(byQuery.get('food groups').best_rank, '');
    assert.equal(byQuery.get('food groups').tracked_depth, '20');
    // THE ABSENT-VERSUS-FALSE CASE (`ro-463`). We hold no result inside the
    // tracked depth here, so there was no result of ours for sitelinks to hang
    // off: unknown, never "the sitelinks are gone". Read as `false`, this cell
    // would turn every week the property ranked past depth 20 into a sitelink
    // loss alert (the rule waiting on it is `ro-770`).
    assert.equal(byQuery.get('food groups').sitelinks_us, '');
    assert.equal(byQuery.get('food groups').second_rank, '');
    assert.equal(byQuery.get('food groups').second_url, '');
    // A feature the provider named without returning its block was still on the
    // page; `organic` is dropped because a token in every row is a constant.
    assert.equal(
      byQuery.get('food groups').serp_features,
      'ai_overview|people_also_ask',
    );
    // Read the page, found no overview: an observation.
    assert.equal(byQuery.get('meals worksheets').aio_present, 'false');
    assert.equal(byQuery.get('meals worksheets').aio_cites_us, 'false');
    // Our result carries a sitelink block, and nothing but organic results were
    // on the page — an empty `serp_features` on a row that HAS a result is an
    // observation, and `provider_status` is what tells it from an unknown.
    assert.equal(byQuery.get('meals worksheets').sitelinks_us, 'true');
    assert.equal(byQuery.get('meals worksheets').serp_features, '');
    assert.equal(byQuery.get('meals worksheets').provider_status, '');
    // The two unknown cases stay empty — this is the distinction the family
    // exists to preserve, so it is asserted separately from the `false` above.
    assert.equal(byQuery.get('canada food guide').aio_present, '');
    assert.equal(byQuery.get('canada food guide').aio_cites_us, '');
    // The overview block was there to be seen even though it never loaded, so
    // the page's composition is still an observation.
    assert.equal(byQuery.get('canada food guide').serp_features, 'ai_overview');
    assert.equal(byQuery.get('canada food guide').sitelinks_us, '');
    assert.equal(byQuery.get('dri calculator').aio_present, '');
    assert.equal(byQuery.get('dri calculator').aio_cites_us, '');
    assert.equal(byQuery.get('dri calculator').best_rank, '');
    // Billed and unanswered: every new column is unknown too, and nothing on
    // this row may read as an observed absence.
    assert.equal(byQuery.get('dri calculator').second_rank, '');
    assert.equal(byQuery.get('dri calculator').second_url, '');
    assert.equal(byQuery.get('dri calculator').sitelinks_us, '');
    assert.equal(byQuery.get('dri calculator').serp_features, '');
    assert.match(
      byQuery.get('dri calculator').provider_status,
      /Invalid Field/,
    );
    assert.equal(byQuery.get('dri calculator').provider_attempts, '3');
    // The device reaches the CSV as its own column, taken off the archived
    // request. A page written before the collector sent one is desktop — it
    // could not have been anything else — never blank.
    assert.ok(columns.includes('device'));
    assert.equal(byQuery.get('meals calculator').device, 'desktop');
    assert.equal(byQuery.get('dri calculator').device, 'desktop');
    // The pair: one query, two devices, two rows that never merge, each with
    // its own AI Overview verdict and its own metered call.
    const pair = panelRows.filter((row) => row.query === 'easy weekly meal plan');
    assert.deepEqual(
      pair.map((row) => row.device),
      ['mobile', 'desktop'],
    );
    assert.equal(pair[0].aio_present, 'true');
    assert.equal(pair[0].aio_cites_us, 'false');
    assert.equal(pair[0].best_rank, '');
    assert.equal(pair[1].aio_present, 'false');
    assert.equal(pair[1].best_rank, '7');
    assert.equal(pair[0].row_grain, 'tracked-query-device');
    const gsc = await fs.readFile(path.join(output, 'gsc-query.csv'), 'utf8');
    assert.match(gsc, /"high protein, ""easy"""/);
    assert.match(gsc, /searchAppearance/);
    assert.match(gsc, /RECIPE/);
    assert.match(gsc, /https:\/\/meals\.example\/recipes\/soup/);
    assert.match(gsc, /row_grain/);
    assert.match(gsc, /query/);
    assert.match(gsc, /page/);
    assert.match(gsc, /2026-07-28/);
    const ga4 = await fs.readFile(path.join(output, 'ga4-pages-screens.csv'), 'utf8');
    assert.match(ga4, /unifiedPagePathScreen/);
    assert.match(ga4, /\/meal-plan/);
    assert.match(ga4, /42/);
    const bing = await fs.readFile(
      path.join(output, 'bing-webmaster-crawl-issues.csv'),
      'utf8',
    );
    assert.match(bing, /https:\/\/meals\.example\/old-page/);
    assert.match(bing, /http_code/);
    assert.match(bing, /issue_names/);
    assert.match(bing, /Code4xx\|BlockedByRobotsTxt/);
    assert.doesNotMatch(bing, /__type/);
    const ranked = await fs.readFile(
      path.join(output, 'dataforseo-ranked-keywords.csv'),
      'utf8',
    );
    assert.match(ranked, /easy weekly meal plan/);
    assert.match(ranked, /keyword_difficulty/);
    assert.match(ranked, /provider_cost_usd/);
    const backlinkMovement = await fs.readFile(
      path.join(output, 'dataforseo-backlinks-new-lost.csv'),
      'utf8',
    );
    assert.match(backlinkMovement, /new_referring_domains/);
    assert.match(backlinkMovement, /2026-07-27/);
    assert.ok(!gsc.includes('2026-07-27'), 'missing dates are not synthesized');
    const executive = JSON.parse(
      await fs.readFile(path.join(output, 'executive.json'), 'utf8'),
    );
    assert.equal(executive.asset, 'meals.example');
    assert.ok(
      executive.methodology.some((line) => /remain unknown/.test(line)),
    );
    assert.equal(executive.items[0].key, 'bing-crawl-issues');
    assert.equal(
      executive.items.find(
        (item) => item.key === 'dataforseo-ranking-opportunity',
      )?.primary.value,
      '500',
    );
    assert.equal(executive.searchIntelligence.rankings.top10, 1);
    assert.equal(executive.searchIntelligence.backlinks.referringDomains, 240);
    assert.equal(executive.searchIntelligence.ai.googleMentions, 7);
    assert.equal(executive.searchIntelligence.ai.chatgptMentions, 4);
    // Five single-call families quoted once each, plus one metered call per
    // tracked query PER DEVICE — the panel is the only family whose rows add,
    // and the snapshot's cost is the real bill or it is worth nothing. The
    // phone's calls are billed, so the phone's rows count here.
    assert.ok(
      Math.abs(executive.searchIntelligence.costUsd - (0.251 + 7 * 0.004)) <
        0.000001,
    );
    // ...and BOTH of the snapshot's panel readers now carry the split through
    // (ro-14d.1). Neither reduces the panel to one row per query any more, so
    // neither can quietly report the surface its tie-break happened to land on
    // — which is what this assertion catches: the phone row says an overview
    // consumes this query's click, the desktop row says the page is clear, and
    // a reader that kept one of them would erase a finding either way.
    const decided = executive.searchQueries.dataforseo.queries.find(
      (row) => row.query === 'easy weekly meal plan',
    );
    assert.deepEqual(decided.aioDevices, [
      { device: 'mobile', aioPresent: true, aioCitesUs: false },
      { device: 'desktop', aioPresent: false, aioCitesUs: false },
    ]);
    // The Tower's panel scoreboard reads this block: one row per (term,
    // device), each naming its own surface, in collection order. The Tower is
    // what groups them back into one tracked term for every count it states.
    const board = executive.serpPanel.queries.filter(
      (row) => row.query === 'easy weekly meal plan',
    );
    assert.deepEqual(
      board.map((row) => [row.device, row.aioPresent, row.bestRank]),
      [
        ['mobile', true, null],
        ['desktop', false, 7],
      ],
    );
    // A page archived before the collector sent a device is desktop, never an
    // unnamed surface: it could not have been anything else.
    assert.equal(
      executive.serpPanel.queries.find(
        (row) => row.query === 'meals calculator',
      ).device,
      'desktop',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an empty newest Clarity revision retains provenance rather than reviving older page facts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-clarity-revision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'); await fs.mkdir(input);
  const archive = { schemaVersion: 1, provider: 'microsoft', asset: 'meals.example', integration: 'clarity', report: 'url-3d',
    reportDate: '2026-07-31', dataState: 'provider-snapshot', providerTruncated: false };
  for (const [name, collectedAt, information] of [
    ['a', '2026-07-31T04:30:00.000Z', [{ Url: 'https://meals.example/planner', sessionsCount: '114', subTotal: '19' }]],
    ['b', '2026-07-31T05:30:00.000Z', []],
  ]) await fs.writeFile(path.join(input, `${name}.json`), JSON.stringify({ ...archive, collectedAt, providerRows: information.length,
    pages: [{ request: { numOfDays: 3, dimension1: 'URL' }, response: [{ metricName: 'ScriptErrorCount', information }] }] }));
  const summary = await analyzeArchiveFixture({ asset: 'meals.example', input, output: path.join(root, 'output'), readValueEvents: fixtureValueEvents });
  assert.deepEqual(summary.executiveSnapshot.clarity, { source: 'clarity', reportDate: '2026-07-31',
    collectedAt: '2026-07-31T05:30:00.000Z', windowHours: 72, truncated: false, page: null, unattributedSessions: null });
});

test('flattens Clarity metric blocks long, keeping each block its own schema', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-clarity-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    await fs.writeFile(
      path.join(input, 'clarity.json'),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'microsoft',
        asset: 'meals.example',
        integration: 'clarity',
        report: 'url-3d',
        reportDate: '2026-07-31',
        collectedAt: '2026-07-31T04:30:00.000Z',
        dataState: 'provider-snapshot',
        providerRows: 4,
        providerTruncated: false,
        pages: [
          {
            request: { numOfDays: 3, dimension1: 'URL' },
            response: [
              {
                metricName: 'DeadClickCount',
                information: [
                  {
                    sessionsCount: '114',
                    sessionsWithMetricPercentage: 11.4,
                    pagesViews: '14',
                    subTotal: '19',
                    Url: 'https://meals.example/my',
                  },
                ],
              },
              {
                // A different block, a genuinely different schema.
                metricName: 'ScrollDepth',
                information: [
                  { averageScrollDepth: 67.78, Url: 'https://meals.example/my' },
                ],
              },
              {
                // The unattributed aggregate really comes back with Url: null.
                metricName: 'Traffic',
                information: [
                  {
                    totalSessionCount: '0',
                    totalBotSessionCount: '1',
                    distinctUserCount: '245',
                    Url: null,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents,
      asset: 'meals.example',
      input,
      output,
    });
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [{ name: 'clarity-url-3d', rows: 3 }],
    );

    const csv = await fs.readFile(path.join(output, 'clarity-url-3d.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    const headers = lines[0].split(',');
    // Clarity capitalizes the dimension it was asked for; the CSV reads like
    // every other family.
    assert.ok(headers.includes('url'));
    assert.ok(headers.includes('metric'));
    assert.ok(headers.includes('average_scroll_depth'));
    assert.ok(headers.includes('total_bot_session_count'));
    assert.ok(!csv.includes('Url,'), 'the provider capitalization is normalized');

    const byMetric = new Map(
      lines.slice(1).map((line) => {
        const cells = line.split(',');
        return [
          cells[headers.indexOf('metric')],
          Object.fromEntries(headers.map((h, i) => [h, cells[i]])),
        ];
      }),
    );
    assert.equal(byMetric.get('DeadClickCount').url, 'https://meals.example/my');
    assert.equal(byMetric.get('DeadClickCount').sub_total, '19');
    assert.equal(byMetric.get('ScrollDepth').average_scroll_depth, '67.78');
    // A block that does not carry a field leaves it EMPTY rather than 0 — the
    // metrics are not a shared schema and must not be padded into one.
    assert.equal(byMetric.get('ScrollDepth').sub_total, '');
    // The unattributed aggregate keeps a null URL as absent, never as "".
    assert.equal(byMetric.get('Traffic').url, '');
    assert.equal(byMetric.get('Traffic').distinct_user_count, '245');
    assert.deepEqual(summary.executiveSnapshot.clarity, { source: 'clarity', reportDate: '2026-07-31',
      collectedAt: '2026-07-31T04:30:00.000Z', windowHours: 72, truncated: false, page: null, unattributedSessions: 0 });

    const caveats = JSON.parse(
      await fs.readFile(path.join(output, 'summary.json'), 'utf8'),
    ).caveats;
    assert.ok(
      caveats.some((line) => /behavior rankings, never as population counts/.test(line)),
      'the sampling and adblock caveat must ride with the data',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('buckets js_error messages so recurring faults count, and keeps absences absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-js-errors-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  const errorRow = (message, source, page, eventCount, totalUsers) => ({
    dimensionValues: [{ value: message }, { value: source }, { value: page }],
    metricValues: [{ value: String(eventCount) }, { value: String(totalUsers) }],
  });
  try {
    await fs.writeFile(
      path.join(input, 'ga4-js-errors.json'),
      JSON.stringify({
        schemaVersion: 1,
        asset: 'meals.example',
        integration: 'ga4',
        report: 'js-errors',
        reportDate: '2026-07-28',
        collectedAt: '2026-07-29T12:15:00.000Z',
        dataState: 'revision-window',
        providerRows: 3,
        providerTruncated: false,
        pages: [
          {
            request: {
              dimensions: [
                { name: 'customEvent:message' },
                { name: 'customEvent:source' },
                { name: 'unifiedPagePathScreen' },
              ],
              dimensionFilter: {
                filter: {
                  fieldName: 'eventName',
                  stringFilter: { matchType: 'EXACT', value: 'js_error' },
                },
              },
            },
            response: {
              dimensionHeaders: [
                { name: 'customEvent:message' },
                { name: 'customEvent:source' },
                { name: 'unifiedPagePathScreen' },
              ],
              metricHeaders: [{ name: 'eventCount' }, { name: 'totalUsers' }],
              rows: [
                // The same fault twice. Only the URL and the line number differ,
                // which is exactly what makes the raw column uncountable.
                errorRow(
                  "TypeError: Cannot read properties of null (reading 'value') at https://meals.example/calculator?step=2 line 42",
                  'https://meals.example/assets/index-a1b2c3d4e5f6.js',
                  '/calculator',
                  125,
                  88,
                ),
                errorRow(
                  "TypeError: Cannot read properties of null (reading 'value') at https://meals.example/recipes line 907",
                  'https://meals.example/assets/index-a1b2c3d4e5f6.js',
                  '/recipes',
                  31,
                  24,
                ),
                // A real js_error whose message parameter was absent.
                errorRow('(not set)', '(not set)', '/plan', 9, 7),
              ],
            },
          },
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents,
      asset: 'meals.example',
      input,
      output,
    });
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [{ name: 'ga4-js-errors', rows: 3 }],
    );

    const csv = await fs.readFile(path.join(output, 'ga4-js-errors.csv'), 'utf8');
    const headers = csv.split('\n')[0].split(',');
    // The `customEvent:` prefix is a Data API transport detail, not a column.
    assert.ok(!csv.includes('customEvent:'), 'the API prefix is stripped');
    assert.ok(headers.includes('message'));
    assert.ok(headers.includes('source'));
    assert.ok(headers.includes('message_bucket'));
    assert.ok(headers.includes('unifiedPagePathScreen'));

    // Both occurrences of the one fault collapse to a single countable bucket.
    const bucket =
      "TypeError: Cannot read properties of null (reading 'value') at <url> line <n>";
    assert.equal(csv.split(bucket).length - 1, 2);
    // …without the raw messages being rewritten: the archive stays verbatim.
    assert.match(csv, /calculator\?step=2 line 42/);
    assert.match(csv, /recipes line 907/);

    // GA4's own token for "the event carried no such parameter" is an absence.
    // Bucketing it in with real messages would invent a fault nobody reported,
    // and blanking it would read as an empty message string.
    const notSet = csv
      .split('\n')
      .find((line) => line.includes('/plan'))
      .split(',');
    assert.equal(notSet[headers.indexOf('message')], '(not set)');
    assert.equal(notSet[headers.indexOf('message_bucket')], '(not set)');
    assert.equal(notSet[headers.indexOf('eventCount')], '9');

    const caveats = JSON.parse(
      await fs.readFile(path.join(output, 'summary.json'), 'utf8'),
    ).caveats;
    assert.ok(
      caveats.some((line) => /custom dimensions and never backfills/.test(line)),
      'the CSV cannot state the unregistered case, so the summary must',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** One GA4 archive in the downloads layout the panel refresh writes. */
function ga4ChannelArchive({ report = 'traffic-acquisition', reportDate, collectedAt, sessions }) {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'google',
    asset: 'meals.example',
    integration: 'ga4',
    report,
    reportDate,
    collectedAt,
    dataState: 'revision-window',
    providerRows: 1,
    providerTruncated: false,
    pages: [
      {
        request: { dateRanges: [{ startDate: reportDate, endDate: reportDate }] },
        response: {
          dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }],
          metricHeaders: [{ name: 'sessions' }],
          rows: [
            {
              dimensionValues: [{ value: 'Unassigned' }],
              metricValues: [{ value: String(sessions) }],
            },
          ],
        },
      },
    ],
  });
}

test('marks a GA4 attribution day provisional until it was collected two days after it (ro-wo0j)', async () => {
  // meals.example's 2026-09-21, collected at D+1, read 3,380 "Unassigned"
  // sessions and was published as final. Every day collected at D+2 or later
  // read correctly.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reindex-ga4-settle-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  const write = async (report, reportDate, body) => {
    const file = path.join(input, 'ga4', report, `${reportDate}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  };
  try {
    // The newest day: only its D+1 copy exists.
    await write('traffic-acquisition', '2026-09-21', ga4ChannelArchive({
      reportDate: '2026-09-21', collectedAt: '2026-09-22T12:15:00.000Z', sessions: 3380,
    }));
    // Revised at D+2: a new object, collected that day.
    await write('traffic-acquisition', '2026-09-20', ga4ChannelArchive({
      reportDate: '2026-09-20', collectedAt: '2026-09-22T12:15:00.000Z', sessions: 212,
    }));
    // Re-collected UNCHANGED at D+2: the object still says D+1, but the
    // manifest beside it records the D+2 run that confirmed those bytes.
    await write('traffic-acquisition', '2026-09-19', ga4ChannelArchive({
      reportDate: '2026-09-19', collectedAt: '2026-09-20T12:15:00.000Z', sessions: 188,
    }));
    // Not an attribution family: no column is invented for it.
    await write('pages-screens', '2026-09-21', ga4ChannelArchive({
      report: 'pages-screens', reportDate: '2026-09-21', collectedAt: '2026-09-22T12:15:00.000Z', sessions: 9,
    }));
    await fs.writeFile(path.join(input, 'manifest.json'), JSON.stringify({
      asset: 'meals.example',
      objects: [
        { integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-19', finishedAt: '2026-09-21T12:16:02.000Z' },
        { integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-20', finishedAt: '2026-09-22T12:16:02.000Z' },
        { integration: 'ga4', report: 'traffic-acquisition', reportDate: '2026-09-21', finishedAt: '2026-09-22T12:16:02.000Z' },
      ],
    }));

    await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output });

    const lines = (await fs.readFile(path.join(output, 'ga4-traffic-acquisition.csv'), 'utf8'))
      .trim()
      .split('\n');
    const headers = lines[0].split(',');
    const byDate = Object.fromEntries(
      lines.slice(1).map((line) => {
        const cells = line.split(',');
        return [cells[headers.indexOf('report_date')], cells[headers.indexOf('provisional')]];
      }),
    );
    assert.deepEqual(byDate, { '2026-09-19': '0', '2026-09-20': '0', '2026-09-21': '1' });

    const pages = await fs.readFile(path.join(output, 'ga4-pages-screens.csv'), 'utf8');
    assert.ok(!pages.split('\n')[0].split(',').includes('provisional'));

    const caveats = JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8')).caveats;
    assert.ok(caveats.some((line) => /provisional=1/.test(line) && /attribution/.test(line)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** One archived Bing AI Performance export, in the shape the ingest door writes
 * it (workers/ingest/src/bing-ai-exports.ts). */
function bingAiArchive({ report, exportDate, rows, file = 'export.csv' }) {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'microsoft',
    asset: 'meals.example',
    integration: 'bing-webmaster',
    report,
    reportDate: exportDate,
    collectedAt: `${exportDate}T13:00:00.000Z`,
    dataState: 'provider-snapshot',
    providerRows: rows.length,
    providerTruncated: false,
    pages: [
      {
        request: {
          source: 'operator-export',
          exportName: 'AIPerformanceOverviewStats',
          exportDate,
          file,
          parser: 'bing-ai-export/1',
        },
        response: { csvBase64: 'aWdub3JlZA==', rows },
      },
    ],
  });
}

test('flattens the operator-dropped Bing AI Performance families', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-bing-ai-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    await fs.writeFile(
      path.join(input, 'overview.json'),
      bingAiArchive({
        report: 'ai-overview',
        exportDate: '2026-08-04',
        rows: [
          { date: '2026-05-04', citations: 326, citedPages: 11 },
          { date: '2026-06-15', citations: 8123, citedPages: 41 },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'queries.json'),
      bingAiArchive({
        report: 'ai-queries',
        exportDate: '2026-08-04',
        rows: [
          {
            query: 'how much protein should i eat daily',
            intent: 'Learn and Solve',
            topic: 'Protein & Muscle Building Nutrition',
            citations: 42488,
            citationSharePercent: 27.24,
          },
          // Bing does not always label a query; an unlabeled one stays empty.
          {
            query: 'meal plan',
            intent: '',
            topic: '',
            citations: 2627,
            citationSharePercent: 24.25,
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'pages.json'),
      bingAiArchive({
        report: 'ai-pages',
        exportDate: '2026-08-04',
        rows: [{ page: 'https://meals.example/protein-calculator', citations: 294996 }],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output });
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [
        { name: 'bing-webmaster-ai-overview', rows: 2 },
        { name: 'bing-webmaster-ai-pages', rows: 1 },
        { name: 'bing-webmaster-ai-queries', rows: 2 },
      ],
    );

    const queries = (
      await fs.readFile(path.join(output, 'bing-webmaster-ai-queries.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const headers = queries[0].split(',');
    const cells = (line) =>
      Object.fromEntries(headers.map((header, index) => [header, line.split(',')[index]]));
    // report_date is the day the FILE was exported: this family has no per-day
    // breakdown at all, and pretending otherwise would date a quarter of
    // citations to one afternoon.
    const top = cells(queries[1]);
    assert.equal(top.report_date, '2026-08-04');
    assert.equal(top.row_grain, 'grounding-query');
    assert.equal(top.citations, '42488');
    // Percentage points, as the export writes them.
    assert.equal(top.citation_share_percent, '27.24');
    const unlabeled = cells(queries[2]);
    assert.equal(unlabeled.intent, '');
    assert.equal(unlabeled.topic, '');

    const overview = (
      await fs.readFile(path.join(output, 'bing-webmaster-ai-overview.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const overviewHeaders = overview[0].split(',');
    // The daily family is the only one carrying a measured day, and that is a
    // different column from the day it was exported.
    assert.ok(overviewHeaders.includes('provider_date'));
    assert.ok(overviewHeaders.includes('cited_pages'));
    assert.equal(
      overview[1].split(',')[overviewHeaders.indexOf('provider_date')],
      '2026-05-04',
    );

    const pages = await fs.readFile(
      path.join(output, 'bing-webmaster-ai-pages.csv'),
      'utf8',
    );
    assert.match(pages, /https:\/\/meals\.example\/protein-calculator/);
    assert.match(pages, /294996/);

    const caveats = JSON.parse(
      await fs.readFile(path.join(output, 'summary.json'), 'utf8'),
    ).caveats;
    assert.ok(
      caveats.some((line) => /nobody has dropped that export yet/.test(line)),
      'an absent AI family must not read as "Bing cited nothing"',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The idempotency that matters most: the operator re-exports a series that
// overlaps what they exported last month, and a day counted twice would double
// the citations this whole lane exists to report.
test('two overlapping AI overview exports resolve to the newest, never to both', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-bing-ai-overlap-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    await fs.writeFile(
      path.join(input, 'july.json'),
      bingAiArchive({
        report: 'ai-overview',
        exportDate: '2026-07-12',
        file: 'meals.example_AIPerformanceOverviewStats_7_12_2026.csv',
        rows: [
          { date: '2026-07-10', citations: 9000, citedPages: 40 },
          { date: '2026-07-11', citations: 9100, citedPages: 41 },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'august.json'),
      bingAiArchive({
        report: 'ai-overview',
        exportDate: '2026-08-04',
        file: 'meals.example_AIPerformanceOverviewStats_8_4_2026.csv',
        rows: [
          // The same two days, one revised upward by Bing, plus a new one.
          { date: '2026-07-10', citations: 9000, citedPages: 40 },
          { date: '2026-07-11', citations: 9250, citedPages: 43 },
          { date: '2026-08-03', citations: 11000, citedPages: 52 },
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output });
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [{ name: 'bing-webmaster-ai-overview', rows: 3 }],
    );

    const lines = (
      await fs.readFile(path.join(output, 'bing-webmaster-ai-overview.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const headers = lines[0].split(',');
    const byDay = new Map(
      lines.slice(1).map((line) => {
        const cells = line.split(',');
        return [
          cells[headers.indexOf('provider_date')],
          Object.fromEntries(headers.map((header, index) => [header, cells[index]])),
        ];
      }),
    );
    assert.deepEqual([...byDay.keys()], ['2026-07-10', '2026-07-11', '2026-08-03']);
    // The newest export is Microsoft's later word on that day.
    assert.equal(byDay.get('2026-07-11').citations, '9250');
    assert.equal(byDay.get('2026-07-11').report_date, '2026-08-04');
    // The day only the older export reaches survives — resolving is not
    // dropping history.
    assert.equal(byDay.get('2026-07-10').citations, '9000');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * ro-282.2 — a panel groups by the bet it measures, and the grouping is a fact
 * of the COLLECTION rather than of today's config.
 *
 * The label rides in the archived page envelope beside `path` and `attempts`,
 * never inside the body that was posted to the provider. This tool is the reason
 * that matters: it reads only archives, so a label it looked up in
 * config/serp-panel.json would rewrite the cluster on every historical row the
 * day a cluster is renamed — the same observations, retitled, with nothing
 * recording that the question had changed.
 */
test('a labelled panel carries its cluster into the CSV and leaves older rows empty', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-panel-labels-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    const page = (keyword, label) => ({
      request: {
        path: '/serp/google/organic/live/advanced',
        body: { keyword, depth: 20, load_async_ai_overview: true },
        attempts: 1,
        // Absent on every archive collected before this property labelled its
        // panel — which is every archive nosh.example has today.
        ...(label === undefined ? {} : { label }),
      },
      response: {
        status_code: 20000,
        cost: 0.004,
        tasks: [
          {
            status_code: 20000,
            result: [
              {
                keyword,
                items: [
                  { type: 'organic', rank_group: 3, domain: 'nosh.example' },
                ],
              },
            ],
          },
        ],
      },
    });
    const archive = (reportDate, pages) =>
      JSON.stringify({
        schemaVersion: 1,
        provider: 'dataforseo',
        asset: 'nosh.example',
        integration: 'dataforseo',
        report: 'serp-panel',
        propertyRef: 'nosh.example',
        reportDate,
        collectedAt: `${reportDate}T12:45:00.000Z`,
        dataState: 'provider-snapshot',
        providerRows: pages.length,
        providerTruncated: true,
        pages,
      });

    await fs.writeFile(
      path.join(input, 'panel-2026-07-27.json'),
      // Collected before labels existed: the envelope has no `label` key at all.
      archive('2026-07-27', [
        page('big mac calories'),
        page('big mac vs whopper'),
      ]),
    );
    await fs.writeFile(
      path.join(input, 'panel-2026-08-10.json'),
      archive('2026-08-10', [
        page('big mac calories', 'Item head'),
        // A cluster no config names any more: the query was retired from the
        // panel after this collection. The CSV must still say what the
        // observation was made under.
        page('big mac vs whopper', 'Comparisons'),
      ]),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'nosh.example', input, output });
    assert.deepEqual(
      summary.datasets.map(({ name, rows }) => ({ name, rows })),
      [{ name: 'dataforseo-serp-panel', rows: 4 }],
    );

    const lines = (
      await fs.readFile(path.join(output, 'dataforseo-serp-panel.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const headers = lines[0].split(',');
    assert.ok(headers.includes('query_label'));
    const rows = lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(headers.map((name, index) => [name, cells[index]]));
    });
    const labelOn = (reportDate, query) =>
      rows.find((row) => row.report_date === reportDate && row.query === query)
        .query_label;

    // The bet each observation was placed on, as that collection recorded it.
    assert.equal(labelOn('2026-08-10', 'big mac calories'), 'Item head');
    assert.equal(labelOn('2026-08-10', 'big mac vs whopper'), 'Comparisons');
    // History is not backfilled. The panel gained labels on 2026-08-10; the
    // July rows were collected without one and say so by staying empty.
    assert.equal(labelOn('2026-07-27', 'big mac calories'), '');
    assert.equal(labelOn('2026-07-27', 'big mac vs whopper'), '');
    // The device is the OPPOSITE call on the same fixture, and the contrast is
    // the point: none of these pages carries a `device` either, but every one of
    // them reads `desktop` rather than empty. A label was never sent, so an
    // empty cell is the honest answer; a device was sent on every call the
    // collector ever made, so an empty cell would be the only wrong one.
    assert.equal(
      rows.every((row) => row.device === 'desktop'),
      true,
    );
    // Nothing else about those rows changed.
    assert.equal(
      rows.filter((row) => row.query === 'big mac calories').every(
        (row) => row.best_rank === '3' && row.row_grain === 'tracked-query-device',
      ),
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * ro-2zk.1. Nothing in the panel dir answered "how many of our pages are
 * indexed" — `gsc-page.csv` lists pages that earned IMPRESSIONS, a strict
 * subset of the indexed set, so a property triaging a traffic drop could not
 * tell "we lost rankings" from "we lost the index". Bing already tells us, in
 * a family the nightly lane has been archiving all along.
 */
function bingArchive({ report, reportDate, method, rows }) {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'microsoft',
    asset: 'nosh.example',
    integration: 'bing-webmaster',
    report,
    reportDate,
    collectedAt: `${reportDate}T12:15:00.000Z`,
    dataState: 'provider-snapshot',
    providerRows: rows.length,
    providerTruncated: false,
    pages: [
      { request: { method, siteUrl: 'https://nosh.example/' }, response: { d: rows } },
    ],
  });
}

const crawlDay = (date, inIndex, crawled) => ({
  __type: 'CrawlStats:#Microsoft.Bing.Webmaster.Api',
  Date: `/Date(${Date.parse(`${date}T00:00:00.000Z`)})/`,
  InIndex: inIndex,
  CrawledPages: crawled,
  CrawlErrors: 3,
  BlockedByRobotsTxt: 0,
  InLinks: 12,
});

test('promotes Bing’s own index count into a coverage family, costing no call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-coverage-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    await fs.writeFile(
      path.join(input, 'crawl-2026-08-02.json'),
      bingArchive({
        report: 'crawl-stats',
        reportDate: '2026-08-02',
        method: 'GetCrawlStats',
        // The 08-01 figure this collection saw, later revised by the next one.
        rows: [crawlDay('2026-08-01', 2600, 400), crawlDay('2026-08-02', 2809, 508)],
      }),
    );
    await fs.writeFile(
      path.join(input, 'crawl-2026-08-03.json'),
      bingArchive({
        report: 'crawl-stats',
        reportDate: '2026-08-03',
        method: 'GetCrawlStats',
        rows: [crawlDay('2026-08-01', 2777, 402), crawlDay('2026-08-03', 2833, 308)],
      }),
    );
    await fs.writeFile(
      path.join(input, 'feeds-2026-08-02.json'),
      bingArchive({
        report: 'feeds',
        reportDate: '2026-08-02',
        method: 'GetFeeds',
        rows: [
          {
            __type: 'Feed:#Microsoft.Bing.Webmaster.Api',
            Url: 'https://nosh.example/sitemap.xml',
            UrlCount: 2900,
            Status: 'Success',
            Type: 'Sitemap',
            LastCrawled: '/Date(1785624815000)/',
            Submitted: '/Date(1783796353525)/',
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(input, 'feeds-2026-08-03.json'),
      bingArchive({
        report: 'feeds',
        reportDate: '2026-08-03',
        method: 'GetFeeds',
        rows: [
          {
            __type: 'Feed:#Microsoft.Bing.Webmaster.Api',
            Url: 'https://nosh.example/sitemap.xml',
            UrlCount: 2970,
            Status: 'Success',
            Type: 'Sitemap',
            LastCrawled: '/Date(1785624815000)/',
            Submitted: '/Date(1783796353525)/',
          },
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'nosh.example', input, output });
    // Derived, and listed after the families it reads.
    assert.deepEqual(summary.datasets.at(-1).name, 'index-coverage');

    const lines = (
      await fs.readFile(path.join(output, 'index-coverage.csv'), 'utf8')
    )
      .trim()
      .split('\n');
    const headers = lines[0].split(',');
    const rows = lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(headers.map((name, index) => [name, cells[index]]));
    });
    const siteDays = rows.filter((row) => row.row_grain === 'site-day');
    const sitemaps = rows.filter((row) => row.row_grain === 'sitemap');

    // Three measured days from four archived ones: Bing re-sends the whole
    // series every collection, so 08-01 appears twice and those are REVISIONS
    // of one day. Counting both would draw the index curve twice.
    assert.deepEqual(
      siteDays.map((row) => row.provider_date),
      ['2026-08-01', '2026-08-02', '2026-08-03'],
    );
    // Newest collection wins the revision, exactly as the AI export does.
    assert.equal(
      siteDays.find((row) => row.provider_date === '2026-08-01').pages_in_index,
      '2777',
    );
    assert.equal(siteDays.at(-1).pages_in_index, '2833');
    assert.equal(siteDays.at(-1).pages_crawled, '308');
    // Every row says whose index it is talking about.
    assert.equal(
      rows.every((row) => row.provider === 'bing-webmaster'),
      true,
    );

    // The denominator is a CURRENT snapshot with no measured day of its own, so
    // only the newest collection is carried: a series of sitemap snapshots
    // would read as a site that grew by 70 pages.
    assert.equal(sitemaps.length, 1);
    assert.equal(sitemaps[0].urls_submitted, '2970');
    assert.equal(sitemaps[0].sitemap_status, 'Success');
    // And no ratio is computed between them — the two grains carry different
    // dates, so one "coverage %" would look exact and straddle both.
    assert.equal(
      headers.some((header) => /percent|ratio|coverage_/.test(header)),
      false,
    );

    const caveats = JSON.parse(
      await fs.readFile(path.join(output, 'summary.json'), 'utf8'),
    ).caveats;
    assert.ok(
      caveats.some((line) => /never that nothing is indexed/.test(line)),
      'an absent coverage file must not read as "nothing is indexed"',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a property whose Bing lane collected nothing gets no coverage file at all', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-coverage-absent-'));
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { recursive: true });
  try {
    // A Bing family that carries no index count at all — the site is verified,
    // the lane ran, and this still says nothing about coverage.
    await fs.writeFile(
      path.join(input, 'queries.json'),
      bingArchive({
        report: 'queries',
        reportDate: '2026-08-03',
        method: 'GetQueryStats',
        rows: [
          {
            __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api',
            Query: 'ramen near me',
            Clicks: 4,
            Impressions: 90,
          },
        ],
      }),
    );

    const summary = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'nosh.example', input, output });
    assert.equal(
      summary.datasets.some((dataset) => dataset.name === 'index-coverage'),
      false,
    );
    // An empty index-coverage.csv is the one absence in this directory that a
    // reader could take for "nothing is indexed", so it is not written.
    await assert.rejects(
      fs.readFile(path.join(output, 'index-coverage.csv'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Bead ro-ujb9.207: the market a site's DataForSEO numbers were asked in is the
// one its saved settings name — read by the rule the collector asks by.
test('reads each site’s saved search market from the stored settings, by the collector’s rule', () => {
  const snapshot = (assets) => new Map([['config/integrations.json', { file: 'config/integrations.json', version: 2, body: { assets } }]]);
  const assets = {
    'meals.example': { dataforseo: { locationCode: 2826, languageCode: 'en' } },
    'nosh.example': { dataforseo: { locationCode: 2276 } },
    'fees.example': { dataforseo: { status: 'needs-setup' } },
    'odd.example': { dataforseo: { locationCode: 'uk', languageCode: '' } },
  };
  assert.deepEqual(storedSearchMarket(snapshot(assets), 'meals.example'), { locationCode: 2826, languageCode: 'en' });
  // A place saved without a language is that place in the default language.
  assert.deepEqual(storedSearchMarket(snapshot(assets), 'nosh.example'), { locationCode: 2276, languageCode: 'en' });
  for (const asset of ['fees.example', 'odd.example', 'absent.example']) {
    assert.equal(storedSearchMarket(snapshot(assets), asset), null, asset);
  }
  assert.equal(storedSearchMarket(new Map(), 'meals.example'), null, 'no stored integrations document');
});

test('the analysis summary names the site’s own panel market, never an assumed one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-signal-market-'));
  try {
    const input = path.join(root, 'input');
    await fs.mkdir(input);
    const german = await analyzeArchiveFixture({
      readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output: path.join(root, 'de'),
      market: { locationCode: 2276, languageCode: 'de' },
    });
    const written = JSON.stringify(german);
    assert.doesNotMatch(written, /US\/English|United States/);
    assert.ok(german.caveats.some((line) => line.startsWith('The tracked SERP panel is a top-20 read in the Germany · German market')));
    assert.ok(german.executiveSnapshot.methodology.some((line) => line.includes('in the Germany · German market')));
    const unset = await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output: path.join(root, 'none') });
    assert.ok(unset.caveats.some((line) => line.includes('top-20 read in the site’s default market')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Frozen whole-report parity and CLI refusals live in signal-history-analyze.test.mjs.

test('an archive it cannot read stops the analysis before any output is replaced', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-archive-refusals-'));
  const good = {
    schemaVersion: 1, asset: 'meals.example', integration: 'gsc', report: 'query',
    reportDate: '2026-09-20', collectedAt: '2026-09-21T12:15:00.000Z', pages: [],
  };
  const cases = [
    ['wrong-site', { ...good, asset: 'nosh.example' }, 'Unsupported or wrong-property signal archive'],
    ['new-version', { ...good, schemaVersion: 2 }, 'Unsupported or wrong-property signal archive'],
    ['not-an-object', [good], 'Unsupported or wrong-property signal archive'],
    ['unknown-provider', { ...good, integration: 'matomo' }, 'Malformed signal archive'],
    ['unnamed-report', { ...good, report: 7 }, 'Malformed signal archive'],
  ];
  try {
    for (const [name, archive, message] of cases) {
      const input = path.join(root, name, 'input');
      const output = path.join(root, name, 'output');
      const file = path.join(input, 'gsc', 'query', '2026-09-20.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(good));
      await analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output });
      const beforeLink = await fs.readlink(output);
      const before = await Promise.all((await fs.readdir(output)).sort().map(async (name) => [name, await fs.readFile(path.join(output, name), 'utf8')]));
      await fs.writeFile(file, JSON.stringify(archive));
      await assert.rejects(
        analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output }),
        (error) => {
          assert.match(error.message, /lists 1 archive it could not read/);
          assert.ok(error.message.includes(message), error.message);
          return true;
        },
        name,
      );
      assert.equal(await fs.readlink(output), beforeLink, name);
      assert.deepEqual(await Promise.all((await fs.readdir(output)).sort().map(async (fileName) => [fileName, await fs.readFile(path.join(output, fileName), 'utf8')])), before, name);
    }
    // A file cut short in transit is a parse failure, never a short report.
    const input = path.join(root, 'truncated', 'input');
    await fs.mkdir(input, { recursive: true });
    await fs.writeFile(path.join(input, 'gsc-query.json'), JSON.stringify(good).slice(0, 60));
    await assert.rejects(
      analyzeArchiveFixture({ readValueEvents: fixtureValueEvents, asset: 'meals.example', input, output: path.join(root, 'truncated', 'output') }),
      /not JSON/,
    );
    await assert.rejects(fs.readdir(path.join(root, 'truncated', 'output')), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
