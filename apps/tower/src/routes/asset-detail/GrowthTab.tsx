import { PurposeSections } from "./purpose-presentation";
import type { CSSProperties } from "react";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type {
  ProductUseMetric,
  ProductUseSnapshot,
  SerpPanelSnapshot,
  SerpPanelTerm,
} from "@shared/asset-detail";
import { serpPanelTerms } from "@shared/asset-detail";
import type { RangeDays } from "@shared/surface";
import type { WatchSeed } from "@shared/watch-windows";
import { ProductJourney } from "@/components/ProductJourney";
import { PanelOverviews, PanelRanks, serpPanelScope } from "@/components/SerpPanelBoard";
import { productConnection } from "@shared/product";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { BarStrip } from "@/components/viz/BarStrip";
import { ChangeRows, changeScale, type ChangeRow } from "@/components/viz/ChangeRows";
import { formatCalendarRange, formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import { growthMoves, type GrowthMove } from "@/routes/asset-detail/growth-moves";
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
 * The Growth tab answers one question, which way did the numbers go. It opens
 * on every series the site collects, each against the window before it, as
 * bars that rise or fall from one zero line; then the four charts with their
 * marks, the tracked search terms as a funnel, and what people did in the
 * product. The header range moves the board and the charts; the snapshots
 * below name their own windows.
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
  const moves = growthMoves(performance, days);

  return (
    <PurposeSections surface="growth" id="growth-evidence" className="@container flex scroll-mt-4 flex-col gap-5">
      {moves.length > 0 ? <Moves key="moves" moves={moves} days={days} /> : null}

      <section key="audience"
        id="performance"
        // With no series to compare, the audience pair is the answer
        // (`audit:surfaces` wants exactly one hero per tab).
        {...(moves.length === 0 ? { "data-surface-hero": "" } : {})}
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
        <div className="grid min-w-0 gap-3.5 @4xl:grid-cols-2">
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

      <SearchPair key="search"
        performance={performance}
        days={days}
        asset={data.asset.displayName}
        timeline={timeline}
        action={{ to: searchTab, label: "Search →" }}
      />

      {/* The analysis's age is Search's to state, beside the findings it
          dates; Growth draws the numbers. */}
      <PanelSummary key="panel" panel={data.executive?.serpPanel ?? null} searchTab={searchTab} />

      <ProductUse key="product" snapshot={data.executive?.productUse ?? null} />

      {/* What people do once they arrive, and where it breaks. Its header
          names PostHog as the source, so its numbers are never read as
          Google's. */}
      <ProductJourney key="journey"
        product={data.executive?.product ?? null}
        connection={productConnection(data.integrations.lanes)}
      />
    </PurposeSections>
  );
}

// --- which way it went -------------------------------------------------------

/**
 * Every collected series against the window before it, as two ruled panels
 * on one scale: visitors and what they did, then how the site shows in
 * search. A rate's arrow states improvement, not raw movement: a falling
 * average position is an improving one, and "right, green" means better on
 * every row of the page.
 */
function Moves({ moves, days }: { moves: readonly GrowthMove[]; days: RangeDays }) {
  const scale = changeScale(moves.map((move) => move.improvement));
  const groups = [
    { key: "audience", title: "Visitors", rows: moves.filter((move) => move.group === "audience") },
    { key: "search", title: "In search", rows: moves.filter((move) => move.group === "search") },
  ].filter((group) => group.rows.length > 0);
  return (
    <section
      id="growth-moves"
      data-surface-hero=""
      aria-label={`Which way it went · last ${days} days`}
      className={cn("grid scroll-mt-4 gap-5", groups.length > 1 && "@5xl:grid-cols-2")}
    >
      {groups.map((group) => (
        <ChangeRows
          key={group.key}
          title={group.title}
          caption={`last ${days} days`}
          against={`vs prior ${days} days`}
          scale={scale}
          rows={group.rows.map((move) => moveRow(move, days))}
          className="h-full"
        />
      ))}
    </section>
  );
}

function moveRow(move: GrowthMove, days: RangeDays): ChangeRow {
  const first = move.days[0]?.t;
  const last = move.days.at(-1)?.t;
  return {
    key: move.key,
    label: move.label,
    figure: move.value === null ? null : move.format(move.value),
    unit: move.unit,
    absent: move.absent,
    improvement: move.improvement,
    change: <MoveChange move={move} days={days} />,
    history:
      move.days.length >= 3 && first && last ? (
        <BarStrip
          data={move.days}
          tone={move.tone}
          provisionalFrom={move.provisionalFrom}
          partial={move.partial}
          baseline={move.baseline === null ? null : { value: move.baseline, label: `prior ${move.stripFormat(move.baseline)}` }}
          format={move.stripFormat}
          ariaLabel={`${move.label}, ${formatSeriesDate(first)} to ${formatSeriesDate(last)}`}
          className="h-12"
        />
      ) : undefined,
  };
}

/** The move in words beside its bar, withheld where the windows cannot be
 * compared; a series with no earlier window says so rather than drawing a
 * level line. */
function MoveChange({ move, days }: { move: GrowthMove; days: RangeDays }) {
  const { delta } = move;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-collected-delta={move.key}>
      {delta === null ? (
        <span className="text-muted-foreground">no earlier {days} days</span>
      ) : delta.comparable && delta.percent === null ? (
        <span className="text-muted-foreground">up from none</span>
      ) : (
        <MovementChip delta={delta} percent={move.improvement} className="text-xs" />
      )}
    </span>
  );
}

// --- the tracked panel -------------------------------------------------------

/**
 * How the tracked search terms are doing, and nothing else: how many of them
 * reach each tier, and what the AI Overview does on them, as the same two
 * funnels the Search tab's board opens with. Then the one term closest to a
 * tier it has not crossed.
 */
function PanelSummary({
  panel,
  searchTab,
}: {
  panel: SerpPanelSnapshot | null;
  searchTab: string;
}) {
  if (!panel) return null;
  const move = bestMove(serpPanelTerms(panel));

  return (
    <section id="panel-scoreboard" className="scroll-mt-4 flex flex-col gap-2">
      <SectionLabel
        title="Search terms"
        caption={serpPanelScope(panel)}
        action={{ to: searchTab, label: "Search terms →" }}
      />
      <div className="@container grid gap-x-8 gap-y-5 rounded-xl bg-card p-5 ring-1 ring-border/70 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PanelRanks panel={panel} />
        <div className="flex min-w-0 flex-col gap-4">
          <PanelOverviews panel={panel} />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-border/60 pt-3 text-xs text-muted-foreground" data-best-move="">
            <span>Closest to the next tier</span>
            {move === null ? (
              <span>nothing within reach</span>
            ) : (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-foreground">{move.term.query}</span>
                <span className="whitespace-nowrap tabular-nums">{move.caption}</span>
              </span>
            )}
          </div>
        </div>
      </div>
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

// --- product use -------------------------------------------------------------

/**
 * What people did in the product, as one bar per action on a shared ruler,
 * most people first, with the declared comparisons beside them. No total is
 * drawn, because one person can take several of these actions, and no
 * sparkline, because the snapshot is one exact rolling aggregate over its own
 * window rather than a series.
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
  const ranked = [...metrics].sort((a, b) => (b.users ?? -1) - (a.users ?? -1));
  const top = Math.max(1, ...metrics.map((metric) => metric.users ?? 0));

  return (
    <section id="product-use" className="scroll-mt-4 flex flex-col gap-2">
      {/* "Fixed" and its own dates say the range selector does not move it; no
          total is drawn, because one person can take several of these actions. */}
      <SectionLabel
        title={`Product use · last ${formatInt(snapshot.days)} days`}
        caption={formatCalendarRange(snapshot.windowStart, snapshot.windowEnd)}
      />
      <div className={cn("@container grid gap-x-8 gap-y-5 rounded-xl bg-card p-5 ring-1 ring-border/70", comparisons.length > 0 && "@3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]")}>
        <ul className="m-0 grid list-none gap-2.5 p-0" aria-label="People who took each action">
          {ranked.map((metric, index) => (
            <li key={metric.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @lg:grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)_minmax(6rem,auto)]" data-product-action={metric.key}>
              <span className="min-w-0 text-xs text-foreground">{metric.label}</span>
              <span aria-hidden className={cn("col-span-2 row-start-2 h-2 overflow-hidden rounded-full @lg:col-span-1 @lg:row-start-auto", metric.users === null ? "text-muted-foreground/50 viz-hatch" : "bg-viz-track")}>
                {metric.users ? (
                  <span className="viz-grow-x block h-full rounded-full bg-traffic/70" style={{ width: `${Math.max(2, (metric.users / top) * 100)}%`, "--viz-i": index } as CSSProperties} />
                ) : null}
              </span>
              <span className="col-start-2 row-start-1 flex flex-col items-end tabular-nums @lg:col-start-auto @lg:row-start-auto">
                <span
                  className="text-sm font-semibold text-foreground"
                  data-small-multiple={metric.label}
                  title={
                    metric.users === null
                      ? `Google Analytics returned no ${metric.eventName} row in this window`
                      : `${formatInt(metric.users)} people, ${formatInt(metric.events ?? 0)} ${metric.eventName} events`
                  }
                >
                  {metric.users === null ? "—" : formatInt(metric.users)}
                </span>
                <span className="text-micro text-muted-foreground">
                  {metric.users === null ? "none recorded" : `${formatInt(metric.events ?? 0)} times`}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {comparisons.length > 0 ? (
          <ul className="m-0 grid list-none content-start gap-4 p-0" aria-label="Comparisons">
            {comparisons.map((comparison) => (
              <li key={`comparison:${comparison.key}`} className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">{comparison.label}</span>
                <span className="flex items-baseline gap-2 tabular-nums">
                  <span
                    className="text-figure-sm text-foreground"
                    data-small-multiple={comparison.label}
                    title={comparison.declared ? "Independent event-user volumes, not a same-person conversion" : undefined}
                  >
                    {Math.round(comparison.value * 100)}%
                  </span>
                  <span className="text-xs text-muted-foreground">{formatInt(comparison.numerator)} of {formatInt(comparison.denominator)}</span>
                </span>
                <span aria-hidden className="h-2 overflow-hidden rounded-full bg-viz-track">
                  {comparison.value > 0 ? (
                    <span className="viz-grow-x block h-full rounded-full bg-traffic" style={{ width: `${Math.max(2, Math.min(100, comparison.value * 100))}%` }} />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
