// One reading of the provider archive.
//
// A signal archive is one provider answer as a collector stored it: an envelope
// (`schemaVersion`, `asset`, `integration`, `report`, `reportDate`,
// `collectedAt`, `dataState`, `providerRows`, `providerTruncated`) around the
// provider's own pages. This module is the one place that says what an archive
// means as rows, and which of several rows about one day is kept.
// scripts/signal-history.mjs stores those rows; scripts/signal-history-analyze.mjs
// reads a pinned generation for the panel CSVs and rules.
//
//   parseArchive(text, { asset, source })  the checked envelope, or a refusal
//   archiveFamily(archive)                 its family, `<integration>-<report>`
//   reportDayKey(archive)                  the report day it answers for
//   manifestConfirmations(manifest)        when each report day was last confirmed
//   archiveRows(archive, confirmations)    its rows, normalized
//   resolveFamily(family, rows)            a family's rows in reading order,
//                                          revisions resolved
//   resolvesAcrossReportDays(family)       whether one report day's rows can be
//                                          replaced by another report's
//   indexCoverageRows(families)            the one family derived from others,
//                                          read from INDEX_COVERAGE_SOURCES
//
// Reading order is part of the rules. Archives are read in path order — in the
// downloads layout, `<integration>/<report>/<reportDate>.json` — and rows in
// the order an archive holds them. `resolveFamily` sorts a family by
// `report_date` (`compareReportDates`), keeping that order among equal dates,
// and a revision rule keeps the last row it meets for a day. A reader that
// gathers rows another way must hand them over in this order, or it will
// resolve ties differently.
//
// Every row of one archive carries that archive's report date, so a family
// that does not resolve across report days reads one report day at a time;
// that is what lets the analytical-file writer rewrite one period of a family
// without reading the rest of it.
//
// Nothing here reads a file, the clock or the settings: every input is an
// argument, so one archive always reads the same way.
//
// Three-state columns. `dataforseo-serp-panel.csv` is one row per (tracked
// query, `device`); never sum or average across `device`. Its `aio_present` /
// `aio_cites_us` are `true | false | (empty)`: empty is unknown — the
// asynchronous AI Overview did not load, or the provider could not answer —
// and is never read as `false`, which is a positive observation. A tracked
// query recorded as unknown is treated exactly like a query nobody tracked.
// `best_rank` and `second_rank` empty mean "no result inside the tracked
// depth", never "does not rank"; `sitelinks_us` empty means there was no result
// of ours to carry them (see `serpItemSitelinks`). `query_label` appears only
// when the archive carries it: an empty cell means the collection predates
// that panel's labels, never "unclustered", and a rename in config changes the
// collections that follow, never the ones archived.
//
// `ga4-js-errors.csv`: "no rows" is either a real zero or a family GA4 could
// not be queried for (no custom dimension registered). The manifest separates
// them — the second case is a `ga4_custom_dimension_unregistered` run that
// archives nothing — so a missing or empty CSV reads as unknown unless the
// manifest shows a successful run. `(not set)` is GA4's own token for an event
// that carried no such parameter; `message_bucket` masks the volatile parts of
// a message and preserves `(not set)` rather than folding it in.
//
// `index-coverage.csv` is derived from the Bing crawl-stats and feeds families
// (see `indexCoverageRows`): site-level, Bing's answer, silent about any
// individual URL.
//
// The `bing-webmaster-ai-*` families are an operator-downloaded export
// (`pnpm bing-ai:import <file>`), so `report_date` is the export day; only
// `ai-overview` carries a measured day, in `provider_date`. Overlapping exports
// are revisions of a day, resolved to the newest. An absent family means
// nobody has dropped that export yet — the lane has no cron to notice its own
// silence.
//
// The `posthog-*` families are window aggregates, not days: each row's
// `people` is a unique-person count over its own window and never adds across
// rows, days or report dates. Read one `report_date` at a time. The one daily
// family, `posthog-web-daily`, is resolved newest-archive-wins per `date`. An
// empty family is PostHog answering with no rows; a missing one is a family
// nobody collected.

import {
  POSTHOG_FAMILIES as CONTRACT_POSTHOG_FAMILIES,
  POSTHOG_FAMILY_ROWS,
} from '../packages/contract/src/posthog-families.mjs';

/** The provenance columns every row starts with, in this order: whose site,
 * which report day, when it was collected, the provider's data state, and
 * whether the provider cut the read short. */
export const PROVENANCE_COLUMNS = ['asset', 'report_date', 'collected_at', 'data_state', 'provider_truncated'];

/**
 * One archive's text, parsed and checked against the envelope every collector
 * writes. `source` names the archive in a refusal (a file path, an object key).
 * Throws on text that is not JSON, an archive of another site or schema
 * version, an integration no rule reads, or a report with no name.
 */
export function parseArchive(text, { asset, source }) {
  const archive = record(JSON.parse(text));
  if (!archive || archive.schemaVersion !== 1 || archive.asset !== asset) {
    throw new Error(`Unsupported or wrong-property signal archive: ${source}`);
  }
  if (
    !FLATTENED_INTEGRATIONS.includes(archive.integration) ||
    typeof archive.report !== 'string'
  ) {
    throw new Error(`Malformed signal archive: ${source}`);
  }
  return archive;
}

/** The family a checked archive's rows belong to. */
export function archiveFamily(archive) {
  return `${archive.integration}-${archive.report}`;
}

/**
 * The report day an archive — or a manifest row — answers for: one
 * (integration, report, report date). Two archives with one key are two
 * deliveries of one report day.
 */
export function reportDayKey({ integration, report, reportDate }) {
  return `${integration}\0${report}\0${reportDate}`;
}

/** The order `resolveFamily` puts report dates in. */
export function compareReportDates(left, right) {
  return String(left).localeCompare(String(right));
}

/**
 * One checked archive's rows: the provenance columns, then the provider's own
 * dimensions and metrics — never a value the provider did not send.
 * `confirmations` is `manifestConfirmations` of the manifest beside the
 * archive (empty when there is none); GA4's attribution families read it to
 * mark a day that had not settled when it was last collected.
 */
export function archiveRows(archive, confirmations) {
  if (!(confirmations instanceof Map)) {
    throw new TypeError('archiveRows needs the manifest confirmations: a Map, empty when there is no manifest.');
  }
  if (archive.integration === 'gsc') return flattenGsc(archive);
  if (archive.integration === 'ga4') {
    if (!GA4_ATTRIBUTION_REPORTS.has(archive.report)) return flattenGa4(archive);
    const provisional = ga4ProvisionalFlag(archive, confirmations);
    return flattenGa4(archive).map((row) => ({ ...row, provisional }));
  }
  if (archive.integration === 'bing-webmaster') return flattenBing(archive);
  if (archive.integration === 'clarity') return flattenClarity(archive);
  if (archive.integration === 'posthog') return flattenPosthog(archive);
  return flattenDataForSeo(archive);
}

/**
 * One family's rows, in reading order, with its revisions resolved: `rows` is
 * sorted by `report_date` in place (a stable sort, so equal dates keep reading
 * order), then the families whose archives overlap keep one row per day
 * (`FAMILY_RESOLVERS`). Every other family keeps every row, and its readers
 * choose a snapshot themselves.
 */
export function resolveFamily(family, rows) {
  rows.sort((left, right) => compareReportDates(left.report_date, right.report_date));
  const resolver = FAMILY_RESOLVERS.get(family);
  return resolver ? resolver(rows) : rows;
}

/**
 * Whether a later report can replace a family's rows about an earlier day
 * (`FAMILY_RESOLVERS`): such a family resolves whole. Every other family's rows
 * depend on their own report day's archive alone.
 */
export function resolvesAcrossReportDays(family) {
  return FAMILY_RESOLVERS.has(family);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function string(value) {
  return typeof value === 'string' ? value : '';
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : '';
}

function flattenGsc(archive) {
  const output = [];
  for (const pageValue of array(archive.pages)) {
    const page = record(pageValue);
    const request = record(page?.request);
    const response = record(page?.response);
    const dimensions = array(request?.dimensions).map(string);
    for (const rowValue of array(response?.rows)) {
      const row = record(rowValue);
      const keys = array(row?.keys);
      const flattened = baseRow(archive);
      flattened.row_grain = dimensions.join('+') || 'property-total';
      dimensions.forEach((dimension, index) => {
        flattened[dimension] = scalar(keys[index]);
      });
      for (const groupValue of array(request?.dimensionFilterGroups)) {
        const group = record(groupValue);
        for (const filterValue of array(group?.filters)) {
          const filter = record(filterValue);
          const dimension = string(filter?.dimension);
          const expression = scalar(filter?.expression);
          if (
            dimension &&
            filter?.operator === 'equals' &&
            !Object.hasOwn(flattened, dimension)
          ) {
            // Search Console requires searchAppearance to be discovered first,
            // then applied as a filter to a second page-level query. Preserve
            // that filter as a real analysis column so the page rows retain
            // their appearance identity after flattening.
            flattened[dimension] = expression;
          }
        }
      }
      for (const metric of ['clicks', 'impressions', 'ctr', 'position']) {
        flattened[metric] = scalar(row?.[metric]);
      }
      output.push(flattened);
    }
  }
  return output;
}

function headerNames(values) {
  return values.map((value) => string(record(value)?.name)).filter(Boolean);
}

/** How the Data API names a registered event parameter. */
const GA4_CUSTOM_EVENT_PREFIX = 'customEvent:';
/** GA4's own token for a row whose event parameter was absent. */
const GA4_NOT_SET = '(not set)';
const MESSAGE_BUCKET_MAX = 120;

/** The API's prefix is a transport detail; analysis wants the parameter's name. */
function ga4ColumnName(dimension) {
  return dimension.startsWith(GA4_CUSTOM_EVENT_PREFIX)
    ? dimension.slice(GA4_CUSTOM_EVENT_PREFIX.length)
    : dimension;
}

/**
 * A countable grouping key for high-cardinality error text. The volatile parts
 * of a JavaScript error message — the URL it happened on, a build hash, a line
 * number — make every occurrence unique, which is why the raw column cannot be
 * counted. Masking them leaves the part that identifies the fault.
 *
 * `(not set)` survives verbatim: those rows are errors whose `message` the
 * emitter did not send, and bucketing them with real messages would invent a
 * fault that was never reported.
 */
function jsErrorMessageBucket(message) {
  const text = string(message).trim();
  if (!text || text === GA4_NOT_SET) return text;
  const masked = text
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > MESSAGE_BUCKET_MAX
    ? `${masked.slice(0, MESSAGE_BUCKET_MAX)}…`
    : masked;
}

function flattenGa4(archive) {
  const output = [];
  for (const pageValue of array(archive.pages)) {
    const page = record(pageValue);
    const request = record(page?.request);
    const response = record(page?.response);
    const dimensions = headerNames(array(response?.dimensionHeaders));
    const metrics = headerNames(array(response?.metricHeaders));
    const dateRange = record(array(request?.dateRanges)[0]);
    for (const rowValue of array(response?.rows)) {
      const row = record(rowValue);
      const dimensionValues = array(row?.dimensionValues);
      const metricValues = array(row?.metricValues);
      const flattened = baseRow(archive);
      if (dateRange) {
        flattened.window_start = scalar(dateRange.startDate);
        flattened.window_end = scalar(dateRange.endDate);
      }
      dimensions.forEach((dimension, index) => {
        flattened[ga4ColumnName(dimension)] = scalar(
          record(dimensionValues[index])?.value,
        );
      });
      metrics.forEach((metric, index) => {
        flattened[metric] = scalar(record(metricValues[index])?.value);
      });
      if (archive.report === 'js-errors') {
        flattened.message_bucket = jsErrorMessageBucket(flattened.message);
      }
      output.push(flattened);
    }
  }
  return output;
}

const BING_CRAWL_ISSUES = [
  [1, 'Code301'],
  [2, 'Code302'],
  [4, 'Code4xx'],
  [8, 'Code5xx'],
  [16, 'BlockedByRobotsTxt'],
  [32, 'ContainsMalware'],
  [64, 'ImportantUrlBlockedByRobotsTxt'],
  [128, 'DnsErrors'],
  [256, 'TimeOutErrors'],
];

/**
 * The Bing families that arrive as an operator-downloaded CSV rather than from
 * the API — Bing's AI Performance report, which exists only in the dashboard's
 * Export button. They share the `bing-webmaster` integration (same account,
 * same verified site); the report name tells them apart.
 * `workers/ingest/src/bing-ai-exports.ts` is the parser whose rows these read.
 */
const BING_AI_GRAINS = new Map([
  ['ai-overview', 'citation-day'],
  ['ai-queries', 'grounding-query'],
  ['ai-pages', 'cited-page'],
]);

/**
 * One AI Performance export's rows.
 *
 * `report_date` is the day the operator downloaded the file, for all three
 * families — two of them carry no date column at all. Only `ai-overview` also
 * carries `provider_date`, the day the citations happened; do not read the two
 * as the same thing.
 */
function flattenBingAiExport(archive) {
  const grain = BING_AI_GRAINS.get(archive.report) ?? 'export-row';
  const output = [];
  for (const pageValue of array(archive.pages)) {
    const response = record(record(pageValue)?.response);
    for (const rowValue of array(response?.rows)) {
      const row = record(rowValue);
      if (!row) continue;
      const flattened = baseRow(archive);
      flattened.row_grain = grain;
      if (archive.report === 'ai-overview') {
        flattened.provider_date = string(row.date);
        flattened.citations = scalar(row.citations);
        flattened.cited_pages = scalar(row.citedPages);
      } else if (archive.report === 'ai-queries') {
        flattened.query = scalar(row.query);
        flattened.intent = scalar(row.intent);
        flattened.topic = scalar(row.topic);
        flattened.citations = scalar(row.citations);
        // Percentage POINTS, as the export writes them: 27.24 means 27.24%.
        flattened.citation_share_percent = scalar(row.citationSharePercent);
      } else {
        flattened.page = scalar(row.page);
        flattened.citations = scalar(row.citations);
      }
      output.push(flattened);
    }
  }
  return output;
}

/**
 * Resolve an overlapping day to the newest export. The daily series is
 * re-exported whole each time, so two exports carry the days between them as
 * revisions of one day; keeping both would double every overlapping day.
 */
export function newestExportPerDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = String(row.provider_date ?? '');
    const held = byDay.get(day);
    if (held === undefined || String(row.report_date) >= String(held.report_date)) {
      byDay.set(day, row);
    }
  }
  return [...byDay.values()].sort((left, right) =>
    String(left.provider_date).localeCompare(String(right.provider_date)),
  );
}

/**
 * GA4's attribution families — the ones whose newest day reads wrong before
 * GA4 has finished processing it (Unassigned high, channel rows summing past
 * the day's total).
 */
const GA4_ATTRIBUTION_REPORTS = new Set([
  'traffic-acquisition',
  'traffic-sources',
  'landing-page-acquisition',
]);
/** Kept in step with `GA4_SETTLE_DAYS` in workers/ingest/src/google-signals.ts,
 * which applies the same rule to the site-level trend. */
const GA4_SETTLE_DAYS = 2;

/**
 * When each archived report day was last CONFIRMED by a collection, read from
 * the `manifest.json` both download lanes write beside the archives: one row
 * per (integration, report, report day), newest run winning — including an
 * `unchanged` run, which re-confirms the bytes without writing a new object.
 * That is why the archive's own `collectedAt` is not enough on its own: a day
 * GA4 answered identically at D+2 still carries its D+1 `collectedAt`. No
 * manifest (`null`, for a hand-assembled input) leaves only `collectedAt` to
 * go on.
 */
export function manifestConfirmations(manifest) {
  const confirmed = new Map();
  for (const row of array(record(manifest)?.objects)) {
    const entry = record(row);
    if (!entry || typeof entry.finishedAt !== 'string') continue;
    confirmed.set(reportDayKey(entry), entry.finishedAt);
  }
  return confirmed;
}

/**
 * `1` when this GA4 attribution archive was last confirmed fewer than
 * GA4_SETTLE_DAYS calendar days (UTC — the archive lane's own day arithmetic)
 * after its report day, `0` once it was, and `''` — unknown, never a guess —
 * when neither date can be read.
 */
function ga4ProvisionalFlag(archive, confirmations) {
  const reportDay = Date.parse(`${string(archive.reportDate)}T00:00:00.000Z`);
  const confirmedAt = [
    string(archive.collectedAt),
    confirmations.get(reportDayKey(archive)) ?? '',
  ]
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
  if (!Number.isFinite(reportDay) || confirmedAt === undefined) return '';
  const confirmedDay = Date.parse(`${confirmedAt.slice(0, 10)}T00:00:00.000Z`);
  return Math.round((confirmedDay - reportDay) / 86_400_000) < GA4_SETTLE_DAYS ? 1 : 0;
}

/** Families whose rows need resolving before they are written. Everything else
 * is written as collected. */
const FAMILY_RESOLVERS = new Map([
  ['bing-webmaster-ai-overview', newestExportPerDay],
  ['posthog-web-daily', newestPosthogDay],
]);

/** Every integration these rules can flatten. `parseArchive` refuses an archive
 * from anything else, so the analyzer stops before a single file is replaced. */
const FLATTENED_INTEGRATIONS = ['ga4', 'gsc', 'bing-webmaster', 'dataforseo', 'clarity', 'posthog'];

/**
 * `index-coverage.csv` — what a provider says it has indexed, as opposed to
 * what received impressions. `gsc-page.csv` and `bing-webmaster-pages.csv`
 * list pages that earned impressions, a strict subset of the indexed set, so
 * they cannot tell "we lost rankings" from "we lost the index".
 *
 * Derived, not collected: Bing Webmaster's `crawl-stats` carries `InIndex` and
 * `feeds` carries each sitemap's `UrlCount`, so this family costs no request.
 * Two grains in one file, because they are two different facts:
 *
 *   row_grain = 'site-day'  — one row per day Bing measured: pages in index,
 *     pages crawled, crawl errors, robots-blocked.
 *   row_grain = 'sitemap'   — one row per submitted sitemap, from the newest
 *     collection only: how many URLs we told Bing about, when it last fetched
 *     the file, and whether it parsed.
 *
 * No ratio is computed: the two grains carry different dates, and a single
 * "coverage %" would look exact while straddling them. It is Bing's answer: a
 * page absent here is unknown, never "not indexed", and an absent file means
 * the lane did not collect rather than an empty index.
 *
 * `families` maps each family's name to its resolved rows (`resolveFamily`);
 * only the INDEX_COVERAGE_SOURCES are read.
 */
export const INDEX_COVERAGE_FAMILY = 'index-coverage';

const CRAWL_STATS_FAMILY = 'bing-webmaster-crawl-stats';
const FEEDS_FAMILY = 'bing-webmaster-feeds';

/** The families index coverage is derived from, in the order its rows are. */
export const INDEX_COVERAGE_SOURCES = [CRAWL_STATS_FAMILY, FEEDS_FAMILY];

export function indexCoverageRows(families) {
  const provenance = (row) => ({
    asset: row.asset,
    report_date: row.report_date,
    collected_at: row.collected_at,
    data_state: row.data_state,
    provider_truncated: row.provider_truncated,
    provider: 'bing-webmaster',
  });

  // Bing rebuilds this series every day, so one measured day appears in every
  // collection since; those are revisions of that day. A row Bing dated
  // nothing cannot be placed on a day and is left out.
  const siteDays = newestExportPerDay(
    (families.get(CRAWL_STATS_FAMILY) ?? []).filter((row) =>
      string(row.provider_date),
    ),
  ).map((row) => ({
    ...provenance(row),
    row_grain: 'site-day',
    provider_date: row.provider_date,
    pages_in_index: scalar(row.in_index),
    pages_crawled: scalar(row.crawled_pages),
    crawl_errors: scalar(row.crawl_errors),
    blocked_by_robots_txt: scalar(row.blocked_by_robots_txt),
  }));

  // The sitemap side is a CURRENT snapshot with no measured day of its own, so
  // only the newest collection is carried: an older one describes a sitemap
  // state that no longer exists, and a series of them would read as growth.
  const feeds = families.get(FEEDS_FAMILY) ?? [];
  const newestFeeds = feeds.reduce(
    (latest, row) => (String(row.report_date) > latest ? String(row.report_date) : latest),
    '',
  );
  const sitemaps = feeds
    .filter((row) => String(row.report_date) === newestFeeds)
    .map((row) => ({
      ...provenance(row),
      row_grain: 'sitemap',
      sitemap_url: scalar(row.url),
      sitemap_type: scalar(row.type),
      urls_submitted: scalar(row.url_count),
      sitemap_status: scalar(row.status),
      sitemap_last_crawled: scalar(row.last_crawled),
    }));

  return [...siteDays, ...sitemaps];
}

function flattenBing(archive) {
  if (BING_AI_GRAINS.has(archive.report)) return flattenBingAiExport(archive);
  const output = [];
  for (const pageValue of array(archive.pages)) {
    const response = record(record(pageValue)?.response);
    for (const rowValue of array(response?.d)) {
      const row = record(rowValue);
      if (!row) continue;
      const flattened = baseRow(archive);
      for (const [providerField, providerValue] of Object.entries(row)) {
        if (providerField === '__type') continue;
        const field = bingFieldName(archive.report, providerField);
        if (providerField === 'Date') {
          flattened[field] = bingTimestamp(providerValue).slice(0, 10);
        } else if (
          providerField === 'LastCrawled' ||
          providerField === 'Submitted'
        ) {
          flattened[field] = bingTimestamp(providerValue);
        } else {
          flattened[field] = scalar(providerValue);
        }
      }
      if (archive.report === 'crawl-issues') {
        flattened.issue_names = decodeBingCrawlIssues(flattened.issues);
      }
      output.push(flattened);
    }
  }
  return output;
}

/**
 * Clarity answers one call with several metric blocks, each carrying its own
 * `information` rows for the same dimension split — and the blocks do not share
 * a schema (`Traffic` counts sessions and bots, `EngagementTime` reports
 * seconds, `ScrollDepth` a single average). Flattening long, one row per
 * (metric, dimension value), keeps every block's own fields intact instead of
 * forcing them into one wide shape that would invent nulls.
 *
 * `Traffic` legitimately carries `Url: null` for the unattributed aggregate.
 * That stays empty — an absence, never a URL of "".
 */
function flattenClarity(archive) {
  const output = [];
  for (const pageValue of array(archive.pages)) {
    for (const blockValue of array(record(pageValue)?.response)) {
      const block = record(blockValue);
      const metric = string(block?.metricName);
      if (!metric) continue;
      for (const rowValue of array(block?.information)) {
        const row = record(rowValue);
        if (!row) continue;
        const flattened = baseRow(archive);
        flattened.row_grain = 'metric-url';
        flattened.metric = metric;
        for (const [field, value] of Object.entries(row)) {
          flattened[clarityFieldName(field)] = scalar(value);
        }
        output.push(flattened);
      }
    }
  }
  return output;
}

/** Clarity capitalizes the dimension column it was asked for (`Url`); the
 * metric fields are already camelCase. Normalize to snake_case throughout so
 * the CSV reads like the other families. */
function clarityFieldName(field) {
  return field
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * The six PostHog families and the contract fields each row carries, renamed
 * to snake_case. The field list is explicit rather than discovered: a row sent
 * without a field must still produce that column empty, and an empty family
 * still gets its header (`posthogColumns`), so "PostHog answered with nothing"
 * and "nobody collected this family" stay two different files. The list is the
 * contract's (`posthog-families.mjs`), not a copy.
 */
export const POSTHOG_FAMILIES = new Map(
  CONTRACT_POSTHOG_FAMILIES.map((family) => [family, POSTHOG_FAMILY_ROWS[family]]),
);

/** The metadata every PostHog row carries beside its contract fields. */
const POSTHOG_META_COLUMNS = ['row_grain', 'window_start', 'window_end', 'project_time_zone', 'row_limit'];

/**
 * The contract body (or bodies) inside one archive.
 *
 * The collector stores the body as `pages[0].response` of the standard archive
 * envelope, so the envelope's `reportDate` is the window end and its
 * `providerTruncated` mirrors the body's `truncated`. A bare body at the top
 * level is accepted too, so a body written by hand for a fixture or a one-off
 * read flattens the same way. A page whose response carries no `rows` array is
 * not a PostHog answer and contributes nothing.
 */
function posthogBodies(archive) {
  const bodies = array(archive.pages)
    .map((page) => record(record(page)?.response))
    .filter((body) => body !== null && Array.isArray(body.rows));
  if (bodies.length > 0) return bodies;
  return Array.isArray(archive.rows) ? [archive] : [];
}

function flattenPosthog(archive) {
  const spec = POSTHOG_FAMILIES.get(archive.report);
  const output = [];
  for (const body of posthogBodies(archive)) {
    const window = record(body.window);
    for (const rowValue of array(body.rows)) {
      const row = record(rowValue);
      if (!row) continue;
      const flattened = baseRow(archive);
      // A family cut at its row limit is a top-N read, whichever of the two
      // places said so.
      flattened.provider_truncated =
        archive.providerTruncated === true || body.truncated === true;
      if (!flattened.collected_at) flattened.collected_at = string(body.collectedAt);
      flattened.row_grain = spec?.grain ?? 'row';
      flattened.window_start = string(window?.start);
      flattened.window_end = string(window?.end);
      flattened.project_time_zone = string(body.projectTimeZone);
      flattened.row_limit = scalar(body.rowLimit);
      const fields = spec?.fields ?? Object.keys(row);
      for (const field of fields) {
        // scalar(null) is '' — an unmeasured percentile stays UNKNOWN, never 0.
        flattened[clarityFieldName(field)] = scalar(row[field]);
      }
      output.push(flattened);
    }
  }
  return output;
}

/** Every column a PostHog family's rows carry — provenance first, the rest
 * sorted, the order the analyzer's CSV writes from a real row — so a family
 * PostHog answered with no rows still has its header. Null for a family the
 * contract does not name. */
export function posthogColumns(report) {
  const spec = POSTHOG_FAMILIES.get(report);
  if (!spec) return null;
  return [
    ...PROVENANCE_COLUMNS,
    ...[...POSTHOG_META_COLUMNS, ...spec.fields.map(clarityFieldName)].sort(),
  ];
}

/**
 * `posthog-web-daily` resolved to one row per `date`, newest archive winning.
 * Each daily run re-sends the trailing 28 days, so one day sits in up to 28
 * archives; those are revisions of the day (late events land, PostHog merges
 * persons), and keeping them all would draw the line 28 times over.
 */
export function newestPosthogDay(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = String(row.date ?? '');
    if (!day) continue;
    const held = byDay.get(day);
    if (held === undefined || String(row.report_date) >= String(held.report_date)) {
      byDay.set(day, row);
    }
  }
  return [...byDay.values()].sort((left, right) =>
    String(left.date).localeCompare(String(right.date)),
  );
}

function dataForSeoResult(archive) {
  const page = record(array(archive.pages)[0]);
  const response = record(page?.response);
  const task = record(array(response?.tasks)[0]);
  return {
    response,
    result: record(array(task?.result)[0]),
  };
}

function joinedKeys(value) {
  return array(value).map(string).filter(Boolean).join('|');
}

function copyScalarFields(target, source, fields) {
  for (const field of fields) target[field] = scalar(source?.[field]);
}

function hostOf(value) {
  const raw = string(value).trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
      .replace(/^www\./i, '')
      .toLowerCase();
  } catch {
    return raw.replace(/^www\./i, '').split('/')[0].toLowerCase();
  }
}

function serpItemDomain(item) {
  return hostOf(item?.domain) || hostOf(item?.url);
}

/**
 * Does our result carry sitelinks, in three states:
 *
 *   `true`  — our organic item carries a sitelink block.
 *   `false` — our organic item was read and carried none (an observation).
 *   `''`    — we hold no result inside the tracked depth, so there was no
 *     result of ours for sitelinks to hang off. Unknown, never "no sitelinks":
 *     otherwise every week the property ranked outside the depth would read
 *     as the week its sitelinks vanished.
 *
 * `links` is DataForSEO's own field for the block; an absent or empty one on a
 * parsed item is the documented shape of a result without sitelinks.
 */
function serpItemSitelinks(item) {
  return array(record(item)?.links).some((link) => record(link) !== null);
}

/**
 * What else is on the result page, in the provider's own item-type vocabulary
 * — `people_also_ask|video|images`, pipe-joined and sorted. Both halves of the
 * response are read, as `aiOverviewState` does: `item_types` is the provider's
 * declaration and the items are what came back; either alone would
 * undercount. `organic` is dropped — this family measures the organic list in
 * its own columns, and a token present in every row is a constant, not a
 * feature. The column shares its name with the ranked-keyword family's
 * `serp_features` because it shares that vocabulary, not because the two can
 * be joined. Empty on a row that carries a result is an observation; empty on
 * a billed-but-unanswered row is unknown, and `provider_status` tells the two
 * apart.
 */
function serpPageFeatures(result) {
  const declared = array(result?.item_types).map(string);
  const observed = array(result?.items).map((item) => string(record(item)?.type));
  return [...new Set([...declared, ...observed])]
    .filter((type) => type && type !== 'organic')
    .sort()
    .join('|');
}

/** Our property, or anything under it. A subdomain result is still this
 * property holding the position. */
function isOurDomain(domain, ours) {
  return Boolean(domain) && (domain === ours || domain.endsWith(`.${ours}`));
}

/**
 * The AI Overview block, resolved to three states rather than two.
 *
 * `present: true`  — an overview is on the page and we could read it.
 * `present: false` — the result page parsed and carries no overview at all.
 * `present: null`  — UNKNOWN, and never to be read as `false`: the asynchronous
 *   overview load did not deliver content, so Google may well have served one we
 *   cannot see. The panel's whole purpose is the zero-click read, and a failed
 *   load that recorded `false` would send an operator to rewrite a title on a
 *   query whose click is already consumed.
 *
 * `citesUs` follows the same discipline: `false` only where a readable overview
 * listed sources and ours was not among them; `null` where there was nothing to
 * read. A page with no overview cites nobody, so that case is an honest `false`.
 */
function aiOverviewState(result, ourDomain) {
  const items = array(result?.items);
  const overview = items.find((item) => string(record(item)?.type) === 'ai_overview');
  const declared = array(result?.item_types).map(string).includes('ai_overview');
  if (!overview) {
    // The provider named the feature but returned no block to inspect: it fires,
    // and its sources are unknown.
    if (declared) return { present: true, citesUs: null };
    return { present: false, citesUs: false };
  }
  const block = record(overview);
  const references = array(block?.references);
  const nested = array(block?.items);
  const links = nested.flatMap((element) => array(record(element)?.links));
  const sources = [...references, ...nested, ...links]
    .map((source) => serpItemDomain(record(source)))
    .filter(Boolean);
  if (sources.length === 0) {
    // An overview element with no readable content is the documented shape of an
    // asynchronous load that did not complete.
    const loaded = nested.length > 0 || string(block?.text).length > 0;
    return { present: loaded ? true : null, citesUs: null };
  }
  return {
    present: true,
    citesUs: sources.some((domain) => isOurDomain(domain, ourDomain)),
  };
}

/**
 * The device this result page was read on, taken from the archived request
 * (`device` is a documented field of the live/advanced SERP task), with the
 * provider's own echo (`tasks[].data.device`) as the fallback. A page carrying
 * neither is backfilled as desktop: a collector that could only ask for one
 * device made the device structurally true — unlike a missing cluster label,
 * which was never sent and stays empty.
 */
function serpPageDevice(request, task) {
  return (
    string(request?.device) ||
    string(record(task?.data)?.device) ||
    'desktop'
  );
}

/** One row per tracked query PER DEVICE, whether or not the provider could
 * answer it. Two devices are two observations of two different result pages;
 * they share a query and nothing else, and the three-state AI Overview
 * discipline below applies to each independently — an overview that fires on
 * the phone and not on the desktop is the finding, not a contradiction. */
function flattenSerpPanel(archive) {
  const ourDomain = hostOf(archive.propertyRef || archive.asset);
  return array(archive.pages).flatMap((pageValue) => {
    const page = record(pageValue);
    const envelope = record(page?.request);
    const request = record(envelope?.body);
    const response = record(page?.response);
    const task = record(array(response?.tasks)[0]);
    const result = record(array(task?.result)[0]);
    // The cluster this query measured, as the collection recorded it. This
    // never opens config: reading today's config over yesterday's archive would
    // relabel history the day a cluster is renamed.
    const label = string(envelope?.label).trim();
    const base = {
      ...baseRow(archive),
      provider_cost_usd: scalar(response?.cost),
      provider_attempts: scalar(envelope?.attempts),
      row_grain: 'tracked-query-device',
      query: string(result?.keyword) || string(request?.keyword),
      // The two archived dimensions and the opposite calls about a page that
      // carries neither: `device` is backfilled `desktop` because it was
      // structurally true; a label is left out because one was never sent, so
      // a panel that starts labelling leaves its earlier rows empty.
      device: serpPageDevice(request, task),
      ...(label ? { query_label: label } : {}),
      tracked_depth: scalar(request?.depth),
    };
    if (!result) {
      // Billed, unanswered. Every observation stays unknown rather than
      // collapsing to a zero the analysis would read as a fact.
      return [
        {
          ...base,
          best_rank: '',
          best_url: '',
          second_rank: '',
          second_url: '',
          aio_present: '',
          aio_cites_us: '',
          sitelinks_us: '',
          serp_features: '',
          top3_domains: '',
          organic_results: '',
          provider_status:
            string(task?.status_message) || 'Provider returned no result.',
        },
      ];
    }
    const organic = array(result.items)
      .map(record)
      .filter((item) => string(item?.type) === 'organic')
      .sort(
        (left, right) =>
          (Number(left?.rank_group) || Infinity) -
          (Number(right?.rank_group) || Infinity),
      );
    const ourResults = organic.filter((item) =>
      isOurDomain(serpItemDomain(item), ourDomain),
    );
    const [ours, second] = ourResults;
    const aio = aiOverviewState(result, ourDomain);
    return [
      {
        ...base,
        // Empty means "no result inside the tracked depth", never "not ranking".
        best_rank: ours ? scalar(ours.rank_group) : '',
        best_url: ours ? scalar(ours.url) : '',
        // Our second slot on the same page, bounded like the first: empty is
        // "no second result of ours inside the tracked depth". Two of the
        // property's URLs on one result page is a double listing or
        // cannibalization, which the GSC families cannot show; the URL travels
        // with it because a rank nobody can attribute to a page is a fact with
        // no next step.
        second_rank: second ? scalar(second.rank_group) : '',
        second_url: second ? scalar(second.url) : '',
        aio_present: aio.present === null ? '' : aio.present,
        aio_cites_us: aio.citesUs === null ? '' : aio.citesUs,
        sitelinks_us: ours ? serpItemSitelinks(ours) : '',
        serp_features: serpPageFeatures(result),
        top3_domains: organic.slice(0, 3).map(serpItemDomain).filter(Boolean).join('|'),
        organic_results: organic.length,
        provider_status: '',
      },
    ];
  });
}

function flattenDataForSeo(archive) {
  // The panel is the one family whose archive holds many result pages: one
  // provider call per (tracked query, device), all under a single manifest row.
  if (archive.report === 'serp-panel') return flattenSerpPanel(archive);

  const { response, result } = dataForSeoResult(archive);
  if (!result) return [];
  const providerCost = scalar(response?.cost);

  if (archive.report === 'ranked-keywords') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      const keywordData = record(item?.keyword_data);
      const keywordInfo = record(keywordData?.keyword_info);
      const properties = record(keywordData?.keyword_properties);
      const serpInfo = record(keywordData?.serp_info);
      const intent = record(keywordData?.search_intent_info);
      const serpItem = record(record(item?.ranked_serp_element)?.serp_item);
      if (!keywordData || !serpItem) return [];
      const rankChanges = record(serpItem.rank_changes);
      const backlinks = record(serpItem.backlinks_info);
      return [
        {
          ...baseRow(archive),
          provider_cost_usd: providerCost,
          row_grain: 'keyword-ranking',
          keyword: scalar(keywordData.keyword),
          search_volume: scalar(keywordInfo?.search_volume),
          cpc: scalar(keywordInfo?.cpc),
          competition_level: scalar(keywordInfo?.competition_level),
          keyword_difficulty: scalar(properties?.keyword_difficulty),
          intent: scalar(intent?.main_intent),
          serp_features: joinedKeys(serpInfo?.serp_item_types),
          result_type: scalar(serpItem.type),
          rank_group: scalar(serpItem.rank_group),
          rank_absolute: scalar(serpItem.rank_absolute),
          title: scalar(serpItem.title),
          url: scalar(serpItem.url),
          relative_url: scalar(serpItem.relative_url),
          etv: scalar(serpItem.etv),
          estimated_paid_traffic_cost: scalar(
            serpItem.estimated_paid_traffic_cost,
          ),
          previous_rank_absolute: scalar(
            rankChanges?.previous_rank_absolute,
          ),
          is_new: scalar(rankChanges?.is_new),
          is_up: scalar(rankChanges?.is_up),
          is_down: scalar(rankChanges?.is_down),
          backlinks: scalar(backlinks?.backlinks),
          referring_domains: scalar(backlinks?.referring_domains),
        },
      ];
    });
  }

  if (archive.report === 'backlinks-summary') {
    const flattened = {
      ...baseRow(archive),
      provider_cost_usd: providerCost,
      row_grain: 'domain-summary',
    };
    copyScalarFields(flattened, result, [
      'target',
      'first_seen',
      'lost_date',
      'rank',
      'backlinks',
      'backlinks_spam_score',
      'crawled_pages',
      'internal_links_count',
      'external_links_count',
      'broken_backlinks',
      'broken_pages',
      'referring_domains',
      'referring_domains_nofollow',
      'referring_main_domains',
      'referring_main_domains_nofollow',
      'referring_ips',
      'referring_subnets',
      'referring_pages',
    ]);
    return [flattened];
  }

  if (archive.report === 'keyword-ideas') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      const keywordInfo = record(item?.keyword_info);
      const properties = record(item?.keyword_properties);
      const intent = record(record(item?.search_intent_info)?.main_intent);
      if (!item) return [];
      return [
        {
          ...baseRow(archive),
          provider_cost_usd: providerCost,
          row_grain: 'keyword-idea',
          keyword: scalar(item.keyword),
          search_volume: scalar(keywordInfo?.search_volume),
          cpc: scalar(keywordInfo?.cpc),
          competition_level: scalar(keywordInfo?.competition_level),
          keyword_difficulty: scalar(properties?.keyword_difficulty),
          // `main_intent` is a bare string on some shapes and an object on
          // others; scalar() on a record yields '', which reads as "the
          // provider did not say" rather than as a wrong intent.
          main_intent:
            scalar(record(item.search_intent_info)?.main_intent) ||
            scalar(intent),
        },
      ];
    });
  }

  if (archive.report === 'serp-competitors') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      const metrics = record(record(item?.metrics)?.organic);
      if (!item) return [];
      return [
        {
          ...baseRow(archive),
          provider_cost_usd: providerCost,
          row_grain: 'serp-competitor',
          competitor_domain: scalar(item.domain),
          // How many of OUR keywords this domain also ranks for — the number
          // that makes it a competitor rather than merely a large site.
          intersections: scalar(item.intersections),
          avg_position: scalar(item.avg_position),
          sum_position: scalar(item.sum_position),
          // The INTERSECTING keyword count, which equals `intersections` — kept
          // because it is what the provider says about the overlap itself.
          competitor_keywords: scalar(metrics?.count),
          // The competitor's whole organic footprint, the denominator that
          // makes overlap share mean anything. Read from `full_domain_metrics`
          // rather than `metrics`, whose counts are scoped to the intersection
          // and therefore equal `intersections`.
          competitor_total_keywords: scalar(
            record(record(item?.full_domain_metrics)?.organic)?.count,
          ),
          competitor_etv: scalar(metrics?.etv),
          competitor_pos_1: scalar(metrics?.pos_1),
          competitor_pos_2_3: scalar(metrics?.pos_2_3),
        },
      ];
    });
  }

  if (archive.report === 'backlinks-referring-domains') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      if (!item) return [];
      const flattened = {
        ...baseRow(archive),
        provider_cost_usd: providerCost,
        row_grain: 'referring-domain',
      };
      copyScalarFields(flattened, item, [
        'domain',
        'rank',
        'backlinks',
        'first_seen',
        'lost_date',
        'backlinks_spam_score',
        'broken_backlinks',
        'broken_pages',
        'referring_domains',
        'referring_pages',
        'referring_ips',
        'referring_subnets',
      ]);
      return [flattened];
    });
  }

  if (archive.report === 'backlinks-anchors') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      if (!item) return [];
      const flattened = {
        ...baseRow(archive),
        provider_cost_usd: providerCost,
        row_grain: 'anchor',
      };
      copyScalarFields(flattened, item, [
        'anchor',
        'rank',
        'backlinks',
        'first_seen',
        'lost_date',
        'backlinks_spam_score',
        'broken_backlinks',
        'broken_pages',
        'referring_domains',
        'referring_domains_nofollow',
        'referring_main_domains',
        'referring_pages',
      ]);
      return [flattened];
    });
  }

  if (archive.report === 'backlinks-new-lost') {
    return array(result.items).flatMap((itemValue) => {
      const item = record(itemValue);
      if (!item) return [];
      const flattened = {
        ...baseRow(archive),
        provider_cost_usd: providerCost,
        row_grain: 'backlink-period',
        provider_date: string(item.date).slice(0, 10),
      };
      copyScalarFields(flattened, item, [
        'new_backlinks',
        'lost_backlinks',
        'new_referring_domains',
        'lost_referring_domains',
        'new_referring_main_domains',
        'lost_referring_main_domains',
      ]);
      return [flattened];
    });
  }

  if (archive.report.startsWith('llm-mentions-')) {
    const metrics = record(result.aggregated_metrics);
    const platform = record(array(metrics?.platform)[0]);
    const summary = {
      ...baseRow(archive),
      provider_cost_usd: providerCost,
      row_grain: 'platform-summary',
      platform: scalar(platform?.key),
      mentions: scalar(platform?.mentions),
      ai_search_volume: scalar(platform?.ai_search_volume),
      source_domain: '',
    };
    const sources = array(metrics?.sources_domain).flatMap((sourceValue) => {
      const source = record(sourceValue);
      if (!source) return [];
      return [
        {
          ...baseRow(archive),
          provider_cost_usd: providerCost,
          row_grain: 'source-domain',
          platform: scalar(platform?.key),
          mentions: scalar(source.mentions),
          ai_search_volume: scalar(source.ai_search_volume),
          source_domain: scalar(source.key),
        },
      ];
    });
    return [summary, ...sources];
  }

  return [];
}

function bingFieldName(report, providerField) {
  if (providerField === 'Date') return 'provider_date';
  if (providerField === 'Query') {
    return report === 'pages' ? 'page' : 'query';
  }
  return providerField
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function bingTimestamp(value) {
  if (typeof value === 'string') {
    const legacy = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
    if (legacy) {
      const time = Number(legacy[1]);
      if (Number.isFinite(time)) return new Date(time).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return '';
}

function decodeBingCrawlIssues(value) {
  const mask = Number(value);
  if (!Number.isInteger(mask) || mask <= 0) return '';
  return BING_CRAWL_ISSUES
    .filter(([bit]) => (mask & bit) !== 0)
    .map(([, name]) => name)
    .join('|');
}

function baseRow(archive) {
  return {
    asset: string(archive.asset),
    report_date: string(archive.reportDate),
    collected_at: string(archive.collectedAt),
    data_state: string(archive.dataState),
    provider_truncated: archive.providerTruncated === true,
  };
}
