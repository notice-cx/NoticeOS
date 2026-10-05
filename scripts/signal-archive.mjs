// ONE READING OF THE PROVIDER ARCHIVE (bead ro-ujb9.67.1).
//
// A signal archive is one provider answer as a collector stored it: an envelope
// (`schemaVersion`, `asset`, `integration`, `report`, `reportDate`,
// `collectedAt`, `dataState`, `providerRows`, `providerTruncated`) around the
// provider's own pages. This module is the one place that says what an archive
// means as rows, and which of several rows about one day is kept. The
// analytical-file writer (scripts/signal-history.mjs) stores those rows;
// scripts/signal-history-analyze.mjs reads a pinned generation for the panel
// CSVs and rules, so a report and its history share one normalization.
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
// READING ORDER IS PART OF THE RULES. Archives are read in path order — in the
// downloads layout, `<integration>/<report>/<reportDate>.json`, that is
// report-date order within a family — and rows in the order an archive holds
// them. `resolveFamily` sorts a family by `report_date` (`compareReportDates`),
// keeping that order among equal dates, and a revision rule keeps the LAST row
// it meets for a day. So of two rows about one day the newer report's wins, and
// of two with the same report date the one read later. A reader that gathers
// rows another way must hand them over in this order, or it will resolve ties
// differently.
//
// Every row of one archive carries that archive's report date. So a family that
// does not resolve across report days reads the same one report day at a time:
// its rows are each report day's rows, report days in `compareReportDates`
// order. That is what lets the analytical-file writer rewrite one period of a
// family without reading the rest of it.
//
// Nothing here reads a file, the clock or the settings: every input is an
// argument, so one archive always reads the same way.
//
// Family by family, each named as the analyzer's CSV of it:

// `dataforseo-serp-panel.csv` is one row per (tracked query, `device`) since
// ro-o1n: the same term is read on a phone and on a desktop, because a phone
// result page is not a narrower desktop one — an AI Overview can consume the
// click on one surface and not the other, and that difference IS the finding.
// Never sum or average across `device`; filter to one first. Rows archived
// before 2026-08-04 read `desktop` because the collector could not have sent
// anything else (see `serpPageDevice`).
//
// Two of its columns carry three states, and the third one is the point of the
// family — per device, so a query can be walled on mobile and clear on desktop:
//
//   aio_present / aio_cites_us = true | false | (empty)
//
// Empty is UNKNOWN, and is never to be read as `false`. It means the tracked
// query's asynchronous AI Overview did not load, or the provider could not
// answer the query at all — so Google may well have served an overview we
// cannot see. `false` is a positive observation: the result page parsed and
// carried no overview (or a readable overview that did not cite this property).
// A tracked query recorded as unknown must be treated exactly like a query
// nobody tracked, because the decision it feeds — do not spend copy budget on a
// query whose click is consumed inline — is only safe on evidence.
//
// `best_rank` is bounded the same way: empty means "no result inside the tracked
// depth this panel pays for", never "does not rank". `second_rank` carries the
// same bound for the property's second slot, and `sitelinks_us` a third state
// of its own: empty because there was no result of ours to carry them, never
// `false` (see `serpItemSitelinks`).
//
// WHAT EARNS A COLUMN HERE, and what stays in the archive (`ro-463`). The panel
// archives each result page verbatim, so every field below was already bought
// and stored; flattening is a choice about what a RULE can act on, not about
// what exists. A column earns its place when a rule or a decision surface can
// read it without opening the archive:
//
//   * `best_rank`/`best_url`, `second_rank`/`second_url` — where the property
//     stands, and whether it stands twice.
//   * `aio_present`/`aio_cites_us` — whether the click is consumed inline, the
//     fact the panel was bought for.
//   * `sitelinks_us` — a brand query's sitelink block appearing or disappearing
//     is a lifecycle event with no other observer in this store.
//   * `serp_features`, `top3_domains`, `organic_results` — the shape of the page
//     and who else is on it, which is what "did the neighborhood change" means.
//
// What deliberately stays archived: the AI Overview's full text and complete
// citation list (variable-length prose; the decision needs "does it cite us",
// and reading the rest is a research pass over the archive), every result's
// title and snippet (copy work reads the LIVE page — a stale snippet in a CSV is
// a rewrite of last week's SERP), the question text inside `people_also_ask`
// and `related_searches` (a rule can act on the block's presence, which
// `serp_features` carries; its contents are a reading task), and paid blocks
// (this family pays for organic depth and says nothing about auctions). Each of
// those is one `jq` away in the immutable archive, which is the right cost for
// something no rule reads.
//
// `query_label` — the cluster a tracked query belongs to, the bet it measures —
// appears only when the ARCHIVE carries it, because it is stored with the
// observation rather than looked up. So an empty cell means the collection
// predates that panel's labels (or that query has none), never "unclustered",
// and renaming a cluster in config/serp-panel.json changes the collections that
// follow it, never the ones already archived. The column is absent entirely from
// a property that has never labelled a panel.
//
// `ga4-js-errors.csv` keeps the same discipline in a different shape. Two
// unrelated facts both present as "no rows":
//
//   * the property threw no JavaScript errors in the window — a real zero, and
//   * GA4 has no custom dimension registered for the `message`/`source` event
//     parameters, so the family could not be queried at all.
//
// They are separated on the MANIFEST, not here: the second case is a
// `ga4_custom_dimension_unregistered` run that archives nothing, so the family
// is simply absent from this directory. A missing or empty `ga4-js-errors.csv`
// therefore reads as UNKNOWN unless the manifest shows a successful run — never
// as "no JavaScript errors". GA4 backfills nothing before registration either,
// so dates before the operator registered the parameters stay unknown forever.
//
// Inside the CSV, a `message`/`source` of `(not set)` is GA4's own token for an
// event that carried no such parameter — also an absence, not an empty string.
// `message_bucket` masks the volatile parts of a message (URLs, ids, numbers)
// so recurring errors group into countable buckets; it preserves `(not set)`
// rather than folding those rows in with real messages.

// `index-coverage.csv` is the one file here that no collector produced: it is
// DERIVED from the Bing crawl-stats and feeds families, which already carry
// Bing's own count of this site's indexed pages and the URL counts of the
// sitemaps we submitted. It answers "how many of our pages are indexed" — which
// `gsc-page.csv` cannot, because that lists pages that earned IMPRESSIONS, a
// strict subset of the indexed set. It is Bing's answer, it is site-level, and
// so it says nothing about whether any individual URL is indexed. See
// `indexCoverageRows` for the two grains and why no ratio is computed.

// The `bing-webmaster-ai-*` families are the one set of rows here that no cron
// bought. They are an operator-downloaded Bing AI Performance export
// (`pnpm bing-ai:import <file>`, bead ro-2dn), so `report_date` is the day the
// FILE was exported rather than a day Bing measured — only `ai-overview`
// carries a measured day, in `provider_date`. Two exports that overlap a day
// are revisions of that day, resolved to the newest export before anything
// reads them; the query and page families are period totals whose period the
// export does not state. An absent family means nobody has dropped that export
// yet, which is the strongest form of "absent is not zero" in this directory:
// the lane has no cron to notice its own silence.

// The `posthog-*` families (bead ro-ghis.2) are PRODUCT data — what people do
// once they arrive — and every one of them is a window AGGREGATE, not a day:
// PostHog answers one server-side query per family over a trailing window
// (`window_start`–`window_end`, inclusive, in the PostHog project's own
// timezone) and the collector archives the answer under the window's end. So
// consecutive daily archives overlap almost completely, and a `people` figure is
// PostHog's unique-person count over ITS row's window: it never adds across
// rows, days or report dates. Read one `report_date` at a time. The one daily
// family, `posthog-web-daily`, is resolved newest-archive-wins per `date`,
// because each run re-sends the whole trailing 28 days and a repeated day is a
// revision (the rule `newestExportPerDay` already applies to Bing). An empty
// family is PostHog answering with no rows for that window; a missing one is a
// family nobody collected — never "no errors" or "no rage clicks".

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
 * the API — Bing's AI Performance report, which exists only in the dashboard
 * and its Export button (docs/11 §"Bing AI Performance boundary", bead ro-2dn).
 *
 * They share the `bing-webmaster` integration because that is what they are:
 * the same account, the same verified site. The report name is what tells them
 * apart, and `workers/ingest/src/bing-ai-exports.ts` is the parser whose rows
 * these read — this side never sees the CSV, only the parse the archive kept.
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
 * Resolve an overlapping day to the newest export.
 *
 * The daily AI-citation series is re-exported whole every time the operator
 * downloads it, so two exports a month apart both carry the days between them.
 * Those are REVISIONS of one day, never two days — the same rule Bing's
 * weekly query/page snapshots already follow — so keeping both would double
 * every overlapping day's citations. Newest export wins, because a later
 * download is Microsoft's later word on the same day.
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
 * GA4's attribution families (bead ro-wo0j) — the ones whose newest day reads
 * wrong before GA4 has finished processing it. One site's 2026-09-21,
 * collected at D+1, carried 3,380 "Unassigned" sessions (101–340 on every other
 * September day) and channel rows that summed to 7,460 against the day's 4,822;
 * every day collected at D+2 or later read correctly.
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
 * `index-coverage.csv` — what a provider says it has INDEXED, as opposed to what
 * received impressions (`ro-2zk.1`).
 *
 * Nothing else in this directory answers "how many of our pages are indexed".
 * `gsc-page.csv` and `bing-webmaster-pages.csv` list pages that earned
 * impressions, which is a strict subset of the indexed set and silent about a
 * page that is indexed and invisible — so a property triaging a traffic drop
 * cannot tell "we lost rankings" from "we lost the index", two different
 * emergencies with two different fixes.
 *
 * DERIVED, NOT COLLECTED, and that is the whole design. Bing Webmaster's
 * `crawl-stats` family already carries `InIndex` — Bing's own count of this
 * site's pages in its index, one figure per measured day — and `feeds` already
 * carries each sitemap's `UrlCount`. Both are archived daily and nothing
 * promotes them. So this family costs no request, no quota and no new
 * credential: it is a view over bytes the Monday and nightly lanes already
 * bought. (Google has no Index Coverage API at all; its per-URL Inspection
 * endpoint is a separate quota-budgeted lane, deliberately not built here.)
 *
 * TWO GRAINS IN ONE FILE, because they are two different facts:
 *
 *   row_grain = 'site-day'  — one row per day Bing measured: pages in index,
 *     pages crawled, crawl errors, robots-blocked. This is the series to read
 *     for "is the index growing or collapsing".
 *   row_grain = 'sitemap'   — one row per submitted sitemap, from the NEWEST
 *     collection only: how many URLs we told Bing about, when it last fetched
 *     the file, and whether it parsed. This is the denominator.
 *
 * No ratio is computed. The two grains carry different dates — the index count
 * is a measured day, the sitemap count is "as of the last collection" — and a
 * single "coverage %" would give a number that looks exact to a reader who
 * cannot see that it straddles them.
 *
 * IT IS BING'S ANSWER, NOT GOOGLE'S. A page absent here is UNKNOWN, never "not
 * indexed": Bing and Google index different things, this family is site-level so
 * it says nothing about any individual URL, and an absent file means the lane
 * did not collect (unverified site, failed family) rather than an empty index.
 *
 * `families` maps each family's name to its resolved rows (`resolveFamily`);
 * only the INDEX_COVERAGE_SOURCES are read, each row from one of them.
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
  // collection since. Those are REVISIONS of that day — the same rule the AI
  // overview export follows — and keeping them all would draw the index curve
  // seven times over. A row Bing dated nothing cannot be placed on a day at all
  // and is left out rather than piled onto an empty one.
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
 * The six PostHog families and the contract fields each row carries (the shared
 * archive contract, ro-ghis.1 ↔ ro-ghis.2). One CSV row per contract row, the
 * fields renamed to snake_case the way every other family here reads.
 *
 * The field list is EXPLICIT rather than discovered, for two reasons. A row the
 * collector sent without a field (a web-vitals segment with no INP measurement
 * arrives as `inpP75: null`) must still produce that column EMPTY — unknown —
 * rather than a file whose header depends on which rows happened to arrive. And
 * an empty family still gets its header (`posthogColumns`), so "PostHog answered
 * with nothing" and "nobody collected this family" stay two different files.
 *
 * It is the CONTRACT's list, not a copy (bead ro-ghis.4): the generated
 * `posthog-families.mjs` is the same definition the collector's zod row schemas
 * are checked against, so a field added there lands in this CSV the same day.
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
 * Does OUR result carry sitelinks — and the third state that makes the column
 * safe (`ro-463`).
 *
 *   `true`  — our organic item carries a sitelink block.
 *   `false` — our organic item was read and carried none. An OBSERVATION: the
 *     sitelink block rides inside the item, so an item we could parse is an item
 *     whose sitelinks we could parse.
 *   `''`    — we hold NO result inside the tracked depth, so there was no result
 *     of ours for sitelinks to hang off. UNKNOWN, never "no sitelinks". The rule
 *     waiting on this column — sitelinks appearing or disappearing on a brand
 *     query (`ro-770`) — would otherwise read every week the property ranked
 *     outside depth 20 as the week its sitelinks vanished, which is an alert
 *     about the panel's depth wearing a ranking's clothes.
 *
 * `links` is DataForSEO's own field for the block; an absent or empty one on a
 * parsed item is the documented shape of a result without sitelinks.
 */
function serpItemSitelinks(item) {
  return array(record(item)?.links).some((link) => record(link) !== null);
}

/**
 * What ELSE is on the result page, in the provider's own item-type vocabulary
 * (`ro-463`) — `people_also_ask|video|images`, pipe-joined and sorted.
 *
 * Both halves of the response are read, for the reason `aiOverviewState` reads
 * both: `item_types` is the provider's declaration of what the page held, and
 * the items are what came back. A feature the provider NAMED but did not return
 * a block for was still on the page, and a block that arrived unnamed was still
 * on the page — either alone would undercount.
 *
 * `organic` is dropped: this family measures the organic list in columns of its
 * own (`organic_results`, `top3_domains`, `best_rank`), and a token present in
 * every row of every panel ever collected is not a feature, it is a constant.
 * The column shares its name with the ranked-keyword family's `serp_features`
 * because it shares that vocabulary, NOT because the two can be joined: those
 * rows are a weekly ranking inventory at keyword grain, these are result pages
 * at (query, device) grain, read at a different moment.
 *
 * Empty on a row that carries a result is an OBSERVATION — nothing but organic
 * results on that page. Empty on a billed-but-unanswered row is unknown, the
 * same way every other column on that row is, and `provider_status` is what
 * tells the two apart.
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
 * The device this result page was read on.
 *
 * It is taken from the archived REQUEST — `device` is a documented field of the
 * live/advanced SERP task, so it rides inside the stored request body of every
 * page the collector has ever written and needs no manifest column to survive
 * (`ro-o1n`). The provider's own echo (`tasks[].data.device`) is the fallback
 * for an archive assembled some other way.
 *
 * A page carrying neither is backfilled as **desktop**, and that is a different
 * decision from the one taken for the panel's missing cluster labels. Device was
 * structurally true, not merely likely: from the family's first collection until
 * 2026-08-04 the collector had exactly one `device` literal in it, so no archive
 * in the store can be anything else. Leaving those rows empty would make every
 * pre-mobile week read as *unknown device*, which is the one thing it certainly
 * is not — and would break every device-vs-device comparison across the cutover
 * for no gain. A label, by contrast, was never sent, so inventing one would be
 * inventing evidence.
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
    // The cluster this query measured, as the COLLECTION recorded it. This tool
    // never opens config/serp-panel.json, and that is the point: reading today's
    // config over yesterday's archive would silently relabel history the day a
    // cluster is renamed. A rename therefore applies from the next collection
    // forward, and old rows keep the bet they were actually placed on.
    const label = string(envelope?.label).trim();
    const base = {
      ...baseRow(archive),
      provider_cost_usd: scalar(response?.cost),
      provider_attempts: scalar(envelope?.attempts),
      row_grain: 'tracked-query-device',
      query: string(result?.keyword) || string(request?.keyword),
      // The two archived dimensions, and the two OPPOSITE calls about a page
      // that carries neither. `device` is backfilled `desktop` because it was
      // structurally true — the collector had one literal in it until
      // 2026-08-04, so no stored archive can be anything else. A label is left
      // out entirely, because a label was never SENT: inventing one would
      // invent evidence, and a panel that starts labelling must leave its
      // earlier rows honestly empty rather than backfilled with a bet nobody
      // had placed yet. A panel that never labelled anything flattens to
      // exactly the columns it always had, plus `device`.
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
        // Our SECOND slot on the same page, bounded exactly like the first
        // (`ro-463`). Empty is "no second result of ours inside the tracked
        // depth" — the page held one of ours, or none. It earns its column
        // because it answers a question GSC cannot: two of the property's URLs
        // sharing one result page is either a double listing worth defending or
        // the cannibalization the impression-harvest playbook consolidates, and
        // the flattened GSC families can only show impressions split across
        // pages, never which page Google actually placed where. The URL travels
        // with it for the same reason `best_url` travels with `best_rank`: a
        // rank nobody can attribute to a page is a fact with no next step.
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
  // provider call per (tracked query, device) since ro-o1n, all under a single
  // manifest row.
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
          // The competitor's WHOLE organic footprint, which is the denominator
          // that makes overlap share mean anything: facebook.com intersects us
          // on 3,036 keywords out of 115,332,098 it ranks for. Read from
          // `full_domain_metrics` rather than `metrics`, whose counts are all
          // scoped to the intersection and therefore equal `intersections`.
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
