// Deterministic executive insights from flattened GA4, GSC, and Bing
// Webmaster report families.
//
// This is deliberately a small evidence engine, not an LLM prompt. Every card
// is produced by an explicit rule over named provider reports and carries its
// own date window, evidence, and limitations. Missing rows never imply zero and
// can never produce a deprecation recommendation.

import { readProductUseStages } from '../packages/contract/src/product-use.mjs';
import { marketLabel } from '../packages/contract/src/search-market.mjs';

/**
 * THE MARKET A SITE'S DATAFORSEO NUMBERS WERE ASKED IN, as a finding names it
 * (bead ro-ujb9.207): the site's saved location and language in words, or the
 * site's default market when it saved none (`savedSearchMarket` in the
 * contract, the rule the collector asks by). Never one market for every site.
 */
export function marketPhrase(market) {
  return market ? `the ${marketLabel(market)} market` : 'the site’s default market';
}

const GENERIC_EVENTS = new Set([
  'page_view',
  'session_start',
  'first_visit',
  'user_engagement',
  'scroll',
]);

function number(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A provider count the row may not state (bead ro-8s5): the number, or null
 * when the field is blank or the row is absent. DataForSEO answers some LLM
 * platform rows with no figures at all, and `number()` would turn that into a
 * zero — negative evidence nobody measured. An explicit provider 0 stays 0.
 */
function reportedCount(row, field) {
  return row ? nullableNumber(row[field]) : null;
}

/** How a possibly-unknown count reads in evidence: never as a zero. */
function formatReported(value) {
  return value === null ? 'not reported' : formatInt(value);
}

function text(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** A plain object or nothing — an array is not a config node. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function rows(families, name) {
  return families.get(name) ?? [];
}

function formatInt(value) {
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatDecimal(value, digits = 1) {
  return value.toFixed(digits);
}

function pagePath(value) {
  const raw = text(value);
  if (!raw) return '(not set)';
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

function dateWindow(input) {
  const dates = [...new Set(input.map((row) => text(row.report_date)).filter(Boolean))].sort();
  return dates.length === 0
    ? null
    : { start: dates[0], end: dates[dates.length - 1], days: dates.length };
}

function providerDateWindow(input) {
  const providerDates = [
    ...new Set(input.map((row) => text(row.provider_date)).filter(Boolean)),
  ].sort();
  if (providerDates.length === 0) return dateWindow(input);
  const observedEnd = input
    .map((row) => text(row.report_date))
    .filter(Boolean)
    .sort()
    .at(-1);
  const boundedDates = providerDates.map((date) =>
    observedEnd && date > observedEnd ? observedEnd : date,
  );
  return {
    start: boundedDates[0],
    end: boundedDates.at(-1),
    days: providerDates.length,
  };
}

function latestSnapshotRows(families, name) {
  const input = rows(families, name);
  const dates = input.map((row) => text(row.report_date)).filter(Boolean).sort();
  const latest = dates.at(-1);
  return latest ? input.filter((row) => text(row.report_date) === latest) : [];
}

function previousSnapshotRows(families, name) {
  const input = rows(families, name);
  const dates = [
    ...new Set(input.map((row) => text(row.report_date)).filter(Boolean)),
  ].sort();
  const previous = dates.at(-2);
  return previous
    ? input.filter((row) => text(row.report_date) === previous)
    : [];
}

function productUseMetric(definition, byEvent) {
  const observed = byEvent.get(definition.eventName);
  return {
    key: definition.eventName,
    eventName: definition.eventName,
    label: definition.label,
    ...(definition.compareTo === undefined ? {} : { compareTo: definition.compareTo }),
    ...(definition.comparisonLabel === undefined ? {} : { comparisonLabel: definition.comparisonLabel }),
    users: observed ? number(observed.totalUsers) : null,
    events: observed ? number(observed.eventCount) : null,
  };
}

/** Exact rolling unique-user aggregates. These must come from one GA4 28-day
 * report: adding daily `totalUsers` would double-count returning people. */
function productUseSnapshot(families, asset, declarations) {
  const stages = readProductUseStages(record(declarations)?.assets?.[asset]?.productUseStages);
  if (!stages?.length) return null;
  const input = latestSnapshotRows(families, 'ga4-events-28d');
  if (input.length === 0) return null;
  const byEvent = new Map(
    input
      .filter((row) => text(row.eventName))
      .map((row) => [text(row.eventName), row]),
  );
  if (!stages.some((definition) => byEvent.has(definition.eventName))) return null;
  const windowStart = text(input[0]?.window_start);
  const windowEnd = text(input[0]?.window_end || input[0]?.report_date);
  if (!windowStart || !windowEnd) return null;
  const days =
    Math.round(
      (Date.parse(`${windowEnd}T00:00:00.000Z`) -
        Date.parse(`${windowStart}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
  if (!Number.isFinite(days) || days < 1) return null;
  return {
    windowStart,
    windowEnd,
    days,
    build: stages.filter((stage) => stage.group === 'primary').map((definition) =>
      productUseMetric(definition, byEvent),
    ),
    sharing: stages.filter((stage) => stage.group === 'sharing').map((definition) =>
      productUseMetric(definition, byEvent),
    ),
    supporting: stages.filter((stage) => stage.group === 'supporting').map((definition) =>
      productUseMetric(definition, byEvent),
    ),
    source: source('ga4', 'events-28d'),
    caveat:
      'Users are unique independently within each event, not a same-person sequence. A missing event means GA4 recorded no row for it in this window; it does not prove nobody performed the action.',
  };
}

function queryWindow({
  input,
  provider,
  dateField,
  positionField,
  sourceName,
  caveat,
  /** Rows this provider's lane states about its own series before ranking it —
   * the same `{label, value, detail}` shape the cards carry. Empty means the
   * lane makes no such statement, never that a check ran and found nothing:
   * a check that ran is a row that is present. */
  evidence: evidenceRows = [],
}) {
  const dates = [
    ...new Set(input.map((row) => text(row[dateField])).filter(Boolean)),
  ].sort();
  const daysPerWindow = 7;
  if (dates.length < daysPerWindow * 2) return null;

  const currentDates = dates.slice(-daysPerWindow);
  const previousDates = dates.slice(-daysPerWindow * 2, -daysPerWindow);
  const currentSet = new Set(currentDates);
  const previousSet = new Set(previousDates);
  const current = aggregateQueryWindow(
    input.filter((row) => currentSet.has(text(row[dateField]))),
    positionField,
  );
  const previous = aggregateQueryWindow(
    input.filter((row) => previousSet.has(text(row[dateField]))),
    positionField,
  );
  const movers = [...current.entries()]
    .flatMap(([query, currentValue]) => {
      const previousValue = previous.get(query);
      if (
        !previousValue ||
        currentValue.impressions <= 0 ||
        previousValue.impressions <= 0 ||
        currentValue.positionImpressions <= 0 ||
        previousValue.positionImpressions <= 0
      ) {
        return [];
      }
      const currentPosition =
        currentValue.weightedPosition / currentValue.positionImpressions;
      const previousPosition =
        previousValue.weightedPosition / previousValue.positionImpressions;
      const impressionDelta =
        currentValue.impressions - previousValue.impressions;
      return [
        {
          query: currentValue.query,
          currentImpressions: currentValue.impressions,
          previousImpressions: previousValue.impressions,
          impressionDelta,
          impressionDeltaPercent:
            (impressionDelta / previousValue.impressions) * 100,
          currentPosition,
          previousPosition,
          positionImprovement: previousPosition - currentPosition,
        },
      ];
    })
    .sort(
      (left, right) =>
        Math.abs(right.impressionDelta) - Math.abs(left.impressionDelta) ||
        right.currentImpressions - left.currentImpressions ||
        left.query.localeCompare(right.query),
    )
    .slice(0, 10);

  return {
    provider,
    currentStart: currentDates[0],
    currentEnd: currentDates.at(-1),
    previousStart: previousDates[0],
    previousEnd: previousDates.at(-1),
    daysPerWindow,
    movers,
    evidence: evidenceRows,
    source: sourceName,
    caveat,
  };
}

function aggregateQueryWindow(input, positionField) {
  const grouped = new Map();
  for (const row of input) {
    const query = text(row.query).trim();
    if (!query) continue;
    const key = query.toLocaleLowerCase('en-US');
    const impressions = number(row.impressions);
    if (impressions <= 0) continue;
    const current = grouped.get(key) ?? {
      query,
      impressions: 0,
      weightedPosition: 0,
      positionImpressions: 0,
    };
    current.impressions += impressions;
    const position = number(row[positionField]);
    if (position > 0) {
      current.weightedPosition += position * impressions;
      current.positionImpressions += impressions;
    }
    grouped.set(key, current);
  }
  return grouped;
}

const DATAFORSEO_QUERY_LIMIT = 16;

function normalizedQuery(value) {
  return text(value).trim().toLocaleLowerCase('en-US');
}

/** Three-state, because the flattened panel has three. Anything that is not a
 * clear true or false — an empty cell, a missing column, an unparsed value — is
 * unknown, and unknown must never harden into `false` on the way to a rule. */
function nullableBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * The device a panel row was read on (`ro-14d.1`).
 *
 * Since `ro-o1n` the panel collects every tracked term on BOTH mobile and
 * desktop, so `dataforseo-serp-panel.csv` carries one row per term PER DEVICE
 * and every reader below is keyed on the pair. A row naming no device at all —
 * anything archived before 2026-08-04, when the collector had exactly one
 * `device` literal in it — is desktop by construction, which is the same call
 * `serpPageDevice()` makes in scripts/signal-archive.mjs for the same
 * reason: the device was structurally true, so leaving it unknown would break
 * every device-vs-device comparison across the cutover for no gain.
 *
 * The cost path is never keyed on this — `searchIntelligenceSnapshot` sums
 * every panel row, because both devices were billed and the snapshot's cost is
 * the real bill or it is worth nothing.
 */
function panelDevice(row) {
  return text(row.device).trim().toLocaleLowerCase('en-US') || 'desktop';
}

/** The order every device-keyed surface states the two in. The phone leads
 * because that is where most of this demand actually searches (the reason
 * `ro-o1n` bought the second device), and the first column is the one that gets
 * read. An unrecognized device sorts after both, alphabetically, rather than
 * being dropped: the collector's device list is config, not a closed set. */
const PANEL_DEVICE_ORDER = ['mobile', 'desktop'];

function byPanelDevice(left, right) {
  const rank = (device) => {
    const index = PANEL_DEVICE_ORDER.indexOf(device);
    return index === -1 ? PANEL_DEVICE_ORDER.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

/**
 * The tracked-query panel's AI Overview evidence, keyed by normalized query —
 * the one read both consumers share: the ranked-keyword visibility rows it
 * enriches, and the striking-distance gate it withholds on.
 *
 * Each query maps to ONE READING PER DEVICE, in `PANEL_DEVICE_ORDER`, never to
 * a single folded verdict. An overview that fires on the phone and not on the
 * desktop is the finding — a phone result page is not a narrower desktop one —
 * and a reader that kept one row per query would have reported whichever
 * surface its tie-break happened to land on.
 *
 * The tie-break is stated once and shared with `serpPanelSnapshot()` below:
 * FIRST row wins per (query, device). Two rows for one pair are a duplicated
 * collection, not two observations, so the choice is arbitrary — but it has to
 * be the SAME arbitrary choice in both readers, because they publish onto the
 * same page and opposite tie-breaks are how two surfaces start disagreeing
 * about one collection.
 *
 * The panel is additive wherever it is joined: it enriches queries a series
 * already surfaced and adds none of its own, so a term on the panel but outside
 * that series contributes nothing, and a query nobody tracked stays exactly as
 * unknown as it was before the panel existed.
 */
function serpPanelEvidence(families) {
  const input = latestSnapshotRows(families, 'dataforseo-serp-panel');
  if (input.length === 0) return null;
  const byQuery = new Map();
  for (const row of input) {
    const query = normalizedQuery(row.query);
    if (!query) continue;
    const device = panelDevice(row);
    const readings = byQuery.get(query) ?? new Map();
    if (readings.has(device)) continue;
    readings.set(device, {
      device,
      aioPresent: nullableBoolean(row.aio_present),
      aioCitesUs: nullableBoolean(row.aio_cites_us),
    });
    byQuery.set(query, readings);
  }
  if (byQuery.size === 0) return null;
  return {
    byQuery: new Map(
      [...byQuery].map(([query, readings]) => [
        query,
        [...readings.values()].sort((left, right) =>
          byPanelDevice(left.device, right.device),
        ),
      ]),
    ),
    observedAt: text(input[0]?.report_date),
  };
}

/**
 * The whole tracked panel, one entry per term the property paid a call for —
 * NOT the intersection `serpPanelEvidence()` joins onto another series. Both
 * existing consumers (the ranked-keyword rows it enriches, the striking-distance
 * gate) are intersections, so a tracked term outside the ranking inventory was
 * invisible on every rendered surface; this block is what the Tower's panel
 * scoreboard reads.
 *
 * ONE ENTRY PER (TERM, DEVICE) since `ro-14d.1`, each naming its own `device`.
 * Two devices are two observations of two different result pages, so folding
 * them here would decide on the producer's behalf which surface the property
 * page is about; the Tower groups the rows back into terms for its counts
 * (`serpPanelTerms` in apps/tower/shared/asset-detail.ts) so a split multiplies
 * no denominator. A snapshot written before this change carries no `device` at
 * all, and the payload parser reads that absence as the desktop-era row it is.
 * First row wins per (term, device) — the same tie-break `serpPanelEvidence()`
 * states above, so the two readers cannot answer about different collections.
 *
 * Empty cells stay `null` in both directions the family means them: an empty
 * `best_rank` is "no result inside the tracked depth", never "does not rank",
 * and an empty `aio_*` is unknown, never `false`.
 *
 * A property with no panel rows gets NO block. Absence is "this property has no
 * panel", which is a different fact from an empty panel, and the Tower renders
 * nothing rather than an empty scoreboard.
 *
 * `market` is the site's saved search market the panel is asked in, or null
 * when it saved none (bead ro-ujb9.230): the Tower's caption names it, and
 * names no market rather than a default one the site never chose.
 */
function serpPanelSnapshot(families, market) {
  const input = latestSnapshotRows(families, 'dataforseo-serp-panel');
  if (input.length === 0) return null;
  const queries = [];
  const seen = new Set();
  for (const row of input) {
    const query = text(row.query).trim();
    const device = panelDevice(row);
    const key = `${normalizedQuery(query)}\u0000${device}`;
    if (!query || seen.has(key)) continue;
    seen.add(key);
    const organicResults = nullableNumber(row.organic_results);
    const providerStatus = text(row.provider_status).trim();
    const providerAttempts = nullableNumber(row.provider_attempts);
    queries.push({
      query,
      device,
      // The cluster this query measures, as the COLLECTION recorded it —
      // `flattenSerpPanel` emits `query_label` from the archived page envelope
      // and never from config (`ro-282.2`). Carried through unread and
      // un-normalized: a cluster rename must not relabel history, so nothing
      // downstream may look this up in config/serp-panel.json at render time.
      // Blank for a property that labels nothing, and for nom's own pre-label
      // collections — a mixed panel is normal input, not a defect.
      label: text(row.query_label).trim() || null,
      bestRank: nullableNumber(row.best_rank),
      bestUrl: text(row.best_url) || null,
      aioPresent: nullableBoolean(row.aio_present),
      aioCitesUs: nullableBoolean(row.aio_cites_us),
      // One availability boundary, not five independent blanks. The flattener
      // leaves `organic_results` empty only on a billed-but-unanswered page; a
      // readable organic-only page is a real zero and keeps an empty feature
      // list. This is CURRENT composition only — one retained panel snapshot
      // cannot say that any domain arrived, left, rose, or fell.
      composition:
        organicResults === null
          ? null
          : {
              top3Domains: text(row.top3_domains)
                .split('|')
                .map((domain) => domain.trim())
                .filter(Boolean),
              organicResults,
              secondRank: nullableNumber(row.second_rank),
              secondUrl: text(row.second_url) || null,
              serpFeatures: text(row.serp_features)
                .split('|')
                .map((feature) => feature.trim())
                .filter(Boolean),
            },
      ...(providerStatus
        ? {
            providerStatus,
            providerAttempts: providerAttempts ?? 1,
          }
        : {}),
    });
  }
  if (queries.length === 0) return null;
  return {
    reportDate: text(input[0]?.report_date),
    // The depth this run paid for, as the request recorded it. Null when the
    // archive does not carry it: an unstated depth is unknown, and a depth of
    // 20 assumed here would turn "no rank recorded" into "outside the top 20".
    trackedDepth: nullableNumber(input[0]?.tracked_depth),
    market: market ?? null,
    queries,
  };
}

function preferHigherResult(current, candidate) {
  if (!current) return candidate;
  const currentRank = nullableNumber(current.rank_group) ?? Infinity;
  const candidateRank = nullableNumber(candidate.rank_group) ?? Infinity;
  return candidateRank < currentRank ? candidate : current;
}

function dataForSeoQueryVisibility(families, market) {
  const current = latestSnapshotRows(families, 'dataforseo-ranked-keywords');
  if (current.length === 0) return null;

  const panel = serpPanelEvidence(families);
  const previous = previousSnapshotRows(families, 'dataforseo-ranked-keywords');
  const currentOrganic = new Map();
  const currentAiReferences = new Map();
  const previousOrganic = new Map();

  for (const row of current) {
    const query = normalizedQuery(row.keyword);
    if (!query) continue;
    if (text(row.result_type) === 'organic') {
      currentOrganic.set(
        query,
        preferHigherResult(currentOrganic.get(query), row),
      );
    }
    if (text(row.result_type) === 'ai_overview_reference') {
      currentAiReferences.set(
        query,
        preferHigherResult(currentAiReferences.get(query), row),
      );
    }
  }

  for (const row of previous) {
    if (text(row.result_type) !== 'organic') continue;
    const query = normalizedQuery(row.keyword);
    if (!query) continue;
    const page = pagePath(row.url || row.relative_url);
    const key = `${query}\u0000${page}`;
    previousOrganic.set(
      key,
      preferHigherResult(previousOrganic.get(key), row),
    );
  }

  const queryKeys = new Set([
    ...currentOrganic.keys(),
    ...currentAiReferences.keys(),
  ]);
  const candidates = [...queryKeys].flatMap((queryKey) => {
    const organic = currentOrganic.get(queryKey);
    const aiReference = currentAiReferences.get(queryKey);
    const anchor = organic ?? aiReference;
    if (!anchor) return [];
    const query = text(anchor.keyword).trim();
    const page = pagePath(anchor.url || anchor.relative_url);
    const monthlySearches = number(anchor.search_volume);
    if (!query || monthlySearches <= 0) return [];

    const organicPosition = organic
      ? nullableNumber(organic.rank_group)
      : null;
    const previousRow = organic
      ? previousOrganic.get(`${queryKey}\u0000${page}`)
      : null;
    const previousOrganicPosition = previousRow
      ? nullableNumber(previousRow.rank_group)
      : null;
    const serpFeatures = text(organic?.serp_features)
      .split('|')
      .map((feature) => feature.trim())
      .filter(Boolean);

    return [
      {
        query,
        monthlySearches,
        organicPosition,
        previousOrganicPosition,
        positionImprovement:
          organicPosition !== null && previousOrganicPosition !== null
            ? previousOrganicPosition - organicPosition
            : null,
        keywordDifficulty: nullableNumber(
          organic?.keyword_difficulty ?? anchor.keyword_difficulty,
        ),
        estimatedVisits: nullableNumber(organic?.etv ?? anchor.etv),
        page,
        intent: text(organic?.intent ?? anchor.intent) || null,
        aiOverview: aiReference
          ? 'cited'
          : serpFeatures.includes('ai_overview')
            ? 'present'
            : 'none',
        aiCitationPosition: aiReference
          ? nullableNumber(aiReference.rank_group)
          : null,
        // Live tracked-panel evidence where it exists, ONE READING PER DEVICE,
        // and an empty list everywhere else. Deliberately not derived from
        // `aiOverview` above: that is a provider ranking-inventory field about
        // the week's ranked results, while these are the exact result pages
        // pulled for this term — one per surface, because an overview can
        // consume the click on the phone and not on the desktop. An empty list
        // is UNKNOWN (not on the panel), never "no overview".
        aioDevices: panel?.byQuery.get(queryKey) ?? [],
      },
    ];
  });

  const byOpportunity = candidates
    .filter(
      (row) =>
        row.organicPosition !== null &&
        row.organicPosition >= 4 &&
        row.organicPosition <= 20 &&
        row.intent !== 'navigational',
    )
    .sort(
      (left, right) =>
        right.monthlySearches * (21 - right.organicPosition) -
          left.monthlySearches * (21 - left.organicPosition) ||
        left.query.localeCompare(right.query),
    );
  const byAiCitation = candidates
    .filter((row) => row.aiOverview === 'cited')
    .sort(
      (left, right) =>
        right.monthlySearches - left.monthlySearches ||
        left.query.localeCompare(right.query),
    );
  const byDemand = [...candidates].sort(
    (left, right) =>
      right.monthlySearches - left.monthlySearches ||
      (left.organicPosition ?? Infinity) -
        (right.organicPosition ?? Infinity) ||
      left.query.localeCompare(right.query),
  );
  const selected = [];
  const selectedQueries = new Set();
  for (const row of [
    ...byOpportunity.slice(0, 8),
    ...byAiCitation.slice(0, 4),
    ...byDemand,
  ]) {
    const key = normalizedQuery(row.query);
    if (selectedQueries.has(key)) continue;
    selectedQueries.add(key);
    selected.push(row);
    if (selected.length >= DATAFORSEO_QUERY_LIMIT) break;
  }

  return {
    observedAt: text(current[0]?.report_date),
    queries: selected,
    source: source('dataforseo', 'ranked-keywords'),
    caveat:
      `Monthly searches, difficulty, and estimated visits are DataForSEO estimates for ${marketPhrase(market)}—not property impressions. Organic and AI-reference positions are ranks among equivalent result types.` +
      (panel
        ? ` Live AI Overview presence and citation come from the tracked ${source('dataforseo', 'serp-panel')} panel observed ${panel.observedAt}, read on each device separately — a term can be walled on the phone and clear on the desktop, and neither reading stands for the other. A query outside that panel, or one whose overview failed to load, is unknown rather than clear.`
        : ''),
  };
}

/** Compact query visibility for the Tower. Google and Bing only compare
 * queries present in both equal report windows; DataForSEO provides the latest
 * locally retained market-demand, rank, and AI-citation baseline immediately.
 * `market` is the site's saved search market, or null (`marketPhrase`). */
export function buildSearchQueryTrends(families, market = null) {
  // The movers are a position-and-impression surface like the CTR rules, so they
  // read the same decontaminated series: a quoted-literal grounding query that
  // doubles its impressions is a machine retrying a retrieval, not demand
  // moving, and it would outrank real movement on absolute change. Excluded is
  // not deleted — each lane carries the same `Grounding queries excluded` row the
  // rules do, at zero as well, so the surface proves the check ran.
  //
  // BOTH PROVIDERS, since 2026-08-04 (`ro-pvl`). `ro-frx` ran the classifier on
  // Google alone and left Bing raw on purpose: the quoted signature had only ever
  // been measured in the GSC series (the 2026-07-31 audit, F2), so an exclusion
  // row on Bing would have claimed a check that never ran. That reason expired the
  // moment the check ran. Measured over the whole archive on 2026-08-04, latest
  // snapshot per property (the then-current `pnpm signals:analyze` →
  // `.local/signal-dumps/analysis/<asset>/bing-webmaster-queries.csv`):
  //
  //   site A   3 of 133,728 impressions   2 queries   0 clicks
  //   site B   1 of   9,072               1 query     1 click
  //   site C   1 of   1,494               1 query     1 click
  //   site D   0 of     556               —           —
  //   site E   0 of     497               —           —
  //
  // Bing is CLEAN, and by three orders of magnitude: across every retained
  // snapshot site A's Bing series carries 25 quoted-literal impressions of
  // 907,006 (0.003%) against 4,351 of 133,898 (3.25%) in the same property's GSC
  // page/query archive. Copilot grounding, if it ever lands here, is not landing
  // in this family today. The two clicked matches are humans using the quote
  // operator (`"ally bank" 7122766`), the opposite of the zero-click signature —
  // which the evidence row's own clicks figure shows a reader, so the row informs
  // rather than overclaims.
  //
  // Clean is why the check runs, not why it is skipped. A measurement recorded
  // only in this comment is true on the day it was taken and decays silently
  // afterwards; a row recomputed every run stays true, and states zero out loud
  // when Bing is clean. The false-positive cost is one quote-operator query that
  // must also survive both seven-date windows to have been a mover at all.
  const { rows: googleRows, excluded: googleExcluded } = excludeGroundingQueries(
    rows(families, 'gsc-query'),
  );
  const google = queryWindow({
    input: googleRows,
    provider: 'google',
    dateField: 'report_date',
    positionField: 'position',
    sourceName: source('gsc', 'query'),
    evidence: [groundingExclusionEvidence(googleExcluded)],
    caveat:
      'Search Console query exports are top rows and can omit anonymized or low-volume demand. Only queries present in both windows are ranked. ' +
      'Quoted-literal grounding queries are excluded before ranking, the same series the CTR and position rules read.',
  });
  // Only the latest snapshot, the way every Bing lane reads this revisable
  // family — so the exclusion is measured over exactly the rows being ranked.
  const { rows: bingRows, excluded: bingExcluded } = excludeGroundingQueries(
    latestSnapshotRows(families, 'bing-webmaster-queries'),
  );
  const bing = queryWindow({
    input: bingRows,
    provider: 'bing',
    dateField: 'provider_date',
    positionField: 'avg_impression_position',
    sourceName: source('bing-webmaster', 'queries'),
    evidence: [groundingExclusionEvidence(bingExcluded)],
    caveat:
      'Bing top-query history is a revisable weekly snapshot. Only the latest snapshot and queries present in both windows are ranked. ' +
      'Quoted-literal grounding queries are excluded before ranking, the same classifier the Google lane and the CTR rules use; measured over this archive the Bing family carries the signature at roughly a thousandth of the Google rate.',
  });
  const dataforseo = dataForSeoQueryVisibility(families, market);
  return google || bing || dataforseo ? { google, bing, dataforseo } : null;
}

// ---------------------------------------------------------------------------
// Page-grain decisions (`ro-427`)
// ---------------------------------------------------------------------------
// The queries surface has carried rule-driven verdicts since it shipped; the
// page grain had cards and nothing else, so the page an operator actually edits
// was the one grain with no act/investigate/protect row. This block is the
// producer half: the EVIDENCE, at page grain, in the same shape the query lanes
// publish. The verdict itself is computed where the query verdict is computed —
// in the Tower component — so one grain cannot drift into a second decision
// engine with its own vocabulary.
//
// THE SERIES IS NOT DECONTAMINATED, and this is the honest limit of the grain.
// `gsc-page` carries no query dimension, so the quoted-literal grounding
// classifier (F2 of the 2026-07-31 audit) cannot be applied to a page's own
// clicks and impressions — there is nothing in a page row to classify. What CAN
// be measured is the join this lane makes on top: each page's leading query
// comes from the decontaminated `gsc-page-query` series, and the lane states the
// exclusion it applied THERE, labelled so nobody reads it as a correction to the
// totals above it. Excluded is not deleted; mislabelled is worse than either.
const PAGE_DECISION_LIMIT = 16;

/** The leading query per page, over the CURRENT window only, off the
 * grounding-decontaminated page/query series — plus whatever the tracked panel
 * saw on that term.
 *
 * "Leading" is by impressions, not clicks: the question a page decision answers
 * is what Google is showing this page FOR, and a page in the harvest band is
 * precisely one whose leading query takes few clicks. Ranking by clicks would
 * name the query that already works on every page worth reviewing.
 *
 * The panel reading rides along unfolded, one per device, exactly as the query
 * rows carry it (`ro-14d.1`): an overview that consumes the click on the phone
 * and not the desktop is the finding at page grain too, and the component
 * applies the same impression-harvest gate to it. An empty list is UNKNOWN — the
 * term is not on this property's panel — and must keep behaving as it did before
 * the panel existed. */
function leadingQueriesByPage(pageQueryRows, panel, currentDates) {
  const byPage = new Map();
  for (const row of pageQueryRows) {
    if (!currentDates.has(text(row.report_date))) continue;
    const page = text(row.page);
    const query = text(row.query).trim();
    if (!page || !query) continue;
    const perPage = byPage.get(page) ?? new Map();
    const key = query.toLocaleLowerCase('en-US');
    const current = perPage.get(key) ?? {
      query,
      impressions: 0,
      clicks: 0,
      weightedPosition: 0,
      positionImpressions: 0,
    };
    const impressions = number(row.impressions);
    current.impressions += impressions;
    current.clicks += number(row.clicks);
    const position = number(row.position);
    if (position > 0) {
      current.weightedPosition += position * impressions;
      current.positionImpressions += impressions;
    }
    perPage.set(key, current);
    byPage.set(page, perPage);
  }
  const leading = new Map();
  for (const [page, perPage] of byPage) {
    const best = [...perPage.values()].sort(
      (left, right) =>
        right.impressions - left.impressions ||
        left.query.localeCompare(right.query),
    )[0];
    if (!best || best.impressions <= 0) continue;
    leading.set(page, {
      query: best.query,
      impressions: best.impressions,
      clicks: best.clicks,
      position:
        best.positionImpressions > 0
          ? best.weightedPosition / best.positionImpressions
          : null,
      aioDevices:
        panel?.byQuery.get(best.query.toLocaleLowerCase('en-US')) ?? [],
    });
  }
  return leading;
}

/** The exclusion row this lane may honestly state. Deliberately NOT the shared
 * `Grounding queries excluded` label: that row means "the numbers beside me were
 * computed on the decontaminated series", and here only the leading-query join
 * was. Present at zero like every other exclusion row, so the surface proves the
 * check ran. */
function pageGroundingEvidence(excluded) {
  return evidence(
    'Grounding queries excluded from the leading-query join',
    formatInt(excluded.impressions),
    (excluded.impressions > 0
      ? `${formatPercent(excluded.share)} of captured page/query impressions · ${formatInt(excluded.queries)} quoted-literal queries · ${formatInt(excluded.clicks)} clicks. `
      : 'No quoted-literal queries in this window. ') +
      'The click and impression totals on each row are the page family’s own and are NOT decontaminated: a page row carries no query to classify.',
  );
}

/**
 * One row per page present in BOTH comparable Google windows — the page-grain
 * analogue of the query movers, and the evidence a page decision is made on.
 *
 * A page reported in only one week is UNKNOWN, not zero: `gsc-page` is a top-row
 * export, so a page that fell below the cut-off did not necessarily fall to
 * nothing. Excluding it understates movement at the export boundary, which is
 * the direction that cannot invent a finding, and the caveat says so.
 */
export function buildSearchPageTrends(families) {
  const input = rows(families, 'gsc-page');
  const weeks = weekOverWeekDates(input);
  if (!weeks) return null;
  const totals = (dates) => {
    const grouped = new Map();
    for (const row of input) {
      if (!dates.has(text(row.report_date))) continue;
      const page = text(row.page);
      if (!page) continue;
      const current = grouped.get(page) ?? {
        page,
        clicks: 0,
        impressions: 0,
        weightedPosition: 0,
        positionImpressions: 0,
      };
      const impressions = number(row.impressions);
      current.clicks += number(row.clicks);
      current.impressions += impressions;
      const position = number(row.position);
      if (position > 0) {
        current.weightedPosition += position * impressions;
        current.positionImpressions += impressions;
      }
      grouped.set(page, current);
    }
    return grouped;
  };
  const current = totals(weeks.current);
  const previous = totals(weeks.previous);
  const { rows: pageQueryRows, excluded } = excludeGroundingQueries(
    rows(families, 'gsc-page-query'),
  );
  const leading = leadingQueriesByPage(
    pageQueryRows,
    serpPanelEvidence(families),
    weeks.current,
  );
  const averagePosition = (value) =>
    value.positionImpressions > 0
      ? value.weightedPosition / value.positionImpressions
      : null;
  const pages = [...current.values()]
    .flatMap((value) => {
      const prior = previous.get(value.page);
      if (!prior || value.impressions <= 0 || prior.impressions <= 0) return [];
      const clickDelta = value.clicks - prior.clicks;
      const impressionDelta = value.impressions - prior.impressions;
      const currentPosition = averagePosition(value);
      const previousPosition = averagePosition(prior);
      return [
        {
          page: value.page,
          path: pagePath(value.page),
          currentClicks: value.clicks,
          previousClicks: prior.clicks,
          clickDelta,
          // A page that took no clicks last week and takes some now has moved
          // infinitely in percentage terms, which is a number nobody can read.
          // Null says "from zero" and the surface renders the absolute instead.
          clickDeltaPercent:
            prior.clicks > 0 ? (clickDelta / prior.clicks) * 100 : null,
          currentImpressions: value.impressions,
          previousImpressions: prior.impressions,
          impressionDelta,
          impressionDeltaPercent:
            (impressionDelta / prior.impressions) * 100,
          currentPosition,
          previousPosition,
          positionImprovement:
            currentPosition !== null && previousPosition !== null
              ? previousPosition - currentPosition
              : null,
          currentCtr: value.clicks / value.impressions,
          previousCtr: prior.clicks / prior.impressions,
          // Absent for a page the page/query export does not cover in this
          // window — unknown, never "this page ranks for nothing".
          leadingQuery: leading.get(value.page) ?? null,
        },
      ];
    })
    .sort(
      (left, right) =>
        Math.abs(right.clickDelta) - Math.abs(left.clickDelta) ||
        right.currentImpressions - left.currentImpressions ||
        left.path.localeCompare(right.path),
    )
    .slice(0, PAGE_DECISION_LIMIT);
  if (pages.length === 0) return null;
  return {
    provider: 'google',
    currentStart: weeks.currentStart,
    currentEnd: weeks.currentEnd,
    previousStart: weeks.previousStart,
    previousEnd: weeks.previousEnd,
    daysPerWindow: weeks.daysPerWindow,
    pages,
    evidence: [pageGroundingEvidence(excluded)],
    source: source('gsc', 'page'),
    caveat:
      'Search Console page exports are top rows: a page reported in only one of the two weeks is unknown rather than zero and is left out, so this understates movement at the export boundary. ' +
      'Page clicks and impressions are the page family’s own totals and carry no query dimension, so the grounding-query exclusion the CTR rules apply cannot be applied to them; it is applied to the leading-query join only, and the lane states what it removed there. ' +
      'The leading query is the page’s largest query by impressions in the current window, not the one it earns most clicks on.',
  };
}

function source(integration, report) {
  return `${integration}/${report}`;
}

function evidence(label, value, detail) {
  return detail ? { label, value, detail } : { label, value };
}

/** Names the deterministic rule that produced a card so a method
 * ([doc 13](../docs/13-opportunity-scouting.md)) can attach to it by id. */
function ruleTag(id) {
  return evidence('Rule', id, `rule: ${id}`);
}

/** Seven reported dates against the preceding seven, the same shape the query
 * movers use. Fewer than fourteen reported dates cannot support a comparison,
 * and a date the provider never reported is not a zero. */
function weekOverWeekDates(input, dateField = 'report_date') {
  const dates = [
    ...new Set(input.map((row) => text(row[dateField])).filter(Boolean)),
  ].sort();
  const daysPerWindow = 7;
  if (dates.length < daysPerWindow * 2) return null;
  const currentDates = dates.slice(-daysPerWindow);
  const previousDates = dates.slice(-daysPerWindow * 2, -daysPerWindow);
  return {
    daysPerWindow,
    current: new Set(currentDates),
    previous: new Set(previousDates),
    currentStart: currentDates[0],
    currentEnd: currentDates.at(-1),
    previousStart: previousDates[0],
    previousEnd: previousDates.at(-1),
  };
}

function card({
  key,
  kind,
  title,
  summary,
  whyItMatters,
  primary,
  confidence,
  window,
  evidence: evidenceRows,
  sources,
  caveat,
}) {
  return {
    key,
    kind,
    title,
    summary,
    whyItMatters,
    primary,
    confidence,
    windowStart: window.start,
    windowEnd: window.end,
    evidence: evidenceRows,
    sources,
    caveat,
  };
}

// ---------------------------------------------------------------------------
// GA4 days that were still being attributed when collected (bead ro-5e8.10)
// ---------------------------------------------------------------------------
// GA4 keeps assigning a day's sessions to channels after the day ends, so the
// analyzer marks its three attribution families `provisional=1` until a
// collection on day D+2 confirmed the day (ro-wo0j, docs/20 honesty rules). A
// provisional day is not a noisier copy of the settled one — it is wrong in a
// known direction: one site's 2026-09-21, read at D+1, put 3,380 sessions in
// "Unassigned" against 101–340 on every other September day, and read Organic
// Search low. Every rule over these families therefore reads SETTLED days only.
//
// SKIPPED, NOT LABELLED. A "provisional" label on the card would still publish a
// finding the next collection is expected to reverse, and would need its own
// ranking rule and its own rendering; a real finding costs nothing to wait for,
// because the day settles within two days and the next analysis reads it.
//
// SET ASIDE IS NOT DELETED. A card built beside provisional days names them in a
// `Provisional days set aside` evidence row, and the rows stay in the CSV,
// marked. A family holding ONLY provisional days raises no card at all.
//
// Only an explicit `provisional=1` is set aside. An empty cell (the analyzer
// could not read the collection date) or a row from before the column existed
// is read exactly as it was before this rule.
function isProvisionalAttributionRow(row) {
  return nullableNumber(row.provisional) === 1;
}

/** One GA4 attribution family split into the rows a rule may read and the
 * report dates it set aside. */
function settledAttributionRows(families, name) {
  const settled = [];
  const provisionalDates = new Set();
  for (const row of rows(families, name)) {
    if (isProvisionalAttributionRow(row)) provisionalDates.add(text(row.report_date));
    else settled.push(row);
  }
  return { rows: settled, provisionalDates: [...provisionalDates].sort() };
}

/** The evidence row a card carries when provisional days were set aside —
 * nothing at all when none were, so a card over settled days only reads exactly
 * as it did before the rule. */
function provisionalDaysEvidence(provisionalDates) {
  if (provisionalDates.length === 0) return [];
  return [
    evidence(
      'Provisional days set aside',
      formatInt(provisionalDates.length),
      `${provisionalDates.join(', ')} — GA4 was still attributing ` +
        `${provisionalDates.length === 1 ? 'this day' : 'these days'} when collected; ` +
        'read once collected two days later',
    ),
  ];
}

// ---------------------------------------------------------------------------
// LLM-grounding / quoted-literal query classification
// (the 2026-07-31 signal audit, F2)
// ---------------------------------------------------------------------------
// 4,217 impressions — 9.0% of every captured page/query impression in the
// largest site's archive — came from queries carrying quoted phrases, and they
// produced zero clicks between them: `"1 medium banana" "3/4 cup" myplate` and
// 101 siblings. Nobody types a quoted phrase pair a thousand times in three days
// and never clicks. That is a machine verifying a retrieved claim, and left in
// the series it chose the striking-distance rule's next candidate, seeded the
// cannibalization rule's runner-up, and sat on the desktop side of the device
// split.
//
// EXCLUDED IS NOT DELETED. Every rule reading a decontaminated series states
// what was removed in its own evidence — the system may decide not to act on
// something, never not to mention it (AGENTS.md) — and the traffic gets its own
// card below rather than vanishing: programmatic grounding is a GEO signal, not
// noise.
//
// SCOPE, deliberately narrow. Only the quoted-phrase signature is classified.
// The same archive holds an unquoted homework-shaped family — `usda myplate
// tomatoes vegetable group` and kin, also zero-click — that reads identically
// to a human, but every generalization of it that does not hard-code one
// property's brand also catches ordinary long-tail informational demand. Those
// queries stay in the series and the grounding card says so.
const GROUNDING_QUOTED_PHRASE = /"[^"]+"/;

/**
 * A GSC page/query series split into the rows a CTR or position rule may read
 * and the grounding rows it may not, with the totals such a rule must state.
 * Rows are never dropped without an accounting: `excluded` is what the evidence
 * row is built from, and it stays present (at zero) when nothing matched, so a
 * card proves the check ran rather than implying it.
 */
function excludeGroundingQueries(input) {
  const kept = [];
  const byQuery = new Map();
  const byPage = new Map();
  let impressions = 0;
  let excludedImpressions = 0;
  let excludedClicks = 0;
  for (const row of input) {
    const rowImpressions = number(row.impressions);
    impressions += rowImpressions;
    const query = text(row.query).trim();
    if (!query || !GROUNDING_QUOTED_PHRASE.test(query)) {
      kept.push(row);
      continue;
    }
    excludedImpressions += rowImpressions;
    excludedClicks += number(row.clicks);
    const key = query.toLocaleLowerCase('en-US');
    const current = byQuery.get(key) ?? { query, impressions: 0, clicks: 0 };
    current.impressions += rowImpressions;
    current.clicks += number(row.clicks);
    byQuery.set(key, current);
    const page = text(row.page);
    if (page) {
      byPage.set(page, (byPage.get(page) ?? 0) + rowImpressions);
    }
  }
  const rank = (left, right) =>
    right.impressions - left.impressions || left.query.localeCompare(right.query);
  return {
    rows: kept,
    excluded: {
      impressions: excludedImpressions,
      clicks: excludedClicks,
      queries: byQuery.size,
      capturedImpressions: impressions,
      share: impressions > 0 ? excludedImpressions / impressions : 0,
      topQueries: [...byQuery.values()].sort(rank),
      topPages: [...byPage.entries()]
        .map(([page, pageImpressions]) => ({ page, impressions: pageImpressions }))
        .sort(
          (left, right) =>
            right.impressions - left.impressions ||
            left.page.localeCompare(right.page),
        ),
    },
  };
}

/** The one evidence row every decontaminated rule carries. */
function groundingExclusionEvidence(excluded) {
  return evidence(
    'Grounding queries excluded',
    formatInt(excluded.impressions),
    excluded.impressions > 0
      ? `${formatPercent(excluded.share)} of captured impressions · ` +
          `${formatInt(excluded.queries)} quoted-literal queries · ${formatInt(excluded.clicks)} clicks`
      : 'No quoted-literal queries in this window',
  );
}

/** A property's own page/query rows are the only archived family carrying both
 * a query and a click, so it is where the classification is observable — even
 * for rules (device) whose own family has no query grain. */
function groundingExclusion(families) {
  return excludeGroundingQueries(rows(families, 'gsc-page-query')).excluded;
}

// ---------------------------------------------------------------------------
// The AI Overview gate on harvest recommendations
// (`ro-gyu`; the zero-click question is F1 of the 2026-07-31 myplate audit)
// ---------------------------------------------------------------------------
// The striking-distance rule scores position 4–12 terms and REWARDS low
// click-through, so with grounding queries excluded it preferentially surfaces
// exactly the zero-click SERPs where an AI Overview is consuming the click: the
// term ranks well, takes nothing, and looks like the largest opportunity on the
// page. Copy and link work on such a term is churn without reach.
//
// The tracked panel is the only evidence that separates the two cases, and it is
// three-state (scripts/README §serp-panel). Only `uncited` — a parsed overview
// that demonstrably does not cite this property — withholds a recommendation,
// because it is the only positive observation of the click being consumed
// inside the block. A term nobody tracked, and a tracked term whose
// asynchronous overview never loaded, are UNKNOWN: still offered, and marked as
// unknown on the card, exactly as offerable as they were before the panel
// existed. Unknown hardening into `false` is the one failure this contract
// exists to prevent.

/** One device's reading of one term, as the gate reads it. */
function aiOverviewStateOf(reading) {
  if (!reading || reading.aioPresent === null) return 'unknown';
  if (reading.aioPresent === false) return 'absent';
  if (reading.aioCitesUs === true) return 'cited';
  if (reading.aioCitesUs === false) return 'uncited';
  // An overview is there; whether it cites this property did not parse. Not
  // evidence of an uncited block, so it does not withhold.
  return 'present';
}

/** One term's tracked-panel state PER DEVICE, in device order — empty when the
 * term is not on the panel at all (`ro-14d.1`). A folded verdict would have to
 * pick a surface, and the surfaces are the finding. */
function trackedAiOverviewStates(panel, query) {
  return (panel?.byQuery.get(normalizedQuery(query)) ?? []).map((reading) => ({
    device: reading.device,
    state: aiOverviewStateOf(reading),
  }));
}

/** The gate itself: a recommendation is withheld when ANY device the panel read
 * shows an overview that demonstrably does not cite this property.
 *
 * Any, not all, and that is the point of the second device. `uncited` is a
 * POSITIVE observation of the click being consumed inside the block on a real
 * result page a real person sees; a clear desktop page does not give that click
 * back to a phone searcher, and most food/health search happens on a phone.
 * Requiring both surfaces to agree would let the quieter one veto the evidence
 * — the exact failure of reading one device, rebuilt with extra steps. */
function withholdsForAiOverview(states) {
  return states.some(({ state }) => state === 'uncited');
}

/** The device as the operator names it, never as the data lane does (doc 14:
 * the collection mechanism is not vocabulary for a property page). */
function deviceNoun(device) {
  if (device === 'mobile') return 'Phone';
  if (device === 'desktop') return 'Desktop';
  return device.charAt(0).toUpperCase() + device.slice(1);
}

const AI_OVERVIEW_STATED = {
  unknown: [
    'Unknown',
    'Not on the tracked panel, or its overview did not load — unknown, never “no overview”',
  ],
  absent: ['None observed', 'No AI Overview on the live result page'],
  cited: [
    'Cites this property',
    'An AI Overview holds this result page and cites this property',
  ],
  uncited: [
    'Shown · does not cite this property',
    'An AI Overview holds this result page and does not cite this property',
  ],
  present: [
    'Present · citation unknown',
    'An AI Overview holds this result page; whether it cites this property did not parse',
  ],
};

/** Short per-device phrasing, for the line that has to fit two surfaces. */
const AI_OVERVIEW_SHORT = {
  unknown: 'unknown',
  absent: 'none',
  cited: 'cites us',
  uncited: 'not cited',
  present: 'shown',
};

/** What the card says about the term it recommends. Stated in every state,
 * including unknown, so the card never implies the SERP was checked when it was
 * not — and never implies it was clear when it is merely unobserved.
 *
 * When the devices DISAGREE the line names both rather than folding to one
 * (`ro-14d.1`): a term walled on the phone and clear on the desktop is two
 * facts, and either half alone is a claim about a page the reader is not
 * looking at. When they agree, the wording is the single-surface wording it has
 * always been — a device column that never varies is noise. */
function aiOverviewEvidence(states, panel) {
  const observed = panel?.observedAt
    ? `tracked panel observed ${panel.observedAt}`
    : 'tracked panel';
  const distinct = new Set(states.map(({ state }) => state));
  if (distinct.size > 1) {
    return evidence(
      'AI Overview on this term',
      states
        .map(({ device, state }) => `${deviceNoun(device)}: ${AI_OVERVIEW_SHORT[state]}`)
        .join(' · '),
      'The result pages disagree by surface — an overview that consumes the click on one device does not clear it on the other · ' +
        observed,
    );
  }
  const state = [...distinct][0] ?? 'unknown';
  const stated = AI_OVERVIEW_STATED[state];
  // Unknown names no observation day, because the sentence covers both ways a
  // term gets there — never tracked, or tracked and unanswered — and dating an
  // observation that may not exist would imply the SERP was checked.
  return evidence(
    'AI Overview on this term',
    stated[0],
    state === 'unknown' ? stated[1] : `${stated[1]} · ${observed}`,
  );
}

function strikingDistanceInsight(families) {
  const { rows: input, excluded } = excludeGroundingQueries(
    rows(families, 'gsc-page-query'),
  );
  const panel = serpPanelEvidence(families);
  const window = dateWindow(input);
  if (!window) return null;
  const grouped = new Map();
  for (const row of input) {
    const page = text(row.page);
    const query = text(row.query);
    if (!page || !query) continue;
    const key = `${page}\u0000${query}`;
    const current = grouped.get(key) ?? {
      page,
      query,
      impressions: 0,
      clicks: 0,
      weightedPosition: 0,
    };
    const impressions = number(row.impressions);
    current.impressions += impressions;
    current.clicks += number(row.clicks);
    current.weightedPosition += number(row.position) * impressions;
    grouped.set(key, current);
  }
  const threshold = Math.max(100, window.days * 25);
  const scored = [...grouped.values()]
    .map((value) => ({
      ...value,
      position:
        value.impressions > 0 ? value.weightedPosition / value.impressions : 0,
      ctr: value.impressions > 0 ? value.clicks / value.impressions : 0,
      aiOverview: trackedAiOverviewStates(panel, value.query),
    }))
    .filter(
      (value) =>
        value.impressions >= threshold &&
        value.position >= 4 &&
        value.position <= 12,
    )
    .sort((left, right) => {
      const score = (value) =>
        value.impressions *
        (1 - Math.min(value.ctr, 0.5)) *
        Math.max(0.1, (13 - value.position) / 9);
      return score(right) - score(left);
    });
  const withheld = scored.filter((value) => withholdsForAiOverview(value.aiOverview));
  const candidates = scored.filter(
    (value) => !withholdsForAiOverview(value.aiOverview),
  );
  const best = candidates[0];
  if (!best) return null;
  const runnerUp = candidates[1];
  return card({
    key: 'search-striking-distance',
    kind: 'recommendation',
    title: `Move “${best.query}” into the top results`,
    summary:
      `${pagePath(best.page)} is already visible at average position ` +
      `${formatDecimal(best.position)} with ${formatInt(best.impressions)} impressions. ` +
      'A focused content, title, and internal-link review is the clearest near-term search opportunity.',
    whyItMatters:
      'This is existing demand, not a speculative keyword: the page is repeatedly being shown but sits below the highest-click positions.',
    primary: {
      value: formatInt(best.impressions),
      label: 'captured impressions',
    },
    confidence: best.impressions >= 500 && window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Average position', formatDecimal(best.position)),
      evidence('CTR', formatPercent(best.ctr)),
      evidence('Clicks', formatInt(best.clicks)),
      ...(runnerUp
        ? [
            evidence(
              'Next candidate',
              `“${runnerUp.query}”`,
              `${pagePath(runnerUp.page)} · position ${formatDecimal(runnerUp.position)} · ${formatInt(runnerUp.impressions)} impressions`,
            ),
          ]
        : []),
      aiOverviewEvidence(best.aiOverview, panel),
      ...(withheld.length > 0
        ? [
            evidence(
              'AI Overview terms withheld',
              formatInt(withheld.length),
              `Largest: “${withheld[0].query}” (${formatInt(withheld[0].impressions)} impressions) — the tracked overview ` +
                `holds that result page on ${withheld[0].aiOverview
                  .filter(({ state }) => state === 'uncited')
                  .map(({ device }) => deviceNoun(device).toLowerCase())
                  .join(' and ')} and does not cite this property, so the click is consumed inside the block`,
            ),
          ]
        : []),
      groundingExclusionEvidence(excluded),
    ],
    sources: panel
      ? [source('gsc', 'page-query'), source('dataforseo', 'serp-panel')]
      : [source('gsc', 'page-query')],
    caveat:
      'GSC page/query exports contain top rows and can omit anonymized or low-volume demand. ' +
      'Quoted-literal grounding queries are excluded before ranking candidates — they carry impressions no title rewrite can convert. ' +
      'A term whose tracked panel row reports an AI Overview that does not cite this property on EITHER device is withheld rather than ' +
      'recommended: the click is consumed inside that block, so moving the page cannot recover it, and a clear result page on the other ' +
      'surface does not give it back. A term outside the panel, or one whose overview did not load, is unknown rather than clear — it is ' +
      'still offered, and the card says which it is.',
  });
}

function searchAppearanceInsight(families) {
  const input = rows(families, 'gsc-search-appearance-pages').filter(
    (row) => row.row_grain === 'searchAppearance',
  );
  const window = dateWindow(input);
  if (!window) return null;
  const grouped = new Map();
  for (const row of input) {
    const appearance = text(row.searchAppearance);
    if (!appearance) continue;
    const current = grouped.get(appearance) ?? {
      appearance,
      impressions: 0,
      clicks: 0,
      weightedPosition: 0,
    };
    const impressions = number(row.impressions);
    current.impressions += impressions;
    current.clicks += number(row.clicks);
    current.weightedPosition += number(row.position) * impressions;
    grouped.set(appearance, current);
  }
  const ranked = [...grouped.values()].sort(
    (left, right) => right.impressions - left.impressions,
  );
  const best = ranked[0];
  if (!best || best.impressions <= 0) return null;
  const ctr = best.clicks / best.impressions;
  const position = best.weightedPosition / best.impressions;
  return card({
    key: 'search-appearance-leader',
    kind: 'discovery',
    title: `${humanizeAppearance(best.appearance)} is the leading search treatment`,
    summary:
      `Google reported ${formatInt(best.impressions)} impressions for this treatment ` +
      `at ${formatPercent(ctr)} CTR. Preserve the markup and use the page-level breakdown to identify where the treatment is strongest or missing.`,
    whyItMatters:
      'Search-result treatments change how much visual space a page earns and can reveal where structured content is already compounding visibility.',
    primary: {
      value: formatInt(best.impressions),
      label: 'appearance impressions',
    },
    confidence: window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Clicks', formatInt(best.clicks)),
      evidence('CTR', formatPercent(ctr)),
      evidence('Average position', formatDecimal(position)),
      evidence('Appearance type', best.appearance),
    ],
    sources: [source('gsc', 'search-appearance-pages')],
    caveat: 'Appearance totals and filtered page rows are separate grains and must not be summed together.',
  });
}

function imageSearchInsight(families) {
  const input = rows(families, 'gsc-image-page-query');
  const window = dateWindow(input);
  if (!window) return null;
  let impressions = 0;
  let clicks = 0;
  const pages = new Map();
  for (const row of input) {
    const rowImpressions = number(row.impressions);
    impressions += rowImpressions;
    clicks += number(row.clicks);
    const page = text(row.page);
    if (!page) continue;
    const current = pages.get(page) ?? { page, impressions: 0, clicks: 0 };
    current.impressions += rowImpressions;
    current.clicks += number(row.clicks);
    pages.set(page, current);
  }
  if (impressions <= 0) return null;
  const noClicks = clicks === 0;
  const topPage = [...pages.values()].sort(
    (left, right) => right.impressions - left.impressions,
  )[0];
  return card({
    key: 'image-search-demand',
    kind: noClicks ? 'recommendation' : 'discovery',
    title: noClicks
      ? 'Turn Image Search visibility into clicks'
      : 'Image Search is a measurable acquisition surface',
    summary: noClicks
      ? `The captured image-search rows produced ${formatInt(impressions)} impressions but no clicks. Review the leading page’s image usefulness, context, and result appeal before expanding image coverage.`
      : `The captured image-search rows produced ${formatInt(clicks)} clicks from ${formatInt(impressions)} impressions. Treat image quality, alt text, and recipe-media coverage as a growth surface rather than decorative polish.`,
    whyItMatters:
      'Food intent is visual. Image demand can expose pages and queries that ordinary Web Search totals hide.',
    primary: noClicks
      ? {
          value: formatInt(impressions),
          label: 'image-search impressions',
        }
      : { value: formatInt(clicks), label: 'image-search clicks' },
    confidence: window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Captured impressions', formatInt(impressions)),
      evidence('Captured CTR', formatPercent(clicks / impressions)),
      ...(topPage
        ? [
            evidence(
              'Top page',
              pagePath(topPage.page),
              `${formatInt(topPage.impressions)} captured impressions`,
            ),
          ]
        : []),
    ],
    sources: [source('gsc', 'image-page-query')],
    caveat: 'This is the sum of GSC top rows, not a guaranteed property-total export.',
  });
}

function bingCrawlIssueInsight(families) {
  const input = latestSnapshotRows(families, 'bing-webmaster-crawl-issues');
  const window = dateWindow(input);
  if (!window || input.length === 0) return null;
  const issues = input.filter(
    (row) => number(row.issues) > 0 || text(row.issue_names),
  );
  if (issues.length === 0) return null;

  const counts = new Map();
  for (const row of issues) {
    const names = text(row.issue_names).split('|').filter(Boolean);
    for (const name of names.length > 0 ? names : ['Unclassified']) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  const [leadingIssue, leadingCount] = ranked[0] ?? ['Unclassified', issues.length];
  const top = [...issues].sort((left, right) => number(right.in_links) - number(left.in_links))[0];
  const severe = ['ContainsMalware', 'Code5xx', 'DnsErrors', 'TimeOutErrors'].some(
    (name) => counts.has(name),
  );
  const crawlStats = latestSnapshotRows(families, 'bing-webmaster-crawl-stats')
    .sort((left, right) =>
      text(right.provider_date).localeCompare(text(left.provider_date)),
    )[0];
  return card({
    key: 'bing-crawl-issues',
    kind: 'warning',
    title: `Bing reports ${formatInt(issues.length)} URL${issues.length === 1 ? '' : 's'} with crawl issues`,
    summary:
      `${humanizeBingIssue(leadingIssue)} is the most common reported issue` +
      `${leadingCount > 1 ? ` (${formatInt(leadingCount)} URLs)` : ''}. ` +
      `${severe ? 'Treat this as a technical-search incident.' : 'Review the affected URLs before changing content based on weak Bing performance.'}`,
    whyItMatters:
      'Crawl failures can suppress discovery and rankings while making healthy content look unsuccessful in search analytics.',
    primary: {
      value: formatInt(issues.length),
      label: 'affected URLs',
    },
    confidence: 'high',
    window,
    evidence: [
      evidence('Leading issue', humanizeBingIssue(leadingIssue)),
      ...(top
        ? [
            evidence(
              'Highest-linked URL',
              pagePath(top.url),
              `${formatInt(number(top.in_links))} reported inlinks · HTTP ${text(top.http_code) || 'unknown'}`,
            ),
          ]
        : []),
      ...(crawlStats
        ? [
            evidence(
              'Latest crawl errors',
              formatInt(number(crawlStats.crawl_errors)),
              `Provider date ${text(crawlStats.provider_date) || 'unknown'}`,
            ),
            evidence('URLs in Bing index', formatInt(number(crawlStats.in_index))),
          ]
        : []),
    ],
    sources: [
      source('bing-webmaster', 'crawl-issues'),
      ...(crawlStats ? [source('bing-webmaster', 'crawl-stats')] : []),
    ],
    caveat:
      'Bing says fixed crawl issues can remain in this API response for several days; verify the affected URL before acting.',
  });
}

function bingFeedIssueInsight(families) {
  const input = latestSnapshotRows(families, 'bing-webmaster-feeds');
  const window = dateWindow(input);
  if (!window) return null;
  const failures = input.filter((row) => {
    const status = text(row.status).trim().toLowerCase();
    return status && status !== 'success';
  });
  if (failures.length === 0) return null;
  const top = failures[0];
  return card({
    key: 'bing-feed-issues',
    kind: 'warning',
    title: `Bing reports ${formatInt(failures.length)} sitemap/feed problem${failures.length === 1 ? '' : 's'}`,
    summary:
      `${pagePath(top.url)} currently reports “${text(top.status)}”. ` +
      'Restore a successful crawl before treating missing Bing visibility as a content-demand signal.',
    whyItMatters:
      'A rejected or unreadable sitemap slows reliable URL discovery and makes the search dataset less representative of the actual site.',
    primary: {
      value: formatInt(failures.length),
      label: 'unhealthy feeds',
    },
    confidence: 'high',
    window,
    evidence: [
      evidence('Feed', pagePath(top.url)),
      evidence('Bing status', text(top.status)),
      evidence('Declared URLs', formatInt(number(top.url_count))),
      ...(text(top.last_crawled)
        ? [evidence('Last crawled', text(top.last_crawled))]
        : []),
    ],
    sources: [source('bing-webmaster', 'feeds')],
    caveat:
      'Feed status is Bing-reported and can lag a successful resubmission; confirm the live sitemap and the next provider refresh.',
  });
}

// Three corrections to this rule from
// the 2026-07-31 signal audit (F3),
// which caught it calling a four-month decline an opportunity at high
// confidence and pointing the operator at the wrong page to fix it.
//
// (a) The join. "dri" (an English/US Bing query) was joined to
// `/es/calculadora-dri` purely because GSC happened to carry the query on that
// page. A localized page is a different surface for a different searcher, and
// Bing's top-query export has no locale dimension to prove otherwise, so a page
// under a locale subtree can never be the identified landing page. No candidate
// outside one means the card says it has none — an unidentified page is a
// smaller error than a confidently wrong one.
const LOCALE_PATH_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2})?(?:\/|$)/i;
// (b) The trend. The "dri" weekly series ran 2,054 → 1,614 → 438 → 604 → 261 →
// 372: the last two weeks sat near a quarter of the window's own mean while the
// card presented the four-month total as current demand. Two periods is the
// shortest recent stretch that is not one revisable week.
const BING_TREND_RECENT_PERIODS = 2;
const BING_TREND_DECLINE_RATIO = 0.7;
// (c) The intent read. Months of ~0% CTR at a visible position is not an
// unconverted opportunity, it is evidence the query means something else —
// "dri" is an ambiguous acronym, and the property took 5 clicks on 11,825
// impressions across ten weeks at position 6–9. Long window, visible position,
// no clicks: name intent mismatch and stop claiming high confidence.
const BING_INTENT_MISMATCH_MAX_CTR = 0.005;
const BING_INTENT_MISMATCH_MIN_PERIODS = 8;
// (d) The join floor. With the locale rule in place "dri" joined
// `/dri-calculator` on ONE captured GSC impression: the card named a page as
// *the* review target off a single row, and the join was the only step in this
// file with no evidence floor at all (recorded noticed-not-fixed by the audit
// brief's F3, tracked as `ro-otv`). GSC page/query exports are top rows, so a
// page the property's own Google series carries a handful of times is the
// export catching it once, not a page Google repeatedly returns for the term.
// Ten is the prune rule's five-impression long-tail line doubled, because this
// claim names one page as the thing to work on rather than listing pages to
// read. Below it the card says it has no landing page — and names the
// candidate it declined, because a thin candidate and no candidate are
// different facts and only the card can tell them apart.
const BING_JOIN_MIN_GSC_IMPRESSIONS = 10;

function bingSearchOpportunityInsight(families) {
  const input = latestSnapshotRows(families, 'bing-webmaster-queries');
  if (input.length === 0) return null;
  const grouped = new Map();
  for (const row of input) {
    const query = text(row.query).trim();
    if (!query) continue;
    const current = grouped.get(query) ?? {
      query,
      impressions: 0,
      clicks: 0,
      weightedPosition: 0,
      periods: new Map(),
      rows: [],
    };
    const impressions = number(row.impressions);
    current.impressions += impressions;
    current.clicks += number(row.clicks);
    current.weightedPosition += number(row.avg_impression_position) * impressions;
    const period = text(row.provider_date);
    if (period) {
      current.periods.set(period, (current.periods.get(period) ?? 0) + impressions);
    }
    current.rows.push(row);
    grouped.set(query, current);
  }
  const candidates = [...grouped.values()]
    .map((value) => ({
      ...value,
      position:
        value.impressions > 0 ? value.weightedPosition / value.impressions : 0,
      ctr: value.impressions > 0 ? value.clicks / value.impressions : 0,
    }))
    .filter(
      (value) =>
        value.impressions >= 50 &&
        value.position >= 4 &&
        value.position <= 20 &&
        value.ctr < 0.15,
    )
    .sort(
      (left, right) =>
        right.impressions * (21 - right.position) -
        left.impressions * (21 - left.position),
    );
  const best = candidates[0];
  if (!best) return null;
  // The window is this query's own reported periods, not the snapshot's: the
  // rule previously quoted every date any query was reported on, which read as
  // 18 dates for a query the provider reported on 10.
  const window = providerDateWindow(best.rows);
  if (!window) return null;

  const series = [...best.periods.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const periodMean =
    series.length > 0
      ? series.reduce((sum, [, value]) => sum + value, 0) / series.length
      : 0;
  const recent = series.slice(-BING_TREND_RECENT_PERIODS);
  const recentMean =
    recent.length > 0
      ? recent.reduce((sum, [, value]) => sum + value, 0) / recent.length
      : 0;
  const declining =
    series.length > BING_TREND_RECENT_PERIODS &&
    periodMean > 0 &&
    recentMean <= periodMean * BING_TREND_DECLINE_RATIO;
  const intentMismatch =
    series.length >= BING_INTENT_MISMATCH_MIN_PERIODS &&
    best.ctr <= BING_INTENT_MISMATCH_MAX_CTR;

  const googleMatches = rows(families, 'gsc-page-query').filter(
    (row) => text(row.query).trim().toLowerCase() === best.query.toLowerCase(),
  );
  const googlePages = new Map();
  for (const row of googleMatches) {
    const page = text(row.page);
    if (!page || LOCALE_PATH_PREFIX.test(pagePath(page))) continue;
    googlePages.set(
      page,
      (googlePages.get(page) ?? 0) + number(row.impressions),
    );
  }
  const rankedGooglePages = [...googlePages.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const googlePage = rankedGooglePages.find(
    ([, impressions]) => impressions >= BING_JOIN_MIN_GSC_IMPRESSIONS,
  );
  // Excluded is not deleted. A candidate that existed and was too thin is a
  // different fact from no candidate at all: the first tells the operator where
  // to start looking, the second says the archive has nothing to offer.
  const thinGooglePage = googlePage ? null : (rankedGooglePages[0] ?? null);
  const thinGooglePageDetail = thinGooglePage
    ? `${pagePath(thinGooglePage[0])} at ${formatInt(thinGooglePage[1])} captured GSC impression${thinGooglePage[1] === 1 ? '' : 's'}, under the ${formatInt(BING_JOIN_MIN_GSC_IMPRESSIONS)}-impression join floor`
    : null;
  return card({
    key: 'bing-search-opportunity',
    kind: 'recommendation',
    title: `Improve Bing visibility for “${best.query}”`,
    summary:
      `Bing reports ${formatInt(best.impressions)} top-query impressions across ${formatInt(window.days)} reported date${window.days === 1 ? '' : 's'} at average position ${formatDecimal(best.position)}. ` +
      (declining
        ? `The series is declining: the latest ${formatInt(recent.length)} reported periods average ` +
          `${formatInt(recentMean)} impressions against ${formatInt(periodMean)} across the window, so the total above is history rather than current demand. `
        : '') +
      (intentMismatch
        ? `${formatInt(best.clicks)} click${best.clicks === 1 ? '' : 's'} across ${formatInt(series.length)} reported periods at a visible position points at intent mismatch — the query may mean something this property does not answer — before it points at a title or indexability problem. `
        : '') +
      (googlePage
        ? `${pagePath(googlePage[0])} is the matching Google-visible page, giving the review a concrete starting point.`
        : thinGooglePageDetail
          ? `No reliable landing page identified: the closest non-localized Google page is ${thinGooglePageDetail}, so the archive caught it rather than showed it repeatedly. Identify the intended page first, then review its Bing indexability, title, and internal links.`
          : 'No reliable landing page identified: no non-localized Google page carries this query, and Bing does not return one. Identify the intended page first, then review its Bing indexability, title, and internal links.'),
    whyItMatters:
      'This is provider-observed demand already close enough to compete; joining it to the matching Google page avoids inventing a landing-page relationship Bing does not return.',
    primary: {
      value: formatInt(best.impressions),
      label: 'Bing impressions',
    },
    // A declining series and a long zero-click window are both reasons the
    // total cannot carry high confidence, whatever its size.
    confidence:
      declining || intentMismatch
        ? 'medium'
        : best.impressions >= 250
          ? 'high'
          : 'medium',
    window,
    evidence: [
      evidence('Average Bing position', formatDecimal(best.position)),
      evidence('Bing CTR', formatPercent(best.ctr)),
      evidence('Bing clicks', formatInt(best.clicks)),
      ...(series.length > 0
        ? [
            evidence(
              'Latest reported period',
              formatInt(series.at(-1)[1]),
              `${series.at(-1)[0]} · window mean ${formatInt(periodMean)} across ${formatInt(series.length)} periods`,
            ),
          ]
        : []),
      ...(googlePage
        ? [
            evidence(
              'Matching Google page',
              pagePath(googlePage[0]),
              `${formatInt(googlePage[1])} captured GSC impressions`,
            ),
          ]
        : [
            evidence(
              'Matching Google page',
              'none identified',
              thinGooglePageDetail
                ? `Closest candidate declined: ${thinGooglePageDetail}`
                : 'No non-localized Google page carries this query',
            ),
          ]),
    ],
    sources: [
      source('bing-webmaster', 'queries'),
      ...(googlePage ? [source('gsc', 'page-query')] : []),
    ],
    caveat:
      'Bing top-query data updates weekly and is not a complete export; GSC and Bing windows differ, so the join identifies a page but does not compare raw volume. ' +
      'Pages under a locale subtree are never joined: Bing reports no locale for a query, so a localized page matching by string is a coincidence, not evidence. ' +
      `A page is named only when the property's own Google series carries this query on it at least ${formatInt(BING_JOIN_MIN_GSC_IMPRESSIONS)} times — GSC exports are top rows, so a page caught once is a coincidence too, and the card names the candidate it declined rather than dropping it silently.`,
  });
}

function aiReferralInsight(families) {
  const settled = settledAttributionRows(families, 'ga4-landing-page-acquisition');
  const input = settled.rows.filter(
    (row) =>
      text(row.sessionDefaultChannelGroup).toLowerCase() === 'ai assistant' ||
      text(row.sessionSourceMedium).toLowerCase().includes('ai-assistant'),
  );
  const window = dateWindow(input);
  if (!window) return null;
  let sessions = 0;
  let keyEvents = 0;
  const landings = new Map();
  const sources = new Map();
  for (const row of input) {
    const rowSessions = number(row.sessions);
    sessions += rowSessions;
    keyEvents += number(row.keyEvents);
    const landing = text(row.landingPage);
    const sourceMedium = text(row.sessionSourceMedium);
    if (landing && landing !== '(not set)') {
      landings.set(landing, (landings.get(landing) ?? 0) + rowSessions);
    }
    sources.set(sourceMedium, (sources.get(sourceMedium) ?? 0) + rowSessions);
  }
  if (sessions <= 0) return null;
  const topLanding = [...landings.entries()].sort((a, b) => b[1] - a[1])[0];
  const topSource = [...sources.entries()].sort((a, b) => b[1] - a[1])[0];
  return card({
    key: 'ai-referral-floor',
    kind: 'discovery',
    title: 'AI assistants are already sending identifiable visits',
    summary: topLanding
      ? `${formatInt(sessions)} sessions arrived through GA4’s AI Assistant channel. ${pagePath(topLanding[0])} was the most common identified landing page.`
      : `${formatInt(sessions)} sessions arrived through GA4’s AI Assistant channel, but GA4 did not identify a landing page.`,
    whyItMatters:
      'This is a measurable floor for GEO distribution and identifies pages assistants choose to cite or recommend when a referrer survives.',
    primary: { value: formatInt(sessions), label: 'AI-referred sessions' },
    confidence: sessions >= 10 && window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      ...(topSource
        ? [evidence('Leading source', topSource[0], `${formatInt(topSource[1])} sessions`)]
        : []),
      ...(topLanding
        ? [evidence('Leading landing page', pagePath(topLanding[0]), `${formatInt(topLanding[1])} sessions`)]
        : []),
      evidence('Key events', formatInt(keyEvents)),
      ...provisionalDaysEvidence(settled.provisionalDates),
    ],
    sources: [source('ga4', 'landing-page-acquisition')],
    caveat: 'Identifiable referrals are a floor: assistants and apps can omit or strip referrers.',
  });
}

/**
 * GA4's answer to "which page is worst for JavaScript errors", extracted so the
 * `javascript-errors` card and the reconciliation card below read ONE ranking.
 * Two rules recomputing this separately could name different pages while
 * claiming to speak for the same observer, which is the failure the
 * reconciliation card exists to expose — it must not commit it itself.
 *
 * null means GA4 has no answer at all: no reported `js_error` dates, or a volume
 * under the floor. That is "GA4 did not say", never "GA4 says zero".
 */
function javascriptErrorRanking(families) {
  const input = rows(families, 'ga4-page-events');
  const errorRows = input.filter((row) => text(row.eventName) === 'js_error');
  const window = dateWindow(errorRows);
  if (!window) return null;
  const byPage = new Map();
  for (const row of input) {
    const page = text(row.unifiedPagePathScreen);
    const event = text(row.eventName);
    if (!page) continue;
    const current = byPage.get(page) ?? {
      page,
      path: pagePath(page),
      errors: 0,
      errorUsers: 0,
      pageViews: 0,
    };
    if (event === 'js_error') {
      current.errors += number(row.eventCount);
      current.errorUsers += number(row.totalUsers);
    } else if (event === 'page_view') {
      current.pageViews += number(row.eventCount);
    }
    byPage.set(page, current);
  }
  const ranked = [...byPage.values()].sort(
    (left, right) => right.errors - left.errors || left.page.localeCompare(right.page),
  );
  const top = ranked[0];
  const totalErrors = ranked.reduce((sum, row) => sum + row.errors, 0);
  const totalUsers = ranked.reduce((sum, row) => sum + row.errorUsers, 0);
  if (!top || totalErrors < Math.max(10, window.days * 2)) return null;
  return {
    ranked,
    // Pages this observer actually reported an error on. `ranked` holds every
    // page GA4 reported any event for, so it is the wrong denominator for "ranks
    // #3 of N": it would quietly widen the field with pages that have nothing to
    // do with the question.
    errorPages: ranked.filter((row) => row.errors > 0),
    top,
    byPath: new Map(ranked.map((row) => [row.path, row])),
    totalErrors,
    totalUsers,
    window,
  };
}

// ---------------------------------------------------------------------------
// The triage half of the javascript-errors card (`ro-14d.3`)
// ---------------------------------------------------------------------------
// `javascriptErrorRanking` above answers WHICH PAGE throws. `ga4-js-errors`
// answers WHAT IT THROWS — the only half an engineer can act on, and the stated
// reason the family was built (the 2026-07-31 myplate audit, F5; docs/11
// §js-errors). It has been collected, flattened and documented since then with
// no reader at all: 584 rows over eight reported dates on one site, 44
// distinct message buckets, and every one of them invisible.
//
// This is NOT a second card. It adds rows to the card that already owns the
// question, so the page ranking and the message ranking cannot drift apart, and
// it says nothing about which observer is right — that is
// `error-observer-disagreement`'s finding (`ro-d5c`) and duplicating it here
// would put two cards in the room arguing about the same page.
//
// THREE BOUNDARIES the rows are built around.
//
// 1. COUNT THE BUCKET, NOT THE MESSAGE. Raw `message` carries the URL, build
//    hash, and line number of each occurrence, so every row looks unique and
//    ranking it would return a list of ones. `message_bucket` masks those
//    (`<url>`, `<id>`, `<n>`) and is what recurs.
//
// 2. `(not set)` MAY NOT RANK, EVER. GA4 answers for an event parameter only
//    after an operator registers it as a custom dimension, and it backfills
//    NOTHING — so `message` is `(not set)` on every myplate row before roughly
//    2026-08-01/02 (the operator's own verdict, `ro-rkx`, docs/11) and those
//    events can never acquire one. Letting that token rank would put "(not set)"
//    at the top of a triage list as if it were an error to go and fix. The
//    boundary is implemented as a property of the ROW rather than as a date
//    constant: an unattributable row is one whose bucket is GA4's absence token,
//    which is true on any property and any vintage without hard-coding a day.
//    The events are not discarded — they are counted into their own row, so the
//    reader can see how much of the family cannot be triaged.
//
// 3. AN ABSENT FAMILY CHANGES NOTHING. It is registered for the sites that
//    declare it (`config/ga4-custom-dimensions.json`); on every other site the
//    collector records `ga4_custom_dimension_unregistered` and archives nothing,
//    and that is a permanent unknown, never a zero. So the whole triage block is
//    additive: no family, no rows, no sentence, no source, no caveat clause —
//    the card is byte-identical to what it was before this rule existed.
const GA4_NOT_SET = '(not set)';
/** Below this the family answered but nothing in it is a *leading* error. One
 * or two events is the long tail of a browser extension, not the fault worth an
 * engineer's morning, and naming it would spend the card's most actionable line
 * on noise. The accounting row still renders, so a reader can tell "the check
 * ran and found nothing big" from "the check never ran". */
const JS_ERROR_MIN_BUCKET_EVENTS = 5;

/** The heaviest entry in a `Map<string, number>`, ties broken by name so two
 * runs over the same archive cannot disagree. */
function heaviestEntry(counts) {
  const ranked = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  return ranked.length > 0 ? { key: ranked[0][0], events: ranked[0][1] } : null;
}

/**
 * `ga4-js-errors` ranked by masked message bucket, with the unattributable
 * events counted rather than dropped.
 *
 * null means the family is not there at all — unregistered dimensions, or a
 * property that was never offered the family. That is UNKNOWN and the card must
 * behave exactly as it did before this rule existed; it is never "this property
 * throws no errors", which is a different fact the manifest records separately.
 */
function javascriptErrorMessageRanking(families) {
  const input = rows(families, 'ga4-js-errors');
  if (input.length === 0) return null;
  const window = dateWindow(input);
  if (!window) return null;

  const buckets = new Map();
  const attributedDates = new Set();
  // Positions are ranked over EVERY row, including the ones whose message can
  // never be recovered. `source` and `message` are two separately registered
  // dimensions and the operator registered `source` first, so a date that
  // carries no message can still carry a bundle position — that is the half of
  // the triage that survives boundary 2, and scoping it to attributable rows
  // would throw it away for no reason.
  const positions = new Map();
  let totalEvents = 0;
  let unattributedEvents = 0;
  let positionedEvents = 0;
  for (const row of input) {
    const events = number(row.eventCount);
    totalEvents += events;
    const page = text(row.unifiedPagePathScreen).trim();
    // An empty `source` is GA4 declining to answer for the parameter on that
    // event, exactly like `(not set)`. It is left out of the ranking rather than
    // bucketed as a position called "", so a message whose position nobody
    // reported says so instead of naming an empty string.
    const position = text(row.source).trim();
    if (position && position !== GA4_NOT_SET) {
      positionedEvents += events;
      const at = positions.get(position) ?? { position, events: 0, pages: new Map() };
      at.events += events;
      if (page) at.pages.set(page, (at.pages.get(page) ?? 0) + events);
      positions.set(position, at);
    }
    const bucket = text(row.message_bucket).trim();
    if (!bucket || bucket === GA4_NOT_SET) {
      unattributedEvents += events;
      continue;
    }
    attributedDates.add(text(row.report_date));
    const current = buckets.get(bucket) ?? {
      bucket,
      events: 0,
      users: 0,
      sources: new Map(),
      pages: new Map(),
    };
    current.events += events;
    current.users += number(row.totalUsers);
    if (position && position !== GA4_NOT_SET) {
      current.sources.set(position, (current.sources.get(position) ?? 0) + events);
    }
    if (page) current.pages.set(page, (current.pages.get(page) ?? 0) + events);
    buckets.set(bucket, current);
  }

  const ranked = [...buckets.values()].sort(
    (left, right) =>
      right.events - left.events ||
      right.users - left.users ||
      left.bucket.localeCompare(right.bucket),
  );
  const leader = ranked[0] ?? null;
  const topPosition = [...positions.values()].sort(
    (left, right) =>
      right.events - left.events || left.position.localeCompare(right.position),
  )[0];
  return {
    window,
    totalEvents,
    unattributedEvents,
    attributedEvents: totalEvents - unattributedEvents,
    positionedEvents,
    positionCount: positions.size,
    /** The first reported date carrying any message at all — the observable
     * edge of the operator's registration, not a date anybody typed. */
    attributedFrom: [...attributedDates].sort()[0] ?? null,
    bucketCount: ranked.length,
    topPosition: topPosition
      ? { ...topPosition, topPage: heaviestEntry(topPosition.pages) }
      : null,
    leader:
      leader && leader.events >= JS_ERROR_MIN_BUCKET_EVENTS
        ? {
            ...leader,
            topSource: heaviestEntry(leader.sources),
            topPage: heaviestEntry(leader.pages),
          }
        : null,
  };
}

/** The triage rows, or none at all. Never a row saying the family was absent:
 * the card's own silence on a property with no family is the honest report. */
function javascriptErrorTriageEvidence(triage) {
  if (!triage) return [];
  const attributedWindow = triage.attributedFrom
    ? `${triage.attributedFrom}–${triage.window.end}`
    : null;
  // Only when it adds a name the leading-error row did not already give. When
  // the property's heaviest position IS the leading message's position, a
  // second row would say the same string twice and spend attention on nothing.
  const showTopPosition =
    triage.topPosition !== null &&
    triage.topPosition.position !== triage.leader?.topSource?.key;
  return [
    ...(triage.leader
      ? [
          evidence(
            'Leading error',
            triage.leader.bucket,
            `${formatInt(triage.leader.events)} events · ${formatInt(triage.leader.users)} reported users · ` +
              `#1 of ${formatInt(triage.bucketCount)} distinct messages over ${attributedWindow}`,
          ),
          evidence(
            'Leading error position',
            triage.leader.topSource ? triage.leader.topSource.key : 'Not reported',
            (triage.leader.topSource
              ? `${formatInt(triage.leader.topSource.events)} of ${formatInt(triage.leader.events)} events at this position. `
              : 'GA4 recorded no source parameter for any event carrying this message — unknown, not an error without a position. ') +
              (triage.leader.topPage
                ? `Fires most on ${pagePath(triage.leader.topPage.key)} (${formatInt(triage.leader.topPage.events)} events).`
                : 'GA4 reported no page for it.'),
          ),
        ]
      : []),
    ...(showTopPosition
      ? [
          evidence(
            'Busiest source position',
            triage.topPosition.position,
            `${formatInt(triage.topPosition.events)} of ${formatInt(triage.positionedEvents)} events carrying a position, ` +
              `#1 of ${formatInt(triage.positionCount)} over ${triage.window.start}–${triage.window.end}` +
              (triage.topPosition.topPage
                ? ` · fires most on ${pagePath(triage.topPosition.topPage.key)} (${formatInt(triage.topPosition.topPage.events)} events)`
                : '') +
              '. GA4 answers for this parameter on dates that carry no message, so it covers the whole window.',
          ),
        ]
      : []),
    evidence(
      'Errors without a message',
      formatInt(triage.unattributedEvents),
      triage.unattributedEvents === 0
        ? `Every js_error event this family reported in ${triage.window.start}–${triage.window.end} carries a message.`
        : `${formatPercent(triage.unattributedEvents / triage.totalEvents)} of the ${formatInt(triage.totalEvents)} events this family reported in ${triage.window.start}–${triage.window.end}. ` +
          (attributedWindow
            ? `GA4 reports the message parameter from ${triage.attributedFrom} and backfills nothing, so earlier events are permanently untriageable.`
            : 'GA4 has reported no message on any date here and backfills nothing, so none of these events can ever be triaged.'),
    ),
  ];
}

function javascriptErrorInsight(families) {
  const ga4 = javascriptErrorRanking(families);
  if (!ga4) return null;
  const triage = javascriptErrorMessageRanking(families);
  const { top, totalErrors, totalUsers, window } = ga4;
  const perHundredViews =
    top.pageViews > 0 ? (top.errors / top.pageViews) * 100 : null;
  // The second observer, stated on the card that would otherwise be the only
  // voice in the room. Absent when Clarity has no usable read for this property
  // — and absence here is "nobody else looked", never "the other observer
  // agrees" (`ro-d5c`).
  const clarity = clarityScriptErrorRanking(families);
  const agrees = clarity ? clarity.top.path === top.path : null;
  return card({
    key: 'javascript-errors',
    kind: 'warning',
    title: `JavaScript errors concentrate on ${pagePath(top.page)}`,
    // The message sentence sits between the volume and the instruction because
    // that is the order the reading happens in: how much, what it is, what to
    // do. With no triage family the join collapses to the exact sentence pair
    // the card carried before this rule — the absent family changes nothing.
    summary: [
      `${formatInt(totalErrors)} js_error events affected ${formatInt(totalUsers)} reported users.`,
      ...(triage?.leader
        ? [
            `The most frequent message is “${triage.leader.bucket}”` +
              (triage.leader.topSource ? `, thrown at ${triage.leader.topSource.key}` : '') +
              '.',
          ]
        : []),
      'Investigate the leading page before treating its engagement or conversion gaps as a content problem.',
    ].join(' '),
    whyItMatters:
      'A broken interaction can look like weak demand or weak UX in aggregate analytics; this is a measurement and product-quality confound.',
    primary: { value: formatInt(totalErrors), label: 'JavaScript errors' },
    confidence: totalErrors >= 50 && window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Leading page', top.path),
      evidence('Errors on leading page', formatInt(top.errors)),
      evidence('Users on leading page', formatInt(top.errorUsers)),
      ...javascriptErrorTriageEvidence(triage),
      ...(perHundredViews === null
        ? []
        : [
            evidence(
              'Events / 100 page views',
              formatDecimal(perHundredViews),
              'Event frequency, not a unique-user error rate.',
            ),
          ]),
      ...(clarity
        ? [
            evidence(
              'Clarity cross-check',
              agrees ? 'Same page' : 'Different page',
              agrees
                ? `Clarity’s trailing 72-hour read also ranks ${clarity.top.path} worst (${formatInt(clarity.top.errors)} script errors).`
                : `Clarity’s trailing 72-hour read ranks ${clarity.top.path} worst instead (${formatInt(clarity.top.errors)} script errors). See the error-observer-disagreement card; the two counts are different units and are not combined.`,
            ),
          ]
        : []),
    ],
    sources: [
      source('ga4', 'page-events'),
      ...(triage ? [source('ga4', 'js-errors')] : []),
      ...(clarity ? [source('clarity', 'url-3d')] : []),
    ],
    caveat:
      'GA4 event counts are aggregate and one user or page view can emit more than one error.' +
      (triage
        ? ' Messages are counted as masked buckets, never as raw text: raw text carries each occurrence’s URL, build hash, and line number, so every event would look like its own unique error. GA4 answers for the message and source parameters only after an operator registered them as custom dimensions and backfills nothing, so an event reported before that registration carries no message and can never acquire one.'
        : '') +
      (clarity
        ? ' The Clarity cross-check is a separate sampled observer over a different window; it corroborates or contradicts the leading page, it never adjusts these counts.'
        : ''),
  });
}

// ---------------------------------------------------------------------------
// Two observers, one question: which page is worst for JavaScript errors
// (`ro-d5c`)
// ---------------------------------------------------------------------------
// Clarity and GA4 both rank error-y pages and they do not always agree. On
// one site's 2026-08-01 archive Clarity ranked `/recipes` worst (203 script
// errors over 43 page views, 2.9% of 238 sampled sessions) while GA4 ranked
// `/calculator` worst (281 `js_error` events from 186 reported users over ten
// reported dates) — and by the 2026-08-04 snapshot Clarity had moved to
// `/calculator` and the two agreed again. A divergence that comes and goes is
// exactly the kind nobody catches by eye.
//
// Both readings are true. They differ in UNIT (Clarity's `ScriptErrorCount`
// sub-total is a metric total over sampled sessions; GA4 counts `js_error`
// events from reported users), in WINDOW (a trailing 72-hour snapshot against
// N completed reported dates), and in POPULATION (clarity.ms is adblock-DNS
// listed and undercounts 15–25%). Nothing converts one into the other, so this
// card reports the divergence and NEVER a merged number, a ratio between the
// two, or a winner. The disagreement is the finding: it says check both pages.
//
// The card is deliberately hard to fire on noise. It needs GA4 to have an
// answer at all (the same floor the `javascript-errors` card clears), Clarity's
// leader to clear its own floors, and the disagreement to survive a tie inside
// Clarity's own ranking — if GA4's page ties Clarity's leader in Clarity's
// numbers, the two observers are not actually disagreeing.

const CLARITY_SCRIPT_ERROR_METRIC = 'ScriptErrorCount';
/** Clarity's leader must carry at least this many script errors and be seen on
 * at least this many sampled sessions. Below either floor a trailing 72-hour,
 * undercounting read is too thin to contradict anything: the archive holds
 * single-session URLs at a 100% error rate, and one such session is not a
 * property's worst page. */
const CLARITY_MIN_SCRIPT_ERRORS = 5;
const CLARITY_MIN_SESSIONS = 10;
/** How far Clarity's leader must clear Clarity's own count for GA4's page
 * before the two observers count as disagreeing rather than tie-breaking. */
const CLARITY_DISAGREEMENT_MARGIN = 2;
/** The documented trailing window (doc 11 §Clarity), not a provider field: the
 * export carries no window bounds, only the date it was collected. Used for the
 * card's date envelope; the evidence row states the trailing read in words. */
const CLARITY_TRAILING_DAYS = 3;

function shiftDate(date, days) {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed + days * 86_400_000).toISOString().slice(0, 10)
    : date;
}

/** Clarity's URL dimension carries non-page hosts (`https://Electron` is in the
 * archive), and those normalize to a path of `/` — which would masquerade as the
 * property's home page. A host without a dot is not a page of this property. */
function isPropertyPageUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.includes('.')
    );
  } catch {
    return false;
  }
}

/**
 * Clarity's answer to the same question, from the latest snapshot only: the
 * family is a trailing 72-hour read, so consecutive collections overlap and
 * adding their rows together would count the same sessions more than once.
 *
 * null means Clarity did not answer — no token, no collection, or nothing over
 * the floors. It never means Clarity saw no errors.
 */
function clarityScriptErrorRanking(families) {
  const input = latestSnapshotRows(families, 'clarity-url-3d').filter(
    (row) => text(row.metric) === CLARITY_SCRIPT_ERROR_METRIC,
  );
  if (input.length === 0) return null;
  const observedAt = text(input[0].report_date);
  if (!observedAt) return null;
  const ranked = input
    .filter((row) => isPropertyPageUrl(text(row.url)))
    .map((row) => ({
      url: text(row.url),
      path: pagePath(row.url),
      // `sub_total` is the metric's own total — script errors, not sessions.
      // `pages_views` is the page views carrying one, and
      // `sessions_with_metric_percentage` the share of sessions that saw one.
      // Three different denominators; the card states which is which rather
      // than picking one and calling it "errors".
      errors: number(row.sub_total),
      viewsWithError: number(row.pages_views),
      sessions: number(row.sessions_count),
      sessionShare: number(row.sessions_with_metric_percentage) / 100,
    }))
    .sort(
      (left, right) =>
        right.errors - left.errors ||
        right.sessions - left.sessions ||
        left.path.localeCompare(right.path),
    );
  const top = ranked.find(
    (row) =>
      row.errors >= CLARITY_MIN_SCRIPT_ERRORS &&
      row.sessions >= CLARITY_MIN_SESSIONS,
  );
  if (!top) return null;
  return {
    ranked,
    errorPages: ranked.filter((row) => row.errors > 0),
    top,
    byPath: new Map(ranked.map((row) => [row.path, row])),
    observedAt,
    window: {
      start: shiftDate(observedAt, -(CLARITY_TRAILING_DAYS - 1)),
      end: observedAt,
      days: CLARITY_TRAILING_DAYS,
    },
  };
}

function clarityErrorDetail(row) {
  return (
    `${formatInt(row.errors)} script errors · ${formatInt(row.viewsWithError)} page views with one · ` +
    `${formatPercent(row.sessionShare)} of ${formatInt(row.sessions)} sampled sessions`
  );
}

function ga4ErrorDetail(row) {
  return `${formatInt(row.errors)} js_error events · ${formatInt(row.errorUsers)} reported users`;
}

/** The rank a page holds in one observer's list, stated as a position rather
 * than a score so neither observer's number is ever rewritten into the other's
 * units. */
function rankOf(list, path) {
  const index = list.findIndex((row) => row.path === path);
  return index < 0 ? null : index + 1;
}

function errorObserverDisagreementInsight(families) {
  const ga4 = javascriptErrorRanking(families);
  const clarity = clarityScriptErrorRanking(families);
  // One observer alone cannot disagree, and silence from either is not consent.
  if (!ga4 || !clarity) return null;
  if (ga4.top.path === clarity.top.path) return null;
  const clarityOnGa4Page = clarity.byPath.get(ga4.top.path) ?? null;
  // A hairline lead is not a disagreement. In a sampled read that undercounts
  // 15–25%, Clarity preferring its own leader by an error or two is the
  // tie-break talking; the divergence has to be bigger than the noise before it
  // is worth an operator's attention. Clarity's leader must therefore carry at
  // least twice the script errors Clarity itself recorded on GA4's page — or
  // GA4's page must be missing from Clarity's read entirely, which is a
  // disagreement of a different and starker kind.
  if (
    clarityOnGa4Page &&
    clarity.top.errors < clarityOnGa4Page.errors * CLARITY_DISAGREEMENT_MARGIN
  ) {
    return null;
  }
  const ga4OnClarityPage = ga4.byPath.get(clarity.top.path) ?? null;
  const window = {
    start: [ga4.window.start, clarity.window.start].sort()[0],
    end: [ga4.window.end, clarity.window.end].sort().at(-1),
  };
  return card({
    key: 'error-observer-disagreement',
    kind: 'warning',
    title: `Clarity and GA4 name different worst pages for JavaScript errors`,
    summary:
      `Clarity’s trailing 72-hour read ranks ${clarity.top.path} worst (${clarityErrorDetail(clarity.top)}); ` +
      `GA4’s ${formatInt(ga4.window.days)} reported dates rank ${ga4.top.path} worst (${ga4ErrorDetail(ga4.top)}). ` +
      'Both readings are correct for what each measures. Open both pages; neither number is the other one adjusted.',
    whyItMatters:
      'Two observers ranking the same problem differently is a where-to-look signal, not a data error. Acting on whichever card renders first can send the fix to a page the other observer says is fine — and averaging them would invent a number no provider reported.',
    // Not a count of anything measured: the two observers' numbers share no
    // unit, so the only honest headline is how many pages are in contention.
    primary: { value: '2', label: 'Pages named worst' },
    // Never higher. Clarity is sampled and undercounting, so a divergence is
    // always a prompt to look, never a finding about either page on its own.
    confidence: 'medium',
    window,
    evidence: [
      evidence(
        'Clarity’s worst page',
        clarity.top.path,
        `${clarityErrorDetail(clarity.top)} · trailing 72 hours ending ${clarity.observedAt}`,
      ),
      evidence(
        'GA4’s worst page',
        ga4.top.path,
        `${ga4ErrorDetail(ga4.top)} · ${formatInt(ga4.window.days)} reported dates ${ga4.window.start}–${ga4.window.end}`,
      ),
      evidence(
        'Clarity on GA4’s page',
        clarityOnGa4Page ? clarityErrorDetail(clarityOnGa4Page) : 'No Clarity row',
        clarityOnGa4Page
          ? `${ga4.top.path} ranks #${rankOf(clarity.errorPages, ga4.top.path)} of ${formatInt(clarity.errorPages.length)} pages Clarity saw an error on.`
          : `Clarity reported no row for ${ga4.top.path} in this window — unseen by a sampled reader, not error-free.`,
      ),
      evidence(
        'GA4 on Clarity’s page',
        // A page GA4 reported page views for but no `js_error` row is the same
        // fact as a page GA4 never mentioned: it did not report an error there.
        // Rendering that as "0 js_error events" would state a zero GA4 never
        // sent.
        ga4OnClarityPage && ga4OnClarityPage.errors > 0
          ? ga4ErrorDetail(ga4OnClarityPage)
          : 'No GA4 row',
        ga4OnClarityPage && ga4OnClarityPage.errors > 0
          ? `${clarity.top.path} ranks #${rankOf(ga4.errorPages, clarity.top.path)} of ${formatInt(ga4.errorPages.length)} pages GA4 reported an error on.`
          : `GA4 reported no js_error row for ${clarity.top.path} in this window — not reported, not zero.`,
      ),
    ],
    sources: [source('clarity', 'url-3d'), source('ga4', 'page-events')],
    caveat:
      'Clarity is a sampled trailing 72-hour read and clarity.ms is adblock-DNS-listed (undercounts 15–25%); its ScriptErrorCount total counts errors, its page views count views carrying one, and its session share counts sessions — three denominators. GA4 counts js_error events over completed reported dates and one session can emit several. Nothing converts one observer into the other, so this card reports the divergence and never a combined figure, a ratio between them, or a winner.',
  });
}

function featureUsageInsight(families) {
  const input = rows(families, 'ga4-page-events');
  const custom = input.filter(
    (row) =>
      !GENERIC_EVENTS.has(text(row.eventName)) &&
      !['js_error', 'chrome_impression'].includes(text(row.eventName)),
  );
  const window = dateWindow(custom);
  if (!window) return null;
  const grouped = new Map();
  for (const row of custom) {
    const eventName = text(row.eventName);
    const page = text(row.unifiedPagePathScreen);
    if (!eventName || !page) continue;
    const key = `${page}\u0000${eventName}`;
    const current = grouped.get(key) ?? {
      eventName,
      page,
      events: 0,
      users: 0,
      keyEvents: 0,
    };
    current.events += number(row.eventCount);
    current.users += number(row.totalUsers);
    current.keyEvents += number(row.keyEvents);
    grouped.set(key, current);
  }
  const completion =
    [...grouped.values()].find(
      (row) => row.eventName === 'calculation_complete' && row.events > 0,
    ) ??
    [...grouped.values()].sort((left, right) => right.events - left.events)[0];
  if (!completion || completion.events <= 0) return null;
  return card({
    key: `feature-usage-${completion.eventName}`,
    kind: 'insight',
    title:
      completion.eventName === 'calculation_complete'
        ? 'The calculator is completing meaningful user jobs'
        : `${humanizeEvent(completion.eventName)} is the strongest custom interaction`,
    summary:
      `${humanizeEvent(completion.eventName)} fired ${formatInt(completion.events)} times ` +
      `for ${formatInt(completion.users)} users on ${pagePath(completion.page)}. ` +
      'Use this behavior as a feature-extension baseline rather than page views alone.',
    whyItMatters:
      'A page view says a surface was reached; a task event says the feature actually delivered part of its intended job.',
    primary: { value: formatInt(completion.events), label: humanizeEvent(completion.eventName) },
    confidence: completion.events >= 100 && window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Users', formatInt(completion.users)),
      evidence('Page', pagePath(completion.page)),
      evidence('GA4 event', completion.eventName),
      evidence('Key events', formatInt(completion.keyEvents)),
    ],
    sources: [source('ga4', 'page-events')],
    caveat: 'Event instrumentation describes recorded behavior, not causal lift or user satisfaction.',
  });
}

// ---------------------------------------------------------------------------
// Rules transferred from one site's manual-analysis history (cross-asset
// transfer, [doc 13](../docs/13-opportunity-scouting.md) lane 6, 2026-07-31).
// Each one consumes an already-archived report family and each threshold cites
// the finding it was derived from.
//
// What acting on each rule means (added 2026-07-31). The rule detects the
// condition; a card's `rule: <id>` evidence row is the join to the work it
// raises:
//
//   concentration-risk      -> a dependency/scale stop rule stated before
//                              spending; the finding itself came out of a
//                              third-source cross-reference
//   measurement-integrity   -> a broken collection is an unknown, not a small
//                              error; the Unassigned half has a cause and a
//                              fix in the campaign-link grammar
//   query-cannibalization   -> diagnose which page owns which intent before
//                              touching copy
//   query-language-drift    -> per-locale surgery is its own surgery, never a
//                              translated echo
//   device-ctr-gap          -> the same diagnosis discipline, split by device
//                              instead of by query
//   prune-candidates        -> the no-new-inventory gate
//   page-movers             -> a week-over-week move is only readable against
//                              a release register
//   reclamation-match       -> the campaign's touch log; the proof is live
//                              link updates, tracked per wave with a
//                              conversion rate; the card is the noticing half,
//                              the human confirmation is the other
// ---------------------------------------------------------------------------

// [doc 00](../docs/00-objective-and-roi.md): 85%+ dependence on a single traffic
// source trades at the bottom of the valuation range and is named there as the
// #1 devaluation factor and the portfolio's dominant correlated risk.
const CONCENTRATION_WARN_SHARE = 0.85;
// Below this the channel split is sampling noise rather than a structural claim
// about the property. The portfolio's smallest configured properties report
// 20–30 sessions a day, so a hundred sessions is a few days of real shape.
const CONCENTRATION_MIN_SESSIONS = 100;

function concentrationRiskInsight(families) {
  const { rows: input, provisionalDates } = settledAttributionRows(
    families,
    'ga4-traffic-acquisition',
  );
  const window = dateWindow(input);
  if (!window) return null;
  const byChannel = new Map();
  let sessions = 0;
  for (const row of input) {
    const channel = text(row.sessionDefaultChannelGroup).trim();
    if (!channel) continue;
    const rowSessions = number(row.sessions);
    byChannel.set(channel, (byChannel.get(channel) ?? 0) + rowSessions);
    sessions += rowSessions;
  }
  if (sessions < CONCENTRATION_MIN_SESSIONS) return null;
  const organic = [...byChannel.entries()]
    .filter(([channel]) => channel.toLowerCase() === 'organic search')
    .reduce((sum, [, value]) => sum + value, 0);
  const share = organic / sessions;
  if (share < CONCENTRATION_WARN_SHARE) return null;
  const ranked = [...byChannel.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  return card({
    key: 'concentration-risk',
    kind: 'warning',
    title: `Organic search carries ${formatPercent(share)} of all sessions`,
    summary:
      `${formatInt(organic)} of ${formatInt(sessions)} sessions across ${formatInt(window.days)} reported ` +
      `date${window.days === 1 ? '' : 's'} arrived through GA4's Organic Search channel, at or above the ` +
      `${formatPercent(CONCENTRATION_WARN_SHARE, 0)} single-channel line. Work that adds direct, email, or ` +
      'referral demand is worth more per dollar here than work that adds more of the same channel.',
    whyItMatters:
      'Concentration is priced twice: it discounts the multiple the asset would sell at, and it turns one ranking change into an existential event rather than a bad week.',
    primary: {
      value: formatPercent(share),
      label: 'organic-search share of sessions',
    },
    confidence: window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      ...ranked
        .slice(0, 3)
        .map(([channel, value]) =>
          evidence(
            channel,
            formatInt(value),
            `${formatPercent(value / sessions)} of ${formatInt(sessions)} sessions`,
          ),
        ),
      ...provisionalDaysEvidence(provisionalDates),
      ruleTag('concentration-risk'),
    ],
    sources: [source('ga4', 'traffic-acquisition')],
    caveat:
      'GA4 assigns the channel grouping itself, and Unassigned or misattributed sessions sit inside this same total — the share is only as reliable as the property’s tagging.',
  });
}

// Two or more of a property's own pages each holding a fifth of one query's
// impressions is the mechanized form of one site's months-long homepage-versus-
// interior-page overlap, which its own repository fixed by hand.
const CANNIBALIZATION_MIN_PAGE_SHARE = 0.2;
// Same floor shape as the striking-distance rule above — 25 impressions per
// reported date, never below 100. At the three-date GSC window currently
// archived this keeps 9 of one site's 862 multi-page queries: the ones carrying
// enough volume to be worth a canonical or internal-link decision.
const CANNIBALIZATION_MIN_IMPRESSIONS = 100;
// One SERP block is not three competing pages
// (the 2026-07-31 signal audit, F1).
// The rule told the operator to consolidate `/`, `/calculator` and `/recipes`
// for "where to find free diet plans" on 1,283 split impressions. The source
// rows: byte-identical impression counts on every single date (94/94, 93/93,
// 226/226), all three pages at position 1.0–1.3, zero clicks anywhere. That is
// one block — an AI Overview or a sitelink group — crediting several of our URLs
// at the block's own position, and the canonical/internal-link consolidation the
// card recommended would have been actively harmful. Two independent signatures
// of the same artifact, either one sufficient:
//   * counts within 5% at positions within 1.5 of each other — real competing
//     pages drift apart on both axes within days;
//   * zero clicks across every competing page — a block consumes the click
//     inline, so there is no click to redistribute and nothing to consolidate.
const CANNIBALIZATION_BLOCK_IMPRESSION_SPREAD = 0.05;
const CANNIBALIZATION_BLOCK_POSITION_SPREAD = 1.5;

/** The block signature this query's competing pages match, or null when they
 * look like pages genuinely splitting one intent. */
function singleSerpBlockSignature(competing) {
  if (competing.reduce((sum, page) => sum + page.clicks, 0) === 0) {
    return 'no clicks on any competing page';
  }
  const impressions = competing.map((page) => page.impressions);
  const positions = competing.map((page) =>
    page.impressions > 0 ? page.weightedPosition / page.impressions : 0,
  );
  const largest = Math.max(...impressions);
  if (largest <= 0) return 'no impressions to split';
  const impressionSpread = (largest - Math.min(...impressions)) / largest;
  const positionSpread = Math.max(...positions) - Math.min(...positions);
  return impressionSpread <= CANNIBALIZATION_BLOCK_IMPRESSION_SPREAD &&
    positionSpread < CANNIBALIZATION_BLOCK_POSITION_SPREAD
    ? 'near-identical impressions at near-identical positions'
    : null;
}

function cannibalizationInsight(families) {
  const { rows: input, excluded } = excludeGroundingQueries(
    rows(families, 'gsc-page-query'),
  );
  const window = dateWindow(input);
  if (!window) return null;
  const byQuery = new Map();
  for (const row of input) {
    const query = text(row.query).trim();
    const page = text(row.page);
    if (!query || !page) continue;
    const key = query.toLocaleLowerCase('en-US');
    const current = byQuery.get(key) ?? {
      query,
      impressions: 0,
      pages: new Map(),
    };
    const impressions = number(row.impressions);
    current.impressions += impressions;
    const pageTotals = current.pages.get(page) ?? {
      page,
      impressions: 0,
      clicks: 0,
      weightedPosition: 0,
    };
    pageTotals.impressions += impressions;
    pageTotals.clicks += number(row.clicks);
    pageTotals.weightedPosition += number(row.position) * impressions;
    current.pages.set(page, pageTotals);
    byQuery.set(key, current);
  }
  const threshold = Math.max(
    CANNIBALIZATION_MIN_IMPRESSIONS,
    window.days * 25,
  );
  const multiPage = [...byQuery.values()]
    .filter((value) => value.impressions >= threshold)
    .map((value) => ({
      query: value.query,
      impressions: value.impressions,
      competing: [...value.pages.values()]
        .filter(
          (page) =>
            page.impressions / value.impressions >=
            CANNIBALIZATION_MIN_PAGE_SHARE,
        )
        .sort((left, right) => right.impressions - left.impressions),
    }))
    .filter((value) => value.competing.length >= 2)
    .map((value) => ({
      ...value,
      blockSignature: singleSerpBlockSignature(value.competing),
    }))
    .sort(
      (left, right) =>
        right.impressions - left.impressions ||
        left.query.localeCompare(right.query),
    );
  const blocks = multiPage.filter((value) => value.blockSignature !== null);
  const candidates = multiPage.filter((value) => value.blockSignature === null);
  const best = candidates[0];
  if (!best) return null;
  return card({
    key: 'query-cannibalization',
    kind: 'recommendation',
    title: `${formatInt(best.competing.length)} of the property’s own pages compete for “${best.query}”`,
    summary:
      `“${best.query}” drew ${formatInt(best.impressions)} impressions across ${formatInt(window.days)} reported ` +
      `date${window.days === 1 ? '' : 's'}, and ${formatInt(best.competing.length)} pages each captured at least ` +
      `${formatPercent(CANNIBALIZATION_MIN_PAGE_SHARE, 0)} of them. Decide which page should own the query, then point the ` +
      'others at it with internal links or a canonical instead of letting them compete.',
    whyItMatters:
      'Two pages splitting one query split its authority and its clicks. Consolidating usually lifts the surviving page without writing anything new.',
    primary: {
      value: formatInt(best.impressions),
      label: 'split impressions',
    },
    confidence: best.impressions >= threshold * 2 ? 'high' : 'medium',
    window,
    evidence: [
      ...best.competing.slice(0, 3).map((page) =>
        evidence(
          pagePath(page.page),
          formatInt(page.impressions),
          `${formatPercent(page.impressions / best.impressions)} of the query · position ` +
            `${formatDecimal(page.impressions > 0 ? page.weightedPosition / page.impressions : 0)} · ` +
            `${formatInt(page.clicks)} clicks`,
        ),
      ),
      ...(candidates.length > 1
        ? [
            evidence(
              'Other affected queries',
              formatInt(candidates.length - 1),
              `Next: “${candidates[1].query}” (${formatInt(candidates[1].impressions)} impressions)`,
            ),
          ]
        : []),
      ...(blocks.length > 0
        ? [
            evidence(
              'Single-SERP-block queries set aside',
              formatInt(blocks.length),
              `Largest: “${blocks[0].query}” (${formatInt(blocks[0].impressions)} impressions, ` +
                `${blocks[0].blockSignature})`,
            ),
          ]
        : []),
      groundingExclusionEvidence(excluded),
      ruleTag('query-cannibalization'),
    ],
    sources: [source('gsc', 'page-query')],
    caveat:
      'GSC page/query exports are top rows, so a page below the export cut-off is unknown rather than absent from the query. Confirm intent overlap before consolidating two pages that serve different jobs. ' +
      'Queries whose pages report near-identical impressions at near-identical positions, or no clicks at all, are set aside rather than recommended: that signature is one SERP block (an AI Overview or a sitelink group) crediting several of the property’s URLs at the block’s position, and consolidating those pages would remove reach without recovering a click.',
  });
}

// Page-grain click movement needs a delta large enough to outrun ordinary daily
// variance. Ten clicks across a week is the smallest change that is still
// legible at the portfolio's page-grain volumes; below that it is weather.
const PAGE_MOVER_MIN_CLICK_DELTA = 10;
const PAGE_MOVER_EVIDENCE_LIMIT = 3;

function pageMoversInsight(families) {
  const input = rows(families, 'gsc-page');
  const weeks = weekOverWeekDates(input);
  if (!weeks) return null;
  const totals = (dates) => {
    const grouped = new Map();
    for (const row of input) {
      if (!dates.has(text(row.report_date))) continue;
      const page = text(row.page);
      if (!page) continue;
      const current = grouped.get(page) ?? { page, clicks: 0, impressions: 0 };
      current.clicks += number(row.clicks);
      current.impressions += number(row.impressions);
      grouped.set(page, current);
    }
    return grouped;
  };
  const current = totals(weeks.current);
  const previous = totals(weeks.previous);
  const movers = [...current.values()]
    .flatMap((value) => {
      const prior = previous.get(value.page);
      if (!prior) return [];
      const delta = value.clicks - prior.clicks;
      return Math.abs(delta) >= PAGE_MOVER_MIN_CLICK_DELTA
        ? [
            {
              page: value.page,
              delta,
              currentClicks: value.clicks,
              previousClicks: prior.clicks,
            },
          ]
        : [];
    })
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) ||
        left.page.localeCompare(right.page),
    );
  if (movers.length === 0) return null;
  const gained = movers
    .filter((value) => value.delta > 0)
    .sort((left, right) => right.delta - left.delta);
  const declined = movers
    .filter((value) => value.delta < 0)
    .sort((left, right) => left.delta - right.delta);
  const net = movers.reduce((sum, value) => sum + value.delta, 0);
  const window = {
    start: weeks.previousStart,
    end: weeks.currentEnd,
    days: weeks.daysPerWindow * 2,
  };
  const moverEvidence = (value) =>
    evidence(
      pagePath(value.page),
      `${value.delta > 0 ? '+' : '−'}${formatInt(Math.abs(value.delta))} clicks`,
      `${formatInt(value.previousClicks)} → ${formatInt(value.currentClicks)} clicks`,
    );
  return card({
    key: 'page-movers',
    kind: 'insight',
    title: `${formatInt(movers.length)} page${movers.length === 1 ? '' : 's'} moved by ${formatInt(PAGE_MOVER_MIN_CLICK_DELTA)}+ clicks week over week`,
    summary:
      `${weeks.currentStart}–${weeks.currentEnd} against ${weeks.previousStart}–${weeks.previousEnd}: ` +
      (gained[0]
        ? `${pagePath(gained[0].page)} gained ${formatInt(gained[0].delta)} clicks`
        : 'no page gained above the floor') +
      ' and ' +
      (declined[0]
        ? `${pagePath(declined[0].page)} lost ${formatInt(Math.abs(declined[0].delta))}`
        : 'no page lost above the floor') +
      `. Net movement across every page above the floor is ${net >= 0 ? '+' : '−'}${formatInt(Math.abs(net))} clicks.`,
    whyItMatters:
      'Property totals hide offsetting page movement. Knowing which page moved is what makes a deploy annotation answerable.',
    primary: {
      value: `${net >= 0 ? '+' : '−'}${formatInt(Math.abs(net))}`,
      label: 'net clicks on moved pages',
    },
    confidence: Math.abs(net) >= PAGE_MOVER_MIN_CLICK_DELTA * 5 ? 'high' : 'medium',
    window,
    evidence: [
      ...gained.slice(0, PAGE_MOVER_EVIDENCE_LIMIT).map(moverEvidence),
      ...declined.slice(0, PAGE_MOVER_EVIDENCE_LIMIT).map(moverEvidence),
      ruleTag('page-movers'),
    ],
    sources: [source('gsc', 'page')],
    caveat:
      'GSC page exports are top rows: a page reported in only one of the two weeks is unknown rather than zero and is excluded, so this understates movement at the export boundary.',
  });
}

// One site's largest manual analysis had to caveat every number because 13.7% of
// its sessions were Unassigned. Past this line the property's own totals are
// the finding, and every other card is bounded by it.
const UNASSIGNED_WARN_SHARE = 0.1;
// An event that was running at this volume and then all but stops is
// instrumentation breakage, not behavior: its form_start fired 8 times
// against 41,195 completions before anyone checked.
const EVENT_BREAK_MIN_PRIOR_PER_DAY = 100;
const EVENT_BREAK_DROP_SHARE = 0.9;

function sessionShare(input, field, matches) {
  let total = 0;
  let matched = 0;
  for (const row of input) {
    const sessions = number(row.sessions);
    total += sessions;
    if (matches(text(row[field]).trim())) matched += sessions;
  }
  return total > 0 ? { total, matched, share: matched / total } : null;
}

// GA4 writes `(data not available)` where it could not attach a session's
// source at all. docs/20 names it beside Unassigned as the settled-day share
// that says the two-day settle rule is too short (ro-5e8.11), and the archive
// carries it on settled days of one site (2026-08-29 and 2026-09-02 in
// ga4-traffic-sources), so it counts as unattributed like `(not set)`.
const GA4_DATA_NOT_AVAILABLE = '(data not available)';

function unattributed(value) {
  const normalized = value.toLowerCase();
  return (
    normalized === 'unassigned' ||
    normalized === '(not set)' ||
    normalized === GA4_DATA_NOT_AVAILABLE ||
    normalized === ''
  );
}

/** The unattributed session share of one GA4 attribution family, labelled with
 * the values GA4 actually reported: the family's own empty token, and
 * `(data not available)` only when it carried sessions. */
function unattributedShare(input, field, namedAs, noun) {
  const share = sessionShare(input, field, unattributed);
  if (!share) return null;
  const notAvailable = sessionShare(
    input,
    field,
    (value) => value.toLowerCase() === GA4_DATA_NOT_AVAILABLE,
  ).matched;
  const names =
    notAvailable === 0
      ? [namedAs]
      : notAvailable === share.matched
        ? [GA4_DATA_NOT_AVAILABLE]
        : [namedAs, GA4_DATA_NOT_AVAILABLE];
  return { ...share, label: `${names.join(' or ')} ${noun}` };
}

function brokenEventCheck(families) {
  const input = rows(families, 'ga4-events');
  const weeks = weekOverWeekDates(input);
  if (!weeks) return null;
  const totals = (dates) => {
    const grouped = new Map();
    for (const row of input) {
      if (!dates.has(text(row.report_date))) continue;
      const name = text(row.eventName).trim();
      if (!name) continue;
      grouped.set(name, (grouped.get(name) ?? 0) + number(row.eventCount));
    }
    return grouped;
  };
  const current = totals(weeks.current);
  const previous = totals(weeks.previous);
  const floor = EVENT_BREAK_MIN_PRIOR_PER_DAY * weeks.daysPerWindow;
  const broken = [...previous.entries()]
    .flatMap(([name, priorEvents]) => {
      if (priorEvents < floor) return [];
      const currentEvents = current.get(name) ?? 0;
      const drop = (priorEvents - currentEvents) / priorEvents;
      return drop >= EVENT_BREAK_DROP_SHARE
        ? [{ name, priorEvents, currentEvents, drop }]
        : [];
    })
    .sort(
      (left, right) =>
        right.priorEvents - left.priorEvents ||
        left.name.localeCompare(right.name),
    );
  return broken[0] ? { ...broken[0], weeks, count: broken.length } : null;
}

function measurementIntegrityInsight(families) {
  // Settled days only: an unsettled GA4 day reads high on Unassigned by
  // construction, so reading it here would report GA4's processing lag as a
  // tagging fault (ro-5e8.10).
  const acquisition = settledAttributionRows(families, 'ga4-traffic-acquisition');
  const trafficSources = settledAttributionRows(families, 'ga4-traffic-sources');
  const channels = unattributedShare(
    acquisition.rows,
    'sessionDefaultChannelGroup',
    'Unassigned',
    'channel',
  );
  const mediums = unattributedShare(
    trafficSources.rows,
    'sessionSourceMedium',
    '(not set)',
    'source / medium',
  );
  const unassigned = [
    channels
      ? { ...channels, family: 'traffic-acquisition', settled: acquisition }
      : null,
    mediums
      ? { ...mediums, family: 'traffic-sources', settled: trafficSources }
      : null,
  ]
    .filter((value) => value && value.share >= UNASSIGNED_WARN_SHARE)
    .sort((left, right) => right.share - left.share)[0];
  const broken = brokenEventCheck(families);
  if (!unassigned && !broken) return null;
  const contributing = [
    ...(unassigned ? unassigned.settled.rows : []),
    ...(broken ? rows(families, 'ga4-events') : []),
  ];
  const window = dateWindow(contributing);
  if (!window) return null;
  return card({
    key: 'measurement-integrity',
    kind: 'warning',
    title:
      unassigned && broken
        ? 'Two measurement faults bound every other number here'
        : unassigned
          ? `${formatPercent(unassigned.share)} of sessions are unattributed`
          : `${humanizeEvent(broken.name)} all but stopped firing`,
    summary: [
      unassigned
        ? `${formatInt(unassigned.matched)} of ${formatInt(unassigned.total)} sessions (${formatPercent(unassigned.share)}) ` +
          `carry no usable acquisition attribution — GA4 reported them as ${unassigned.label}. ` +
          `Past ${formatPercent(UNASSIGNED_WARN_SHARE, 0)} every channel, landing-page, and campaign split on this property inherits that uncertainty.`
        : null,
      broken
        ? `${broken.name} fired ${formatInt(broken.currentEvents)} times in ${broken.weeks.currentStart}–${broken.weeks.currentEnd} against ` +
          `${formatInt(broken.priorEvents)} the week before (${formatPercent(broken.drop)} down). ` +
          'A drop that size on an established event is normally instrumentation, not behavior — check the tag before reading it as a product signal.'
        : null,
    ]
      .filter(Boolean)
      .join(' '),
    whyItMatters:
      'Every other card is computed from these numbers, so a measurement fault is not one more finding — it bounds how far any of the others can be trusted. The measurement channel is also operator-only by invariant (doc 01): the OS reports the fault, it never repairs the ruler.',
    primary: unassigned
      ? { value: formatPercent(unassigned.share), label: 'unattributed sessions' }
      : {
          value: `−${formatPercent(broken.drop)}`,
          label: `${broken.name} week over week`,
        },
    confidence: 'high',
    window,
    evidence: [
      ...(unassigned
        ? [
            evidence(
              'Unattributed sessions',
              formatInt(unassigned.matched),
              `${formatPercent(unassigned.share)} of ${formatInt(unassigned.total)} · ${unassigned.label}`,
            ),
            ...provisionalDaysEvidence(unassigned.settled.provisionalDates),
          ]
        : []),
      ...(broken
        ? [
            evidence(
              'Broken event',
              broken.name,
              `${formatInt(broken.priorEvents)} → ${formatInt(broken.currentEvents)} events week over week`,
            ),
            ...(broken.count > 1
              ? [
                  evidence(
                    'Other collapsed events',
                    formatInt(broken.count - 1),
                    `Same week-over-week window, same ${formatPercent(EVENT_BREAK_DROP_SHARE, 0)} drop floor`,
                  ),
                ]
              : []),
          ]
        : []),
      ruleTag('measurement-integrity'),
    ],
    sources: [
      ...(unassigned
        ? [source('ga4', unassigned.family)]
        : []),
      ...(broken ? [source('ga4', 'events')] : []),
    ],
    caveat:
      'GA4 omits an event with no occurrences, so an event absent from a week that reported other events is read as zero for that event only. Unassigned sessions are a GA4 attribution outcome and can also reflect consent state rather than a broken tag.',
  });
}

// One site found meta copy written in the site's language rather than the
// searcher's; one Korean character was worth roughly 1,300 impressions a month.
// That country held 6.5% of impressions, so the share gate sits at 5% — a
// locale problem is a minority-of-traffic problem by construction.
const COUNTRY_DRIFT_MIN_SHARE = 0.05;
// Compared against the CTR of the property *excluding* this country, never the
// overall CTR: a country large enough to matter is also large enough to drag
// the overall number down toward itself and hide its own gap.
const COUNTRY_DRIFT_CTR_RATIO = 0.5;
// Below a thousand impressions a country's CTR is a handful of clicks and the
// ratio is noise; at current portfolio scale this admits the top two or three
// countries per property.
const COUNTRY_DRIFT_MIN_IMPRESSIONS = 1000;

function queryLanguageDriftInsight(families) {
  const input = rows(families, 'gsc-country');
  const window = dateWindow(input);
  if (!window) return null;
  const byCountry = new Map();
  let impressions = 0;
  let clicks = 0;
  for (const row of input) {
    const country = text(row.country).trim();
    if (!country) continue;
    const rowImpressions = number(row.impressions);
    const rowClicks = number(row.clicks);
    const current = byCountry.get(country) ?? {
      country,
      impressions: 0,
      clicks: 0,
    };
    current.impressions += rowImpressions;
    current.clicks += rowClicks;
    byCountry.set(country, current);
    impressions += rowImpressions;
    clicks += rowClicks;
  }
  if (impressions <= 0) return null;
  const shortfall = (value) => value.impressions * (value.restCtr - value.ctr);
  const candidates = [...byCountry.values()]
    .map((value) => {
      const restImpressions = impressions - value.impressions;
      const restClicks = clicks - value.clicks;
      return {
        ...value,
        share: value.impressions / impressions,
        ctr: value.impressions > 0 ? value.clicks / value.impressions : 0,
        restImpressions,
        restClicks,
        restCtr: restImpressions > 0 ? restClicks / restImpressions : 0,
      };
    })
    .filter(
      (value) =>
        value.share >= COUNTRY_DRIFT_MIN_SHARE &&
        value.impressions >= COUNTRY_DRIFT_MIN_IMPRESSIONS &&
        value.restCtr > 0 &&
        value.ctr <= value.restCtr * COUNTRY_DRIFT_CTR_RATIO,
    )
    .sort(
      (left, right) =>
        shortfall(right) - shortfall(left) ||
        left.country.localeCompare(right.country),
    );
  const worst = candidates[0];
  if (!worst) return null;
  const code = worst.country.toUpperCase();
  const countryPages = new Map();
  for (const row of rows(families, 'gsc-page-country')) {
    const page = text(row.page);
    if (!page || text(row.country).trim() !== worst.country) continue;
    countryPages.set(
      page,
      (countryPages.get(page) ?? 0) + number(row.impressions),
    );
  }
  const leadingPage = [...countryPages.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  return card({
    key: 'query-language-drift',
    kind: 'recommendation',
    title: `Review the ${code} locale: ${formatPercent(worst.share)} of impressions at ${formatPercent(worst.ctr)} CTR`,
    summary:
      `${code} accounts for ${formatInt(worst.impressions)} of ${formatInt(impressions)} impressions ` +
      `(${formatPercent(worst.share)}) but clicks at ${formatPercent(worst.ctr)} against the ` +
      `${formatPercent(worst.restCtr)} the rest of the property earns. Check that the titles and meta descriptions ` +
      'these searchers see are written in their language rather than the site’s, and that the served page matches ' +
      'the locale they searched from.',
    whyItMatters:
      'A result that ranks but is described in the wrong language loses the click before the page is ever judged. It is one of the few search fixes that costs no new content.',
    primary: { value: formatPercent(worst.ctr), label: `${code} CTR` },
    confidence:
      worst.impressions >= COUNTRY_DRIFT_MIN_IMPRESSIONS * 3 ? 'high' : 'medium',
    window,
    evidence: [
      evidence(
        `${code} impressions`,
        formatInt(worst.impressions),
        `${formatPercent(worst.share)} of the property`,
      ),
      evidence(`${code} CTR`, formatPercent(worst.ctr), `${formatInt(worst.clicks)} clicks`),
      evidence(
        `CTR excluding ${code}`,
        formatPercent(worst.restCtr),
        `${formatInt(worst.restClicks)} clicks / ${formatInt(worst.restImpressions)} impressions`,
      ),
      ...(leadingPage
        ? [
            evidence(
              `Leading ${code} page`,
              pagePath(leadingPage[0]),
              `${formatInt(leadingPage[1])} captured impressions`,
            ),
          ]
        : []),
      ruleTag('query-language-drift'),
    ],
    sources: [
      source('gsc', 'country'),
      ...(leadingPage ? [source('gsc', 'page-country')] : []),
    ],
    caveat:
      'GSC country rows are top-row exports and country is where the search happened, not the searcher’s language. Confirm the served locale and the query language before rewriting copy.',
  });
}

// One device clicking at or below half the other's CTR on the same property
// points at that surface's result presentation — title truncation, snippet,
// above-the-fold layout — rather than at demand.
const DEVICE_CTR_RATIO = 0.5;
const DEVICE_MIN_IMPRESSIONS = 1000;
// The rule was mobile-only and missed a real gap
// (the 2026-07-31 signal audit, F8):
// one site ran desktop at roughly a quarter of mobile's CTR on double the
// impressions for three straight days and the rule stayed silent, because it
// only ever tested mobile against desktop. Whichever side is worse is the
// finding; which side that turns out to be is an observation, not an assumption.
const DEVICE_SURFACES = [
  { key: 'MOBILE', label: 'Mobile', noun: 'mobile' },
  { key: 'DESKTOP', label: 'Desktop', noun: 'desktop' },
];
const DEVICE_ADVICE = {
  MOBILE:
    'Review how titles truncate on a phone SERP and what the mobile snippet actually shows before treating mobile as weaker demand.',
  DESKTOP:
    'Review what the desktop result page actually shows — an AI Overview or a large answer block above the result consumes the click there long before the title does.',
};

function deviceCtrGapInsight(families) {
  const input = rows(families, 'gsc-device');
  const window = dateWindow(input);
  if (!window) return null;
  const byDevice = new Map();
  for (const row of input) {
    const device = text(row.device).trim().toUpperCase();
    if (!device) continue;
    const current = byDevice.get(device) ?? { impressions: 0, clicks: 0 };
    current.impressions += number(row.impressions);
    current.clicks += number(row.clicks);
    byDevice.set(device, current);
  }
  const surfaces = DEVICE_SURFACES.map((surface) => {
    const observed = byDevice.get(surface.key);
    return observed
      ? {
          ...surface,
          ...observed,
          ctr: observed.impressions > 0 ? observed.clicks / observed.impressions : 0,
        }
      : null;
  });
  if (surfaces.some((surface) => surface === null)) return null;
  if (surfaces.some((surface) => surface.impressions < DEVICE_MIN_IMPRESSIONS)) {
    return null;
  }
  const [worse, better] = [...surfaces].sort((left, right) => left.ctr - right.ctr);
  if (better.ctr <= 0 || worse.ctr > better.ctr * DEVICE_CTR_RATIO) return null;

  // Decontamination, applied as a worst case rather than a measurement. The
  // grounding traffic that F2 classifies presents as desktop, but no archived
  // family carries query × device, so it cannot be subtracted where it was
  // observed. Charging every excluded impression to the deficit side instead can
  // only raise that side's CTR, and therefore can only make this rule quieter: a
  // gap that survives the correction is a gap grounding traffic does not explain.
  const excluded = groundingExclusion(families);
  if (excluded.impressions >= worse.impressions) return null;
  const correctedImpressions = worse.impressions - excluded.impressions;
  const correctedCtr = worse.clicks / correctedImpressions;
  if (correctedCtr > better.ctr * DEVICE_CTR_RATIO) return null;

  return card({
    key: 'device-ctr-gap',
    kind: 'recommendation',
    title: `${worse.label} results click at ${formatPercent(worse.ctr)} against ${better.noun}’s ${formatPercent(better.ctr)}`,
    summary:
      `${formatInt(worse.impressions)} ${worse.noun} impressions returned ${formatInt(worse.clicks)} clicks ` +
      `(${formatPercent(worse.ctr)}), at or below half the ${formatPercent(better.ctr)} the same property earns on ` +
      `${formatInt(better.impressions)} ${better.noun} impressions. ` +
      (excluded.impressions > 0
        ? `Charging every one of the ${formatInt(excluded.impressions)} excluded grounding impressions to ${worse.noun} still leaves ` +
          `${formatPercent(correctedCtr)}, so programmatic traffic does not account for the gap. `
        : '') +
      DEVICE_ADVICE[worse.key],
    whyItMatters:
      'A presentation gap this wide costs clicks the property has already earned the ranking for, on a surface it is already winning impressions on.',
    primary: { value: formatPercent(worse.ctr), label: `${worse.noun} CTR` },
    confidence:
      worse.impressions >= DEVICE_MIN_IMPRESSIONS * 5 ? 'high' : 'medium',
    window,
    evidence: [
      ...surfaces.map((surface) =>
        evidence(
          surface.label,
          formatPercent(surface.ctr),
          `${formatInt(surface.clicks)} clicks / ${formatInt(surface.impressions)} impressions`,
        ),
      ),
      evidence(
        `${worse.label} share of impressions`,
        formatPercent(
          worse.impressions / (worse.impressions + better.impressions),
        ),
      ),
      ...(excluded.impressions > 0
        ? [
            evidence(
              `${worse.label} CTR excluding grounding traffic`,
              formatPercent(correctedCtr),
              `${formatInt(worse.clicks)} clicks / ${formatInt(correctedImpressions)} impressions · worst case, every excluded impression charged to ${worse.noun}`,
            ),
          ]
        : []),
      groundingExclusionEvidence(excluded),
      ruleTag('device-ctr-gap'),
    ],
    sources: [
      source('gsc', 'device'),
      ...(excluded.impressions > 0 ? [source('gsc', 'page-query')] : []),
    ],
    caveat:
      'Device CTR is not adjusted for the position mix each device sees; a ranking gap on one device produces the same shape. Compare average positions before concluding the snippet is at fault. ' +
      'No archived family carries query × device, so the grounding exclusion is charged entirely to the weaker surface as a worst case rather than measured there.',
  });
}

// One site's noindex rule was "<5 impressions in 90 days AND no internal links".
// Only the impressions half of that rule exists in this archive; the card says
// so rather than implying the other half was checked.
const PRUNE_MAX_IMPRESSIONS = 5;
// Below a hundred reported pages a thin-page list is something an operator
// reads directly, and pruning is not a program worth a card.
const PRUNE_MIN_PROPERTY_PAGES = 100;
// A page under five impressions across three reported dates is the ordinary
// long tail. Fourteen reported dates is the shortest window where the count
// carries meaning, and matches the two-week comparison window used elsewhere
// in this file.
const PRUNE_MIN_WINDOW_DAYS = 14;
const PRUNE_EXAMPLE_LIMIT = 5;

function pruneCandidatesInsight(families) {
  const input = rows(families, 'gsc-page');
  const window = dateWindow(input);
  if (!window || window.days < PRUNE_MIN_WINDOW_DAYS) return null;
  const byPage = new Map();
  for (const row of input) {
    const page = text(row.page);
    if (!page) continue;
    byPage.set(page, (byPage.get(page) ?? 0) + number(row.impressions));
  }
  if (byPage.size < PRUNE_MIN_PROPERTY_PAGES) return null;
  const candidates = [...byPage.entries()]
    .filter(([, impressions]) => impressions < PRUNE_MAX_IMPRESSIONS)
    .sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    );
  if (candidates.length === 0) return null;
  return card({
    key: 'prune-candidates',
    kind: 'discovery',
    title: `${formatInt(candidates.length)} reported pages captured almost no search impressions`,
    summary:
      `${formatInt(candidates.length)} of ${formatInt(byPage.size)} reported pages ` +
      `(${formatPercent(candidates.length / byPage.size)}) drew fewer than ${formatInt(PRUNE_MAX_IMPRESSIONS)} impressions ` +
      `across ${formatInt(window.days)} reported dates. The rule this came from also required the page to have no ` +
      'internal links; that half is not in this archive, so treat this as a review list rather than a prune list.',
    whyItMatters:
      'Pages that never earn an impression still consume crawl budget and blur what the property is about. Naming them is the cheap half of the decision.',
    primary: {
      value: formatInt(candidates.length),
      label: 'pages under the impression floor',
    },
    confidence: window.days >= 28 ? 'high' : 'medium',
    window,
    evidence: [
      ...candidates
        .slice(0, PRUNE_EXAMPLE_LIMIT)
        .map(([page, impressions]) =>
          evidence(
            pagePath(page),
            formatInt(impressions),
            `impressions across ${formatInt(window.days)} reported dates`,
          ),
        ),
      evidence('Reported pages', formatInt(byPage.size)),
      ruleTag('prune-candidates'),
    ],
    sources: [source('gsc', 'page')],
    caveat:
      'GSC page exports are top rows, so a page missing entirely is unknown rather than zero and is not counted here. No internal-link data exists in this archive, so nothing on this list is proven orphaned and nothing here is a deprecation recommendation.',
  });
}

function dataForSeoOpportunityInsight(families, market) {
  const input = latestSnapshotRows(families, 'dataforseo-ranked-keywords');
  const window = dateWindow(input);
  if (!window) return null;
  const candidates = input
    .map((row) => ({
      row,
      keyword: text(row.keyword),
      page: text(row.url || row.relative_url),
      volume: number(row.search_volume),
      cpc: number(row.cpc),
      difficulty: number(row.keyword_difficulty),
      rank: number(row.rank_group),
      etv: number(row.etv),
    }))
    .filter(
      (value) =>
        value.keyword &&
        value.page &&
        pagePath(value.page) !== '/' &&
        text(value.row.intent) !== 'navigational' &&
        text(value.row.result_type) === 'organic' &&
        value.volume >= 20 &&
        value.rank >= 4 &&
        value.rank <= 20,
    )
    .sort((left, right) => {
      const score = (value) =>
        (value.volume *
          (21 - value.rank) *
          (1 + Math.min(value.cpc, 10))) /
        Math.max(10, value.difficulty);
      return score(right) - score(left);
    });
  const best = candidates[0];
  if (!best) return null;
  return card({
    key: 'dataforseo-ranking-opportunity',
    kind: 'recommendation',
    title: `Move “${best.keyword}” up from #${formatDecimal(best.rank, 0)}`,
    summary:
      `DataForSEO estimates ${formatInt(best.volume)} monthly searches for this query in ${marketPhrase(market)}. ` +
      `${pagePath(best.page)} already ranks on page ${best.rank <= 10 ? 'one' : 'two'}, making it a concrete page to improve before creating something new.`,
    whyItMatters:
      'This combines current rank, estimated demand, competition, and CPC so an existing near-win can outrank a speculative content idea.',
    primary: {
      value: formatInt(best.volume),
      label: 'estimated searches / month',
    },
    confidence: best.volume >= 100 && best.rank <= 12 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Current organic rank', `#${formatDecimal(best.rank, 0)}`),
      evidence('Ranking page', pagePath(best.page)),
      evidence('Keyword difficulty', formatDecimal(best.difficulty, 0)),
      evidence(
        'Estimated CPC',
        best.cpc > 0 ? `$${best.cpc.toFixed(2)}` : 'not reported',
      ),
      evidence('Estimated visits', formatDecimal(best.etv)),
    ],
    sources: [source('dataforseo', 'ranked-keywords')],
    caveat:
      `Search volume, difficulty, CPC, and estimated visits are provider-modelled estimates for ${marketPhrase(market)}. They prioritize review; they do not predict causal traffic or revenue.`,
  });
}

function dataForSeoRankChangeInsight(families, market) {
  const current = latestSnapshotRows(families, 'dataforseo-ranked-keywords');
  const previous = previousSnapshotRows(
    families,
    'dataforseo-ranked-keywords',
  );
  if (current.length === 0 || previous.length === 0) return null;
  const priorByKey = new Map(
    previous.map((row) => [
      `${text(row.keyword)}\u0000${text(row.url)}\u0000${text(row.result_type)}`,
      row,
    ]),
  );
  const changes = current
    .flatMap((row) => {
      const prior = priorByKey.get(
        `${text(row.keyword)}\u0000${text(row.url)}\u0000${text(row.result_type)}`,
      );
      const currentRank = number(row.rank_group);
      const previousRank = number(prior?.rank_group);
      const volume = number(row.search_volume);
      if (
        !prior ||
        text(row.result_type) !== 'organic' ||
        currentRank <= 0 ||
        previousRank <= 0 ||
        volume < 20
      ) {
        return [];
      }
      const improvement = previousRank - currentRank;
      return Math.abs(improvement) >= 3
        ? [{ row, previousRank, currentRank, improvement, volume }]
        : [];
    })
    .sort(
      (left, right) =>
        right.volume * Math.abs(right.improvement) -
        left.volume * Math.abs(left.improvement),
    );
  const best = changes[0];
  if (!best) return null;
  const window = dateWindow([...previous, ...current]);
  if (!window) return null;
  const gained = best.improvement > 0;
  return card({
    key: gained
      ? 'dataforseo-ranking-gain'
      : 'dataforseo-ranking-loss',
    kind: gained ? 'discovery' : 'warning',
    title: `“${text(best.row.keyword)}” ${gained ? 'rose' : 'fell'} ${formatInt(Math.abs(best.improvement))} positions`,
    summary:
      `${pagePath(best.row.url)} moved from #${formatDecimal(best.previousRank, 0)} to #${formatDecimal(best.currentRank, 0)} between stored weekly snapshots. ` +
      `DataForSEO estimates ${formatInt(best.volume)} monthly searches for the query in ${marketPhrase(market)}.`,
    whyItMatters: gained
      ? 'A meaningful gain on an established page can reveal content or authority changes worth extending to nearby queries.'
      : 'A meaningful loss on an established, higher-demand query deserves review before the decline compounds into lost visits.',
    primary: {
      value: `${gained ? '↑' : '↓'} ${formatInt(Math.abs(best.improvement))}`,
      label: 'weekly rank change',
    },
    confidence: best.volume >= 100 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('Previous rank', `#${formatDecimal(best.previousRank, 0)}`),
      evidence('Current rank', `#${formatDecimal(best.currentRank, 0)}`),
      evidence('Estimated searches / month', formatInt(best.volume)),
      evidence('Page', pagePath(best.row.url)),
    ],
    sources: [source('dataforseo', 'ranked-keywords')],
    caveat:
      'This compares two locally stored weekly provider snapshots. SERPs vary by time and location, so confirm the change in GSC before attributing impact.',
  });
}

function backlinkMomentumInsight(families) {
  const input = latestSnapshotRows(
    families,
    'dataforseo-backlinks-new-lost',
  );
  const window = providerDateWindow(input);
  if (!window || input.length === 0) return null;
  const newDomains = input.reduce(
    (sum, row) => sum + number(row.new_referring_domains),
    0,
  );
  const lostDomains = input.reduce(
    (sum, row) => sum + number(row.lost_referring_domains),
    0,
  );
  if (newDomains === 0 && lostDomains === 0) return null;
  const net = newDomains - lostDomains;
  const summary = latestSnapshotRows(
    families,
    'dataforseo-backlinks-summary',
  )[0];
  const negative = net < 0;
  return card({
    key: negative
      ? 'dataforseo-backlink-loss'
      : 'dataforseo-backlink-growth',
    kind: negative ? 'warning' : 'discovery',
    title: negative
      ? 'More referring domains were lost than gained'
      : 'Referring-domain momentum is positive',
    summary:
      `Across the stored ${formatInt(window.days)}-period DataForSEO series, ${formatInt(newDomains)} referring domains appeared and ${formatInt(lostDomains)} were lost. ` +
      `${negative ? 'Review lost authority and affected landing pages.' : 'Identify which pages earned the new links and repeat the useful pattern.'}`,
    whyItMatters:
      'Referring-domain direction is a more useful authority signal than a single backlink stock count, and stored snapshots make the movement auditable.',
    primary: {
      value: `${net >= 0 ? '+' : '−'}${formatInt(Math.abs(net))}`,
      label: 'net referring domains',
    },
    confidence: window.days >= 4 ? 'high' : 'medium',
    window,
    evidence: [
      evidence('New referring domains', formatInt(newDomains)),
      evidence('Lost referring domains', formatInt(lostDomains)),
      ...(summary
        ? [
            evidence(
              'Provider inventory',
              `${formatInt(number(summary.backlinks))} backlinks / ${formatInt(number(summary.referring_domains))} referring domains`,
              'The whole basis of this card — a movement of one domain moves it by ' +
                (number(summary.referring_domains) > 0
                  ? formatPercent(1 / number(summary.referring_domains))
                  : 'an unknown share'),
            ),
            evidence('DataForSEO domain rank', formatInt(number(summary.rank))),
          ]
        : []),
    ],
    sources: [
      source('dataforseo', 'backlinks-new-lost'),
      ...(summary
        ? [source('dataforseo', 'backlinks-summary')]
        : []),
    ],
    // The inventory size is stated because the audit found it implausible and
    // the card had no way to show that: 11 referring domains / 404 backlinks for
    // a domain an independent index rates DR 32
    // (the 2026-07-31 signal audit, F7).
    // The direction may well be right; the absolute basis is not decision-grade,
    // and only the operator can see that if the card says how small it is. A
    // second observer (Ahrefs API v3, or GSC links) is NOT wired — the honest
    // state, parked rather than implied.
    caveat:
      (summary
        ? `This is DataForSEO's observed inventory and nothing more: ${formatInt(number(summary.backlinks))} backlinks across ` +
          `${formatInt(number(summary.referring_domains))} referring domains. Judge the coverage before the direction — a provider that has ` +
          'indexed a small share of a domain’s real links reports real movement on an unreal basis, and no second link observer is wired to reconcile it. '
        : '') +
      'DataForSEO discovers and revises links on its own crawl schedule. New/lost counts describe provider-observed link inventory, not causal ranking impact.',
  });
}

// ---------------------------------------------------------------------------
// Reclamation match
// ---------------------------------------------------------------------------
// A reclamation campaign's proof is "live link updates, tracked per wave with a
// conversion rate", and its pipeline table (db/0015 `reclamation_targets`) has
// nowhere for a win to come from unless someone notices one. This rule notices.
//
// WHAT IT DOES NOT DO: mark the win. `reclamation_targets.status = 'won'` is
// human-only and terminal, because a campaign that scores itself cannot be
// graded against the campaign's own 10-20% conversion band, and the abandonment
// rule that band feeds would then be reading its own optimism.
//
// EVIDENCE HONESTY. The obvious source — DataForSEO's new/lost referring-domain
// series — reports COUNTS and never names a domain, so it cannot support a
// match; it appears here only as timing corroboration, labelled as such. The one
// archived family that names an external host is GA4's session source/medium,
// where a referral reads `host / referral`. That is a stronger signal anyway: a
// backlink index says a link exists, a referral session says a real person
// followed it. It is still not proof that the pitched link is the one they
// clicked, which is why the card asks the operator to open the page.
const RECLAMATION_REFERRAL_MEDIUM = 'referral';
// Every status before the three terminal ones. A target that is 'won', 'skip',
// or 'dead' has nothing left to verify, so referral traffic from it is ordinary
// traffic and not a finding.
const RECLAMATION_OPEN_STATUSES = new Set([
  'queued',
  'sent',
  'opened',
  'clicked',
  'replied',
]);
// A screenful of matches to check by hand. The origin's actionable list was 49
// rows; more than a handful firing at once means a wave landed, and the count in
// the summary carries that better than fifty evidence rows would.
const RECLAMATION_MATCH_EVIDENCE_LIMIT = 5;

/** Hosts as GA4 reports them: lowercase, and `www.` is not a different site. */
function referralHost(value) {
  return text(value).trim().toLowerCase().replace(/^www\./, '');
}

/**
 * A referral host belongs to a target when it IS that domain, or sits under it
 * (`blog.example.org` under `example.org` — the same institution, often the same
 * curator). Never the other way round: `cornell.edu` is not evidence about
 * `genesee.cce.cornell.edu`, it is a different office.
 */
function matchesTargetDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The open-target export, as this rule reads it. `pnpm reclamation:open-targets`
 * writes this function's own output (scripts/reclamation-open-targets.mjs), so
 * its file reads back unchanged. Only a bare row array is accepted; column
 * names may be snake_case or camelCase.
 */
export function reclamationTargetList(value) {
  if (!Array.isArray(value) || value.some((row) =>
    row === null || typeof row !== 'object' || Array.isArray(row) || typeof row.domain !== 'string',
  )) {
    throw new Error('Reclamation targets must be a row array; export them with pnpm reclamation:open-targets.');
  }
  return value.flatMap((row) => {
    const domain = referralHost(row?.domain);
    const status = text(row?.status).trim() || 'queued';
    if (!domain || !RECLAMATION_OPEN_STATUSES.has(status)) return [];
    return [
      {
        domain,
        status,
        referringPage: text(row?.referring_page ?? row?.referringPage).trim(),
        replaceWith: text(row?.replace_with ?? row?.replaceWith).trim(),
      },
    ];
  });
}

function reclamationWonInsight(families, reclamationTargets) {
  // Silent without the export. The rule has no store access by design — this script
  // runs over immutable archive CSVs — so an absent input is "not asked", never
  // "no matches".
  if (reclamationTargets === null || reclamationTargets === undefined) return null;
  const targets = reclamationTargetList(reclamationTargets);
  if (!targets || targets.length === 0) return null;

  const { rows: input, provisionalDates } = settledAttributionRows(
    families,
    'ga4-traffic-sources',
  );
  const window = dateWindow(input);
  if (!window) return null;

  const sessionsByHost = new Map();
  for (const row of input) {
    const [host, medium] = text(row.sessionSourceMedium)
      .split('/')
      .map((part) => part.trim());
    if (!host || medium?.toLowerCase() !== RECLAMATION_REFERRAL_MEDIUM) continue;
    const key = referralHost(host);
    sessionsByHost.set(key, (sessionsByHost.get(key) ?? 0) + number(row.sessions));
  }
  if (sessionsByHost.size === 0) return null;

  const matches = targets
    .map((target) => {
      let sessions = 0;
      for (const [host, hostSessions] of sessionsByHost) {
        if (matchesTargetDomain(host, target.domain)) sessions += hostSessions;
      }
      return { ...target, sessions };
    })
    .filter((match) => match.sessions > 0)
    .sort(
      (left, right) =>
        right.sessions - left.sessions || left.domain.localeCompare(right.domain),
    );
  const best = matches[0];
  if (!best) return null;

  // Counts only — this can say a link appeared somewhere that week, never where.
  const newLost = latestSnapshotRows(families, 'dataforseo-backlinks-new-lost');
  const newDomains = newLost.reduce(
    (sum, row) => sum + number(row.new_referring_domains),
    0,
  );

  return card({
    key: 'reclamation-match',
    kind: 'discovery',
    title: `Reclamation match: ${best.domain} is sending visitors`,
    summary:
      `${best.domain} is an open reclamation target (last recorded state: ${best.status}) and ` +
      `appeared as a referral source across ${formatInt(window.days)} reported date` +
      `${window.days === 1 ? '' : 's'}, sending ${formatInt(best.sessions)} session` +
      `${best.sessions === 1 ? '' : 's'}. ` +
      (matches.length > 1
        ? `${formatInt(matches.length - 1)} other open target${matches.length === 2 ? '' : 's'} also sent referral traffic. `
        : '') +
      `Open ${best.referringPage || 'the pitched page'} and confirm the link is live before marking the target won.`,
    whyItMatters:
      'A pitched page that starts sending visitors is the first unprompted sign the link went live, and it is how a wave gets a conversion rate at all. Nothing here marks the win — the pipeline counts only links a person confirmed on the page, and a rule that flipped the row would be exactly the optimism the log exists to prevent.',
    primary: {
      value: formatInt(best.sessions),
      label: `referral sessions from ${best.domain}`,
    },
    // Never 'high'. A referral host is not a backlink index, and the whole point
    // of the card is that a human still has to look.
    confidence: 'medium',
    window,
    evidence: [
      ...matches
        .slice(0, RECLAMATION_MATCH_EVIDENCE_LIMIT)
        .map((match) =>
          evidence(
            match.domain,
            `${formatInt(match.sessions)} sessions`,
            `pipeline state ${match.status}` +
              (match.referringPage ? `; pitched page ${match.referringPage}` : '') +
              (match.replaceWith ? `; replacement ${match.replaceWith}` : ''),
          ),
        ),
      evidence('Open targets checked', formatInt(targets.length)),
      ...(newDomains > 0
        ? [
            evidence(
              'New referring domains (provider count)',
              formatInt(newDomains),
              'DataForSEO counts referring domains without naming them — timing corroboration only, never the match.',
            ),
          ]
        : []),
      ...provisionalDaysEvidence(provisionalDates),
      ruleTag('reclamation-match'),
    ],
    sources: [
      source('ga4', 'traffic-sources'),
      ...(newDomains > 0 ? [source('dataforseo', 'backlinks-new-lost')] : []),
    ],
    caveat:
      'GA4 names the referring host, not the link. This is evidence that someone arrived from that domain, not proof that the pitched link is the one they clicked or that it still points where it was asked to. Confirm on the page before marking the target won.',
  });
}

/**
 * Where the property itself sits in a platform's cited-source ranking, and who
 * is above it. The audit found this the strongest fact in the lane and the one
 * the card was not showing: the audited site is the #1 cited domain on Google AI
 * surfaces for its query set, and #3 on ChatGPT behind healthline and
 * diabetes.org — a competitive position, not a volume count
 * (the 2026-07-31 signal audit, "verified correct" section).
 *
 * The rank is among the domains this snapshot returned, which is a provider
 * top-N and not a census; a domain the provider did not return is unranked
 * here, not absent from the platform.
 */
function citedDomainRank(families, family, asset) {
  const ours = referralHost(asset);
  if (!ours) return null;
  const domains = latestSnapshotRows(families, family)
    .filter((row) => text(row.row_grain) === 'source-domain')
    .map((row) => ({
      domain: referralHost(row.source_domain),
      mentions: number(row.mentions),
    }))
    .filter((row) => row.domain)
    .sort(
      (left, right) =>
        right.mentions - left.mentions || left.domain.localeCompare(right.domain),
    );
  if (domains.length === 0) return null;
  const index = domains.findIndex((row) => row.domain === ours);
  if (index < 0) return null;
  return {
    rank: index + 1,
    of: domains.length,
    mentions: domains[index].mentions,
    ahead: domains.slice(0, index),
    next: domains[index + 1] ?? null,
  };
}

function citedDomainEvidence(label, rank) {
  return evidence(
    label,
    `#${formatInt(rank.rank)} of ${formatInt(rank.of)}`,
    `${formatInt(rank.mentions)} mentions · ` +
      (rank.ahead.length > 0
        ? `behind ${rank.ahead
            .slice(0, 2)
            .map((row) => `${row.domain} ${formatInt(row.mentions)}`)
            .join(', ')}`
        : rank.next
          ? `ahead of ${rank.next.domain} ${formatInt(rank.next.mentions)}`
          : 'the only cited domain returned') +
      ' · among the domains this snapshot returned',
  );
}

function llmVisibilityInsight(families, asset, market) {
  const google = latestSnapshotRows(
    families,
    'dataforseo-llm-mentions-google',
  ).find((row) => text(row.row_grain) === 'platform-summary');
  const chatgpt = latestSnapshotRows(
    families,
    'dataforseo-llm-mentions-chatgpt',
  ).find((row) => text(row.row_grain) === 'platform-summary');
  const mentions = number(google?.mentions) + number(chatgpt?.mentions);
  if ((!google && !chatgpt) || mentions <= 0) return null;
  const input = [google, chatgpt].filter(Boolean);
  const window = dateWindow(input);
  if (!window) return null;
  const leader =
    number(google?.mentions) >= number(chatgpt?.mentions)
      ? ['Google AI surfaces', google]
      : ['ChatGPT', chatgpt];
  const googleRank = citedDomainRank(
    families,
    'dataforseo-llm-mentions-google',
    asset,
  );
  const chatgptRank = citedDomainRank(
    families,
    'dataforseo-llm-mentions-chatgpt',
    asset,
  );
  const standing = [
    googleRank ? `#${formatInt(googleRank.rank)} on Google AI surfaces` : null,
    chatgptRank ? `#${formatInt(chatgptRank.rank)} on ChatGPT` : null,
  ].filter(Boolean);
  return card({
    key: 'dataforseo-llm-visibility',
    kind: 'discovery',
    title: `${formatInt(mentions)} DataForSEO-tracked AI mentions`,
    summary:
      `${leader[0]} currently contributes the larger reported share. ` +
      (standing.length > 0
        ? `The property ranks ${standing.join(' and ')} among the cited domains this snapshot returned. `
        : '') +
      'Use the cited-source detail to find pages and third-party domains already shaping the property’s AI visibility.',
    whyItMatters:
      'AI mentions show where the property or its sources appear in model-mediated discovery, complementing GA4’s smaller identifiable-referral floor.',
    primary: {
      value: formatInt(mentions),
      label: 'reported AI mentions',
    },
    confidence: mentions >= 10 ? 'high' : 'medium',
    window,
    evidence: [
      // A platform whose row stated nothing is "not reported", never "0" (ro-8s5).
      evidence('Google mentions', formatReported(reportedCount(google, 'mentions'))),
      evidence('ChatGPT mentions', formatReported(reportedCount(chatgpt, 'mentions'))),
      ...(googleRank
        ? [citedDomainEvidence('Rank among Google-cited domains', googleRank)]
        : []),
      ...(chatgptRank
        ? [citedDomainEvidence('Rank among ChatGPT-cited domains', chatgptRank)]
        : []),
      evidence(
        'AI search volume represented',
        formatInt(
          number(google?.ai_search_volume) +
            number(chatgpt?.ai_search_volume),
        ),
      ),
    ],
    sources: [
      ...(google ? [source('dataforseo', 'llm-mentions-google')] : []),
      ...(chatgpt
        ? [source('dataforseo', 'llm-mentions-chatgpt')]
        : []),
    ],
    caveat:
      `This is DataForSEO dataset coverage for prompts in ${marketPhrase(market)}, not a census of all AI answers or attributable sessions. Platform totals can overlap and must not be read as unique people. ` +
      'A cited-domain rank is a position among the source domains this snapshot returned — a provider top-N, not the platform’s full citation set.',
  });
}

// ---------------------------------------------------------------------------
// Rules added from the 2026-07-31 signal audit.
// The audit cross-checked every card against the raw archive CSVs; these three
// cover conditions that were true in the data and produced no card at all.
// ---------------------------------------------------------------------------

// Programmatic grounding traffic is a finding, not a filter (F2b). At 9.0% of
// one site's captured page/query impressions it is larger than most cards on
// the page, and it corroborates the LLM-mentions lane from a completely
// independent direction: the same property that is the top-cited domain on
// Google AI surfaces is also being read, at scale, by something that never
// clicks. The floor is a share rather than a count because the question is
// whether the property's demand profile is meaningfully programmatic, which a
// large property can reach with a rounding error's worth of queries.
const GROUNDING_TRAFFIC_MIN_SHARE = 0.05;
// And an absolute floor so a small archive cannot cross the share gate on three
// stray queries. Same shape as the striking-distance floor it sits beside.
const GROUNDING_TRAFFIC_MIN_IMPRESSIONS = 500;
const GROUNDING_TRAFFIC_EVIDENCE_LIMIT = 3;

function llmGroundingTrafficInsight(families) {
  const input = rows(families, 'gsc-page-query');
  const window = dateWindow(input);
  if (!window) return null;
  const { excluded } = excludeGroundingQueries(input);
  if (
    excluded.impressions < GROUNDING_TRAFFIC_MIN_IMPRESSIONS ||
    excluded.share < GROUNDING_TRAFFIC_MIN_SHARE
  ) {
    return null;
  }
  const google = latestSnapshotRows(
    families,
    'dataforseo-llm-mentions-google',
  ).find((row) => text(row.row_grain) === 'platform-summary');
  const topQuery = excluded.topQueries[0];
  const topPage = excluded.topPages[0];
  return card({
    key: 'llm-grounding-traffic',
    kind: 'discovery',
    title: `${formatPercent(excluded.share)} of captured search impressions are machine grounding, not people`,
    summary:
      `${formatInt(excluded.impressions)} impressions across ${formatInt(excluded.queries)} quoted-literal queries produced ` +
      `${formatInt(excluded.clicks)} clicks in ${formatInt(window.days)} reported date${window.days === 1 ? '' : 's'}. ` +
      (topPage
        ? `${pagePath(topPage.page)} is the most-grounded page. `
        : '') +
      'These are retrieval-verification searches — a model checking a claim it is about to state — so the pages they land on are the pages already inside AI answers. ' +
      'Treat that as a citation surface to protect, and read every CTR number on this property as excluding them.',
    whyItMatters:
      'This is GEO distribution visible in ordinary search data, on the free lane, with page-level detail the paid mention lane does not carry. It is also the reason a CTR rule left alone here would recommend rewriting titles for an audience that has no hands.',
    primary: {
      value: formatInt(excluded.impressions),
      label: 'grounding impressions',
    },
    confidence: window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      ...excluded.topPages
        .slice(0, GROUNDING_TRAFFIC_EVIDENCE_LIMIT)
        .map((page) =>
          evidence(
            pagePath(page.page),
            formatInt(page.impressions),
            `${formatPercent(page.impressions / excluded.impressions)} of the grounded impressions`,
          ),
        ),
      ...(topQuery
        ? [
            evidence(
              'Leading query',
              `“${topQuery.query}”`,
              `${formatInt(topQuery.impressions)} impressions · ${formatInt(topQuery.clicks)} clicks`,
            ),
          ]
        : []),
      evidence(
        'Share of captured impressions',
        formatPercent(excluded.share),
        `${formatInt(excluded.impressions)} of ${formatInt(excluded.capturedImpressions)}`,
      ),
      ...(google
        ? [
            reportedCount(google, 'mentions') === null
              ? evidence(
                  'Corroborating AI mentions',
                  formatReported(null),
                  `${source('dataforseo', 'llm-mentions-google')} returned no Google AI mention figure for the same period`,
                )
              : evidence(
                  'Corroborating AI mentions',
                  formatInt(number(google.mentions)),
                  `${source('dataforseo', 'llm-mentions-google')} reports the property mentioned on Google AI surfaces in the same period`,
                ),
          ]
        : []),
      ruleTag('llm-grounding-traffic'),
    ],
    sources: [
      source('gsc', 'page-query'),
      ...(google ? [source('dataforseo', 'llm-mentions-google')] : []),
    ],
    caveat:
      'A quoted phrase is a strong programmatic signature but not a provider label: GSC does not say who searched, and a human power-user typing quotes is counted here too. ' +
      'The classifier is also deliberately narrow — unquoted grounding-shaped queries (long, entity-stuffed, zero-click) are NOT counted, so this is a floor for the behavior, not its measure. ' +
      'Nothing here attributes a citation: it says a machine read the page, not that any answer credited it.',
  });
}

// A declared value event that GA4 does not count as a key event (F4).
// one site's `calculation_complete` — the property's core value event, 1,989
// events in five days — carried `keyEvents = 0` while `auth_complete` carried
// 142, and no rule noticed. That misconfiguration silently zeroes every
// conversion-flavored read the OS does, including the AI-referral card's own
// evidence row, which reported "Key events: 0" as if it were a behavior.
//
// The rule only reads. Which events are a property's value events is a
// declaration the operator makes in config/value-events.json, and the GA4
// key-event setting itself is inside the measurement channel — `forbidden` class
// by AGENTS.md, operator-only forever. The OS says the ruler disagrees with the
// declaration; the operator decides which one is wrong.
const VALUE_EVENT_MIN_EVENTS_PER_DAY = 10;
const VALUE_EVENT_EVIDENCE_LIMIT = 5;

/** The declared value events for one property, or null when the config was not
 * supplied at all — which is "not declared", never "nothing to declare". */
function declaredValueEvents(config, asset) {
  const declared = record(config)?.assets?.[asset]?.valueEvents;
  if (!Array.isArray(declared)) return null;
  const names = [
    ...new Set(declared.map((name) => text(name).trim()).filter(Boolean)),
  ];
  return names.length > 0 ? names : null;
}

function valueEventInsight(families, asset, valueEvents) {
  const declared = declaredValueEvents(valueEvents, asset);
  if (!declared) return null;
  const input = rows(families, 'ga4-events');
  const window = dateWindow(input);
  if (!window) return null;
  const totals = new Map();
  for (const row of input) {
    const name = text(row.eventName).trim();
    if (!name) continue;
    const current = totals.get(name) ?? { name, events: 0, keyEvents: 0 };
    current.events += number(row.eventCount);
    current.keyEvents += number(row.keyEvents);
    totals.set(name, current);
  }
  const floor = VALUE_EVENT_MIN_EVENTS_PER_DAY * window.days;
  const observed = declared.flatMap((name) => {
    const total = totals.get(name);
    // A declared event GA4 reported no row for is unknown, not zero: it can be
    // a renamed tag or a quiet week, and either way there is nothing to compare
    // a key-event count against.
    return total ? [total] : [];
  });
  const unmeasured = observed
    .filter((total) => total.events >= floor && total.keyEvents === 0)
    .sort(
      (left, right) =>
        right.events - left.events || left.name.localeCompare(right.name),
    );
  const leading = unmeasured[0];
  if (!leading) return null;
  const counted = observed.filter((total) => total.keyEvents > 0);
  return card({
    key: 'value-event-not-key-event',
    kind: 'warning',
    title:
      unmeasured.length === 1
        ? `${leading.name} is a declared value event GA4 counts zero of`
        : `${formatInt(unmeasured.length)} declared value events are not GA4 key events`,
    summary:
      `${leading.name} fired ${formatInt(leading.events)} times across ${formatInt(window.days)} reported ` +
      `date${window.days === 1 ? '' : 's'} and GA4 recorded ${formatInt(leading.keyEvents)} key events for it. ` +
      `config/value-events.json declares ${formatInt(declared.length)} value event${declared.length === 1 ? '' : 's'} for this property; ` +
      `${formatInt(unmeasured.length)} of them ${unmeasured.length === 1 ? 'is' : 'are'} carrying real volume that no conversion figure can see. ` +
      (counted.length > 0
        ? `${counted[0].name} is configured correctly, which is what makes this a settings gap rather than a collection failure.`
        : 'No declared value event is configured as a key event, so every conversion figure on this property currently reads zero by construction.'),
    whyItMatters:
      'Key events are what GA4 counts as conversions, so an unconfigured value event does not read as a small number — it reads as zero, everywhere, including in cards that then explain the zero as user behavior. This is a measurement fault: it bounds the other numbers rather than adding to them.',
    primary: {
      value: formatInt(leading.events),
      label: `${leading.name} events, 0 counted`,
    },
    confidence: window.days >= 3 ? 'high' : 'medium',
    window,
    evidence: [
      ...unmeasured
        .slice(0, VALUE_EVENT_EVIDENCE_LIMIT)
        .map((total) =>
          evidence(
            total.name,
            formatInt(total.events),
            `events across ${formatInt(window.days)} reported dates · 0 key events`,
          ),
        ),
      ...(counted.length > 0
        ? [
            evidence(
              'Declared and counted',
              counted[0].name,
              `${formatInt(counted[0].keyEvents)} key events — the comparison that rules out a broken export`,
            ),
          ]
        : []),
      evidence('Declared value events', formatInt(declared.length), 'config/value-events.json'),
      ruleTag('value-event-not-key-event'),
    ],
    sources: [source('ga4', 'events')],
    caveat:
      'GA4 applies a key-event change going forward only, so a window spanning one shows both states and the series steps rather than trends — annotate the change date instead of reading the step as behavior. ' +
      'This card compares an operator declaration against a provider setting; it cannot tell which of the two is wrong, and it never edits either. The measurement channel is operator-only by invariant (doc 01).',
  });
}

// High-demand distant clusters (F10). The near-win rule's position 4–20 filter
// is right for near-wins and wrong as the property's whole aperture: it silently
// excluded the largest raw demand in one site's archive — ~56k/month across
// three water-intake queries at positions 37–49, and ~36k across the weight-loss
// -percentage variants, every one of them already mapped to an existing page.
// [Doc 13](../docs/13-opportunity-scouting.md)'s outer loop exists precisely so a
// scope filter does not become a blind spot.
const CLUSTER_DEMAND_MIN_VOLUME = 10_000;
// Difficulty is the whole reason a distant position is interesting: rank 90 on a
// KD 4 term is a page nobody has fought for, rank 90 on a KD 60 term is a
// market. 25 is the near-win rule's "cheap" band read at distance.
const CLUSTER_DEMAND_MAX_DIFFICULTY = 25;
// Starts where the near-win rule stops so the two never emit the same keyword,
// and ends at the depth the provider's ranked-keyword inventory actually
// reaches. The brief proposed a ceiling of 60; its own evidence (and its
// acceptance check) put the weight-loss cluster at 56–106, so the ceiling is the
// inventory's depth instead — a page at position 94 for a 12k/month KD 4 term is
// exactly the invisible-but-cheap case this rule exists to surface.
const CLUSTER_DEMAND_MIN_POSITION = 21;
const CLUSTER_DEMAND_MAX_POSITION = 100;
// One card per URL cluster, capped: this is a discovery lane, and a property
// with eleven distant clusters has a strategy question, not eleven cards.
const CLUSTER_DEMAND_CARD_LIMIT = 3;
const CLUSTER_DEMAND_KEYWORD_EVIDENCE_LIMIT = 4;

function distantDemandClusterInsights(families, market) {
  const input = latestSnapshotRows(families, 'dataforseo-ranked-keywords');
  const window = dateWindow(input);
  if (!window) return null;
  const clusters = new Map();
  for (const row of input) {
    const keyword = text(row.keyword).trim();
    const page = text(row.relative_url || row.url);
    const volume = number(row.search_volume);
    const difficulty = nullableNumber(row.keyword_difficulty);
    const position = number(row.rank_group);
    if (
      !keyword ||
      !page ||
      // A homepage cluster is a brand-term artifact, not a content decision —
      // the same exclusion the near-win rule makes.
      pagePath(page) === '/' ||
      text(row.result_type) !== 'organic' ||
      text(row.intent) === 'navigational' ||
      volume < CLUSTER_DEMAND_MIN_VOLUME ||
      // An unreported difficulty is unknown, and an unknown difficulty cannot
      // clear a ceiling.
      difficulty === null ||
      difficulty > CLUSTER_DEMAND_MAX_DIFFICULTY ||
      position < CLUSTER_DEMAND_MIN_POSITION ||
      position > CLUSTER_DEMAND_MAX_POSITION
    ) {
      continue;
    }
    const key = pagePath(page);
    const cluster = clusters.get(key) ?? { page: key, volume: 0, keywords: [] };
    cluster.volume += volume;
    cluster.keywords.push({ keyword, volume, difficulty, position });
    clusters.set(key, cluster);
  }
  const ranked = [...clusters.values()]
    .map((cluster) => ({
      ...cluster,
      keywords: [...cluster.keywords].sort(
        (left, right) =>
          right.volume - left.volume || left.keyword.localeCompare(right.keyword),
      ),
    }))
    .sort(
      (left, right) =>
        right.volume - left.volume || left.page.localeCompare(right.page),
    )
    .slice(0, CLUSTER_DEMAND_CARD_LIMIT);
  if (ranked.length === 0) return null;
  return ranked.map((cluster) => {
    const best = cluster.keywords[0];
    const shallowest = [...cluster.keywords].sort(
      (left, right) => left.position - right.position,
    )[0];
    return card({
      // One key per URL cluster: the Tower's mark/dismiss decisions attach to
      // it, and a cluster is the thing an operator decides about.
      key: `distant-demand-cluster${cluster.page}`,
      kind: 'discovery',
      title: `${formatInt(cluster.volume)} monthly searches sit past the near-win band on ${cluster.page}`,
      summary:
        `${formatInt(cluster.keywords.length)} quer${cluster.keywords.length === 1 ? 'y' : 'ies'} at position ` +
        `${formatDecimal(shallowest.position, 0)}–${formatDecimal(cluster.keywords.reduce((deepest, keyword) => Math.max(deepest, keyword.position), 0), 0)} ` +
        `map to a page that already exists, with DataForSEO difficulty at or under ${formatInt(CLUSTER_DEMAND_MAX_DIFFICULTY)}. ` +
        `The striking-distance and near-win rules cannot see any of it: both stop at position 20. ` +
        'This is the cheapest kind of demand to test — the page is built, the competition is modelled as low, and nothing about it is a new content bet.',
      whyItMatters:
        'A scope filter that is right for near-wins turns the largest demand on a property invisible. One page here carries more modelled monthly demand than every near-win card combined, and the only reason it never appeared is that nobody looks past page two.',
      primary: {
        value: formatInt(cluster.volume),
        label: 'estimated searches / month',
      },
      // Two or more variants of the same intent landing on one page is a
      // repeated observation; a single keyword is one provider estimate.
      confidence: cluster.keywords.length >= 2 ? 'high' : 'medium',
      window,
      evidence: [
        ...cluster.keywords
          .slice(0, CLUSTER_DEMAND_KEYWORD_EVIDENCE_LIMIT)
          .map((keyword) =>
            evidence(
              `“${keyword.keyword}”`,
              formatInt(keyword.volume),
              `position ${formatDecimal(keyword.position, 0)} · difficulty ${formatDecimal(keyword.difficulty, 0)}`,
            ),
          ),
        evidence('Mapped page', cluster.page, 'already exists — no new inventory required'),
        evidence(
          'Best current position',
          `#${formatDecimal(shallowest.position, 0)}`,
          `“${shallowest.keyword}”`,
        ),
        ruleTag('distant-demand-cluster'),
      ],
      sources: [source('dataforseo', 'ranked-keywords')],
      caveat:
        `Volume, difficulty, and position are DataForSEO estimates for ${marketPhrase(market)} from one weekly snapshot, and a distant position is the least stable thing a SERP reports. ` +
        'The provider inventory is a top-200-by-volume read, so a cluster below that cut-off is unknown rather than absent, and nothing here says the page can rank — only that the demand exists and the page does too.',
    });
  });
}

/** Words too common to make an idea relevant on their own. */
const IDEA_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'best',
  'free', 'how', 'what', 'is', 'are', 'you', 'your', 'my', 'me', 'near', 'now',
]);

/** Tokens the property already ranks for — its own vocabulary. */
function rankedVocabularyOf(rankings) {
  const vocabulary = new Set();
  for (const row of rankings) {
    for (const token of text(row.keyword).toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 3 && !IDEA_STOPWORDS.has(token)) vocabulary.add(token);
    }
  }
  return vocabulary;
}

/**
 * Is this idea about anything this property does? (`ro-kukv.2`, measured.)
 *
 * `keyword_ideas` expands a seed set by CATEGORY, so even under a volume
 * ceiling it returns terms with no connection to the property — "free chat now"
 * came back at 246k against a USDA nutrition site. A request-time filter cannot
 * express relevance, so it is applied here, against the property's OWN ranked
 * vocabulary rather than a hand-kept seed list: an idea is relevant when it
 * shares a real word with something the property already ranks for. Nothing to
 * keep true, and it tightens automatically as the property's footprint grows.
 */
function ideaIsRelevant(keyword, vocabulary) {
  if (vocabulary.size === 0) return true; // nothing to judge against yet
  return keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => token.length > 3 && vocabulary.has(token));
}

function searchIntelligenceSnapshot(families) {
  const rankings = latestSnapshotRows(
    families,
    'dataforseo-ranked-keywords',
  );
  const backlinks = latestSnapshotRows(
    families,
    'dataforseo-backlinks-summary',
  )[0];
  const momentum = latestSnapshotRows(
    families,
    'dataforseo-backlinks-new-lost',
  );
  const google = latestSnapshotRows(
    families,
    'dataforseo-llm-mentions-google',
  ).find((row) => text(row.row_grain) === 'platform-summary');
  const chatgpt = latestSnapshotRows(
    families,
    'dataforseo-llm-mentions-chatgpt',
  ).find((row) => text(row.row_grain) === 'platform-summary');
  if (
    rankings.length === 0 &&
    !backlinks &&
    momentum.length === 0 &&
    !google &&
    !chatgpt
  ) {
    return null;
  }
  const organic = rankings.filter(
    (row) => text(row.result_type) === 'organic',
  );
  const reportFamilies = [
    rankings,
    backlinks ? [backlinks] : [],
    momentum,
    google ? [google] : [],
    chatgpt ? [chatgpt] : [],
  ].filter((input) => input.length > 0);
  // One cost per family — every row of a single-call family repeats it. The
  // panel is the exception: each row is its own metered call, so its rows add.
  // The four families added 2026-08-31 (ro-kukv.2). Each is absent until its
  // first collection, and an absent family renders nothing rather than an empty
  // panel claiming the property has no backlinks or no competitors.
  const referring = latestSnapshotRows(families, 'dataforseo-backlinks-referring-domains');
  const anchorRows = latestSnapshotRows(families, 'dataforseo-backlinks-anchors');
  const ideaRows = latestSnapshotRows(families, 'dataforseo-keyword-ideas');
  const competitorRows = latestSnapshotRows(families, 'dataforseo-serp-competitors');

  const panel = latestSnapshotRows(families, 'dataforseo-serp-panel');
  const costUsd =
    reportFamilies.reduce(
      (sum, input) => sum + number(input[0].provider_cost_usd),
      0,
    ) + panel.reduce((sum, row) => sum + number(row.provider_cost_usd), 0);
  const all = reportFamilies.flat();
  const observedAt = all
    .map((row) => text(row.report_date))
    .filter(Boolean)
    .sort()
    .at(-1);
  const ANCHOR_SPAM_THRESHOLD = 40;
  const rankedVocabulary = rankedVocabularyOf(rankings);
  const spammyAnchors = anchorRows.filter(
    (row) => number(row.backlinks_spam_score) > ANCHOR_SPAM_THRESHOLD,
  );

  return {
    observedAt: observedAt ?? null,
    costUsd,
    // Named domains behind the counts, best-ranked first — a lost domain with a
    // real rank is a reclamation target; one from a scraper farm is noise.
    referringDomains: referring
      .map((row) => ({
        domain: text(row.domain),
        rank: number(row.rank),
        backlinks: number(row.backlinks),
        spamScore: number(row.backlinks_spam_score),
        firstSeen: text(row.first_seen) || null,
      }))
      .filter((entry) => entry.domain)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 12),
    anchors:
      anchorRows.length === 0
        ? null
        : {
            sampled: anchorRows.length,
            spammy: spammyAnchors.length,
            // Domains, not anchors: one PBN can mint a hundred anchor variants,
            // so counting anchors would overstate a single attacker.
            spammyDomains: spammyAnchors.reduce(
              (sum, row) => sum + number(row.referring_domains),
              0,
            ),
            top: anchorRows
              .map((row) => ({
                anchor: text(row.anchor),
                referringDomains: number(row.referring_domains),
                backlinks: number(row.backlinks),
                spamScore: number(row.backlinks_spam_score),
              }))
              .filter((entry) => entry.anchor)
              .sort((a, b) => b.referringDomains - a.referringDomains)
              .slice(0, 10),
          },
    keywordIdeas: ideaRows
      .filter((row) => ideaIsRelevant(text(row.keyword), rankedVocabulary))
      .map((row) => ({
        keyword: text(row.keyword),
        searchVolume: number(row.search_volume),
        difficulty: number(row.keyword_difficulty),
        cpc: number(row.cpc),
        intent: text(row.main_intent) || null,
      }))
      .filter((entry) => entry.keyword)
      .sort((a, b) => b.searchVolume - a.searchVolume)
      .slice(0, 15),
    // RANKED BY OVERLAP SHARE, not raw intersections (operator decision
    // 2026-08-31). Raw counts put the general web first — YouTube, Facebook and
    // Reddit overlap us on thousands of keywords because they rank for
    // everything, which is true and useless. Share asks how much of THEIR
    // footprint is ours, so the giants sink on their own and no denylist has to
    // be kept true.
    competitors: competitorRows
      .map((row) => {
        const intersections = number(row.intersections);
        // The competitor's WHOLE footprint. `competitor_keywords` is scoped to
        // the intersection and therefore equals `intersections`, which made
        // every share 100% — the denominator has to be the domain's own total.
        const keywords = number(row.competitor_total_keywords);
        return {
          domain: text(row.competitor_domain),
          intersections,
          competitorKeywords: keywords,
          overlapShare: keywords > 0 ? intersections / keywords : 0,
          avgPosition: number(row.avg_position),
        };
      })
      .filter((entry) => entry.domain)
      .sort((a, b) => b.overlapShare - a.overlapShare)
      .slice(0, 10),
    rankings: {
      keywords: organic.length,
      top3: organic.filter((row) => number(row.rank_group) <= 3).length,
      top10: organic.filter((row) => number(row.rank_group) <= 10).length,
      top20: organic.filter((row) => number(row.rank_group) <= 20).length,
      estimatedVisits: organic.reduce((sum, row) => sum + number(row.etv), 0),
      estimatedPaidTrafficCost: organic.reduce(
        (sum, row) => sum + number(row.estimated_paid_traffic_cost),
        0,
      ),
      aiOverviewReferences: rankings.filter(
        (row) => text(row.result_type) === 'ai_overview_reference',
      ).length,
    },
    backlinks: backlinks
      ? {
          rank: number(backlinks.rank),
          backlinks: number(backlinks.backlinks),
          referringDomains: number(backlinks.referring_domains),
          newReferringDomains: momentum.reduce(
            (sum, row) => sum + number(row.new_referring_domains),
            0,
          ),
          lostReferringDomains: momentum.reduce(
            (sum, row) => sum + number(row.lost_referring_domains),
            0,
          ),
        }
      : null,
    // Null when the platform row is blank or its family was never collected —
    // absent is never zero (docs/20). The Tower renders null as "not reported".
    ai: {
      googleMentions: reportedCount(google, 'mentions'),
      googleSearchVolume: reportedCount(google, 'ai_search_volume'),
      chatgptMentions: reportedCount(chatgpt, 'mentions'),
      chatgptSearchVolume: reportedCount(chatgpt, 'ai_search_volume'),
    },
  };
}

// ---------------------------------------------------------------------------
// PostHog: what people do once they arrive, and where it breaks (bead ro-ghis.3)
// ---------------------------------------------------------------------------
// Five rules over the six `posthog-*` families, each grounded in a real
// finding from the first manual PostHog read of one site (2026-09-08 → 09-22):
// rage clicks on the calculator's inputs, an exception total that was 84% one
// unattributable message, a `first_meal_logged` that fired three times per
// person, Chrome OS desktops waiting 744 ms for an interaction, and a funnel
// where 97% of starters finish but 8% of finishers save.
//
// EVERY RULE SAYS WHICH OF FOUR THINGS IT FOUND, and only one of them is a card:
//   fired            — the line was crossed; a card carries the facts.
//   clear            — enough data, nothing crossed.
//   not-enough-data  — the family was collected but is too thin to judge; the
//                      threshold that was not met is named.
//   not-collected    — no archive of the family exists for this property.
// The four states travel in the executive `product.checks` block, so a thin
// window reads as "not enough data" on the Tower rather than as silence that
// looks like health.
//
// PostHog `people` is a unique-person count over the row's own window, so no
// rule ever adds it across rows; a family's window is read from the archive body
// (`window_start`/`window_end`), never assumed from `report_date` — a manual
// collection can end on a daily run's date over a different window.

/** Each family's trailing window on the daily run (the archive contract). Used
 * only to state the window of a family PostHog answered with NO rows, which
 * leaves no row to carry its own window. */
const POSTHOG_NOMINAL_WINDOW_DAYS = {
  'web-daily': 28,
  events: 14,
  exceptions: 14,
  rageclicks: 14,
  'web-vitals': 14,
  funnels: 7,
};
const POSTHOG_FAMILY_ORDER = Object.keys(POSTHOG_NOMINAL_WINDOW_DAYS);

function isTrue(value) {
  return value === true || value === 'true';
}

/** `true` / `false` / null — the flattened CSV writes booleans as text and an
 * unknown as an empty cell, and the rules must keep all three apart. */
function nullableBoolean3(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function nullableText(value) {
  const raw = text(value).trim();
  return raw ? raw : null;
}

/** One PostHog family's archive at one report date. */
function posthogAt(input, family, reportDate) {
  const at = input.filter((row) => text(row.report_date) === reportDate);
  const first = at[0];
  const nominal = POSTHOG_NOMINAL_WINDOW_DAYS[family] ?? 1;
  return {
    family,
    reportDate,
    rows: at,
    window: {
      start: text(first?.window_start) || shiftDate(reportDate, -(nominal - 1)),
      end: text(first?.window_end) || reportDate,
    },
    truncated: at.some((row) => isTrue(row.provider_truncated)),
    collectedAt: nullableText(first?.collected_at),
  };
}

/** Every report date a PostHog family was archived for — from its rows AND from
 * the archive list, because a family PostHog answered with no rows leaves no
 * row behind, and "collected, nothing found" is not "never collected". */
function posthogReportDates(families, archives, family) {
  const fromRows = rows(families, `posthog-${family}`).map((row) => text(row.report_date));
  const fromArchives = (Array.isArray(archives) ? archives : [])
    .filter((entry) => record(entry)?.integration === 'posthog' && entry.report === family)
    .map((entry) => text(entry.reportDate));
  return [...new Set([...fromRows, ...fromArchives].filter(Boolean))].sort();
}

/** The newest archive of one family, or null when it was never collected. */
function posthogLatest(families, archives, family) {
  const reportDate = posthogReportDates(families, archives, family).at(-1);
  return reportDate
    ? posthogAt(rows(families, `posthog-${family}`), family, reportDate)
    : null;
}

function posthogWindowLabel(snapshot) {
  return `${snapshot.window.start}–${snapshot.window.end}`;
}

function check(key, label, state, detail) {
  return { key, label, state, detail };
}

function notCollected(key, label, family) {
  return {
    check: check(key, label, 'not-collected', `No PostHog ${family} read has been collected yet.`),
    cards: [],
  };
}

// --- 1. once-per-person events that fire more than once ----------------------

/** An event whose NAME promises it happens once per person. */
const ONCE_EVENT_NAME = /^first_|_created$/;
/** How far the count may exceed the people before the name is broken: 10%
 * absorbs a retried request or a double mount; three times per person does not. */
const ONCE_EVENT_EXCESS_SHARE = 0.1;
/** Below this many people the ratio is a handful of testers, not a pattern. */
const ONCE_EVENT_MIN_PEOPLE = 30;
const ONCE_EVENT_LIMIT = 5;

function posthogOnceEvents(snapshot) {
  const key = 'posthog-once-event-repeats';
  const label = 'Once-only events';
  if (!snapshot) return { ...notCollected(key, label, 'events'), repeating: [] };
  const named = snapshot.rows.filter((row) => ONCE_EVENT_NAME.test(text(row.event)));
  if (named.length === 0) {
    return {
      check: check(key, label, 'clear', 'No event named first_* or *_created was captured in this window.'),
      cards: [],
      repeating: [],
    };
  }
  const measured = named.filter((row) => number(row.people) >= ONCE_EVENT_MIN_PEOPLE);
  if (measured.length === 0) {
    return {
      check: check(
        key,
        label,
        'not-enough-data',
        `${formatInt(named.length)} once-only event(s) captured, none from ${formatInt(ONCE_EVENT_MIN_PEOPLE)} or more people.`,
      ),
      cards: [],
      repeating: [],
    };
  }
  const repeating = measured
    .filter((row) => number(row.count) > number(row.people) * (1 + ONCE_EVENT_EXCESS_SHARE))
    .map((row) => ({
      event: text(row.event),
      count: number(row.count),
      people: number(row.people),
      perPerson: number(row.count) / number(row.people),
    }))
    .sort((left, right) => right.perPerson - left.perPerson || right.count - left.count)
    .slice(0, ONCE_EVENT_LIMIT);
  if (repeating.length === 0) {
    return {
      check: check(
        key,
        label,
        'clear',
        `${formatInt(measured.length)} once-only event(s) fire at most ${formatDecimal(1 + ONCE_EVENT_EXCESS_SHARE)} times per person.`,
      ),
      cards: [],
      repeating: [],
    };
  }
  const [top] = repeating;
  const others = repeating.length - 1;
  const cardItem = card({
    key,
    kind: 'warning',
    title: `${top.event} fires ${formatDecimal(top.perPerson)} times per person — its name promises once`,
    summary:
      `PostHog counted ${formatInt(top.count)} ${top.event} events from ${formatInt(top.people)} people over ${posthogWindowLabel(snapshot)}.` +
      (others > 0 ? ` ${formatInt(others)} other once-only event(s) repeat too.` : '') +
      ' Check where the event is sent before building any activation number on it.',
    whyItMatters:
      'An event named for a first time is how new activity gets counted. If it fires on every repeat, any funnel or conversion built on it overstates first-timers by that factor, and fixing it later will look like a drop.',
    primary: { value: `${formatDecimal(top.perPerson)}×`, label: 'Events per person' },
    confidence: 'high',
    window: snapshot.window,
    evidence: [
      ruleTag(key),
      ...repeating.map((row) =>
        evidence(
          row.event,
          `${formatInt(row.count)} events · ${formatInt(row.people)} people`,
          `${formatDecimal(row.perPerson)} per person; the line is ${formatDecimal(1 + ONCE_EVENT_EXCESS_SHARE)}.`,
        ),
      ),
    ],
    sources: [source('posthog', 'events')],
    caveat:
      'People is PostHog’s unique-person count over the window. One human counted as two people — two devices before signing in, or events sent before consent — raises people and lowers the ratio, so the excess is a floor. The rule reads event names only: whether an event should happen once is what its name promises, not something PostHog checks.',
  });
  return {
    check: check(
      key,
      label,
      'fired',
      `${formatInt(repeating.length)} once-only event(s) repeat; ${top.event} fires ${formatDecimal(top.perPerson)} times per person.`,
    ),
    cards: [cardItem],
    repeating,
  };
}

// --- 2. error concentration, noise-aware ---------------------------------------

/** Fewer exceptions than this in a window is too few to call anything dominant. */
const EXCEPTION_MIN_EVENTS = 100;
/** One message holding at least this share of the volume dominates the total. */
const EXCEPTION_DOMINANT_SHARE = 0.5;
/** The remaining messages worth naming, ranked by people. */
const EXCEPTION_RANK_LIMIT = 3;
/** The next real message must reach this many people for the card to warn
 * rather than inform. */
const EXCEPTION_WARN_PEOPLE = 100;
/** What the Tower carries: the noise message plus the top real ones. */
const EXCEPTION_PRODUCT_LIMIT = 5;

function exceptionRow(row) {
  return {
    type: nullableText(row.type),
    message: nullableText(row.message)?.slice(0, 200) ?? null,
    count: number(row.count),
    people: number(row.people),
    sessions: nullableNumber(row.sessions),
    maxPerSession: nullableNumber(row.max_per_session),
    hasSourceFile: nullableBoolean3(row.has_source_file),
    topPath: nullableText(row.top_path),
    topBrowser: nullableText(row.top_browser),
  };
}

function exceptionName(row) {
  const message = row.message ?? '(no message)';
  return row.type && !message.startsWith(row.type) ? `${row.type}: ${message}` : message;
}

function exceptionDetail(row) {
  return [
    `${formatInt(row.people)} people`,
    `${formatInt(row.count)} times`,
    ...(row.sessions === null ? [] : [`${formatInt(row.sessions)} sessions`]),
    row.hasSourceFile === null ? 'source file unknown' : row.hasSourceFile ? 'has a source file' : 'no source file',
    ...(row.topPath ? [`mostly on ${row.topPath}`] : []),
  ].join(' · ');
}

function posthogExceptions(snapshot) {
  const key = 'posthog-error-concentration';
  const label = 'Errors';
  if (!snapshot) return { ...notCollected(key, label, 'exceptions'), block: null };
  const all = snapshot.rows.map(exceptionRow).sort(
    (left, right) => right.count - left.count || right.people - left.people,
  );
  const total = all.reduce((sum, row) => sum + row.count, 0);
  const base = {
    windowStart: snapshot.window.start,
    windowEnd: snapshot.window.end,
    reportDate: snapshot.reportDate,
    total,
    truncated: snapshot.truncated,
  };
  if (all.length === 0) {
    return {
      check: check(key, label, 'clear', 'PostHog captured no exceptions in this window.'),
      cards: [],
      block: { ...base, noise: null, top: [] },
    };
  }
  const [dominant] = all;
  const share = total > 0 ? dominant.count / total : 0;
  const isDominant = total >= EXCEPTION_MIN_EVENTS && share >= EXCEPTION_DOMINANT_SHARE;
  const noise = isDominant && dominant.hasSourceFile === false ? dominant : null;
  const ranked = all
    .filter((row) => row !== noise)
    .sort((left, right) => right.people - left.people || right.count - left.count);
  const block = {
    ...base,
    noise: noise ? { ...noise, share } : null,
    top: ranked.slice(0, EXCEPTION_PRODUCT_LIMIT),
  };
  if (total < EXCEPTION_MIN_EVENTS) {
    return {
      check: check(
        key,
        label,
        'not-enough-data',
        `${formatInt(total)} exceptions in the window; the rule needs ${formatInt(EXCEPTION_MIN_EVENTS)}.`,
      ),
      cards: [],
      block,
    };
  }
  if (!isDominant) {
    return {
      check: check(
        key,
        label,
        'clear',
        `No single message holds half of ${formatInt(total)} exceptions; the most widespread reaches ${formatInt(ranked[0]?.people ?? 0)} people.`,
      ),
      cards: [],
      block,
    };
  }
  const next = ranked.slice(0, EXCEPTION_RANK_LIMIT);
  const totalNote = snapshot.truncated
    ? ' The read hit its row limit, so the total is a floor.'
    : '';
  const cardItem = noise
    ? card({
        key,
        kind: (next[0]?.people ?? 0) >= EXCEPTION_WARN_PEOPLE ? 'warning' : 'insight',
        title: `${formatPercent(share, 0)} of ${formatInt(total)} errors are one message with no source file — probably third-party noise`,
        summary:
          `“${exceptionName(noise)}” accounts for ${formatInt(noise.count)} of ${formatInt(total)} exceptions over ${posthogWindowLabel(snapshot)}, ` +
          `from ${formatInt(noise.people)} people` +
          (noise.maxPerSession !== null ? ` and up to ${formatInt(noise.maxPerSession)} in one session` : '') +
          ', and no occurrence carries a stack frame with a source file.' +
          (next[0]
            ? ` Set aside, the message reaching the most people is “${exceptionName(next[0])}” (${formatInt(next[0].people)} people).`
            : ' Nothing else was captured.') +
          totalNote,
        whyItMatters:
          'An exception total dominated by one unattributable message hides the errors that belong to the site. The ranking of what is left, by people affected, is the list a fix can start from.',
        primary: { value: formatPercent(share, 0), label: 'Probable noise' },
        confidence: 'medium',
        window: snapshot.window,
        evidence: [
          ruleTag(key),
          evidence(
            'Probable noise',
            exceptionName(noise),
            `${formatInt(noise.count)} of ${formatInt(total)} (${formatPercent(share)}) · ${exceptionDetail(noise)}`,
          ),
          ...next.map((row, index) =>
            evidence(`#${index + 1} by people`, exceptionName(row), exceptionDetail(row)),
          ),
        ],
        sources: [source('posthog', 'exceptions')],
        caveat:
          'No source file is a strong hint, not proof: browser extensions, aborted network requests and cross-origin scripts throw without a frame the site owns, but an inline script can too. Counts cover the top 100 messages by volume, and people never add across messages — one person can hit several.',
      })
    : card({
        key,
        kind: 'warning',
        title: `One error is ${formatPercent(share, 0)} of ${formatInt(total)} exceptions`,
        summary:
          `“${exceptionName(dominant)}” accounts for ${formatInt(dominant.count)} of ${formatInt(total)} exceptions over ${posthogWindowLabel(snapshot)}, from ${formatInt(dominant.people)} people` +
          (dominant.hasSourceFile === true
            ? '. It carries a source file, so it is thrown by code the site serves.'
            : '. PostHog could not say whether it carries a source file.') +
          totalNote,
        whyItMatters:
          'When one message is most of the error volume, fixing it is most of the fix — and until it is fixed, every other error is hard to see behind it.',
        primary: { value: formatPercent(share, 0), label: 'Of all exceptions' },
        confidence: dominant.hasSourceFile === true ? 'high' : 'medium',
        window: snapshot.window,
        evidence: [
          ruleTag(key),
          evidence('Dominant message', exceptionName(dominant), exceptionDetail(dominant)),
          ...ranked
            .filter((row) => row !== dominant)
            .slice(0, EXCEPTION_RANK_LIMIT)
            .map((row, index) =>
              evidence(`#${index + 1} after it by people`, exceptionName(row), exceptionDetail(row)),
            ),
        ],
        sources: [source('posthog', 'exceptions')],
        caveat:
          'Counts cover the top 100 messages by volume, and people never add across messages — one person can hit several.',
      });
  return {
    check: check(
      key,
      label,
      'fired',
      noise
        ? `${formatPercent(share, 0)} of ${formatInt(total)} exceptions are one message with no source file.`
        : `One message is ${formatPercent(share, 0)} of ${formatInt(total)} exceptions.`,
    ),
    cards: [cardItem],
    block,
  };
}

// --- 3. rage-click clusters ------------------------------------------------------

/** An element whose rage-clickers exceed this share of the page's visitors. */
const RAGE_CLICK_PAGE_SHARE = 0.05;
/** Below this many visitors a page's share is a few sessions, not a pattern. */
const RAGE_CLICK_MIN_PAGE_PEOPLE = 200;
/** An element must frustrate at least this many people to be named. */
const RAGE_CLICK_MIN_PEOPLE = 20;
const RAGE_CLICK_EVIDENCE_LIMIT = 4;
const RAGE_CLICK_PRODUCT_LIMIT = 5;

/** What a person would call the element: its name/id attribute, else its text,
 * else its tag. */
function rageElementLabel(row) {
  const tag = row.tag ?? 'element';
  if (row.attr) return `${row.attr} ${tag}`;
  if (row.text) return `“${row.text}” ${tag}`;
  return tag;
}

function rageRow(row) {
  const desktop = nullableNumber(row.desktop_clicks);
  const mobile = nullableNumber(row.mobile_clicks);
  const tablet = nullableNumber(row.tablet_clicks);
  const deviceClicks = (desktop ?? 0) + (mobile ?? 0) + (tablet ?? 0);
  const people = number(row.people);
  const pagePeople = number(row.page_people);
  const shaped = {
    path: nullableText(row.path),
    tag: nullableText(row.tag),
    text: nullableText(row.text),
    attr: nullableText(row.attr),
    clicks: number(row.clicks),
    people,
    pagePeople,
    share: pagePeople > 0 ? people / pagePeople : null,
    desktopShare: deviceClicks > 0 && desktop !== null ? desktop / deviceClicks : null,
  };
  return { ...shaped, element: rageElementLabel(shaped) };
}

function rageDetail(row) {
  return (
    `${formatInt(row.people)} of ${formatInt(row.pagePeople)} page visitors` +
    (row.share === null ? '' : ` (${formatPercent(row.share)})`) +
    ` · ${formatInt(row.clicks)} clicks` +
    (row.desktopShare === null ? '' : ` · ${formatPercent(row.desktopShare, 0)} on desktop`)
  );
}

function posthogRageClicks(snapshot) {
  const key = 'posthog-rage-click-cluster';
  const label = 'Rage clicks';
  if (!snapshot) return { ...notCollected(key, label, 'rage-click'), block: null };
  const all = snapshot.rows.map(rageRow).filter((row) => row.path !== null);
  const blockBase = {
    windowStart: snapshot.window.start,
    windowEnd: snapshot.window.end,
    reportDate: snapshot.reportDate,
    shareLine: RAGE_CLICK_PAGE_SHARE,
  };
  if (all.length === 0) {
    return {
      check: check(key, label, 'clear', 'PostHog captured no rage clicks on a page in this window.'),
      cards: [],
      block: { ...blockBase, clusters: [] },
    };
  }
  const eligible = all.filter(
    (row) => row.pagePeople >= RAGE_CLICK_MIN_PAGE_PEOPLE && row.people >= RAGE_CLICK_MIN_PEOPLE,
  );
  const clusters = eligible
    .filter((row) => row.share !== null && row.share > RAGE_CLICK_PAGE_SHARE)
    .sort((left, right) => right.share - left.share || right.people - left.people);
  const block = { ...blockBase, clusters: clusters.slice(0, RAGE_CLICK_PRODUCT_LIMIT) };
  if (eligible.length === 0) {
    return {
      check: check(
        key,
        label,
        'not-enough-data',
        `No element reached ${formatInt(RAGE_CLICK_MIN_PEOPLE)} people on a page with ${formatInt(RAGE_CLICK_MIN_PAGE_PEOPLE)} or more visitors.`,
      ),
      cards: [],
      block,
    };
  }
  if (clusters.length === 0) {
    return {
      check: check(
        key,
        label,
        'clear',
        `No element drew rage clicks from more than ${formatPercent(RAGE_CLICK_PAGE_SHARE, 0)} of its page’s visitors.`,
      ),
      cards: [],
      block,
    };
  }
  // The page is chosen by the people its clusters frustrate, so a page with one
  // sharp cluster does not outrank a page where four inputs all fail.
  const byPage = new Map();
  for (const row of clusters) {
    byPage.set(row.path, [...(byPage.get(row.path) ?? []), row]);
  }
  const [path, onPage] = [...byPage.entries()].sort(
    ([leftPath, left], [rightPath, right]) =>
      Math.max(...right.map((row) => row.people)) - Math.max(...left.map((row) => row.people)) ||
      leftPath.localeCompare(rightPath),
  )[0];
  const pageRows = onPage.sort((left, right) => right.people - left.people);
  const [top] = pageRows;
  const otherPages = byPage.size - 1;
  const cardItem = card({
    key,
    kind: 'warning',
    title:
      pageRows.length > 1
        ? `Rage clicks cluster on ${path}: ${formatInt(pageRows.length)} elements frustrate over ${formatPercent(RAGE_CLICK_PAGE_SHARE, 0)} of its visitors`
        : `Rage clicks cluster on ${path}: the ${top.element} frustrates ${formatPercent(top.share)} of its visitors`,
    summary:
      `Over ${posthogWindowLabel(snapshot)}, ${formatInt(top.people)} of the ${formatInt(top.pagePeople)} people who viewed ${path} rage-clicked the ${top.element} (${formatPercent(top.share)}).` +
      (pageRows.length > 1
        ? ` ${pageRows
            .slice(1, RAGE_CLICK_EVIDENCE_LIMIT)
            .map((row) => `The ${row.element}: ${formatPercent(row.share)}`)
            .join('; ')}.`
        : '') +
      (otherPages > 0 ? ` ${formatInt(otherPages)} other page(s) cross the line too.` : '') +
      ' Watch a session on that element before changing it.',
    whyItMatters:
      'Repeated clicks on one control are people telling the page it did not respond the way they expected. On a form they usually mean an input that looks editable but is not yet, or one that ignores the first tap.',
    primary: { value: formatPercent(top.share), label: 'Of page visitors' },
    confidence: 'medium',
    window: snapshot.window,
    evidence: [
      ruleTag(key),
      ...pageRows.slice(0, RAGE_CLICK_EVIDENCE_LIMIT).map((row) =>
        evidence(`${path} · ${row.element}`, formatPercent(row.share), rageDetail(row)),
      ),
      ...(otherPages > 0
        ? [
            evidence(
              'Other pages over the line',
              formatInt(otherPages),
              [...byPage.keys()].filter((other) => other !== path).join(', '),
            ),
          ]
        : []),
    ],
    sources: [source('posthog', 'rageclicks')],
    caveat:
      'A rage click is PostHog’s own heuristic — several fast clicks in one spot — so on a control people click repeatedly by design it can overstate frustration. Page visitors are people with a page view on that path in the window; both counts are unique people over the window and neither adds across elements.',
  });
  return {
    check: check(
      key,
      label,
      'fired',
      `${formatInt(clusters.length)} element(s) over the ${formatPercent(RAGE_CLICK_PAGE_SHARE, 0)} line; worst is the ${top.element} on ${path}.`,
    ),
    cards: [cardItem],
    block,
  };
}

// --- 4. real-visitor speed against Google's lines ---------------------------------

/** Google's Core Web Vitals lines at the 75th percentile: at or under `good` is
 * good, over `poor` is poor, between is needs improvement. LCP and INP in ms. */
const VITALS_LINES = {
  lcp: { good: 2500, poor: 4000 },
  inp: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
};
/** A segment's p75 over fewer measurements than this is not a verdict. */
const VITALS_MIN_MEASUREMENTS = 500;
/** "A top page": the pages with the most measurements. */
const VITALS_TOP_PAGES = 5;
const VITALS_EVIDENCE_LIMIT = 4;
const VITALS_PRODUCT_LIMIT = 12;
const RATING_RANK = { poor: 2, 'needs-improvement': 1, good: 0 };

function vitalsRating(metric, value) {
  if (value === null) return null;
  const line = VITALS_LINES[metric];
  if (value <= line.good) return 'good';
  return value > line.poor ? 'poor' : 'needs-improvement';
}

function ratingWords(rating) {
  return rating === 'needs-improvement' ? 'needs improvement' : rating;
}

function vitalsRow(row) {
  const lcpP75 = nullableNumber(row.lcp_p75);
  const inpP75 = nullableNumber(row.inp_p75);
  const clsP75 = nullableNumber(row.cls_p75);
  return {
    path: nullableText(row.path),
    device: nullableText(row.device),
    os: nullableText(row.os),
    measurements: number(row.measurements),
    lcpP75,
    inpP75,
    clsP75,
    fcpP75: nullableNumber(row.fcp_p75),
    lcpRating: vitalsRating('lcp', lcpP75),
    inpRating: vitalsRating('inp', inpP75),
    clsRating: vitalsRating('cls', clsP75),
  };
}

function segmentName(row) {
  return [row.os, row.device].filter(Boolean).join(' ') || 'every visitor';
}

/** How badly the segment misses the lines the rule reads (LCP, INP). */
function segmentSeverity(row) {
  return Math.max(RATING_RANK[row.lcpRating] ?? 0, RATING_RANK[row.inpRating] ?? 0);
}

function vitalsReading(row) {
  return [
    row.lcpP75 === null ? 'LCP not measured' : `LCP ${formatInt(row.lcpP75)} ms (${ratingWords(row.lcpRating)})`,
    row.inpP75 === null ? 'INP not measured' : `INP ${formatInt(row.inpP75)} ms (${ratingWords(row.inpRating)})`,
  ].join(' · ');
}

function vitalsDetail(row) {
  return `${vitalsReading(row)} · ${formatInt(row.measurements)} measurements`;
}

function posthogVitals(snapshot) {
  const key = 'posthog-slow-segment';
  const label = 'Real-visitor speed';
  if (!snapshot) return { ...notCollected(key, label, 'web-vitals'), block: null };
  const all = snapshot.rows.map(vitalsRow).filter((row) => row.path !== null);
  const pageTotals = new Map();
  for (const row of all) {
    pageTotals.set(row.path, (pageTotals.get(row.path) ?? 0) + row.measurements);
  }
  const topPages = [...pageTotals.entries()]
    .sort(([leftPath, left], [rightPath, right]) => right - left || leftPath.localeCompare(rightPath))
    .slice(0, VITALS_TOP_PAGES)
    .map(([path]) => path);
  const pageRank = new Map(topPages.map((path, index) => [path, index]));
  const onTopPages = all.filter((row) => pageRank.has(row.path));
  const measured = onTopPages
    .filter((row) => row.measurements >= VITALS_MIN_MEASUREMENTS)
    .sort(
      (left, right) =>
        segmentSeverity(right) - segmentSeverity(left) ||
        pageRank.get(left.path) - pageRank.get(right.path) ||
        right.measurements - left.measurements,
    );
  const block = {
    windowStart: snapshot.window.start,
    windowEnd: snapshot.window.end,
    reportDate: snapshot.reportDate,
    minMeasurements: VITALS_MIN_MEASUREMENTS,
    lines: VITALS_LINES,
    // First paint stays in posthog-web-vitals.csv: no rule or surface reads it,
    // and the snapshot carries what the Tower draws.
    segments: measured.slice(0, VITALS_PRODUCT_LIMIT).map(({ fcpP75: _fcp, ...segment }) => segment),
    unmeasuredSegments: onTopPages.length - measured.length,
  };
  if (measured.length === 0) {
    return {
      check: check(
        key,
        label,
        'not-enough-data',
        all.length === 0
          ? 'PostHog captured no speed measurements on a page in this window.'
          : `No device and system segment on a top page reached ${formatInt(VITALS_MIN_MEASUREMENTS)} measurements.`,
      ),
      cards: [],
      block,
    };
  }
  const failing = measured.filter(
    (row) =>
      (row.lcpP75 !== null && row.lcpP75 > VITALS_LINES.lcp.good) ||
      (row.inpP75 !== null && row.inpP75 > VITALS_LINES.inp.good),
  );
  if (failing.length === 0) {
    return {
      check: check(
        key,
        label,
        'clear',
        `${formatInt(measured.length)} measured segment(s) on the top pages are inside Google’s good lines for LCP and INP.`,
      ),
      cards: [],
      block,
    };
  }
  const [worst] = failing;
  // The headline is whichever of the two metrics misses its good line by more,
  // measured against the line — 744 ms of INP is further out than 3,844 ms of LCP.
  const lcpOver = worst.lcpP75 === null ? -Infinity : worst.lcpP75 / VITALS_LINES.lcp.good;
  const inpOver = worst.inpP75 === null ? -Infinity : worst.inpP75 / VITALS_LINES.inp.good;
  const headline =
    inpOver >= lcpOver
      ? { value: `${formatInt(worst.inpP75)} ms`, label: 'INP at p75' }
      : { value: `${formatInt(worst.lcpP75)} ms`, label: 'LCP at p75' };
  // A segment of the same page inside both lines, same device first: Chrome OS
  // desktops against Mac desktops is a like-for-like contrast, a phone is not.
  const sibling = measured
    .filter((row) => row.path === worst.path && row !== worst && segmentSeverity(row) === 0)
    .sort(
      (left, right) =>
        Number(right.device === worst.device) - Number(left.device === worst.device) ||
        right.measurements - left.measurements,
    )[0];
  const cardItem = card({
    key,
    kind: 'warning',
    title: `${segmentName(worst)} visitors to ${worst.path} wait past Google’s lines`,
    summary:
      `Over ${posthogWindowLabel(snapshot)}, ${segmentName(worst)} visitors to ${worst.path} measured ${vitalsReading(worst)} at the 75th percentile, across ${formatInt(worst.measurements)} measurements. ` +
      `Google’s good lines are ${formatInt(VITALS_LINES.lcp.good)} ms for LCP and ${formatInt(VITALS_LINES.inp.good)} ms for INP.` +
      (sibling ? ` ${segmentName(sibling)} visitors on the same page are inside both (${vitalsReading(sibling)}).` : '') +
      (failing.length > 1 ? ` ${formatInt(failing.length - 1)} other measured segment(s) on the top pages cross a line too.` : ''),
    whyItMatters:
      'Slow paint and slow response on a segment this size is a real audience waiting, and Google reads the same field data for page experience. A fix aimed at the segment that fails beats a site-wide average that hides it.',
    primary: headline,
    confidence: worst.measurements >= VITALS_MIN_MEASUREMENTS * 10 ? 'high' : 'medium',
    window: snapshot.window,
    evidence: [
      ruleTag(key),
      ...failing
        .slice(0, VITALS_EVIDENCE_LIMIT)
        .map((row) => evidence(`${row.path} · ${segmentName(row)}`, vitalsDetail(row))),
      ...(sibling ? [evidence(`${sibling.path} · ${segmentName(sibling)}`, vitalsDetail(sibling), 'Inside both lines on the same page.')] : []),
    ],
    sources: [source('posthog', 'web-vitals')],
    caveat:
      'Real-visitor 75th percentiles from PostHog’s web-vitals capture: only browsers that report these metrics send them, and only visitors whose browser does not block PostHog. Google judges a page on its own Chrome field data over 28 days, so this is where to look in Search Console’s Core Web Vitals report, not Google’s verdict.',
  });
  return {
    check: check(
      key,
      label,
      'fired',
      `${formatInt(failing.length)} measured segment(s) cross a line; worst is ${segmentName(worst)} on ${worst.path}.`,
    ),
    cards: [cardItem],
    block,
  };
}

// --- 5. the largest step-to-step drop in each funnel ---------------------------------

/** A funnel whose first step saw fewer people than this is too thin to rank. */
const FUNNEL_MIN_START_PEOPLE = 100;
/** The comparison archive: the same funnel, one window earlier. */
const FUNNEL_PRIOR_DAYS = 7;
/** A step that lost at least this many percentage points against the prior
 * window warns rather than informs. */
const FUNNEL_WORSENED_POINTS = 0.05;
const FUNNEL_CARD_LIMIT = 3;
const FUNNEL_PRODUCT_LIMIT = 10;
const FUNNEL_STEP_LIMIT = 10;

function stepLabel(step) {
  if (step.event === '$pageview') return step.path ? `Viewed ${step.path}` : 'Viewed a page';
  return step.path ? `${step.event} on ${step.path}` : step.event;
}

/** Every funnel in one archive, steps in order. */
function funnelsIn(snapshotRows) {
  const byId = new Map();
  for (const row of snapshotRows) {
    const id = text(row.funnel_id);
    if (!id) continue;
    const entry = byId.get(id) ?? { id, name: text(row.name) || id, steps: [] };
    entry.steps.push({
      step: number(row.step),
      event: text(row.event),
      path: nullableText(row.path),
      people: number(row.people),
    });
    byId.set(id, entry);
  }
  return [...byId.values()].map((funnel) => {
    const steps = funnel.steps.sort((left, right) => left.step - right.step).slice(0, FUNNEL_STEP_LIMIT);
    const start = steps[0]?.people ?? 0;
    let largestDrop = null;
    for (let index = 1; index < steps.length; index++) {
      const before = steps[index - 1].people;
      if (before <= 0) continue;
      const stepConversion = steps[index].people / before;
      if (largestDrop === null || stepConversion < largestDrop.stepConversion) {
        largestDrop = {
          fromStep: steps[index - 1].step,
          toStep: steps[index].step,
          lostPeople: Math.max(0, before - steps[index].people),
          stepConversion,
        };
      }
    }
    return {
      id: funnel.id,
      name: funnel.name,
      steps,
      start,
      conversion: start > 0 && steps.length > 1 ? steps.at(-1).people / start : null,
      largestDrop,
    };
  });
}

function stepConversionBetween(funnel, fromStep, toStep) {
  const from = funnel.steps.find((step) => step.step === fromStep);
  const to = funnel.steps.find((step) => step.step === toStep);
  return from && to && from.people > 0 ? to.people / from.people : null;
}

function posthogFunnels(families, snapshot) {
  const key = 'posthog-funnel-drop';
  const label = 'Funnels';
  if (!snapshot) return { ...notCollected(key, label, 'funnel'), block: [] };
  const priorDate = shiftDate(snapshot.reportDate, -FUNNEL_PRIOR_DAYS);
  const allRows = rows(families, 'posthog-funnels');
  const priorRows = allRows.filter((row) => text(row.report_date) === priorDate);
  const prior = priorRows.length > 0 ? posthogAt(allRows, 'funnels', priorDate) : null;
  const priorFunnels = new Map(prior ? funnelsIn(prior.rows).map((funnel) => [funnel.id, funnel]) : []);
  const current = funnelsIn(snapshot.rows).sort(
    (left, right) => right.start - left.start || left.name.localeCompare(right.name),
  );
  const block = current.slice(0, FUNNEL_PRODUCT_LIMIT).map((funnel) => {
    const earlier = priorFunnels.get(funnel.id) ?? null;
    return {
      id: funnel.id,
      name: funnel.name,
      windowStart: snapshot.window.start,
      windowEnd: snapshot.window.end,
      steps: funnel.steps,
      conversion: funnel.conversion,
      largestDrop: funnel.largestDrop,
      prior: earlier
        ? {
            windowStart: prior.window.start,
            windowEnd: prior.window.end,
            conversion: earlier.conversion,
            stepConversion: funnel.largestDrop
              ? stepConversionBetween(earlier, funnel.largestDrop.fromStep, funnel.largestDrop.toStep)
              : null,
          }
        : null,
    };
  });
  if (current.length === 0) {
    return {
      check: check(key, label, 'not-enough-data', 'The funnel read came back with no steps.'),
      cards: [],
      block,
    };
  }
  const judged = block.filter(
    (funnel) => funnel.steps.length > 1 && (funnel.steps[0]?.people ?? 0) >= FUNNEL_MIN_START_PEOPLE && funnel.largestDrop,
  );
  if (judged.length === 0) {
    return {
      check: check(
        key,
        label,
        'not-enough-data',
        `No funnel’s first step reached ${formatInt(FUNNEL_MIN_START_PEOPLE)} people in this window.`,
      ),
      cards: [],
      block,
    };
  }
  const cards = judged.slice(0, FUNNEL_CARD_LIMIT).map((funnel) => {
    const drop = funnel.largestDrop;
    const from = funnel.steps.find((step) => step.step === drop.fromStep);
    const to = funnel.steps.find((step) => step.step === drop.toStep);
    const before = funnel.prior?.stepConversion ?? null;
    const worsened = before !== null && before - drop.stepConversion >= FUNNEL_WORSENED_POINTS;
    const priorSentence = funnel.prior
      ? before === null
        ? ` The ${funnel.prior.windowStart}–${funnel.prior.windowEnd} read has no matching steps to compare.`
        : ` In ${funnel.prior.windowStart}–${funnel.prior.windowEnd} the same step kept ${formatPercent(before)}` +
          (worsened ? ` — down ${formatDecimal((before - drop.stepConversion) * 100)} points.` : '.')
      : ` No read of this funnel ended on ${priorDate}, so there is no week-over-week comparison yet.`;
    const suffix = funnel.id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    return card({
      key: `${key}-${suffix}`,
      kind: worsened ? 'warning' : 'insight',
      title: `${funnel.name}: the biggest loss is ${stepLabel(from)} → ${stepLabel(to)}, where ${formatPercent(drop.stepConversion, 0)} continue`,
      summary:
        `Over ${funnel.windowStart}–${funnel.windowEnd}, ${formatInt(funnel.steps[0].people)} people reached “${stepLabel(funnel.steps[0])}” and ${formatInt(funnel.steps.at(-1).people)} reached “${stepLabel(funnel.steps.at(-1))}”` +
        (funnel.conversion === null ? '.' : ` (${formatPercent(funnel.conversion)} end to end).`) +
        ` The largest step-to-step loss is ${formatInt(from.people)} → ${formatInt(to.people)}: ${formatInt(drop.lostPeople)} people stop there.` +
        priorSentence,
      whyItMatters:
        'The step that loses the most people is where one change moves the whole funnel. Every step after it is capped by what gets through it.',
      primary: { value: formatPercent(drop.stepConversion, 0), label: 'Continue past the drop' },
      confidence: 'high',
      window: { start: funnel.windowStart, end: funnel.windowEnd },
      evidence: [
        ruleTag(key),
        ...funnel.steps.map((step, index) =>
          evidence(
            `Step ${formatInt(step.step)}`,
            `${stepLabel(step)} · ${formatInt(step.people)} people`,
            index === 0
              ? 'Where the funnel starts.'
              : `${formatPercent(step.people / Math.max(1, funnel.steps[index - 1].people))} of the step before.`,
          ),
        ),
        evidence(
          'Same step one window earlier',
          before === null ? 'No comparison' : formatPercent(before),
          funnel.prior
            ? `${funnel.prior.windowStart}–${funnel.prior.windowEnd}`
            : `No funnel read ended on ${priorDate}.`,
        ),
      ],
      sources: [source('posthog', 'funnels')],
      caveat:
        'Ordered-step conversion inside the window: a person counts at a step only after the steps before it, within the same window. People are unique over the window. Signed-in steps that wait for consent are floors, and a browser that blocks PostHog never enters the funnel at all.',
    });
  });
  const worst = [...judged].sort(
    (left, right) => left.largestDrop.stepConversion - right.largestDrop.stepConversion,
  )[0];
  return {
    check: check(
      key,
      label,
      'fired',
      `${formatInt(judged.length)} funnel(s) ranked; the deepest drop keeps ${formatPercent(worst.largestDrop.stepConversion, 0)} in ${worst.name}.`,
    ),
    cards,
    block,
  };
}

// --- the Tower's product block ----------------------------------------------------

/** The days the Tower charts. The panel refresh keeps 35 days of archives, and
 * this cap keeps a longer local history from growing the snapshot. */
const PRODUCT_DAY_LIMIT = 90;

function productWebDaily(families, snapshot) {
  if (!snapshot) return null;
  const days = rows(families, 'posthog-web-daily')
    .filter((row) => text(row.date))
    .map((row) => ({
      date: text(row.date),
      people: nullableNumber(row.people),
      pageviews: nullableNumber(row.pageviews),
      sessions: nullableNumber(row.sessions),
    }))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-PRODUCT_DAY_LIMIT);
  if (days.length === 0) return null;
  return {
    windowStart: days[0].date,
    windowEnd: days.at(-1).date,
    reportDate: snapshot.reportDate,
    days,
  };
}

/**
 * PostHog's five rules and the compact block the Tower's Product section reads.
 * One pass: the cards and the block come from the same readings, so the Growth
 * tab and the findings list can never disagree about a number.
 */
function posthogProduct(families, archives) {
  const latest = Object.fromEntries(
    POSTHOG_FAMILY_ORDER.map((family) => [family, posthogLatest(families, archives, family)]),
  );
  const collected = POSTHOG_FAMILY_ORDER.filter((family) => latest[family] !== null);
  if (collected.length === 0) return { cards: [], product: null };

  const once = posthogOnceEvents(latest.events);
  const errors = posthogExceptions(latest.exceptions);
  const rage = posthogRageClicks(latest.rageclicks);
  const speed = posthogVitals(latest['web-vitals']);
  const funnels = posthogFunnels(families, latest.funnels);

  const readings = collected.map((family) => {
    const snapshot = latest[family];
    return {
      family,
      reportDate: snapshot.reportDate,
      windowStart: snapshot.window.start,
      windowEnd: snapshot.window.end,
      rows: snapshot.rows.length,
      truncated: snapshot.truncated,
    };
  });
  const collectedAt = collected
    .map((family) => latest[family].collectedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  return {
    cards: [...once.cards, ...errors.cards, ...rage.cards, ...speed.cards, ...funnels.cards],
    product: {
      source: 'posthog',
      observedAt: readings.map((reading) => reading.reportDate).sort().at(-1),
      collectedAt,
      families: readings,
      webDaily: productWebDaily(families, latest['web-daily']),
      funnels: funnels.block,
      vitals: speed.block,
      exceptions: errors.block,
      rageClicks: rage.block,
      onceEvents: once.repeating,
      checks: [speed.check, rage.check, errors.check, funnels.check, once.check],
      caveat:
        'PostHog counts only browsers that load it, so its totals run below Google Analytics; it drops known bots that Google Analytics keeps; signed-in events wait for consent, so they are floors; and server-side events use account ids that do not join browser visitors. People are unique within each figure’s own window and never add across rows or days.',
    },
  };
}

function humanizeAppearance(value) {
  return value
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function humanizeEvent(value) {
  return value
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function humanizeBingIssue(value) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/Code(\d)/, 'HTTP $1')
    .replace('Txt', 'txt');
}

const KIND_ORDER = {
  warning: 0,
  recommendation: 1,
  discovery: 2,
  insight: 3,
};

/** A screen an operator reads in one sitting. Sorting by kind before the cut
 * means the cards that survive are the most severe, and `Array#sort` is stable
 * (ES2019), so within one kind the rule list order below decides.
 *
 * The cut is a display decision, not a judgment that the dropped cards are
 * false, so what it drops is listed in `suppressedItems` rather than discarded:
 * the system may decide not to show something, never not to mention it
 * (AGENTS.md). This started mattering on 2026-07-31, when four rules were added
 * and one site's three warnings plus five recommendations filled the page on
 * their own — including the largest single finding in its archive. */
const INSIGHT_CARD_LIMIT = 8;

/** Display one retained Clarity observation, not a daily series or a finding.
 * URL rows are page-scoped; the null-URL Traffic row is an unattributed bucket,
 * not evidence of a property-wide audience. No row counts are added together. */
export function claritySnapshot(asset, families, archives) {
  const input = rows(families, 'clarity-url-3d').filter((row) => row.asset === asset);
  const metadata = archives.filter((archive) => archive.integration === 'clarity' && archive.report === 'url-3d');
  const date = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value ? value : null;
  const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
  const reportDate = [...input.map((row) => date(row.report_date)), ...metadata.map((archive) => date(archive.reportDate))]
    .filter(Boolean).sort().at(-1);
  if (!reportDate) return null;
  const at = input.filter((row) => row.report_date === reportDate);
  const reports = metadata.filter((archive) => archive.reportDate === reportDate);
  // An unstamped report could be a newer empty revision. Its ordering is
  // unknown, so older stamped rows cannot establish the latest observation.
  const ambiguous = reports.some((archive) => instant(archive.collectedAt) === null);
  const collectedAt = ambiguous ? null : [...at.map((row) => instant(row.collected_at)), ...reports.map((archive) => instant(archive.collectedAt))]
    .filter(Boolean).sort().at(-1) ?? null;
  const current = ambiguous ? [] : at.filter((row) => instant(row.collected_at) === collectedAt);
  const count = (value) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/u.test(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const pageRows = current.filter((row) => row.metric === 'ScriptErrorCount' && typeof row.url === 'string' && row.url);
  const occurrences = new Map();
  for (const row of pageRows) occurrences.set(row.url, (occurrences.get(row.url) ?? 0) + 1);
  const pages = pageRows.flatMap((row) => {
    try {
      const url = new URL(row.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return [];
      if (occurrences.get(row.url) !== 1) return [];
      const sessions = count(row.sessions_count), scriptErrors = count(row.sub_total);
      return sessions === null && scriptErrors === null ? [] : [{ url: url.href, sessions, scriptErrors }];
    } catch { return []; }
  }).sort((left, right) => (right.scriptErrors ?? -1) - (left.scriptErrors ?? -1) || left.url.localeCompare(right.url));
  const unattributed = current.filter((row) => row.metric === 'Traffic' && Object.hasOwn(row, 'url') && (row.url === '' || row.url === null));
  return {
    source: 'clarity', reportDate, collectedAt, windowHours: 72,
    truncated: current.some((row) => isTrue(row.provider_truncated))
      || reports.some((archive) => instant(archive.collectedAt) === collectedAt && archive.providerTruncated === true),
    page: pages[0] ?? null,
    unattributedSessions: unattributed.length === 1 ? count(unattributed[0].total_session_count) : null,
  };
}

export function buildExecutiveSnapshot({
  asset,
  families,
  archives,
  generatedAt = new Date().toISOString(),
  /** Optional export of this property's OPEN outreach targets
   * (`pnpm reclamation:open-targets`, `--reclamation-targets` — see
   * scripts/README). null means the operator did
   * not ask, which is not the same as "no matches": the reclamation rule stays
   * silent rather than reporting an absence it never looked for. */
  reclamationTargets = null,
  /** Parsed `config/value-events.json` — which GA4 events this property counts
   * as value events. Read at the analyzer's filesystem boundary for the same
   * reason the reclamation export is: the rules stay pure functions over stored
   * rows. null means the config was not supplied, which is "not declared", not
   * "nothing to declare", so the rule stays silent. */
  valueEvents = null,
  /** The site's saved DataForSEO market (`savedSearchMarket` over its
   * `dataforseo` entry in config/integrations.json), read at the same
   * boundary. null — nothing saved — names the site's default market. */
  market = null,
}) {
  // PostHog's cards and the Growth tab's Product block come from one pass over
  // the same readings (ro-ghis.3).
  const posthog = posthogProduct(families, archives);
  // Order inside a kind is the tie-break the eight-card cap uses, so it is a
  // priority list, not a call order. Measurement faults lead: if the ruler is
  // wrong, every card below it is bounded by that.
  const ranked = [
    measurementIntegrityInsight(families),
    valueEventInsight(families, asset, valueEvents),
    concentrationRiskInsight(families),
    // Above the card it bounds: when two observers name different worst pages,
    // the single-observer card is the one that would send the fix to the wrong
    // page, so the operator must meet the divergence first (`ro-d5c`).
    errorObserverDisagreementInsight(families),
    javascriptErrorInsight(families),
    bingCrawlIssueInsight(families),
    bingFeedIssueInsight(families),
    // After the search-side warnings, so a product finding never pushes a
    // measurement or crawl fault below the cut; every card the cut drops is
    // still named in suppressedItems.
    ...posthog.cards,
    dataForSeoRankChangeInsight(families, market),
    reclamationWonInsight(families, reclamationTargets),
    backlinkMomentumInsight(families),
    dataForSeoOpportunityInsight(families, market),
    strikingDistanceInsight(families),
    cannibalizationInsight(families),
    bingSearchOpportunityInsight(families),
    queryLanguageDriftInsight(families),
    deviceCtrGapInsight(families),
    llmGroundingTrafficInsight(families),
    llmVisibilityInsight(families, asset, market),
    distantDemandClusterInsights(families, market),
    aiReferralInsight(families),
    searchAppearanceInsight(families),
    imageSearchInsight(families),
    pruneCandidatesInsight(families),
    featureUsageInsight(families),
    pageMoversInsight(families),
  ]
    .flat()
    .filter(Boolean)
    .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]);
  const items = ranked.slice(0, INSIGHT_CARD_LIMIT);
  const suppressedItems = ranked
    .slice(INSIGHT_CARD_LIMIT)
    .map(({ key, kind, title }) => ({ key, kind, title }));
  const allRows = [...families.values()].flat();
  const window = dateWindow(allRows);
  const serpPanel = serpPanelSnapshot(families, market);
  const clarity = claritySnapshot(asset, families, archives);
  return {
    schemaVersion: 1,
    asset,
    generatedAt,
    windowStart: window?.start ?? null,
    windowEnd: window?.end ?? null,
    sourceArchiveCount: archives.length,
    items,
    suppressedItems,
    searchQueries: buildSearchQueryTrends(families, market),
    // The page-grain analogue (`ro-427`). Null until the archive holds fourteen
    // reported dates, the same bar the movers lanes are held to: a page
    // comparison needs two complete weeks or it is comparing a week to a
    // fragment.
    searchPages: buildSearchPageTrends(families),
    productUse: productUseSnapshot(families, asset, valueEvents),
    searchIntelligence: searchIntelligenceSnapshot(families),
    // Absent, not null, for a property with no panel: the key's presence is the
    // claim that a panel exists.
    ...(serpPanel ? { serpPanel } : {}),
    // What people do once they arrive, and where it breaks (ro-ghis.3). null
    // when no PostHog family was ever collected for this property — the Tower
    // says "not collected", never a row of zeros.
    product: posthog.product,
    ...(clarity ? { clarity } : {}),
    methodology: [
      'Every finding is generated by a deterministic rule over named GA4, GSC, Bing Webmaster, and DataForSEO report rows.',
      'Product-use stage signals use one rolling 28-day GA4 aggregate so returning users are not added more than once per event; independent event totals are not a cohort conversion.',
      'Google and Bing query movers compare seven reported dates with the preceding seven and include only queries present in both; DataForSEO adds a current query baseline even before a second local snapshot exists.',
      'Bing snapshot reports are revision history: rules read only the latest snapshot and never add repeated weekly rows together.',
      'DataForSEO rankings, backlinks, and LLM mentions are stored weekly snapshots; current facts use the latest snapshot and movement rules compare locally retained history without repulling it.',
      'DataForSEO demand, difficulty, traffic, and AI-volume values are provider estimates used for prioritization—not causal ROI or user counts. Exact report cost is retained.',
      `Tracked-panel AI Overview evidence is one live result page in ${marketPhrase(market)} per hand-picked head term PER DEVICE—phone and desktop are two different pages and are never folded into one verdict. It enriches queries the ranking inventory already carries and gates the striking-distance recommendation, withholding a term whose overview was read on either device and does not cite this property there. An untracked query or a failed overview load stays unknown—never recorded as no overview—and an unknown term is offered exactly as it was before the panel existed.`,
      'Quoted-literal queries are classified as machine grounding and excluded from the CTR and position rules, never silently: each affected card states the excluded impressions and their share, and the excluded traffic gets its own card. The classifier covers the quoted signature only, so it is a floor for that behavior rather than its measure.',
      'No archived family carries query by device, so the device rule charges the whole grounding exclusion to whichever surface is clicking worse — a worst case that can only make that rule quieter, never louder.',
      'Cards recommending page consolidation set aside queries whose pages report near-identical impressions at near-identical positions, or no clicks at all: that is one SERP block crediting several of the property’s URLs, not pages competing.',
      'Value events are an operator declaration in config/value-events.json compared against GA4’s own key-event counts. The OS reports the disagreement and never edits either side; the measurement channel is operator-only by invariant.',
      'Page-grain and country-grain rules read GSC top-row exports: a page or country below the export cut-off is unknown, never zero, so week-over-week page movement compares only pages reported in both weeks.',
      'Page decisions compare the same two seven-date windows the query movers do, at page grain. A page row carries no query, so the grounding-query exclusion cannot be applied to its clicks and impressions — it is applied only to the leading query joined onto each page, and the lane says so rather than letting one row imply the other was corrected.',
      'Reclamation matches compare an operator-supplied export of open outreach targets against GA4 referral hosts. Without that export the rule is silent, and it never marks a link won: that stays a human confirmation on the page.',
      'Measurement-integrity findings bound the rest of the page rather than adding to it, and the OS only reports them — the measurement channel is operator-only by invariant.',
      'Rules over GA4’s channel and source/medium reports read settled days only. A day GA4 was still attributing when it was collected (provisional=1, until a collection two days after it) reads high on Unassigned and low on the real channels, so it is set aside rather than labelled, and each card built beside such days names them. A report holding only unsettled days raises no finding until it settles.',
    'Where two observers rank the same problem — Clarity’s sampled trailing 72-hour script errors and GA4’s js_error events over completed dates — a disagreement about the worst page is reported as its own finding, with each observer’s page, unit, and window stated separately. The units are not convertible, so the OS never merges, averages, or ranks the two observers against each other.',
      'JavaScript error messages are ranked as masked buckets rather than raw text, which carries each occurrence’s URL, build hash, and line number. GA4 answers for that parameter only after an operator registered it and backfills nothing, so events reported earlier carry no message, are counted in their own row rather than ranked, and can never be triaged. A property whose message dimension is unregistered has no such rows at all, and its error card claims exactly what it claimed before the triage family existed.',
      'PostHog product findings read each family’s newest archive over its own window: rage clicks against the page’s visitors (over 5% of at least 200), exceptions with one message holding half the volume and no source file set aside as probable third-party noise, events named first_* or *_created that fire over 10% more often than people, 75th-percentile LCP and INP against Google’s 2,500 ms and 200 ms lines on top-page segments with at least 500 measurements, and each funnel’s largest step-to-step loss against the read ending seven days earlier. A rule below its floor reports not enough data rather than firing.',
      'The page keeps the eight most severe cards. Every card the cut drops is listed in suppressedItems with its rule id and title — a finding the system decides not to show is still a finding it may not decide not to mention.',
      'Missing provider rows remain unknown and never justify a deprecation recommendation.',
      'Recommendations are directional evidence, not causal claims; deploy annotations and outcome watch still decide whether a change worked.',
    ],
  };
}
