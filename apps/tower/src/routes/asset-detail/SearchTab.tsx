import type { AssetDetailFor } from "@shared/asset-detail-views";
import { Link } from "react-router-dom";
import { AnalysisEvidence, useAnalysisValidity } from "@/components/AnalysisEvidence";
import type {
  SearchIntelligenceSnapshot,
  SerpCompetitor,
} from "@shared/asset-detail";
import { connectable, connectHref, firstToConnect } from "@shared/connect-panel";
import { sourceReadings } from "@shared/connection-status";
import { integrationLabel } from "@shared/integrations";
import type { SignalTrend } from "@shared/wall";
import type { WatchSeed } from "@shared/watch-windows";
import { EmptyState } from "@/components/EmptyState";
import { PageDecisions } from "@/components/PageDecisions";
import { QueryVisibilityRankings } from "@/components/QueryVisibilityRankings";
import { SerpPanelBoard } from "@/components/SerpPanelBoard";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { formatCalendarDate, formatInt, formatUsd } from "@/lib/format";
import { SectionLabel } from "@/components/surface/SectionLabel";
import {
  SmallMultiple,
  SmallMultipleStrip,
} from "@/components/surface/SmallMultiple";
import { useAssetTabPath } from "@/routes/asset-detail/AssetTabs";
import { timelineAnnotations } from "@/routes/asset-detail/shared";
import { SearchPair } from "@/routes/asset-detail/trend-panels";
import { useRange } from "@/routes/asset-detail/useRange";

/**
 * THE SEARCH TAB — which term, which page, which domain (doc 21, `ro-78qo.4`).
 *
 * WHY IT EXISTS. Until 2026-09-05 all of this was the bottom nine tenths of the
 * Growth tab, which measured 10,139px at 1440 wide with every table open at
 * once. Growth asks *which way did the numbers go*; a tracked result page, a
 * query decision, a page decision, a competitor and a linking domain all answer
 * *which one* — a different question, and doc 21's first principle makes a
 * different question a tab rather than a section further down.
 *
 * EVERYTHING OPENS COLLAPSED, which is the whole design. The panel shows its
 * scoreboard and its first terms; the two decision lists show three rows each,
 * closed over their own evidence; the search context is four strips of numbers
 * with its reference tables behind one disclosure. Every row and every table is
 * still here and every action still works — the ten thousand pixels became
 * clicks, and none of them leaves the page.
 *
 * NO ABOUT (bead `ro-ujb9.96.6.5`). Its four paragraphs explained what the
 * screen already shows: ">20" is a rank past the depth the pull read, "of 7
 * checked" is the AI Overview denominator, each list names the windows it
 * compares, "Modelled" and its date head the search context, and a filed row
 * wears its task marker. The saved analysis's applicability is said once, at
 * the top; a list repeats it only where its own state differs.
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

  // NEVER A BLANK TAB (bead `ro-ujb9.136`). Every section below draws only
  // from a tracked panel, the query and page decisions or the search
  // context, so a site with none of them opened onto one analysis line over
  // nothing — even with Bing's clicks collected. It opens instead on the
  // site's own search numbers and the one step to tracking terms, or, with
  // no search numbers at all, the one step to a search source.
  if (!panel && !hasDecisions && !intelligence) return <SearchStart data={data} nowMs={nowMs} />;

  return (
    <div id="search-evidence" className="flex scroll-mt-4 flex-col gap-5">
      {data.executive ? <AnalysisEvidence snapshot={data.executive} /> : null}
      {panel ? (
        // The block that IS this tab's answer (`surface:audit`, doc 21): the
        // panel's scoreboard is what "how is search doing" looks like at a
        // glance, and the first screen is measured against its bottom edge.
        //
        // NO SECTION EYEBROW OVER IT. `SerpPanelBoard` draws its own heading and
        // its own collection line, so a second title above the card would be the
        // same fact at two sizes (doc 14). The one thing this tab owes it that
        // the board cannot know is where the panel's TREND lives, and that goes
        // beside the board rather than over it.
        <section id="serp-panel" data-surface-hero className="scroll-mt-4 min-w-0">
          <SerpPanelBoard panel={panel} collapsed />
          <Link
            to={`${pathFor(data.asset.id, "growth")}#panel-scoreboard`}
            className="mt-1 inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            How the panel is moving →
          </Link>
        </section>
      ) : null}

      {hasDecisions ? (
        // NO CARD AROUND THE PAIR. Both lists already carry their own rules and
        // their own hairlines; a border round the two of them is a container
        // that has not earned its boundary (doc 14) and thirty-two pixels of
        // inset on a tab measured in pixels.
        <div className="grid min-w-0 gap-3.5">
          <QueryVisibilityRankings
            trends={data.executive?.searchQueries ?? null}
            asset={data.asset}
            handoffBeads={data.handoffBeads}
            onWatch={onWatch}
            statedState={statedState}
            collapsed
          />
          {/* Directly under the query list, because they are the same four
              decisions on two grains and an operator reads down from the term to
              the page that answers it (bead `ro-427`). */}
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

      <SearchContext snapshot={intelligence} />

      {/* WHAT THE PANEL BUYS IS ON SETTINGS (bead `ro-78qo.25`). `ro-78qo.4`
          parked the two register editors here behind a closed disclosure rather
          than delete them, because hand-editing `config/serp-panel.json` would
          have been the operator's only remaining control; doc 21 principle 4
          gives a file-owned register a home on Settings, and that is where they
          went, with the spend meter and the monthly-cap sentence. Search keeps
          the BOARD — the evidence — which is what this tab is for. */}

    </div>
  );
}

// --- before the site tracks anything ---------------------------------------

/** The sources a site's search clicks and impressions come from. */
const SEARCH_SOURCES = new Set(["gsc", "bing-webmaster"]);

const hasPoints = (trend: SignalTrend) => trend.series.length > 0 || (trend.contextSeries?.length ?? 0) > 0;

/**
 * THE SEARCH TAB BEFORE ANY TRACKED TERM, and its one next step.
 *
 * With search numbers: Growth's search pair — the same rendering, so the
 * site's clicks are one fact on both tabs — and a row whose one button starts
 * tracking terms (Settings' tracked panel), or connects DataForSEO first,
 * which buys them. With none: one empty state whose button connects the
 * site's first search source, the one its Data sources lead with.
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

// --- the search context strips ---------------------------------------------

/**
 * WHAT THE WEEKLY PROVIDER PULL BOUGHT, as strips of numbers.
 *
 * These were four bordered groups of labelled statistics on the Overview, under
 * a heading, two badges and a two-sentence caveat — the second thing an operator
 * saw on the page they open most. They belong beside the queries and pages they
 * are context FOR, and they belong as numbers rather than as a section: doc 21's
 * `SmallMultiple` strip is one bordered row of hairline cells, which is what a
 * list of counts actually is.
 *
 * Every metered figure the pull retains still has a slot of its own (bead
 * `ro-dqh`): a number demoted to a sub-line is a number nobody reads.
 */
function SearchContext({
  snapshot,
}: {
  snapshot: SearchIntelligenceSnapshot | null;
}) {
  if (!snapshot) return null;
  const links = snapshot.backlinks;
  const linkValue = (pick: (b: NonNullable<typeof links>) => number) =>
    links ? formatInt(pick(links)) : "—";
  // A platform whose row stated no figure is unknown, never zero (bead
  // `ro-8s5`), and a total over an unknown is not a total.
  const { googleMentions, chatgptMentions, googleSearchVolume, chatgptSearchVolume } =
    snapshot.ai;
  const aiMentions =
    googleMentions === null || chatgptMentions === null
      ? null
      : googleMentions + chatgptMentions;
  const reported = (value: number | null) => (value === null ? "—" : formatInt(value));
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

  return (
    <section id="search-context" className="scroll-mt-4 flex flex-col gap-2">
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

      <SmallMultipleStrip columns={6}>
        {/* THE MONEY FIGURE LEADS. It is the only number here denominated in
            something the operator spends, and it is the question the counts
            beside it are evidence for: what are these rankings worth? */}
        {/* Ahrefs' "traffic value": the estimated visits priced as ads. The
            secondary line says both halves, so it needs no hover. */}
        <SmallMultiple
          label="Traffic value"
          value={formatUsd(snapshot.rankings.estimatedPaidTrafficCost)}
          secondary={`${formatInt(snapshot.rankings.estimatedVisits)} visits a month, priced as ads`}
          secondaryBelow
        />
        <SmallMultiple
          label="Keywords"
          value={formatInt(snapshot.rankings.keywords)}
          secondary="ranking somewhere"
        />
        <SmallMultiple label="Top 3" value={formatInt(snapshot.rankings.top3)} />
        <SmallMultiple label="Top 10" value={formatInt(snapshot.rankings.top10)} />
        <SmallMultiple label="Top 20" value={formatInt(snapshot.rankings.top20)} />
        <SmallMultiple
          label="In AI Overviews"
          value={formatInt(snapshot.rankings.aiOverviewReferences)}
          secondary="keywords citing us"
        />
      </SmallMultipleStrip>

      {/* ONE STRIP VISIBLE, THE REST BEHIND A DOOR (doc 21, bead `ro-78qo.4`).
          Four strips of equal-weight numbers is twenty-two figures in one block
          with nothing saying which of them the operator came for — the
          "everything at once, in the same size" the redesign exists to cure. The
          rankings above answer what the asset's search position is WORTH, which
          is the question this section is on the page for; links, AI mentions and
          competitors qualify that answer and are one click away with the rows
          they are drawn from. */}
      <details className="rounded-[10px] border border-border bg-card">
        <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 text-xs text-muted-foreground hover:text-foreground">
          More context · links, AI mentions, competitors
        </summary>
        <div data-context-more className="flex flex-col gap-1.5 p-3 pt-0">
      <SmallMultipleStrip columns={6}>
        <SmallMultiple
          label="Linking domains"
          value={linkValue((b) => b.referringDomains)}
          secondary={links ? "point here" : "no link report"}
        />
        <SmallMultiple
          label="Gained"
          value={linkValue((b) => b.newReferringDomains)}
          secondary="in 90 days"
        />
        <SmallMultiple
          label="Lost"
          value={linkValue((b) => b.lostReferringDomains)}
          secondary="in 90 days"
        />
        <SmallMultiple
          label="Links"
          value={linkValue((b) => b.backlinks)}
          secondary="individual"
        />
        <SmallMultiple
          label="Domain rank"
          value={
            <span title="The provider's own strength score for this domain, from 0 to 1000">
              {linkValue((b) => b.rank)}
            </span>
          }
          secondary="provider score"
        />
        {/* Spam is counted as DOMAINS: one link farm mints a hundred anchor
            variants, and counting those would overstate one attacker into a
            crisis. */}
        <SmallMultiple
          label="Spammy anchors"
          value={
            snapshot.anchors === null
              ? "—"
              : formatInt(snapshot.anchors.spammyDomains)
          }
          secondary={
            snapshot.anchors === null
              ? "not sampled"
              : `domains, of ${formatInt(snapshot.anchors.sampled)} anchors`
          }
        />
      </SmallMultipleStrip>

      <SmallMultipleStrip columns={5}>
        <SmallMultiple
          label="AI mentions"
          value={reported(aiMentions)}
          secondary={`${platformMentions(googleMentions, "Google")} · ${platformMentions(chatgptMentions, "ChatGPT")}`}
        />
        <SmallMultiple
          label="Google demand"
          value={reported(googleSearchVolume)}
          secondary={googleSearchVolume === null ? "not reported" : "searches a month"}
        />
        <SmallMultiple
          label="ChatGPT demand"
          value={reported(chatgptSearchVolume)}
          secondary={chatgptSearchVolume === null ? "not reported" : "searches a month"}
        />
        <SmallMultiple
          label="Best opportunity"
          value={
            bestIdea ? (
              <span className="block truncate text-sm font-semibold">
                {bestIdea.keyword}
              </span>
            ) : (
              "—"
            )
          }
          secondary={
            bestIdea
              ? `${formatInt(bestIdea.searchVolume)} a month, difficulty ${formatInt(bestIdea.difficulty)}`
              : "no ideas collected yet"
          }
        />
        <SmallMultiple
          label="Ideas"
          value={
            snapshot.keywordIdeas.length === 0
              ? "—"
              : formatInt(snapshot.keywordIdeas.length)
          }
          secondary="terms we do not rank for"
        />
      </SmallMultipleStrip>

      {competitors.length > 0 ? (
        <SmallMultipleStrip columns={5}>
          {competitors.map((entry) => (
            <SmallMultiple
              key={entry.domain}
              label={entry.domain}
              // Their keywords and average position are the competitors
              // table's columns below, one click away.
              value={
                <span className="block truncate text-base">
                  {overlapValue(entry)}
                </span>
              }
              secondary={`${formatInt(entry.intersections)} shared`}
            />
          ))}
        </SmallMultipleStrip>
      ) : null}

          <SearchContextRows snapshot={snapshot} />
        </div>
      </details>
    </section>
  );
}

/**
 * Overlap share, readable at the magnitudes it actually takes (`ro-kukv.2`).
 *
 * A focused competitor overlaps on a fraction of a percent of its own footprint
 * — one asset's closest competitor sits at 0.22%. Rounded to whole
 * percent that reads "0%", which is both wrong and useless, so anything under
 * one percent keeps two decimals.
 */
function overlapValue(entry: SerpCompetitor): string {
  if (entry.competitorKeywords <= 0) return "—";
  const percent = entry.overlapShare * 100;
  return percent >= 1 ? `${Math.round(percent)}%` : `${percent.toFixed(2)}%`;
}

/**
 * THE ROWS BEHIND THE STRIPS, in one closed disclosure.
 *
 * The strips answer "is anything happening"; these answer "what, exactly". They
 * are reference tables — the named linking domains, the anchor distribution, the
 * keyword ideas, the full competitor set — and doc 21's rule for a reference
 * table on a view surface is that it opens closed.
 */
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
          head: ["Domain", "Rank", "Links", "Spam", "First seen"],
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
          summary: `Keyword ideas · ${formatInt(snapshot.keywordIdeas.length)} terms this site does not rank for`,
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
    // ONE door, not four. Four collapsed cards stacked under the strips is two
    // hundred pixels of chrome on a page whose whole point is that the evidence
    // is one click away rather than in the way; the tables inside keep their own
    // summaries, so nothing about what is behind each one is hidden.
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
