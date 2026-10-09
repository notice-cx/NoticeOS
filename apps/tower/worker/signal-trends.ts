// Signal trends — every asset's charted GA4, Search Console and Bing series,
// read from the append-only log of collection runs and the values they changed
// (on Postgres since bead ro-ujb9.76.5.3: `noticeos.signal_runs`,
// `measurement_series` and `signal_observations`).
//
// ONE DERIVATION, TWO SURFACES (`ro-elf`). The Wall's asset cards and the asset
// page's performance section both call `loadSignalTrends`; the asset page only
// narrows the same SQL to one asset (`ro-48p.2`). Two copies of this read are
// how two surfaces come to disagree about one asset, so neither page builder
// owns it: both compose it from here. Pure over an injected store, so the
// tests run this exact SQL against a Postgres copy: the series, and the dated
// timezone changes (the annotations, on Postgres since bead ro-ujb9.76.5.7).

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { signalEvidenceFloor } from "./integration-evidence";
import type { SignalTrend, SignalTrendSet, TimeZoneChangePoint } from "../shared/wall";

/** Compact asset cards keep four complete weeks legible at every viewport.
 * This is the DRAWN window and nothing else touches it — see below. */
export const WALL_SIGNAL_CHART_DAYS = 28;
/**
 * The days carried BEFORE the drawn window, as `SignalTrend.contextSeries`.
 *
 * SEVEN UNTIL `ro-78qo.35`, WHEN IT BECAME SIXTY-TWO. Seven was enough for the
 * one job context had: a rolling seven-day average whose first visible point is
 * already an average rather than a stub. But /assets reads this same payload
 * and doc 14 gives every surface a 7 · 28 · 90 range, and there was no third
 * range to offer — a 90d button drawing 28 days of line would be the page lying
 * about its own window.
 *
 * SIXTY-TWO IS CHOSEN SO CONTEXT PLUS CHART IS NINETY. The split is what keeps
 * this safe: `series` is still exactly the Wall's four weeks, so the TV's card
 * chart, `wall:fit` and every existing reader are untouched by construction,
 * and a desk surface asking for ninety days reads `[...contextSeries,
 * ...series]` and windows it. Nothing needed a render change to stay correct,
 * because nothing has ever drawn `contextSeries` as chart days.
 */
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

/** Options for the shared trend loader.
 *
 * Both exist because the two callers render different things and neither should
 * pay to read rows it would drop — the filter is in the SQL, not a post-pass.
 * `includeWebSearch`: the asset page charts Google/Bing clicks and
 * impressions; the Wall's asset card charts neither, since the card gave
 * that space to the work widget and search history lives on the asset page
 * (doc 10, 2026-08-01). `includeSecondarySeries`: the asset page's
 * supporting sparkline row is the only reader of the GA4 volume metrics and the
 * two Search Console rate metrics. */
export interface SignalTrendOptions {
  includeWebSearch?: boolean;
  includeSecondarySeries?: boolean;
  includeSessions?: boolean;
  /** One asset, narrowed IN THE SQL. The asset page draws one card and
   * used to compute the whole portfolio's trend to get it (`ro-48p.2`); this is
   * the same query with one more equality, deliberately not a second query —
   * the Wall and the page share one derivation so they cannot disagree about a
   * asset (`ro-elf`). Absent means the whole portfolio, as before. */
  asset?: string;
  /** Several assets, narrowed the same way (bead `ro-ujb9.102`): the Wall's
   * revenue projection needs traffic only for the assets that report daily
   * revenue, and read the whole portfolio's to use one of them. Ignored when
   * `asset` is given; an empty list reads nothing. */
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

/** Which series one observation belongs to, or null when the caller did not ask
 * for that metric (the SQL filters it out, so this is the belt to that braces). */
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
 * Every series in the set, each paired with the INTEGRATION that reported it.
 *
 * The pairing is `trendFor` read backwards, and it exists because some of what
 * a trend carries is filed against a PROVIDER rather than against the asset
 * (`ro-kukv.11`). A reporting timezone is a setting on one provider's property:
 * a GA4 property changing its clock changes what a GA4 day is and says nothing
 * whatsoever about what a Search Console day is. Stamping every series of an
 * asset with every change filed for it would paint a GA4 fact onto a GSC line —
 * a knowingly wrong mark, which is worse than an unmarked one.
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
 * for every asset (bead `ro-ujb9.102`).
 *
 * A change is kept for a series only when it is dated after that series' first
 * point, so nothing on or before the earliest first point of any series can
 * reach a chart. The read therefore starts there, and it is a range seek on
 * the annotations' (site, time) index per asset instead of a pass over every
 * annotation ever filed. On Postgres (bead ro-ujb9.76.5.7):
 *
 *  - "a day after" is an instant bound, the next UTC midnight, so the index
 *    seeks it; D1 compared the first ten characters of its text.
 *  - Driven from the site list, one seek per site (`LATERAL`), because the
 *    index leads with the site. `OFFSET 0` keeps each site's read its own:
 *    without it Postgres flattens the join into one pass over every site's
 *    changes since the bound, which the index cannot seek. An annotation's
 *    site is always a listed site.
 *  - The change's number breaks a tie between two filed at the same instant.
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
 * The trend read's statement, for the metrics a caller asked for. `$1` is the
 * evidence floor, `$2` the days before a lane's newest window end the read
 * reaches back, and `$3`, when `narrowed`, the sites it is narrowed to.
 *
 * The lanes are spelled out, the three the collectors write, so each (site,
 * lane) pair is one seek. The values come through the series of the latest
 * run's property, a seek per series on its (series, day) index, and each is
 * kept only when its run succeeded and finished inside the window. Each step
 * is LATERAL on the one before and fenced (`OFFSET 0`, which keeps Postgres
 * from flattening it), so that is the order Postgres takes them in whatever
 * its statistics say. Text is ordered byte by byte, as D1 ordered it.
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
 * when `asset` is given.
 *
 * Two bounds make this affordable over an append-only log that only grows, and
 * they are different KINDS of bound (`ro-48p.1`):
 *
 *   - the latest successful run per (asset, lane) is a `LIMIT 1` seek per pair
 *     down the runs' latest-first index (`signal_runs_latest`), floored at
 *     `signalEvidenceFloor`. It used to be a ROW_NUMBER() ranking of every run
 *     ever written — a full index scan plus two sorts to keep at most eighteen
 *     rows;
 *   - the self-join back over that pair's PRIOR runs (the change log: a value
 *     unchanged since March was written by March's run) is floored at the same
 *     day the observation window starts. That bound is exact, not generous: a
 *     run's observations only ever cover dates up to its own `window_end`, which
 *     is never after the day it finished, so a run that finished before the
 *     window opened cannot hold a value inside it.
 *
 * ONE PROVIDER RESOURCE PER SERIES (`ro-ujb9.70`). The self-join reads only
 * prior runs of the latest successful run's `property_ref`. An asset repointed
 * at another GA4 property or Search Console site is measuring a different
 * resource, so days only the old one reported fall out of the chart instead of
 * being spliced in front of the new one's line. The collector records a
 * switched-to property's whole window on its first run, so the new line starts
 * as far back as the provider reports. `credential_ref` is not part of this:
 * rotating the key that reads the same resource keeps the whole series. Neither
 * is `time_zone`: a reporting-timezone change on one property stays one series,
 * and the dated annotations below mark where its day definition moved.
 *
 * THE NEWEST WRITE OF A DAY is the one whose run finished last, and between two
 * runs that finished in the same instant the one written last (its
 * observation's identity): `ORDER BY r.finished_at DESC, o.observation_id DESC`,
 * kept once per (asset, lane, day, metric) with `DISTINCT ON`, whose sort is
 * also the output order. On D1 `finished_at` was text and compared as text
 * (bead `ro-ujb9.110`); on Postgres it is an instant (bead ro-ujb9.76.5.3), so
 * two spellings of one instant are one instant.
 *
 * `store` is this call's Postgres store, where the runs and their values are,
 * and the dated timezone changes (the annotations, bead ro-ujb9.76.5.7).
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

  // The reporting-timezone changes the collector filed on the timeline
  // (`ro-tzq`). The changes are read rather than the runs because
  // that is where the change is DATED to the day the two day-definitions
  // diverged; a run row only says what timezone that run used, which cannot
  // tell a reader when the boundary moved.
  //
  // Keyed by asset AND integration (`ro-kukv.11`): the ref names the provider
  // whose property moved, and that is the only series set the move is evidence
  // about. Filing them all under the asset lost that, so every chart of the
  // asset would have carried every provider's changes.
  //
  // Only changes AFTER a series' first point are ever kept (below), so the
  // read starts at the earliest first point of any series (`ro-ujb9.102`).
  // It used to read every annotation in the store, every poll.
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
      // This provider's changes and no other's, then only the ones inside THIS
      // series' own range: a change from before the first point cannot split a
      // window that starts after it, and carrying it would mark comparisons
      // that are entirely one-sided.
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
