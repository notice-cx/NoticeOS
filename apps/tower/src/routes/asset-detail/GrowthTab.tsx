import type { AssetDetailFor } from "@shared/asset-detail-views";
import type {
  AssetDetailPayload,
  ProductUseMetric,
  ProductUseSnapshot,
  SerpPanelSnapshot,
  SerpPanelTerm,
} from "@shared/asset-detail";
import { serpPanelScoreboard, serpPanelTerms } from "@shared/asset-detail";
import {
  periodDelta,
  windowSeries,
  type RangeDays,
} from "@shared/surface";
import type { SignalTrend } from "@shared/wall";
import type { WatchSeed } from "@shared/watch-windows";
import { ProductJourney } from "@/components/ProductJourney";
import { serpPanelScope } from "@/components/SerpPanelBoard";
import { productConnection } from "@shared/product";
import { SectionLabel } from "@/components/surface/SectionLabel";
import {
  SmallMultiple,
  SmallMultipleStrip,
} from "@/components/surface/SmallMultiple";
import { formatCalendarRange, formatInt } from "@/lib/format";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import {
  settledSeries,
  weightedMetricWindow,
} from "@/routes/asset-detail/overview-metrics";
import { timelineAnnotations } from "@/routes/asset-detail/shared";
import {
  MovementChip,
  SearchPair,
  SectionCaption,
  TrendPanel,
  sectionCaveat,
} from "@/routes/asset-detail/trend-panels";
import { useRange } from "@/routes/asset-detail/useRange";

/**
 * The Growth tab answers one question, which way did the numbers go, as two
 * pairs of charts following the page's range, then the three strips that say
 * whether the tracked panel, the other collected series and the product are
 * moving. No tables: a table answers "which row", and that is the Search tab.
 * The header range controls the traffic charts and collected daily metrics;
 * other snapshots name their own windows explicitly.
 */
export function GrowthTab({
  data,
  nowMs: _nowMs,
  onWatch: _onWatch,
}: {
  data: AssetDetailFor<"growth">;
  nowMs: number;
  /** Unused: the watch composer is raised from Search. */
  onWatch: (seed: WatchSeed) => void;
}) {
  // The range is the page's and its control is in the asset header, so this
  // tab reads it and renders no second selector.
  const { days } = useRange();
  const assetTabPath = useAssetTabPath();
  const { performance } = data;
  const searchTab = assetTabPath(data.asset.id, "search");
  // The asset's recorded deploys and config changes, labelled the way the
  // Overview labels them — one derivation, so the same day carries the same
  // sentence on whichever tab marks it.
  const timeline = timelineAnnotations(data.annotations.items);
  const audience = [performance.activeUsers, performance.sessions];

  return (
    <div id="growth-evidence" className="flex scroll-mt-4 flex-col gap-5">
      {/* The block that is this tab's answer (`audit:surfaces`): the audience
          pair is where the eye has to land. */}
      <section
        id="performance"
        data-surface-hero
        className="scroll-mt-4 flex flex-col gap-2"
      >
        <SectionLabel
          title="Audience"
          caption={
            <SectionCaption
              label="About audience charts"
              text="Google Analytics, daily · the bold line is the 7-day average"
              caveat={sectionCaveat(audience, days)}
            />
          }
        />
        <div className="grid min-w-0 gap-3.5 lg:grid-cols-2">
          <TrendPanel
            title="Active users"
            trends={[{ name: "GA4", tone: "primary", trend: performance.activeUsers }]}
            days={days}
            aggregate="mean"
            unit="a day"
            format={formatInt}
            asset={data.asset.displayName}
            timeline={timeline}
          />
          <TrendPanel
            title="Sessions"
            trends={[{ name: "GA4", tone: "primary", trend: performance.sessions }]}
            days={days}
            aggregate="sum"
            unit="visits"
            format={formatInt}
            asset={data.asset.displayName}
            timeline={timeline}
          />
        </div>
      </section>

      <SearchPair
        performance={performance}
        days={days}
        asset={data.asset.displayName}
        timeline={timeline}
        action={{ to: searchTab, label: "Search →" }}
      />

      <AlsoCollected performance={performance} days={days} />

      {/* The analysis's age is Search's to state, beside the findings it
          dates; Growth draws the numbers. */}
      <PanelScoreboard panel={data.executive?.serpPanel ?? null} searchTab={searchTab} />

      <ProductUse snapshot={data.executive?.productUse ?? null} />

      {/* What people do once they arrive, and where it breaks. Its header
          names PostHog as the source, so its numbers are never read as
          Google's. */}
      <ProductJourney
        product={data.executive?.product ?? null}
        connection={productConnection(data.integrations.lanes)}
      />

    </div>
  );
}


// --- the tracked panel's scoreboard ----------------------------------------

/**
 * The panel as six numbers: how is the panel doing, and nothing else. Both
 * this and `SerpPanelBoard` read `serpPanelScoreboard`, so the strip and the
 * board can never disagree about what "top 10" means. Denominators, not
 * percentages: `AI Overview` is quoted against the terms the panel could
 * answer for, because dividing by the tracked count spends every unknown as a
 * "no".
 */
function PanelScoreboard({
  panel,
  searchTab,
}: {
  panel: SerpPanelSnapshot | null;
  searchTab: string;
}) {
  if (!panel) return null;
  const board = serpPanelScoreboard(panel);
  const move = bestMove(serpPanelTerms(panel));

  return (
    <section id="panel-scoreboard" className="scroll-mt-4 flex flex-col gap-2">
      <SectionLabel
        title={`Search terms · ${formatInt(board.tracked)} tracked`}
        caption={serpPanelScope(panel)}
        action={{ to: searchTab, label: "Search terms →" }}
      />
      <SmallMultipleStrip columns={6}>
        <SmallMultiple
          label="Ranking"
          value={formatInt(board.ranking)}
          secondary={`of ${formatInt(board.tracked)}`}
        />
        <SmallMultiple label="Top 10" value={formatInt(board.top10)} />
        <SmallMultiple label="Top 3" value={formatInt(board.top3)} />
        <SmallMultiple
          label="AI Overview"
          value={board.aioKnown === 0 ? "—" : formatInt(board.aioPresent)}
          secondary={
            board.aioKnown === 0
              ? "not checked"
              : `of ${formatInt(board.aioKnown)} checked`
          }
        />
        <SmallMultiple
          label="Cites us"
          value={board.aioPresent === 0 ? "—" : formatInt(board.aioCitesUs)}
          secondary={
            board.aioPresent === 0
              ? "no overview seen"
              : `of ${formatInt(board.aioPresent)} shown`
          }
        />
        <SmallMultiple
          label="Best move"
          value={
            move === null ? (
              "—"
            ) : (
              <span className="block text-sm [overflow-wrap:anywhere]">{move.term.query}</span>
            )
          }
          secondary={move === null ? "nothing within reach" : move.caption}
        />
      </SmallMultipleStrip>
    </section>
  );
}

/**
 * The one term worth a week's work: the tracked term sitting closest to a tier
 * it has not crossed.
 *
 * Page one first, then the top three, because a term at 12 gains more from
 * reaching 10 than a term at 4 gains from reaching 3 — the click curve is
 * steepest at the page boundary. A term already in the top three has no next
 * tier and is deliberately not offered as a move; nor is a term with no result
 * inside the pull's depth, because nobody looked far enough down to say how far
 * away it is.
 */
function bestMove(
  terms: SerpPanelTerm[],
): { term: SerpPanelTerm; caption: string } | null {
  const ranked = terms.filter((term) => term.bestRank !== null);
  const nearest = (floor: number) =>
    ranked
      .filter((term) => term.bestRank! > floor)
      .sort((left, right) => left.bestRank! - right.bestRank!)[0];
  const pageOne = nearest(10);
  if (pageOne) {
    return { term: pageOne, caption: `#${formatInt(pageOne.bestRank!)} → top 10` };
  }
  const topThree = nearest(3);
  if (topThree) {
    return { term: topThree, caption: `#${formatInt(topThree.bestRank!)} → top 3` };
  }
  return null;
}

// --- the series the four charts do not lead with ---------------------------

interface CollectedSpec {
  key: string;
  label: string;
  trend: SignalTrend;
  /** A stored daily rate supplies its chart coverage; the period calculation
   * uses original counts rather than reverse-engineering rounded rates. */
  values?: SignalTrend;
  format: (value: number) => string;
  aggregate: "total" | "ratio" | "weighted-mean";
  weights?: SignalTrend;
  secondary: string;
  /** Inverts the direction chip only — the line stays neutral ink, so nothing
   * but the arrow and its tone claims a judgement. */
  lowerIsBetter?: boolean;
}

/**
 * The other four series the OS collects, as one strip with sparklines:
 * context for the charts above. Sessions is not here, because it is a chart
 * above. The direction chip states improvement, not raw movement: a falling
 * average position is an improving one, and "arrow up, green" has to mean the
 * same thing on every row of the page.
 */
function AlsoCollected({
  performance,
  days,
}: {
  performance: AssetDetailPayload["performance"];
  days: RangeDays;
}) {
  const all: CollectedSpec[] = [
    {
      key: "page-views",
      label: "Page views",
      trend: performance.pageViews,
      format: formatInt,
      aggregate: "total",
      secondary: "pages opened",
    },
    {
      key: "events",
      label: "Events",
      trend: performance.events,
      format: formatInt,
      aggregate: "total",
      secondary: "tracked actions",
    },
    {
      key: "search-ctr",
      label: "Click rate",
      trend: performance.searchCtr,
      values: performance.webSearchClicks.google,
      weights: performance.webSearchImpressions.google,
      format: (value) => `${(value * 100).toFixed(1)}%`,
      aggregate: "ratio",
      secondary: "clicks ÷ impressions",
    },
    {
      key: "search-position",
      label: "Average position",
      trend: performance.searchPosition,
      weights: performance.webSearchImpressions.google,
      format: (value) => value.toFixed(1),
      aggregate: "weighted-mean",
      secondary: "weighted by impressions",
      lowerIsBetter: true,
    },
  ];
  // Fewer than three reported days is no trend: a cell that is not there
  // rather than a dash pretending to a series.
  const specs = all.filter((spec) => spec.trend.series.length >= 3);
  if (specs.length === 0) return null;

  return (
    <section id="also-collected" className="scroll-mt-4 flex flex-col gap-2">
      <SectionLabel
        title="Also collected"
        caption={
          <SectionCaption
            label="About supporting metrics"
            text="The same window, from the same reports"
            caveat={sectionCaveat(
              specs.map((spec) => spec.trend),
              days,
            )}
          />
        }
      />
      <SmallMultipleStrip columns={4}>
        {specs.map((spec) => (
          <CollectedCell key={spec.key} spec={spec} days={days} />
        ))}
      </SmallMultipleStrip>
    </section>
  );
}

function CollectedCell({ spec, days }: { spec: CollectedSpec; days: RangeDays }) {
  const { trend } = spec;
  const weighted = spec.weights && spec.aggregate !== "total"
    ? weightedMetricWindow(spec.values ?? trend, spec.weights, days, spec.aggregate)
    : null;
  const delta = weighted ? weighted.delta : periodDelta(
    trend.series,
    days,
    trend.timeZoneChanges,
    trend.provisionalFrom,
  );
  const window = windowSeries(
    settledSeries(trend.series, trend.provisionalFrom),
    days,
  );
  const total = window.reduce((sum, point) => sum + point.v, 0);
  const value = weighted ? weighted.value : window.length < 3 ? null : total;
  const improvement =
    delta === null || delta.percent === null
      ? null
      : spec.lowerIsBetter
        ? -delta.percent
        : delta.percent;

  return (
    <SmallMultiple
      label={spec.label}
      value={value === null ? "—" : spec.format(value)}
      secondary={
        delta === null || (delta.comparable && improvement === null) ? (
          spec.secondary
        ) : (
          <span
            className="inline-flex items-center gap-1"
            data-collected-delta={spec.key}
          >
            <MovementChip delta={delta} percent={improvement} className="text-[11px]" />
            {spec.secondary}
          </span>
        )
      }
      spark={weighted ? weighted.spark : window}
      format={spec.format}
    />
  );
}

// --- product use -----------------------------------------------------------

/**
 * What people did in the product, as one strip. The strip draws no total,
 * because a person can appear under more than one action. No sparkline,
 * because there is no series: the snapshot is one exact rolling aggregate
 * over its own window.
 */
function ProductUse({ snapshot }: { snapshot: ProductUseSnapshot | null }) {
  if (!snapshot) return null;
  const metrics: ProductUseMetric[] = [
    ...snapshot.build,
    ...snapshot.sharing,
    ...snapshot.supporting,
  ];
  if (metrics.length === 0) return null;
  const comparisons = metrics.flatMap((metric) => {
    if (!metric.compareTo) return [];
    const base = metrics.find((other) => other.eventName === metric.compareTo);
    return base?.users && metric.users !== null
      ? [{ key: metric.eventName, label: metric.comparisonLabel ?? `${metric.label} ratio`, value: metric.users / base.users,
          numerator: metric.users, denominator: base.users, declared: true }]
      : [];
  });
  // Already-stored snapshots predate declarations. This reads their internal
  // keys only; new analysis never selects a product's event names.
  if (!metrics.some((metric) => metric.compareTo !== undefined)) {
    const opened = snapshot.build.find((metric) => metric.key === "item-openers");
    const added = snapshot.build.find((metric) => metric.key === "builder-users");
    if (opened?.users && added?.users !== null && added?.users !== undefined) {
      comparisons.push({ key: added.key, label: "Added of opened", value: added.users / opened.users,
        numerator: added.users, denominator: opened.users, declared: false });
    }
  }

  return (
    <section id="product-use" className="scroll-mt-4 flex flex-col gap-2">
      {/* "Fixed" and its own dates say the range selector does not move it; no
          total is drawn, because one person can take several of these actions. */}
      <SectionLabel
        title={`Product use · last ${formatInt(snapshot.days)} days`}
        caption={formatCalendarRange(snapshot.windowStart, snapshot.windowEnd)}
      />
      <SmallMultipleStrip columns={5}>
        {comparisons.map((comparison) => (
          <SmallMultiple
            key={`comparison:${comparison.key}`}
            label={comparison.label}
            value={
              <span data-small-multiple={comparison.label} title={comparison.declared ? "Independent event-user volumes, not a same-person conversion" : undefined}>
                {Math.round(comparison.value * 100)}%
              </span>
            }
            secondary={`${formatInt(comparison.numerator)} of ${formatInt(comparison.denominator)}`}
          />
        ))}
        {metrics.map((metric) => (
          <SmallMultiple
            key={metric.key}
            label={metric.label}
            value={
              <span
                data-small-multiple={metric.label}
                title={
                  metric.users === null
                    ? `Google Analytics returned no ${metric.eventName} row in this window`
                    : `${formatInt(metric.users)} people, ${formatInt(metric.events ?? 0)} ${metric.eventName} events`
                }
              >
                {metric.users === null ? "—" : formatInt(metric.users)}
              </span>
            }
            secondary={
              metric.users === null
                ? "none recorded"
                : `${formatInt(metric.events ?? 0)} times`
            }
          />
        ))}
      </SmallMultipleStrip>
    </section>
  );
}
