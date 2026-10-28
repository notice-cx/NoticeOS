import { PurposeSections } from "./purpose-presentation";
import type { ReactNode } from "react";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { Link } from "react-router-dom";
import { AnalysisEvidence, useAnalysisValidity } from "@/components/AnalysisEvidence";
import type {
  SearchIntelligenceSnapshot,
  SearchQueryProviderTrend,
  SearchQueryTrends,
  SerpCompetitor,
} from "@shared/asset-detail";
import { connectable, connectHref, firstToConnect } from "@shared/connect-panel";
import { sourceReadings } from "@shared/connection-status";
import { integrationLabel } from "@shared/integrations";
import type { SignalTrend } from "@shared/wall";
import type { WatchSeed } from "@shared/watch-windows";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { EmptyState } from "@/components/EmptyState";
import { PageDecisions } from "@/components/PageDecisions";
import { QueryVisibilityRankings } from "@/components/QueryVisibilityRankings";
import { SerpPanelBoard } from "@/components/SerpPanelBoard";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { formatCalendarDate, formatCalendarRange, formatInt, formatPercent, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { ChangeRows, type ChangeRow } from "@/components/viz/ChangeRows";
import { FunnelBars } from "@/components/viz/FunnelBars";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import { timelineAnnotations } from "@/routes/asset-detail/shared";
import { SearchPair } from "@/routes/asset-detail/trend-panels";
import { useRange } from "@/routes/asset-detail/useRange";

/**
 * The Search tab: which term, which page, which domain. Growth asks which way
 * the numbers went; this answers which one. Everything opens collapsed: the
 * panel shows its scoreboard and its first terms, the two decision lists show
 * three rows each, and the search context is four strips of numbers with its
 * reference tables behind one disclosure. The saved analysis's applicability
 * is said once, at the top.
 */
export function SearchTab({
  data,
  nowMs,
  onWatch,
}: {
  data: AssetDetailFor<"search">;
  nowMs: number;
  onWatch: (seed: WatchSeed) => void;
}) {
  const pathFor = useAssetTabPath();
  const panel = data.executive?.serpPanel ?? null;
  const intelligence = data.executive?.searchIntelligence ?? null;
  const hasDecisions =
    (data.executive?.searchQueries ?? null) !== null ||
    (data.executive?.searchPages ?? null) !== null;
  const analysis = useAnalysisValidity(
    data.executive ?? { generatedAt: "", windowStart: null, windowEnd: null },
  );
  // What the line at the top of this tab already says, so neither list says
  // it again. Nothing is stated when there is no saved analysis to state.
  const statedState = data.executive ? analysis.state : null;

  // Never a blank tab: a site with no tracked panel, decisions or search
  // context opens on its own search numbers and the one step to tracking
  // terms, or, with no search numbers at all, the one step to a search source.
  if (!panel && !hasDecisions && !intelligence) return <SearchStart data={data} nowMs={nowMs} />;
  const moved = queryMoves(data.executive?.searchQueries ?? null);
  // The block that is this tab's answer (`audit:surfaces`): which queries
  // moved, else the tracked panel, else the decision lists.
  const hero = moved ? "moves" : panel ? "panel" : hasDecisions ? "decisions" : "context";

  return (
    <PurposeSections surface="search" id="search-evidence" className="@container flex scroll-mt-4 flex-col gap-5">
      {data.executive ? <AnalysisEvidence key="analysis" snapshot={data.executive} /> : null}
      {moved ? (
        <div key="moves" data-surface-hero="">
          <ChangeRows
            id="search-moves"
            title="Queries that moved"
            caption={`${moved.provider} · ${formatCalendarRange(moved.lane.currentStart, moved.lane.currentEnd)}`}
            against={`vs the ${moved.lane.daysPerWindow} days before`}
            rows={moved.rows}
          />
        </div>
      ) : null}
      {panel ? (
        // No section eyebrow over it: `SerpPanelBoard` draws its own heading
        // and its own collection line. The one thing this tab owes it that
        // the board cannot know is where the panel's trend lives, and that
        // goes beside the board rather than over it.
        <section key="panel" id="serp-panel" {...(hero === "panel" ? { "data-surface-hero": "" } : {})} className="scroll-mt-4 min-w-0">
          <SerpPanelBoard panel={panel} collapsed />
          <Link
            to={`${pathFor(data.asset.id, "growth")}#panel-scoreboard`}
            className="mt-1 inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            How search terms move →
          </Link>
        </section>
      ) : null}

      {hasDecisions ? (
        // No card around the pair: both lists already carry their own rules
        // and their own hairlines.
        <div key="decisions" className="grid min-w-0 gap-3.5" {...(hero === "decisions" ? { "data-surface-hero": "" } : {})}>
          <QueryVisibilityRankings
            trends={data.executive?.searchQueries ?? null}
            asset={data.asset}
            handoffBeads={data.handoffBeads}
            onWatch={onWatch}
            statedState={statedState}
            collapsed
          />
          {/* Directly under the query list, because they are the same four
              decisions on two grains and an operator reads down from the term
              to the page that answers it. */}
          <PageDecisions
            pages={data.executive?.searchPages ?? null}
            asset={data.asset}
            handoffBeads={data.handoffBeads}
            annotations={data.annotations}
            statedState={statedState}
            collapsed
          />
        </div>
      ) : null}

      <SearchContext key="context" snapshot={intelligence} hero={hero === "context"} />

      {/* What the panel buys is on Settings, with the spend meter. Search keeps
          the board, the evidence, which is what this tab is for. */}

    </PurposeSections>
  );
}

// --- which queries moved -----------------------------------------------------

/** The most queries the board draws: the ones that moved most. */
const MOVES_SHOWN = 8;

/**
 * The queries whose impressions moved most between the saved analysis's two
 * like-for-like windows, from one provider (Google first; the two report
 * different horizons and are never added). Each row is its impressions now,
 * the change as a bar from the shared zero line and where it sits on the
 * results page now against where it sat before. Null when the analysis holds
 * no comparison.
 */
function queryMoves(trends: SearchQueryTrends | null): { provider: string; lane: SearchQueryProviderTrend; rows: ChangeRow[] } | null {
  const lane = trends?.google ?? trends?.bing ?? null;
  if (!lane || lane.movers.length === 0) return null;
  const provider = lane === trends?.google ? "Google" : "Bing";
  const movers = [...lane.movers]
    .sort((a, b) => Math.abs(b.impressionDelta) - Math.abs(a.impressionDelta) || a.query.localeCompare(b.query))
    .slice(0, MOVES_SHOWN);
  const deepest = Math.max(20, ...movers.flatMap((mover) => [mover.currentPosition, mover.previousPosition]));
  return {
    provider,
    lane,
    rows: movers.map((mover): ChangeRow => {
      const percent = mover.previousImpressions > 0 ? mover.impressionDeltaPercent : null;
      return {
        key: mover.query,
        label: mover.query,
        figure: formatInt(mover.currentImpressions),
        unit: "impressions",
        improvement: percent,
        change: percent === null ? (
          <span className="text-muted-foreground">new this week</span>
        ) : (
          <DeltaChip
            value={percent}
            render={(value) => `${formatPercent(value)}%`}
            tone={performanceTone(percent)}
            meaning={`${formatInt(mover.currentImpressions)} impressions against ${formatInt(mover.previousImpressions)} the ${lane.daysPerWindow} days before`}
            className="text-xs"
          />
        ),
        history: <PositionMove previous={mover.previousPosition} current={mover.currentPosition} deepest={deepest} />,
        marks: { "data-subject": `query:${mover.query}` },
      };
    }),
  };
}

/**
 * Where a query sits on the results page, now against before: a ruler from
 * first place down, a ring where it was, a dot where it is, the move between
 * them drawn in the better or the worse ink. Position 1 is at the left, so a
 * dot that moved left climbed.
 */
function PositionMove({ previous, current, deepest }: { previous: number; current: number; deepest: number }) {
  const at = (position: number) => `${((Math.min(position, deepest) - 1) / Math.max(deepest - 1, 1)) * 100}%`;
  const climbed = current < previous;
  const position = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  const from = Math.min(previous, current);
  const to = Math.max(previous, current);
  return (
    <span className="flex min-w-0 flex-col gap-1" data-position-move={climbed ? "up" : current > previous ? "down" : "level"}>
      <span
        role="img"
        aria-label={`Average position ${position(previous)} before, ${position(current)} now`}
        className="relative block h-4"
      >
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-viz-track" />
        <span aria-hidden className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-traffic/20" style={{ insetInlineStart: 0, width: at(10) }} />
        <span
          aria-hidden
          className={cn("absolute top-1/2 h-0.5 -translate-y-1/2", climbed ? "bg-trend-positive" : "bg-trend-negative")}
          style={{ insetInlineStart: at(from), width: `calc(${at(to)} - ${at(from)})` }}
        />
        <span aria-hidden className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-muted-foreground/70 bg-card" style={{ insetInlineStart: at(previous) }} />
        <span aria-hidden className={cn("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card", climbed ? "bg-trend-positive" : current > previous ? "bg-trend-negative" : "bg-foreground")} style={{ insetInlineStart: at(current) }} />
      </span>
      <span aria-hidden className="flex justify-between gap-2 text-micro tabular-nums text-muted-foreground">
        <span>#1</span>
        <span className="text-foreground">{position(previous)} → {position(current)}</span>
        <span>#{Math.round(deepest)}</span>
      </span>
    </span>
  );
}

// --- before the site tracks anything ---------------------------------------

/** The sources a site's search clicks and impressions come from. */
const SEARCH_SOURCES = new Set(["gsc", "bing-webmaster"]);

const hasPoints = (trend: SignalTrend) => trend.series.length > 0 || (trend.contextSeries?.length ?? 0) > 0;

/**
 * The Search tab before any tracked term, and its one next step: with search
 * numbers, Growth's search pair (one rendering, so clicks are one fact on both
 * tabs) and a button to start tracking terms; with none, a button to connect
 * the site's first search source.
 */
function SearchStart({ data, nowMs }: { data: AssetDetailFor<"search">; nowMs: number }) {
  const { days } = useRange();
  const pathFor = useAssetTabPath();
  const connections = useConnections();
  const id = data.asset.id;
  const { performance } = data;
  const readings = sourceReadings(id, data.integrations.sources, connections, nowMs);
  const searched = [
    performance.webSearchClicks.google,
    performance.webSearchClicks.bing,
    performance.webSearchImpressions.google,
    performance.webSearchImpressions.bing,
  ].some(hasPoints);

  if (searched) {
    const dataforseo = readings.find((reading) => reading.id === "dataforseo") ?? null;
    const step = dataforseo === null || connectable(dataforseo)
      ? { label: "Connect DataForSEO", to: connectHref("dataforseo", id) }
      : { label: "Track search terms", to: `${pathFor(id, "settings")}#tracked-panels` };
    return (
      <div id="search-evidence" data-search-start="numbers" className="flex scroll-mt-4 flex-col gap-3.5">
        <div data-surface-hero>
          <SearchPair
            performance={performance}
            days={days}
            asset={data.asset.displayName}
            timeline={timelineAnnotations(data.annotations.items)}
          />
        </div>
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-4 py-3" data-search-next>
          <SectionLabel title="Tracked terms" caption="none yet" />
          <Button asChild size="sm">
            <Link to={step.to}>{step.label}</Link>
          </Button>
        </section>
      </div>
    );
  }

  const source = firstToConnect(readings.filter((reading) => SEARCH_SOURCES.has(reading.id)));
  return (
    <section
      id="search-evidence"
      data-surface-hero
      data-search-start="none"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border bg-card px-4 py-3"
    >
      <EmptyState title="No search numbers yet" />
      <Button asChild size="sm">
        {source !== null && source.provider !== null ? (
          <Link to={connectHref(source.provider, id)}>Connect {integrationLabel(source.id, source.label)}</Link>
        ) : (
          <Link to={pathFor(id, "sources")}>Open Data sources</Link>
        )}
      </Button>
    </section>
  );
}

// --- the search context ------------------------------------------------------

/**
 * What the weekly provider pull bought, drawn beside the queries and pages it
 * is context for. The money figure leads: it is the only number here
 * denominated in something the operator spends, and the counts beside it are
 * the evidence for it. The rankings narrow as a funnel on one ruler; links
 * gained and lost, the AI platforms and the competitors are one press away,
 * each as bars on its own ruler. A figure the provider did not state is a
 * hatched track and a word, never a zero.
 */
function SearchContext({
  snapshot,
  hero = false,
}: {
  snapshot: SearchIntelligenceSnapshot | null;
  /** The tab's answer when it holds nothing else. */
  hero?: boolean;
}) {
  if (!snapshot) return null;
  const { rankings } = snapshot;
  const links = snapshot.backlinks;
  // A platform whose row stated no figure is unknown, never zero, and a total
  // over an unknown is not a total.
  const { googleMentions, chatgptMentions, googleSearchVolume, chatgptSearchVolume } =
    snapshot.ai;
  const aiMentions =
    googleMentions === null || chatgptMentions === null
      ? null
      : googleMentions + chatgptMentions;
  const platformMentions = (value: number | null, platform: string) =>
    value === null ? `${platform} not reported` : `${formatInt(value)} ${platform}`;
  /**
   * The idea worth acting on, which is NOT the biggest one. Ranked by volume
   * alone the head is always the hardest term in the niche; volume over
   * difficulty asks what is winnable at scale, which is the question the family
   * was bought to answer.
   */
  const bestIdea = [...snapshot.keywordIdeas]
    .filter((idea) => idea.searchVolume > 0)
    .sort(
      (a, b) =>
        b.searchVolume / Math.max(b.difficulty, 1) -
        a.searchVolume / Math.max(a.difficulty, 1),
    )[0];
  const competitors = [...snapshot.competitors]
    .sort((a, b) => b.overlapShare - a.overlapShare)
    .slice(0, 5);
  const cell = (name: string) => ({ "data-context-cell": name });

  return (
    <section id="search-context" {...(hero ? { "data-surface-hero": "" } : {})} className="@container scroll-mt-4 flex flex-col gap-2">
      {/* "Modelled" and the snapshot's date are the section's whole caveat:
          a provider's estimate of the market, dated, never this asset's own
          traffic (Search Console and Analytics are on the Growth tab). */}
      <SectionLabel
        title="Search context"
        caption={
          snapshot.observedAt
            ? `Modelled · ${formatCalendarDate(snapshot.observedAt)}`
            : "Modelled"
        }
      />

      <div className="grid gap-x-10 gap-y-5 rounded-xl bg-card p-5 ring-1 ring-border/70 @3xl:grid-cols-[minmax(12rem,1fr)_minmax(0,2.5fr)]">
        {/* Ahrefs' "traffic value": the estimated visits priced as ads. The
            line under it says both halves, so it needs no hover. */}
        <div className="flex min-w-0 flex-col gap-1" {...cell("traffic-value")}>
          <span className="text-xs font-medium text-muted-foreground">Traffic value</span>
          <span className="text-figure tabular-nums text-foreground">{formatUsd(rankings.estimatedPaidTrafficCost)}</span>
          <span className="text-xs text-muted-foreground">{formatInt(rankings.estimatedVisits)} visits a month, priced as ads</span>
        </div>
        <FunnelBars
          ariaLabel={`Keywords ranking: ${formatInt(rankings.keywords)}, ${formatInt(rankings.top20)} in the top 20, ${formatInt(rankings.top10)} in the top 10, ${formatInt(rankings.top3)} in the top 3, ${formatInt(rankings.aiOverviewReferences)} cited in AI Overviews`}
          steps={[
            { key: "keywords", label: "Keywords", value: rankings.keywords, note: "ranking somewhere", fill: "bg-foreground/30", marks: cell("keywords") },
            { key: "top20", label: "Top 20", value: rankings.top20, fill: "bg-traffic/45", marks: cell("top20") },
            { key: "top10", label: "Top 10", value: rankings.top10, fill: "bg-traffic/70", marks: cell("top10") },
            { key: "top3", label: "Top 3", value: rankings.top3, fill: "bg-traffic", marks: cell("top3") },
            { key: "ai-overviews", label: "In AI Overviews", value: rankings.aiOverviewReferences, note: "keywords citing us", fill: "bg-foreground/45", marks: cell("ai-overviews") },
          ]}
        />
      </div>

      {/* The rankings above answer what the asset's search position is
          worth; links, AI mentions and competitors qualify that answer and
          are one press away with the rows they are drawn from. */}
      <details className="rounded-xl bg-card ring-1 ring-border/70">
        <summary className="flex min-h-11 cursor-pointer list-none items-center px-5 text-xs text-muted-foreground hover:text-foreground">
          More context · links, AI mentions, competitors
        </summary>
        <div data-context-more className="flex flex-col gap-5 px-5 pb-5">
          <div className="grid gap-x-10 gap-y-6 @3xl:grid-cols-2">
            <ContextGroup title="Links" figure={links ? formatInt(links.referringDomains) : "—"} caption={links ? "linking domains point here" : "no link report"} marks={cell("linking-domains")}>
              <FunnelBars
                ariaLabel={links ? `Linking domains in 90 days: ${formatInt(links.newReferringDomains)} gained, ${formatInt(links.lostReferringDomains)} lost` : "No link report"}
                max={links ? Math.max(links.newReferringDomains, links.lostReferringDomains, 1) : undefined}
                steps={[
                  { key: "gained", label: "Gained", value: links?.newReferringDomains ?? null, note: links ? "in 90 days" : "no link report", fill: "bg-trend-positive", marks: cell("gained") },
                  { key: "lost", label: "Lost", value: links?.lostReferringDomains ?? null, note: links ? "in 90 days" : "no link report", fill: "bg-trend-negative", marks: cell("lost") },
                ]}
              />
              <dl className="m-0 grid grid-cols-3 gap-x-4 text-xs">
                <ContextFact label="Links" value={links ? formatInt(links.backlinks) : "—"} note="individual" marks={cell("links")} />
                {/* The provider's own strength score, 0 to 1000. */}
                <ContextFact label="Domain rank" value={links ? formatInt(links.rank) : "—"} note="of 1,000" marks={cell("domain-rank")} />
                {/* Spam is counted as DOMAINS: one link farm mints a hundred
                    anchor variants, and counting those would overstate one
                    attacker into a crisis. */}
                <ContextFact
                  label="Spammy anchors"
                  value={snapshot.anchors === null ? "—" : formatInt(snapshot.anchors.spammyDomains)}
                  note={snapshot.anchors === null ? "not sampled" : `domains, of ${formatInt(snapshot.anchors.sampled)} anchors`}
                  marks={cell("spammy-anchors")}
                />
              </dl>
            </ContextGroup>

            <ContextGroup title="AI mentions" figure={aiMentions === null ? "—" : formatInt(aiMentions)} caption={`${platformMentions(googleMentions, "Google")} · ${platformMentions(chatgptMentions, "ChatGPT")}`} marks={cell("ai-mentions")}>
              <FunnelBars
                ariaLabel="Searches a month on each platform"
                max={Math.max(googleSearchVolume ?? 0, chatgptSearchVolume ?? 0, 1)}
                steps={[
                  { key: "google-demand", label: "Google demand", value: googleSearchVolume, note: googleSearchVolume === null ? "not reported" : "searches a month", fill: "bg-foreground/45", marks: cell("google-demand") },
                  { key: "chatgpt-demand", label: "ChatGPT demand", value: chatgptSearchVolume, note: chatgptSearchVolume === null ? "not reported" : "searches a month", fill: "bg-foreground/45", marks: cell("chatgpt-demand") },
                ]}
              />
            </ContextGroup>
          </div>

          <div className="grid gap-x-10 gap-y-6 @3xl:grid-cols-2">
            {competitors.length > 0 ? (
              <ContextGroup title="Competitors" caption="share of their keywords that overlap ours">
                <FunnelBars
                  ariaLabel="Competitors by keyword overlap"
                  max={Math.max(...competitors.map((entry) => entry.overlapShare * 100), 0.01)}
                  format={(value) => overlapPercent(value)}
                  steps={competitors.map((entry) => ({
                    key: entry.domain,
                    label: <span className="break-all">{entry.domain}</span>,
                    value: entry.competitorKeywords <= 0 ? null : entry.overlapShare * 100,
                    note: `${formatInt(entry.intersections)} shared`,
                    fill: "bg-foreground/45",
                    marks: cell(`competitor:${entry.domain}`),
                  }))}
                />
              </ContextGroup>
            ) : null}
            <ContextGroup title="Opportunities" figure={snapshot.keywordIdeas.length === 0 ? "—" : formatInt(snapshot.keywordIdeas.length)} caption="terms we do not rank for" marks={cell("ideas")}>
              <div className="flex flex-col gap-0.5 text-xs" {...cell("best-opportunity")}>
                <span className="text-muted-foreground">Best opportunity</span>
                {bestIdea ? (
                  <>
                    <span className="text-sm font-semibold text-foreground">{bestIdea.keyword}</span>
                    <span className="tabular-nums text-muted-foreground">{formatInt(bestIdea.searchVolume)} a month, difficulty {formatInt(bestIdea.difficulty)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">no ideas collected yet</span>
                )}
              </div>
            </ContextGroup>
          </div>

          <SearchContextRows snapshot={snapshot} />
        </div>
      </details>
    </section>
  );
}

/** One group of the context: its name, its lead figure and what it counts,
 * then its bars. */
function ContextGroup({
  title,
  figure,
  caption,
  marks,
  children,
}: {
  title: string;
  figure?: string;
  caption?: string;
  marks?: Record<`data-${string}`, string>;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2" {...marks}>
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {figure ? <span className="text-figure-sm tabular-nums text-foreground">{figure}</span> : null}
        {caption ? <span className="text-xs text-muted-foreground">{caption}</span> : null}
      </div>
      {children}
    </div>
  );
}

function ContextFact({ label, value, note, marks }: { label: string; value: string; note: string; marks: Record<`data-${string}`, string> }) {
  return (
    <div className="flex min-w-0 flex-col" {...marks}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 text-sm font-semibold tabular-nums text-foreground">{value}</dd>
      <dd className="m-0 text-micro text-muted-foreground">{note}</dd>
    </div>
  );
}

/** Overlap share, readable at the magnitudes it actually takes: a focused
 * competitor overlaps on a fraction of a percent, which rounded to whole
 * percent reads "0%", so anything under one percent keeps two decimals. */
function overlapPercent(percent: number): string {
  return percent >= 1 ? `${Math.round(percent)}%` : `${percent.toFixed(2)}%`;
}

function overlapValue(entry: SerpCompetitor): string {
  if (entry.competitorKeywords <= 0) return "—";
  return overlapPercent(entry.overlapShare * 100);
}

/** The rows behind the strips, in one closed disclosure: the strips answer
 * "is anything happening"; these reference tables answer "what, exactly". */
function SearchContextRows({
  snapshot,
}: {
  snapshot: SearchIntelligenceSnapshot;
}) {
  const tables = [
    snapshot.referringDomains.length > 0
      ? {
          key: "domains",
          summary: `Linking domains · ${formatInt(snapshot.referringDomains.length)} named, best ranked first`,
          head: ["Domain", "Rank", "Links", "Spam", "First found"],
          rows: snapshot.referringDomains.map((entry) => [
            entry.domain,
            formatInt(entry.rank),
            formatInt(entry.backlinks),
            formatInt(entry.spamScore),
            entry.firstSeen ? entry.firstSeen.slice(0, 10) : "—",
          ]),
        }
      : null,
    snapshot.anchors && snapshot.anchors.top.length > 0
      ? {
          key: "anchors",
          summary: `Anchors · ${formatInt(snapshot.anchors.sampled)} sampled, ${formatInt(snapshot.anchors.spammy)} spammy`,
          head: ["Anchor", "Domains", "Links", "Spam"],
          rows: snapshot.anchors.top.map((entry) => [
            entry.anchor,
            formatInt(entry.referringDomains),
            formatInt(entry.backlinks),
            formatInt(entry.spamScore),
          ]),
        }
      : null,
    snapshot.keywordIdeas.length > 0
      ? {
          key: "ideas",
          summary: `Keyword ideas · ${formatInt(snapshot.keywordIdeas.length)} terms this asset does not rank for`,
          head: ["Keyword", "Searches a month", "Difficulty", "Cost per click", "Intent"],
          rows: snapshot.keywordIdeas.map((idea) => [
            idea.keyword,
            formatInt(idea.searchVolume),
            formatInt(idea.difficulty),
            formatUsd(idea.cpc, { cents: true }),
            idea.intent ?? "—",
          ]),
        }
      : null,
    snapshot.competitors.length > 0
      ? {
          key: "competitors",
          summary: `Competitors · ${formatInt(snapshot.competitors.length)}, by the share of their keywords that overlap ours`,
          head: ["Domain", "Overlap", "Shared", "Their keywords", "Average position"],
          rows: snapshot.competitors.map((entry) => [
            entry.domain,
            overlapValue(entry),
            formatInt(entry.intersections),
            formatInt(entry.competitorKeywords),
            entry.avgPosition.toFixed(1),
          ]),
        }
      : null,
  ].filter((table) => table !== null);

  if (tables.length === 0) return null;

  return (
    // One door, not four; the tables inside keep their own summaries, so
    // nothing about what is behind each one is hidden.
    <details className="rounded-[10px] border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-xs text-muted-foreground hover:text-foreground">
        The rows behind these numbers · {formatInt(tables.length)}{" "}
        {tables.length === 1 ? "table" : "tables"}
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        {tables.map((table) => (
          <details key={table.key} className="rounded-md border border-border/60">
            <summary className="flex min-h-11 cursor-pointer list-none items-center px-2.5 text-xs text-muted-foreground hover:text-foreground">
              {table.summary}
            </summary>
            {/* Its own horizontal scroller: a long anchor string must never
                make the page scroll sideways. */}
            <div className="overflow-x-auto px-2.5 pb-2.5">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    {table.head.map((cell) => (
                      <th key={cell} className="py-1 pr-3 font-medium">
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((cells, index) => (
                    <tr
                      key={`${table.key}:${index}`}
                      className="border-t border-border/60"
                    >
                      {cells.map((cell, cellIndex) => (
                        <td
                          key={`${cellIndex}:${cell}`}
                          className={
                            cellIndex === 0 ? "py-1 pr-3" : "py-1 pr-3 tabular-nums"
                          }
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
