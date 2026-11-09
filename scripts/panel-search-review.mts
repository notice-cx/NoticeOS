/** The bounded first read for a weekly search review. Every input belongs to
 * one published version. Daily totals, top rows and revisions stay separate. */
import { PanelReadError, type PanelRef, type PanelTableInfo, type createPanelStore } from './panel-store.mjs';
import { PanelQueryError, queryPanel } from './panel-query.mjs';

const DAY = 86_400_000;
const DAYS = 7;
const MOVEMENTS = 5;
const SERP_ROWS = 200;
const TABLES_PER_QUERY = 2;
const BING_REPORTS = ['bing_webmaster_pages', 'bing_webmaster_queries', 'bing_webmaster_ai_overview',
  'bing_webmaster_ai_pages', 'bing_webmaster_ai_queries'] as const;

type Json = Record<string, unknown>;
type Store = ReturnType<typeof createPanelStore>;
type Day = { day: string; provisional?: boolean | null; truncated?: boolean | null; [key: string]: unknown };
type Daily = { reportDate?: string; measuredThrough?: string; days: Day[]; };
type Movement = { subject: string; priorClicks: number; currentClicks: number };
type Detail = Daily & { movements: Movement[] };
type TrackedRow = { query: string; device: string; answered: boolean | null; trackedDepth: number | null };
type Tracked = { reportDate: string | null; rows: TrackedRow[]; totalRows: number };
type Pair = { query: string; device: string };
type Source = { table: PanelTableInfo; section: string; sql: string };

/** Read optional archived metadata as an object. Arrays and older missing values are absent. */
const record = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

/** Require a real calendar date before using it in a SQL date literal. */
function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const shiftDay = (day: string, offset: number) => new Date(Date.parse(day) + offset * DAY).toISOString().slice(0, 10);
/** Report lag in whole days only when both dates are known. */
const lag = (newer: string | null | undefined, older: string | null | undefined) =>
  newer && older ? (Date.parse(newer) - Date.parse(older)) / DAY : null;
const date = (column: string) => `TRY_CAST(${column} AS DATE)`;
const count = (column: string) => `TRY_CAST(${column} AS BIGINT)`;
/** A flag missing from an older snapshot stays unknown. */
const flag = (table: PanelTableInfo, column: string) => table.columns.includes(column) ? `TRY_CAST(${column} AS BOOLEAN)` : 'NULL';
const payload = (name: string, sql: string) => `SELECT '${name}' AS section, CAST(result AS VARCHAR) AS payload FROM (${sql})`;

/** Use property totals only for dates with one click row and one impression row. */
function gscProperty(anchor: string) {
  return `WITH metrics AS (
    SELECT ${date('date')} AS day, metric, ${count('value')} AS value, TRY_CAST(provisional AS BOOLEAN) AS provisional
    FROM signal_trend_daily WHERE integration = 'gsc' AND metric IN ('clicks', 'impressions')
      AND ${date('date')} <= DATE '${anchor}'
  ), latest AS (SELECT MAX(day) AS measured_through FROM metrics),
  daily AS (
    SELECT day, MAX(value) FILTER (WHERE metric = 'clicks') AS clicks, MAX(value) FILTER (WHERE metric = 'impressions') AS impressions,
      CASE WHEN BOOL_OR(provisional) THEN TRUE WHEN COUNT(provisional) = 2 THEN FALSE ELSE NULL END AS provisional
    FROM metrics, latest WHERE day >= measured_through - 34 GROUP BY day
    HAVING COUNT(*) = 2 AND COUNT(DISTINCT metric) = 2
  )
  SELECT json_object('measuredThrough', measured_through, 'days', (SELECT list(daily ORDER BY day) FROM daily)) AS result FROM latest`;
}

/** Use one row per organic search day and exclude overlapping multi-day exports. */
function ga4Organic(anchor: string, table: PanelTableInfo) {
  return `WITH channel AS (
    SELECT ${date('report_date')} AS day, ${count('sessions')} AS sessions, ${count('engagedSessions')} AS engagedSessions,
      ${count('keyEvents')} AS keyEvents, TRY_CAST(provisional AS BOOLEAN) AS provisional, ${flag(table, 'provider_truncated')} AS truncated
    FROM ga4_traffic_acquisition WHERE sessionDefaultChannelGroup = 'Organic Search'
      AND ${date('report_date')} <= DATE '${anchor}'
      AND ${date('window_start')} = ${date('report_date')} AND ${date('window_end')} = ${date('report_date')}
  ), latest AS (SELECT MAX(day) AS measured_through FROM channel),
  daily AS (
    SELECT channel.* FROM channel, latest WHERE day >= measured_through - 34
    QUALIFY COUNT(*) OVER (PARTITION BY day) = 1
  )
  SELECT json_object('measuredThrough', measured_through, 'days', (SELECT list(daily ORDER BY day) FROM daily)) AS result FROM latest`;
}

/** Read measured days from the latest eligible export without mixing revisions. */
function bingTraffic(anchor: string, table: PanelTableInfo) {
  return `WITH latest AS (
    SELECT MAX(${date('report_date')}) AS report_day FROM bing_webmaster_rank_traffic WHERE ${date('report_date')} <= DATE '${anchor}'
  ), snapshot AS (
    SELECT ${date('provider_date')} AS day, ${count('clicks')} AS clicks, ${count('impressions')} AS impressions,
      FALSE AS provisional, ${flag(table, 'provider_truncated')} AS truncated
    FROM bing_webmaster_rank_traffic, latest WHERE ${date('report_date')} = report_day
      AND ${date('provider_date')} <= report_day
  ), measured AS (SELECT MAX(day) AS measured_through FROM snapshot),
  daily AS (
    SELECT snapshot.* FROM snapshot, measured WHERE day >= measured_through - 34
    QUALIFY COUNT(*) OVER (PARTITION BY day) = 1
  )
  SELECT json_object('reportDate', report_day, 'measuredThrough', measured_through,
    'days', (SELECT list(daily ORDER BY day) FROM daily)) AS result FROM latest, measured`;
}

/** Report when the latest eligible export was filed and the last day it measured, if recorded. */
function bingReport(anchor: string, table: PanelTableInfo) {
  const measured = table.columns.includes('provider_date') ? `MAX(${date('provider_date')})` : 'NULL';
  return `WITH latest AS (SELECT MAX(${date('report_date')}) AS report_day FROM ${table.table} WHERE ${date('report_date')} <= DATE '${anchor}')
  SELECT json_object('reportDate', report_day, 'measuredThrough', ${measured},
    'providerTruncated', BOOL_OR(${flag(table, 'provider_truncated')}::BOOLEAN)) AS result
  FROM latest LEFT JOIN ${table.table} ON ${date('report_date')} = report_day GROUP BY report_day`;
}

/** Only subjects present exactly once on every day of both windows can move
 * in the shortlist. An omitted top row contributes neither a zero nor a total. */
function gscDetail(anchor: string, table: PanelTableInfo, key: 'query' | 'page') {
  return `WITH rows AS (
    SELECT ${date('report_date')} AS day, CAST(${key} AS VARCHAR) AS subject,
      ${count('clicks')} AS clicks, ${count('impressions')} AS impressions, TRY_CAST(position AS DOUBLE) AS position,
      ${flag(table, 'provider_truncated')} AS truncated
    FROM ${table.table} WHERE ${date('report_date')} <= DATE '${anchor}'
  ), latest AS (SELECT MAX(day) AS measured_through FROM rows),
  recent AS (SELECT rows.*, day > measured_through - ${DAYS} AS current FROM rows, latest WHERE day > measured_through - ${2 * DAYS}),
  daily AS (SELECT day, BOOL_OR(truncated::BOOLEAN) AS truncated, FALSE AS provisional FROM recent GROUP BY day),
  movers AS (
    SELECT subject, SUM(clicks) FILTER (WHERE NOT current) AS "priorClicks", SUM(clicks) FILTER (WHERE current) AS "currentClicks",
      SUM(impressions) FILTER (WHERE NOT current) AS "priorImpressions", SUM(impressions) FILTER (WHERE current) AS "currentImpressions",
      ROUND(SUM(position * impressions) FILTER (WHERE NOT current) / NULLIF(SUM(impressions) FILTER (WHERE NOT current AND position IS NOT NULL), 0), 2) AS "priorPosition",
      ROUND(SUM(position * impressions) FILTER (WHERE current) / NULLIF(SUM(impressions) FILTER (WHERE current AND position IS NOT NULL), 0), 2) AS "currentPosition",
      SUM(CASE WHEN current THEN clicks ELSE -clicks END) AS "clickChange"
    FROM recent WHERE subject IS NOT NULL AND subject <> '' GROUP BY subject
    HAVING COUNT(*) = ${2 * DAYS} AND COUNT(DISTINCT day) = ${2 * DAYS}
      AND COUNT(clicks) = ${2 * DAYS} AND COUNT(impressions) = ${2 * DAYS}
      AND "clickChange" <> 0
    ORDER BY ABS("clickChange") DESC, subject LIMIT ${MOVEMENTS}
  )
  SELECT json_object('measuredThrough', measured_through, 'days', (SELECT list(daily ORDER BY day) FROM daily),
    'movements', (SELECT list(movers ORDER BY ABS("clickChange") DESC, subject) FROM movers)) AS result FROM latest`;
}

/** Bound the returned evidence and count all snapshot rows so a cutoff stays visible. */
function trackedRows(anchor: string, table: PanelTableInfo) {
  const answered = table.columns.includes('organic_results') ? 'organic_results IS NOT NULL' : 'NULL';
  const depth = table.columns.includes('tracked_depth') ? count('tracked_depth') : 'NULL';
  return `WITH latest AS (SELECT MAX(${date('report_date')}) AS report_day FROM dataforseo_serp_panel WHERE ${date('report_date')} <= DATE '${anchor}'),
  pairs AS (
    SELECT CAST(query AS VARCHAR) AS query, CAST(device AS VARCHAR) AS device, ${answered} AS answered, ${depth} AS "trackedDepth"
    FROM dataforseo_serp_panel, latest WHERE ${date('report_date')} = report_day
    ORDER BY query, device LIMIT ${SERP_ROWS}
  )
  SELECT json_object('reportDate', report_day, 'rows', (SELECT list(pairs ORDER BY query, device) FROM pairs),
    'totalRows', (SELECT COUNT(*) FROM dataforseo_serp_panel WHERE ${date('report_date')} = report_day)) AS result FROM latest`;
}

/** Compare two consecutive weeks ending on the latest complete day and expose gaps. */
function matchedWeeks(data: Daily | undefined, metrics: readonly string[], latestObserved = data?.measuredThrough ?? null) {
  const rows = data?.days ?? [];
  const complete = rows.filter(row => row.provisional === false && metrics.every(metric => typeof row[metric] === 'number'));
  const end = complete.at(-1)?.day;
  const provisionalDates = rows.filter(row => row.provisional === true).map(row => row.day);
  const unknownFinalityDates = rows.filter(row => row.provisional == null).map(row => row.day);
  const info = { latestObserved, reportDate: data?.reportDate ?? null, provisionalDates, unknownFinalityDates };
  if (!end) return { ...info, status: data ? 'insufficient-coverage' : 'unavailable', prior: null, current: null };

  /** Sum a metric only when every day in the week has a finalized value. */
  function period(start: string, end: string) {
    const selected = complete.filter(row => row.day >= start && row.day <= end);
    const totals = selected.length === DAYS ? Object.fromEntries(metrics.map(metric =>
      [metric, selected.reduce((sum, row) => sum + (row[metric] as number), 0)])) : null;
    const covered = new Set(selected.map(row => row.day));
    const missingDates = Array.from({ length: DAYS }, (_, offset) => shiftDay(start, offset)).filter(day => !covered.has(day));
    const capFlags = rows.filter(row => row.day >= start && row.day <= end).map(row => row.truncated);
    const providerTruncated = capFlags.some(flag => flag === true) ? true
      : capFlags.length === DAYS && capFlags.every(flag => flag === false) ? false : null;
    return { start, end, completeDays: selected.length, missingDates, providerTruncated, totals };
  }

  const current = period(shiftDay(end, 1 - DAYS), end);
  const prior = period(shiftDay(end, 1 - 2 * DAYS), shiftDay(end, -DAYS));
  const status = current.completeDays === DAYS && prior.completeDays === DAYS ? 'comparable' : 'insufficient-coverage';
  return { ...info, status, prior, current };
}

/** Read the request roster saved with this version, when it exists. */
async function readRosters(store: Store, ref: PanelRef) {
  try { return record(await store.document(ref, 'freshness'))?.trackedSearchRosters; } catch (error) {
    if (error instanceof PanelReadError) return null;
    throw error;
  }
}

/** Isolate a failed query to its source so other sections can still be reviewed. */
async function readSources(folder: string, reads: Source[]) {
  const data = new Map<unknown, unknown>();
  const unavailable: { table: string; reason: string }[] = [];
  /** Collect one result per section and reject a response cut short by the query limit. */
  async function run(batch: Source[]) {
    const result = await queryPanel({
      folder, tables: batch.map(({ table }) => ({ table: table.table, file: table.stored })),
      sql: batch.map(({ section, sql }) => payload(section, sql)).join('\nUNION ALL\n'), maxRows: batch.length,
    });
    if (result.truncated) throw new PanelQueryError('The result exceeded its evidence limit.');
    for (const [name, body] of result.rows) data.set(name, JSON.parse(body as string));
  }

  // Keep CSV sniffing and scan buffers inside the existing query limits.
  const batches: Source[][] = [];
  for (let index = 0; index < reads.length; index += TABLES_PER_QUERY) batches.push(reads.slice(index, index + TABLES_PER_QUERY));
  const initial = await Promise.allSettled(batches.map(run));
  const retry = initial.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    if (!(result.reason instanceof PanelQueryError)) throw result.reason;
    const batch = batches[index]!;
    if (batch.length > 1) return batch;
    unavailable.push({ table: batch[0]!.section, reason: result.reason.message });
    return [];
  });
  const isolated = await Promise.allSettled(retry.map(source => run([source])));
  isolated.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    if (!(result.reason instanceof PanelQueryError)) throw result.reason;
    unavailable.push({ table: retry[index]!.section, reason: result.reason.message });
  });
  return { data, unavailable };
}

/** Compare same-date requests and results, withholding pair counts when the scan is incomplete. */
function coverage(tracked: Tracked | undefined, publishedRosters: unknown, quality: unknown, anchor: string) {
  const rosters = Array.isArray(publishedRosters) ? publishedRosters.map(record) : [];
  const latestRosterDate = rosters.map(entry => entry?.reportDate)
    .filter(validDay).filter(day => day <= anchor).sort().at(-1) ?? null;
  const observedDate = tracked?.reportDate ?? null;
  const reportDate = [latestRosterDate, observedDate].filter(validDay).sort().at(-1) ?? null;
  const observed = observedDate === reportDate ? tracked : undefined;
  const rows = observed?.rows ?? [];
  const pairKey = (pair: Pair) => JSON.stringify([pair.query, pair.device]);
  const pairs = new Map(rows.filter(row => row.query && row.device).map(row => [pairKey(row), row]));
  const roster = rosters.find(entry => entry?.reportDate === reportDate);
  const requests = Array.isArray(roster?.requests) ? roster.requests as Pair[] : null;
  const expected = requests && new Set(requests.map(pairKey));
  const overflow = (observed?.totalRows ?? 0) > rows.length;
  const pairsKnown = tracked !== undefined && reportDate !== null && !overflow;
  const observations = [...pairs.values()].map(({ query, device, answered }) => ({ query, device, answered }));
  return {
    reportDate, rosterSource: requests ? 'archived-requests' : 'unavailable',
    expectedPairs: requests?.length ?? null, requests,
    observedPairs: pairsKnown ? pairs.size : null, observedRows: tracked && reportDate ? observed?.totalRows ?? 0 : null,
    observations, observationsTruncated: overflow,
    duplicateRows: pairsKnown ? rows.filter(row => row.query && row.device).length - pairs.size : null,
    unansweredPairs: pairsKnown ? observations.filter(row => row.answered === false).map(({ query, device }) => ({ query, device })) : null,
    unknownAnswerPairs: pairsKnown ? observations.filter(row => row.answered === null).length : null,
    missingPairs: requests && pairsKnown ? requests.filter(pair => !pairs.has(pairKey(pair))) : null,
    unexpectedPairs: expected && pairsKnown ? observations.filter(pair => !expected.has(pairKey(pair))) : null,
    trackedDepths: [...new Set(rows.map(row => row.trackedDepth).filter(depth => depth !== null))].sort((a, b) => a - b),
    organicQuality: record(quality)?.reportDate === reportDate ? quality : null,
  };
}

/** Assemble reproducible evidence from one retained version through the chosen calendar date. */
export async function readSearchReview(store: Store, ref: PanelRef, asOf: string, requestedDate: string | null) {
  const panel = await store.describe(ref, asOf);
  const builtDay = panel.builtAt?.slice(0, 10);
  const reportDate = requestedDate ?? (validDay(builtDay) ? builtDay : asOf.slice(0, 10));
  if (!validDay(reportDate) || (validDay(builtDay) && reportDate > builtDay)) {
    throw new PanelReadError('report_date must be a calendar date (YYYY-MM-DD) no later than the panel build date.');
  }
  const tables = new Map(panel.tables.map(table => [table.table, table]));
  const reads: Source[] = [];
  const incompatible: { table: string; reason: string }[] = [];
  /** Queue a query only when its table has the columns required for this section. */
  function add(name: string, columns: readonly string[], sql: (table: PanelTableInfo) => string) {
    const table = tables.get(name);
    if (table === undefined) return;
    const missing = columns.filter(column => !table.columns.includes(column));
    if (missing.length) incompatible.push({ table: name, reason: `This version lacks: ${missing.join(', ')}.` });
    else reads.push({ table, section: name, sql: sql(table) });
  }
  add('dataforseo_serp_panel', ['report_date', 'query', 'device'], table => trackedRows(reportDate, table));
  add('signal_trend_daily', ['date', 'integration', 'metric', 'value', 'provisional'], () => gscProperty(reportDate));
  for (const key of ['page', 'query'] as const) {
    add(`gsc_${key}`, ['report_date', key, 'clicks', 'impressions', 'position'], table => gscDetail(reportDate, table, key));
  }
  add('ga4_traffic_acquisition', ['report_date', 'sessionDefaultChannelGroup', 'sessions', 'engagedSessions', 'keyEvents',
    'provisional', 'window_start', 'window_end'], table => ga4Organic(reportDate, table));
  add('bing_webmaster_rank_traffic', ['report_date', 'provider_date', 'clicks', 'impressions'], table => bingTraffic(reportDate, table));
  for (const name of BING_REPORTS) add(name, ['report_date'], table => bingReport(reportDate, table));

  const { data, unavailable } = await readSources(ref.folder, reads);
  const tracked = data.get('dataforseo_serp_panel') as Tracked | undefined;
  const gsc = matchedWeeks(data.get('signal_trend_daily') as Daily | undefined, ['clicks', 'impressions']);
  const ga4 = matchedWeeks(data.get('ga4_traffic_acquisition') as Daily | undefined, ['sessions', 'engagedSessions', 'keyEvents']);
  const bing = matchedWeeks(data.get('bing_webmaster_rank_traffic') as Daily | undefined, ['clicks', 'impressions']);
  /** Show top-row movements for comparable weeks without treating them as property totals. */
  function detail(name: 'gsc_page' | 'gsc_query') {
    const source = data.get(name) as Detail | undefined;
    const comparison = matchedWeeks(source, []);
    return { ...comparison, scope: 'top-rows', grain: name === 'gsc_page' ? 'page-day' : 'query-day',
      prior: comparison.prior && { ...comparison.prior, totals: null },
      current: comparison.current && { ...comparison.current, totals: null },
      movements: comparison.status === 'comparable' ? source?.movements ?? [] : null };
  }
  const searchFamily = (name: string) => /^(dataforseo-serp-panel|gsc-(page|query)$|ga4-traffic-acquisition|bing-webmaster-)/u.test(name);
  const attention = panel.attention.filter(note => note.family === null || searchFamily(note.family));
  const sources = panel.families.filter(source => searchFamily(source.family)).map(source => ({
    family: source.family, table: source.table, status: source.status, newestReportDate: source.newestReportDate, ageDays: source.ageDays,
  }));

  return {
    evidenceVersion: 1, asset: ref.asset, version: ref.version, latest: panel.latest, builtAt: panel.builtAt, reportDate,
    attention, sources, unavailableSources: [...incompatible, ...unavailable],
    trackedSearch: coverage(tracked, await readRosters(store, ref), record(panel)?.serpOrganicQuality, reportDate),
    comparisons: {
      gscProperty: { ...gsc, grain: 'property-day' }, gscPages: detail('gsc_page'), gscQueries: detail('gsc_query'),
      ga4OrganicSearch: { ...ga4, grain: 'channel-day' },
      bingRankTraffic: { ...bing, grain: 'provider-day', measuredLagDays: lag(bing.reportDate, bing.latestObserved) },
    },
    bingSnapshots: BING_REPORTS.map(name => {
      const snapshot = data.get(name) as { reportDate: string | null; measuredThrough: string | null; providerTruncated: boolean | null } | undefined;
      return { table: name, reportDate: snapshot?.reportDate ?? null, measuredThrough: snapshot?.measuredThrough ?? null,
        measuredLagDays: lag(snapshot?.reportDate, snapshot?.measuredThrough), providerTruncated: snapshot?.providerTruncated ?? null };
    }),
    drilldown: reads.map(({ table, section, sql }) => ({ table: section, sha256: table.sha256, sql })),
  };
}
