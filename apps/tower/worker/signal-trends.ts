// Signal trends — every asset's charted GA4, Search Console and Bing series,
// read from the append-only log of collection runs and the values they
// changed (`noticeos.signal_runs`, `measurement_series`,
// `signal_observations`). The Wall's asset cards and the asset page's
// performance section both call `loadSignalTrends`; the asset page only
// narrows the same SQL to one asset.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { signalEvidenceFloor } from "./integration-evidence";
import type { SignalTrend, SignalTrendSet, TimeZoneChangePoint } from "../shared/wall";

/** Compact asset cards keep four complete weeks legible at every viewport.
 * This is the drawn window. */
export const WALL_SIGNAL_CHART_DAYS = 28;
/** The days carried before the drawn window, as `SignalTrend.contextSeries`:
 * sixty-two, so context plus chart is the desk's ninety-day range. `series`
 * stays exactly the Wall's four weeks; a desk surface reads
 * `[...contextSeries, ...series]` and windows it. */
const SIGNAL_CHART_CONTEXT_DAYS = 62;

type SignalSeriesRow = {
  asset: string;
  integration: "ga4" | "gsc" | "bing-webmaster";
  finishedAt: string;
  provisionalFrom: string | null;
  date: string;
  metric: string;
  value: number;
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Options for the shared trend loader. The filters are in the SQL, not a
 * post-pass, so neither caller pays to read rows it would drop.
 * `includeWebSearch`: Google/Bing clicks and impressions.
 * `includeSecondarySeries`: the GA4 volume metrics and the two Search Console
 * rate metrics, which only the asset page's supporting row reads. */
export interface SignalTrendOptions {
  includeWebSearch?: boolean;
  includeSecondarySeries?: boolean;
  includeSessions?: boolean;
  /** One asset, narrowed in the SQL: the same query with one more equality,
   * deliberately not a second query. Absent means the whole portfolio. */
  asset?: string;
  /** Several assets, narrowed the same way. Ignored when `asset` is given; an
   * empty list reads nothing. */
  assets?: readonly string[];
  /** When "now" is, for the evidence floor below. Defaults to the wall clock so
   * a caller that does not care need not thread it. */
  nowMs?: number;
}

/** An untouched set: every series present, every series empty. */
export function emptySignalTrendSet(): SignalTrendSet {
  const empty = (): SignalTrend => ({
    contextSeries: [],
    series: [],
    provisionalFrom: null,
    collectedAt: null,
    timeZoneChanges: [],
  });
  return {
    activeUsers: empty(),
    webSearchClicks: { google: empty(), bing: empty() },
    webSearchImpressions: { google: empty(), bing: empty() },
    sessions: empty(),
    pageViews: empty(),
    events: empty(),
    searchCtr: empty(),
    searchPosition: empty(),
  };
}

/** Which series one observation belongs to, or null when the caller did not
 * ask for that metric. */
function trendFor(
  set: SignalTrendSet,
  integration: SignalSeriesRow["integration"],
  metric: string,
): SignalTrend | null {
  if (integration === "ga4") {
    if (metric === "active_users") return set.activeUsers;
    if (metric === "sessions") return set.sessions;
    if (metric === "page_views") return set.pageViews;
    if (metric === "event_count") return set.events;
    return null;
  }
  if (integration === "gsc") {
    if (metric === "clicks") return set.webSearchClicks.google;
    if (metric === "impressions") return set.webSearchImpressions.google;
    if (metric === "ctr") return set.searchCtr;
    if (metric === "position") return set.searchPosition;
    return null;
  }
  if (metric === "clicks") return set.webSearchClicks.bing;
  if (metric === "impressions") return set.webSearchImpressions.bing;
  return null;
}

/**
 * Every series in the set, each paired with the integration that reported it.
 * A reporting timezone is a setting on one provider's property, so a change
 * filed for GA4 must never be stamped onto a Search Console line.
 */
function everyTrend(
  set: SignalTrendSet,
): { trend: SignalTrend; integration: SignalSeriesRow["integration"] }[] {
  return [
    { trend: set.activeUsers, integration: "ga4" },
    { trend: set.sessions, integration: "ga4" },
    { trend: set.pageViews, integration: "ga4" },
    { trend: set.events, integration: "ga4" },
    { trend: set.webSearchClicks.google, integration: "gsc" },
    { trend: set.webSearchImpressions.google, integration: "gsc" },
    { trend: set.searchCtr, integration: "gsc" },
    { trend: set.searchPosition, integration: "gsc" },
    { trend: set.webSearchClicks.bing, integration: "bing-webmaster" },
    { trend: set.webSearchImpressions.bing, integration: "bing-webmaster" },
  ];
}

/**
 * The reporting-timezone changes filed on a UTC day after `earliestPoint`
 * ($1), for the assets in $2 when the read is narrowed (`narrowedTo` > 0), or
 * for every asset. A change is kept for a series only when it is dated after
 * that series' first point, so the read starts there as a range seek on the
 * annotations' (site, time) index per site (`LATERAL`; `OFFSET 0` keeps each
 * site's read its own, where Postgres would flatten the join into one pass).
 * The change's number breaks a tie between two filed at the same instant.
 */
export function timeZoneChangesSql(narrowedTo: number): string {
  return `SELECT a.asset_id AS asset, (n.at AT TIME ZONE 'UTC')::date AS "effectiveOn", n.ref AS ref
           FROM noticeos.assets a
           CROSS JOIN LATERAL (
             SELECT c.at, c.ref, c.annotation_number
               FROM noticeos.annotations c
              WHERE c.workspace_id = a.workspace_id AND c.asset_id = a.asset_id
                AND c.at >= (($1::date + 1)::timestamp AT TIME ZONE 'UTC')
                AND c.kind = 'config' AND c.ref LIKE 'reporting-time-zone-changed:%'
             OFFSET 0) n
          ${narrowedTo > 0 ? "WHERE a.asset_id = ANY($2::text[])" : ""}
          ORDER BY n.at ASC, n.annotation_number ASC`;
}

/** One lookup key for a fact filed against an asset's ONE provider property.
 * The separator is the annotation ref's own `::`, and the integration half
 * comes from a closed three-name set, so no two pairs can collide. */
function timeZoneChangeKey(asset: string, integration: string): string {
  return `${asset}::${integration}`;
}

/**
 * The trend read's statement, for the metrics a caller asked for. `$1` is
 * the evidence floor, `$2` the days before a lane's newest window end the
 * read reaches back, and `$3`, when `narrowed`, the sites it is narrowed to.
 * The lanes are spelled out so each (site, lane) pair is one seek. The values
 * come through the series of the latest run's property, a seek per series on
 * its (series, day) index, kept only when the run succeeded and finished
 * inside the window. Each step is LATERAL on the one before and fenced
 * (`OFFSET 0`), so Postgres takes them in that order whatever its statistics
 * say. Text is ordered byte by byte.
 */
export function signalTrendsSql(options: {
  includeWebSearch: boolean;
  includeSecondarySeries: boolean;
  includeSessions: boolean;
  narrowed: boolean;
}): string {
  const webSearchClause = options.includeWebSearch
    ? `OR (latest.integration IN ('gsc', 'bing-webmaster') AND s.metric IN ('clicks', 'impressions'))`
    : "";
  const ga4Metrics = options.includeSecondarySeries
    ? `s.metric IN ('active_users', 'sessions', 'page_views', 'event_count')`
    : options.includeSessions ? `s.metric IN ('active_users', 'sessions')` : `s.metric = 'active_users'`;
  // CTR and average position are rates, so they belong to no provider-comparison
  // chart; only the asset page's supporting row reads them.
  const searchRateMetrics = options.includeSecondarySeries
    ? `OR (latest.integration = 'gsc' AND s.metric IN ('ctr', 'position'))`
    : "";
  return `WITH latest_success AS MATERIALIZED (
  SELECT a.asset_id AS asset, lanes.integration, run.finished_at AS "finishedAt", run.window_end AS "windowEnd",
         run.provisional_from AS "provisionalFrom", run.property_ref AS "propertyRef"
    FROM noticeos.assets a
   CROSS JOIN (VALUES ('ga4'), ('gsc'), ('bing-webmaster')) AS lanes(integration)
    JOIN LATERAL (
      SELECT candidate.finished_at, candidate.window_end, candidate.provisional_from, candidate.property_ref
        FROM noticeos.signal_runs candidate
       WHERE candidate.workspace_id = a.workspace_id
         AND candidate.asset_id = a.asset_id
         AND candidate.integration = lanes.integration
         AND candidate.status = 'success'
         AND candidate.finished_at >= $1::timestamptz
       ORDER BY candidate.finished_at DESC, candidate.run_seq DESC
       LIMIT 1
    ) run ON true${options.narrowed ? `\n   WHERE a.asset_id = ANY($3::text[])` : ""}
)
SELECT DISTINCT ON (latest.asset COLLATE "C", latest.integration COLLATE "C", written.date, series.metric COLLATE "C")
       latest.asset, latest.integration, latest."finishedAt", latest."provisionalFrom",
       written.date, series.metric, written.value
  FROM latest_success latest
 CROSS JOIN LATERAL (
       SELECT s.workspace_id, s.series_id, s.metric
         FROM noticeos.measurement_series s
        WHERE s.asset_id = latest.asset AND s.integration = latest.integration AND s.property_ref = latest."propertyRef"
          AND ((latest.integration = 'ga4' AND ${ga4Metrics})
               ${webSearchClause}
               ${searchRateMetrics})
       OFFSET 0) series
 CROSS JOIN LATERAL (
       SELECT o.observed_date AS date, o.value, o.observation_id, run.finished_at
         FROM noticeos.signal_observations o
        CROSS JOIN LATERAL (
              SELECT r.finished_at
                FROM noticeos.signal_runs r
               WHERE r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
                 AND r.status = 'success'
                 AND r.finished_at <= latest."finishedAt"
                 AND r.finished_at >= latest."windowEnd" - $2::integer
              OFFSET 0) run
        WHERE o.workspace_id = series.workspace_id AND o.series_id = series.series_id
          AND o.observed_date >= latest."windowEnd" - $2::integer
          AND o.observed_date <= latest."windowEnd"
       OFFSET 0) written
 ORDER BY latest.asset COLLATE "C", latest.integration COLLATE "C", written.date, series.metric COLLATE "C",
          written.finished_at DESC, written.observation_id DESC`;
}

/**
 * Every asset's charted signal series, keyed by asset id — or one asset's,
 * when `asset` is given. Two bounds make this affordable over a log that only
 * grows: the latest successful run per (asset, lane) is a `LIMIT 1` seek down
 * `signal_runs_latest`, floored at `signalEvidenceFloor`; and the self-join
 * back over that pair's prior runs (the change log) is floored at the day the
 * observation window starts, which is exact, since a run's observations never
 * cover dates after the day it finished.
 *
 * One provider resource per series: the self-join reads only prior runs of
 * the latest successful run's `property_ref`, so an asset repointed at another
 * property drops the old one's days rather than splicing them in.
 * `credential_ref` is not part of this (rotating a key keeps the series), and
 * neither is `time_zone` (a change stays one series, marked by the dated
 * annotations).
 *
 * The newest write of a day is the one whose run finished last, then the one
 * written last: `ORDER BY r.finished_at DESC, o.observation_id DESC`, kept
 * once per (asset, lane, day, metric) with `DISTINCT ON`.
 */
export async function loadSignalTrends(
  store: WorkspaceStore,
  chartDays = WALL_SIGNAL_CHART_DAYS,
  {
    includeWebSearch = true,
    includeSecondarySeries = false,
    includeSessions = false,
    asset,
    assets,
    nowMs = Date.now(),
  }: SignalTrendOptions = {},
): Promise<Map<string, SignalTrendSet>> {
  // The assets the read is narrowed to, or null for the whole portfolio.
  const narrowed: readonly string[] | null = asset ? [asset] : (assets ?? null);
  if (narrowed?.length === 0) return new Map();
  const narrowedTo = narrowed?.length ?? 0;
  const boundedChartDays = Number.isFinite(chartDays)
    ? Math.max(1, Math.floor(chartDays))
    : WALL_SIGNAL_CHART_DAYS;
  const historyDays = boundedChartDays + SIGNAL_CHART_CONTEXT_DAYS;
  const floor = signalEvidenceFloor(nowMs);
  const rows = (
    await store.read((tx) =>
      tx.query<SignalSeriesRow>(
        signalTrendsSql({ includeWebSearch, includeSecondarySeries, includeSessions, narrowed: narrowedTo > 0 }),
        [floor, historyDays - 1, ...(narrowed === null ? [] : [narrowed])],
      ),
    )
  ).map((row) => ({ ...row, finishedAt: javascriptInstant(row.finishedAt) }));

  // The reporting-timezone changes the collector filed on the timeline, read
  // rather than the runs because that is where the change is dated to the day
  // the two day-definitions diverged. Keyed by asset and integration: the ref
  // names the provider whose property moved. Only changes after a series'
  // first point are ever kept, so the read starts at the earliest first point.
  const timeZoneChanges = new Map<string, TimeZoneChangePoint[]>();
  const earliestPoint = rows.reduce<string | null>(
    (earliest, row) => (earliest === null || row.date < earliest ? row.date : earliest),
    null,
  );
  const changeRows =
    earliestPoint === null
      ? []
      : await store.read((tx) =>
          tx.query<{ asset: string; effectiveOn: string; ref: string }>(
            timeZoneChangesSql(narrowedTo),
            narrowed === null ? [earliestPoint] : [earliestPoint, [...narrowed]],
          ),
        );
  for (const row of changeRows) {
    // ref shape: reporting-time-zone-changed:<integration>:<from>-><to>
    const [, integration, transition] = row.ref.split(':');
    const [from, to] = (transition ?? '').split('->');
    if (!integration || !from || !to) continue;
    const key = timeZoneChangeKey(row.asset, integration);
    const list = timeZoneChanges.get(key) ?? [];
    list.push({ effectiveOn: row.effectiveOn, from, to });
    timeZoneChanges.set(key, list);
  }

  const map = new Map<string, SignalTrendSet>();
  for (const row of rows) {
    const entry = map.get(row.asset) ?? emptySignalTrendSet();
    const trend = trendFor(entry, row.integration, row.metric);
    if (!trend) continue;
    trend.series.push({ t: row.date, v: toNum(row.value) ?? 0 });
    trend.provisionalFrom = row.provisionalFrom;
    trend.collectedAt = row.finishedAt;
    map.set(row.asset, entry);
  }
  for (const [assetId, entry] of map.entries()) {
    for (const { trend, integration } of everyTrend(entry)) {
      // This provider's changes and no other's, then only the ones inside
      // this series' own range.
      const changes =
        timeZoneChanges.get(timeZoneChangeKey(assetId, integration)) ?? [];
      const first = trend.series[0]?.t;
      trend.timeZoneChanges = first
        ? changes.filter((change) => change.effectiveOn > first)
        : [];
      const bounded = trend.series.slice(-historyDays);
      const visibleStart = Math.max(0, bounded.length - boundedChartDays);
      trend.contextSeries = bounded.slice(
        Math.max(0, visibleStart - SIGNAL_CHART_CONTEXT_DAYS),
        visibleStart,
      );
      trend.series = bounded.slice(visibleStart);
    }
  }
  return map;
}
