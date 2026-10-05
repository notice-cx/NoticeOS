import {
  type SerpPanelQuery,
  type SerpPanelSnapshot,
  type SerpPanelTerm,
  serpPanelDeviceNoun,
  serpPanelScoreboard,
  serpPanelTerms,
} from "@shared/asset-detail";
import { marketLabel } from "@shared/site-markets";
import { Monitor, Smartphone, TriangleAlert } from "lucide-react";
import { AiOverviewGlyphs } from "@/components/AiOverviewGlyphs";
import { formatCalendarDate, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface SerpPanelBoardProps {
  /** The asset's tracked-query panel, or null — which renders nothing. */
  panel: SerpPanelSnapshot | null;
  /**
   * Open on the scoreboard and the first few terms, with the rest one click
   * away (doc 21, bead `ro-78qo.4`).
   *
   * Twenty-eight terms, each carrying two device lanes of organic neighborhood,
   * is thousands of pixels on a page that also has to hold the query and page
   * decisions. The scoreboard is the line a human reads first and it is
   * unchanged; what collapses is the rows beneath it, and the rest arrive in
   * place rather than on another screen.
   *
   * WHAT THE FIRST ROWS ARE, and what they are not: an insight snapshot retains
   * ONE collection, so this panel has no movement to sort by. The default rows
   * are simply the ones the board would already have drawn first — best rank
   * first — and calling them movers would be a claim the evidence cannot
   * support.
   */
  collapsed?: boolean;
  /** How many terms the collapsed shape shows before the disclosure. */
  collapsedRows?: number;
  className?: string;
}

/**
 * How is the tracked SERP panel doing? (bead `ro-282.3`)
 *
 * SCOREBOARD FIRST, ROWS SECOND, which is the whole shape of this component and
 * the reason it exists. nom's local markdown report opened with six numbers —
 * tracked, ranking, top 10, top 3, AI Overviews, citations — and the central
 * lane replaced its DATA without replacing that. Twenty query rows answer "what
 * is each term doing"; only the scoreboard answers "how is the panel doing",
 * and that is the line a human reads first and the only one that survives a
 * glance across a room.
 *
 * THREE SEMANTICS THIS SURFACE EXISTS TO PRESERVE, each of which is a lie the
 * obvious rendering would tell:
 *
 *   1. The panel is a fixed-depth pull — of each term on EACH device it is
 *      configured for, never the desktop-only pull this comment used to claim
 *      (`ro-o1n` bought the phone; `ro-14d.1` carried it here). A query with no
 *      `bestRank` has NO RESULT INSIDE THE TRACKED DEPTH — it is not "not
 *      ranking". So the empty cell reads `>20` (the depth, stated), never a
 *      dash meaning absent and never the word "none".
 *   2. An unstated depth stays unstated. A legacy archive row carries no
 *      `tracked_depth`; the caption then says "inside tracked depth" with no
 *      number and the empty cells fall back to an em dash, because printing
 *      "20" would name a depth nobody pulled to.
 *   3. Unknown AI Overviews are unknown. The overview loads asynchronously and
 *      a pull that missed it recorded nothing, so the two AI tiles count only
 *      rows the panel could actually answer for and QUOTE that denominator. A
 *      board dividing by the tracked count would spend every unknown as a "no"
 *      and report an asset clear of an overview nobody ever checked.
 *
 * Absence is the answer for most assets and it is total: no panel, no
 * block, an older snapshot, or a block too malformed to trust all render
 * nothing whatsoever — not an empty scoreboard, which would read as six real
 * zeroes on an asset that buys no panel at all.
 *
 * No status word anywhere (doc 14). The rank tiers are numbers against a stated
 * denominator, and the per-query AI Overview state is the registry's
 * `AiOverviewGlyphs` — the same component `QueryVisibilityRankings` renders from
 * the same readings, since bead `ro-glf`, rather than a second copy of it held
 * in step by a comment. One fact drawn two ways on one page is two facts to the
 * reader, and that guarantee is now structural.
 *
 * DEGRADED COVERAGE STAYS REVIEWABLE. A provider failure keeps its row as an
 * explicit unknown and tints the whole board amber with one observed/total
 * meter. Three failed attempts across the bounded, family-wide exponential-
 * backoff ladder settle that surface to pale yellow instead of escalating it
 * forever. The failed row gets an alert glyph and an em dash — never `>depth`,
 * because the provider did not read the result page. No prose status block
 * competes with the evidence.
 *
 * GROUPED BY THE BET EACH TERM MEASURES since `ro-282.5`, where the panel names
 * one. A panel's twenty terms can be six bets, and "which of them is moving" is the
 * question the operator actually has; a flat rank-sorted list can only answer
 * "which term ranks". A panel that labels nothing renders the
 * identical single list it always did, and a partly-labelled one keeps its
 * unlabelled terms in a trailing run rather than inventing a cluster for them.
 */
export function SerpPanelBoard({
  panel,
  collapsed = false,
  collapsedRows = 3,
  className,
}: SerpPanelBoardProps) {
  if (!panel) return null;

  const board = serpPanelScoreboard(panel);
  const depth = panel.trackedDepth;
  // TERMS, not rows: the panel reads each term on every configured device, and
  // one row per (term, device) would list the same twenty bets forty times
  // (`serpPanelTerms`, bead `ro-14d.1`).
  const rows = serpPanelTerms(panel);
  const clusters = groupByLabel(rows);
  const failedCalls = panel.queries.filter((row) => row.providerStatus).length;
  // Retry spend is family-wide. Two unread calls with 2 + 1 attempts have
  // exhausted exactly the same ladder as one call with 3; max() would
  // incorrectly leave the former in the fresh orange state forever.
  const failedAttempts = panel.queries.reduce(
    (total, row) => total + (row.providerStatus ? (row.providerAttempts ?? 1) : 0),
    0,
  );
  const settledDegradation = failedCalls > 0 && failedAttempts >= 3;

  return (
    <section
      data-serp-panel
      className={cn(
        "min-w-0 rounded-lg border border-border bg-background/40 p-4",
        failedCalls > 0 &&
          (settledDegradation
            ? "border-warn/35 bg-warn/5"
            : "border-warn/65 bg-warn/10"),
        className,
      )}
      data-serp-panel-degradation={
        failedCalls === 0 ? undefined : settledDegradation ? "settled" : "partial"
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <h3 className="text-wall-label font-semibold uppercase tracking-widest text-muted-foreground">
          Tracked SERP panel
        </h3>
        {/* The collection this whole block is about, stated ONCE (doc 14: time
            belongs to the fact it qualifies) — every number below is that day's,
            and no tile repeats the date. */}
        <div className="flex items-center gap-2">
          {failedCalls > 0 ? (
            <PanelCoverage
              total={panel.queries.length}
              failed={failedCalls}
              settled={settledDegradation}
            />
          ) : null}
          <p className="text-xs tabular-nums text-muted-foreground">
            {serpPanelScope(panel)}
          </p>
        </div>
      </div>

      {/* Two questions, six numbers, one divider between them: where we rank,
          and what the AI Overview does. Flat six-across would make the reader
          work out the grouping every time they look. */}
      <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-[minmax(0,3fr)_auto_minmax(0,2fr)]">
        <dl className="grid grid-cols-4 gap-x-4 gap-y-2">
          <Tile label="Tracked" value={formatInt(board.tracked)} name="tracked" />
          <Tile
            label="Ranking"
            value={formatInt(board.ranking)}
            sub={depth === null ? "inside tracked depth" : `inside top ${formatInt(depth)}`}
            name="ranking"
          />
          <Tile label="Top 10" value={formatInt(board.top10)} name="top10" />
          <Tile label="Top 3" value={formatInt(board.top3)} name="top3" />
        </dl>

        <div className="hidden w-px bg-border sm:block" aria-hidden />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          {/* Denominators, not percentages: `aioKnown` below `tracked` IS the
              unknown count, visible without a fourth number naming it. */}
          <Tile
            label="AI Overview"
            value={board.aioKnown === 0 ? "—" : formatInt(board.aioPresent)}
            sub={
              board.aioKnown === 0
                ? "not checked"
                : `of ${formatInt(board.aioKnown)} checked`
            }
            name="aio-present"
          />
          <Tile
            label="Cites us"
            value={board.aioPresent === 0 ? "—" : formatInt(board.aioCitesUs)}
            sub={
              board.aioPresent === 0
                ? "no overview seen"
                : `of ${formatInt(board.aioPresent)} shown`
            }
            name="aio-cites-us"
          />
        </dl>
      </div>

      {/* The rows the scoreboard is made of, best rank first so the panel's own
          order (config order) never decides what the eye lands on — grouped by
          the bet each term measures where the panel names one. */}
      {collapsed ? (
        <CollapsedRows
          rows={rows}
          clusters={clusters}
          trackedDepth={depth}
          panel={panel}
          visible={collapsedRows}
        />
      ) : (
      <div className="mt-4">
        {clusters.map((cluster) => (
          <Cluster
            key={cluster.label ?? "\u0000unlabelled"}
            cluster={cluster}
            trackedDepth={depth}
            panel={panel}
          />
        ))}
      </div>
      )}
    </section>
  );
}

/**
 * The board's rows, collapsed to a handful (bead `ro-78qo.4`).
 *
 * The first rows are DENSE — rank, term, path, the AI-Overview mark per surface
 * and the failed-call glyph, but not the organic neighborhood, which is two
 * lanes of domains per row and belongs to the term somebody has decided to look
 * at. Opening the disclosure draws the full clustered board exactly as it always
 * was, every composition lane included, in place and without leaving the page.
 */
function CollapsedRows({
  rows,
  clusters,
  trackedDepth,
  panel,
  visible,
}: {
  rows: SerpPanelTerm[];
  clusters: PanelCluster[];
  trackedDepth: number | null;
  panel: SerpPanelSnapshot;
  visible: number;
}) {
  const first = [...rows].sort(byRankThenQuery).slice(0, visible);
  const rest = rows.length - first.length;
  return (
    <div className="mt-4">
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {first.map((row) => (
          <PanelRow key={row.query} row={row} trackedDepth={trackedDepth} dense />
        ))}
      </ul>
      {rest > 0 ? (
        <details className="group" data-serp-panel-more>
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center text-xs font-medium text-muted-foreground hover:text-foreground">
            <span className="group-open:hidden">
              Show all {formatInt(rows.length)} terms →
            </span>
            <span className="hidden group-open:inline">
              Show the first {formatInt(first.length)} only
            </span>
          </summary>
          <div className="pb-1">
            {clusters.map((cluster) => (
              <Cluster
                key={`all:${cluster.label ?? ""}`}
                cluster={cluster}
                trackedDepth={trackedDepth}
                panel={panel}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * One cluster of the panel: its own count line, then its terms.
 *
 * An UNLABELLED run gets no heading and no count line — it is a trailing run of
 * rows, never a cluster called "Unlabelled" (bead `ro-282.5`). Inventing a
 * cluster there would read as a seventh bet on nom's page and as one enormous
 * bet on myplate's, and neither exists; the honest rendering of "no bet was
 * recorded for these" is silence about the bet.
 */
function Cluster({
  cluster,
  trackedDepth,
  panel,
}: {
  cluster: PanelCluster;
  trackedDepth: number | null;
  panel: SerpPanelSnapshot;
}) {
  return (
    <section data-serp-panel-cluster={cluster.label ?? ""}>
      {cluster.label === null ? null : (
        <ClusterLine label={cluster.label} panel={panel} terms={cluster.terms} />
      )}
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {cluster.terms.map((row) => (
          <PanelRow key={row.query} row={row} trackedDepth={trackedDepth} />
        ))}
      </ul>
    </section>
  );
}

/** A cluster's headline, from `serpPanelScoreboard` over that cluster's own
 * rows — the SAME derivation the six tiles above use, never a second opinion of
 * "top 10" scoped smaller.
 *
 * Two figures, not six: the whole-panel tiles already state the panel, and this
 * line answers the one question the grouping exists for — is this bet working.
 * The AI clause appears only where a term in the cluster was actually checked,
 * because "0 AI Overviews" on an unchecked cluster is the unknown-as-no lie the
 * tiles above spend a denominator to avoid. */
function ClusterLine({
  label,
  panel,
  terms,
}: {
  label: string;
  panel: SerpPanelSnapshot;
  terms: SerpPanelTerm[];
}) {
  const board = serpPanelScoreboard({
    ...panel,
    queries: terms.flatMap((term) => term.devices),
  });
  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h4 className="text-xs font-semibold text-foreground">{label}</h4>
      <p
        className="text-[10px] tabular-nums text-muted-foreground"
        data-serp-panel-cluster-line={label}
      >
        {formatInt(board.top10)} of {formatInt(board.tracked)} in top 10
        {board.aioKnown === 0
          ? ""
          : ` · ${formatInt(board.aioPresent)} AI Overview of ${formatInt(board.aioKnown)} checked`}
      </p>
    </div>
  );
}

interface PanelCluster {
  /** `null` is the trailing ungrouped run, never a cluster name. */
  label: string | null;
  terms: SerpPanelTerm[];
}

/**
 * The terms grouped by the bet they measure, labelled clusters first.
 *
 * ADDITIVE IN BOTH DIRECTIONS, which is the whole constraint. A panel that
 * labels nothing — and every collection made before
 * `ro-282.2` — comes back as ONE unlabelled group, and that renders as exactly
 * the flat list this component drew before grouping existed: no heading, no
 * count line, nothing to explain away. A panel that labels SOME of its rows
 * keeps the rest in one trailing run rather than inventing a cluster for them.
 *
 * Cluster order is first-appearance in the panel's own row order, which is the
 * config order the operator wrote — the order they think about their bets in.
 * Within a cluster the rows sort by rank, so the eye still lands on the best
 * result rather than on whatever the config happened to list first.
 */
function groupByLabel(terms: SerpPanelTerm[]): PanelCluster[] {
  const labelled = new Map<string, SerpPanelTerm[]>();
  const unlabelled: SerpPanelTerm[] = [];
  for (const term of terms) {
    if (term.label === null) {
      unlabelled.push(term);
      continue;
    }
    labelled.set(term.label, [...(labelled.get(term.label) ?? []), term]);
  }
  return [
    ...[...labelled].map(([label, group]) => ({
      label,
      terms: [...group].sort(byRankThenQuery),
    })),
    ...(unlabelled.length > 0
      ? [{ label: null, terms: [...unlabelled].sort(byRankThenQuery) }]
      : []),
  ];
}

/** One scoreboard figure. `Stat` is the Wall's metric component and is sized
 * for a 3-meter read; this is a dense six-up cluster inside a section, so it
 * borrows the same rules (tabular numerals, label above, sub below) at the
 * page's scale rather than adding a rival to the registry. */
function Tile({
  label,
  value,
  sub,
  name,
}: {
  label: string;
  value: string;
  sub?: string;
  name: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-serp-panel-stat={name}>
      <dt className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-xl font-semibold leading-none tabular-nums">{value}</dd>
      {sub ? (
        <dd className="truncate text-[10px] tabular-nums text-muted-foreground">{sub}</dd>
      ) : null}
    </div>
  );
}

/** The surfaces the panel actually read, named the way the operator names them
 * (doc 17: the collection mechanism is never the asset page's vocabulary,
 * and neither is `mobile`).
 *
 * Read off the rows rather than stated as a constant, because "desktop" was a
 * hardcoded caption here until `ro-14d.1` — and a caption that cannot be wrong
 * about what it describes is worth the four lines. Nothing renders a device the
 * snapshot did not observe. */
/**
 * What one panel collection covers, as the board states it: the day, the
 * surfaces it read, the market, the depth. Exported so the Growth tab's
 * scoreboard names the same scope in the same words instead of a tooltip
 * paragraph (bead `ro-ujb9.96.6.5`).
 *
 * The market is the site's own saved one, in the contract's words (bead
 * `ro-ujb9.230`); a site that saved none gets no market named, never a
 * default it did not choose. Its spaces do not break, so a phone wraps the
 * caption before the market rather than between the place and the language.
 */
export function serpPanelScope(panel: SerpPanelSnapshot): string {
  const depth = panel.trackedDepth;
  return [
    formatCalendarDate(panel.reportDate),
    surfacesRead(serpPanelTerms(panel)),
    panel.market === null ? "" : marketLabel(panel.market).replaceAll(" ", "\u00a0"),
    depth === null ? "" : `depth ${formatInt(depth)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function surfacesRead(terms: SerpPanelTerm[]): string {
  const devices = [
    ...new Set(terms.flatMap((term) => term.devices.map((row) => row.device))),
  ];
  const names = devices.map((device) =>
    serpPanelDeviceNoun(device).toLocaleLowerCase("en-US"),
  );
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names.at(-1)}`;
}

/** Best rank first, unranked last, then alphabetical — a total order, so the
 * list does not reshuffle between two collections that scored the same. */
function byRankThenQuery(left: SerpPanelTerm, right: SerpPanelTerm): number {
  const a = left.bestRank ?? Number.POSITIVE_INFINITY;
  const b = right.bestRank ?? Number.POSITIVE_INFINITY;
  return a - b || left.query.localeCompare(right.query);
}

function PanelRow({
  row,
  trackedDepth,
  dense = false,
}: {
  row: SerpPanelTerm;
  trackedDepth: number | null;
  /** Drop the organic-neighborhood lanes. The collapsed board uses it so its
   * first rows answer "where does this term stand" without also answering "who
   * else holds that result page" for terms nobody has asked about yet. */
  dense?: boolean;
}) {
  const ranked = row.bestRank !== null;
  const failedDevices = row.devices.filter((device) => device.providerStatus);
  const whollyUnread = failedDevices.length === row.devices.length;
  return (
    <li
      data-serp-panel-query={row.query}
      className={cn("py-2", failedDevices.length > 0 && "bg-warn/5")}
    >
      <div className="flex items-baseline gap-3">
        <RankCell
          rank={row.bestRank}
          trackedDepth={trackedDepth}
          devices={row.devices}
          unread={whollyUnread}
        />
        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium text-foreground">{row.query}</span>
          {row.bestUrl ? (
            <span className="ml-2 truncate font-mono text-[10px] text-muted-foreground">
              {pathOf(row.bestUrl)}
            </span>
          ) : null}
          {failedDevices.length > 0 ? (
            <FailedCallGlyph devices={failedDevices} />
          ) : null}
        </div>
        {/* BLANK SLOT for a surface whose overview never loaded: this cell sits
            in a fixed row grid, and a collapsed pair would slide the desktop
            mark under the phone column — a term checked on one surface, to the
            eye. The ranked-query table draws nothing there instead, because it
            has no column to align to (bead `ro-glf`). */}
        <AiOverviewGlyphs readings={row.devices} unknownSurface="blank" />
        {/* Weight, not color: an unranked term is the interesting one, and
            dimming it would hide exactly the work the panel was bought to
            find. */}
        <span className="sr-only">
          {ranked ? "ranked" : "no result inside tracked depth"}
        </span>
      </div>
      {dense ? null : <SerpComposition devices={row.devices} />}
    </li>
  );
}

/** The CURRENT neighborhood of one term, one lane per result-page surface.
 *
 * Numbered domains do the visual work: the eye can compare phone vs desktop
 * without parsing a sentence, while the short facts at right answer the two
 * operational questions the panel already paid for — how much organic space
 * existed, and whether the asset held a second slot. No lane renders for an
 * unread page or a legacy block, because an empty neighborhood would be a much
 * stronger claim than unknown. */
function SerpComposition({ devices }: { devices: SerpPanelQuery[] }) {
  const readable = devices.filter((row) => row.composition !== null);
  if (readable.length === 0) return null;
  return (
    <div
      className="ml-[3.25rem] mt-1.5 grid gap-x-5 gap-y-2 sm:grid-cols-2"
      data-serp-composition
    >
      {readable.map((reading) => (
        <SerpCompositionLane key={reading.device} reading={reading} />
      ))}
    </div>
  );
}

function SerpCompositionLane({ reading }: { reading: SerpPanelQuery }) {
  const composition = reading.composition!;
  const DeviceIcon = reading.device === "mobile" ? Smartphone : Monitor;
  const device = serpPanelDeviceNoun(reading.device);
  const ourSlots = reading.bestRank === null ? 0 : composition.secondRank === null ? 1 : 2;
  return (
    <div
      className="min-w-0 border-l border-border/60 pl-2"
      data-serp-composition-device={reading.device}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-semibold text-foreground">
          <DeviceIcon className="size-3" aria-hidden />
          {device}
        </span>
        <span className="tabular-nums">
          {formatInt(composition.organicResults)} organic
        </span>
        <span className="tabular-nums" data-serp-our-slots>
          Our slots {formatInt(ourSlots)}
        </span>
        {composition.secondRank !== null ? (
          <span className="tabular-nums text-foreground" data-serp-second-slot>
            second #{formatInt(composition.secondRank)}
            {composition.secondUrl ? ` ${pathOf(composition.secondUrl)}` : ""}
          </span>
        ) : null}
      </div>

      {composition.top3Domains.length > 0 ? (
        <ol
          className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5"
          aria-label={`${device} organic top three`}
          data-serp-top-three
        >
          {composition.top3Domains.map((domain, index) => (
            <li
              key={`${index}:${domain}`}
              className="min-w-0 font-mono text-[10px] text-foreground"
            >
              <span className="mr-0.5 text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              {domain}
            </li>
          ))}
        </ol>
      ) : null}

      {composition.serpFeatures.length > 0 ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground" data-serp-features>
          {composition.serpFeatures.map(featureLabel).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function featureLabel(feature: string): string {
  return feature.replaceAll("_", " ").replaceAll("-", " ");
}

/** The rank, or the honest shape of its absence.
 *
 * `>20` and not a dash, because the two say different things: a dash reads as
 * "nothing here", while `>20` says the pull looked twenty deep and this term was
 * past it — which is a working position, not a blank. With no recorded depth
 * there is no number to state, so the dash is the truthful fallback and the
 * hover carries the rest.
 *
 * ONE NUMBER, best across the surfaces the term was read on — the rank column
 * answers "does this asset hold a position", and a term ranked 3 on the phone
 * holds position 3. The device split gets a second column of GLYPHS and not a
 * second column of numbers, because the AI Overview is the fact that differs by
 * surface in a way the operator would act on (bead `ro-e46.2`); two ranks per
 * row would double the digits on every line to state a difference that is
 * usually zero. Where the surfaces DO disagree the hover says both, so nothing
 * is hidden — it is just not spent on width every row pays for. */
function RankCell({
  rank,
  trackedDepth,
  devices,
  unread,
}: {
  rank: number | null;
  trackedDepth: number | null;
  devices: SerpPanelQuery[];
  unread: boolean;
}) {
  const perDevice =
    new Set(devices.map((row) => row.bestRank)).size > 1
      ? ` By surface: ${devices
          .map(
            (row) =>
              `${serpPanelDeviceNoun(row.device)} ${
                row.bestRank === null
                  ? trackedDepth === null
                    ? "no result inside the tracked depth"
                    : `>${formatInt(trackedDepth)}`
                  : formatInt(row.bestRank)
              }`,
          )
          .join(", ")}.`
      : "";
  if (rank !== null) {
    return (
      <span
        className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-foreground"
        title={perDevice.trim() || undefined}
        data-serp-panel-rank
      >
        {formatInt(rank)}
      </span>
    );
  }
  if (unread) {
    const reason = devices
      .map(
        (row) =>
          `${serpPanelDeviceNoun(row.device)}: ${row.providerStatus ?? "provider did not answer"}`,
      )
      .join("; ");
    return (
      <span
        className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-warn"
        title={reason}
        data-serp-panel-unread
      >
        —
      </span>
    );
  }
  // ">20" is a rank beyond the depth the pull read, never "does not rank".
  const beyond =
    trackedDepth === null
      ? "Not in the tracked results."
      : `Not in the top ${formatInt(trackedDepth)}.`;
  return (
    <span
      className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-muted-foreground"
      title={`${beyond}${perDevice}`}
      data-serp-panel-unranked
    >
      {trackedDepth === null ? "—" : `>${formatInt(trackedDepth)}`}
    </span>
  );
}

function PanelCoverage({
  total,
  failed,
  settled,
}: {
  total: number;
  failed: number;
  settled: boolean;
}) {
  const observed = Math.max(0, total - failed);
  const title = `${observed} of ${total} calls observed; ${failed} unknown${
    settled ? " after 3 attempts with exponential backoff" : ""
  }.`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
        settled
          ? "border-warn/30 bg-warn-soft text-warn"
          : "border-warn/55 bg-warn-soft text-warn",
      )}
      title={title}
      aria-label={title}
      data-serp-panel-coverage
    >
      <TriangleAlert className="size-3" aria-hidden />
      <span>{formatInt(observed)}/{formatInt(total)}</span>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-warn/30" aria-hidden>
        <span
          className="block h-full bg-foreground/70"
          style={{ width: `${total === 0 ? 0 : (observed / total) * 100}%` }}
        />
      </span>
    </span>
  );
}

function FailedCallGlyph({ devices }: { devices: SerpPanelQuery[] }) {
  const title = devices
    .map(
      (row) =>
        `${serpPanelDeviceNoun(row.device)}: ${row.providerStatus ?? "provider did not answer"}`,
    )
    .join("; ");
  return (
    <span
      className="ml-1 inline-flex align-middle text-warn"
      title={title}
      aria-label={title}
      data-serp-panel-call-failure
    >
      <TriangleAlert className="size-3" aria-hidden />
    </span>
  );
}

/** Path only. The host is this asset on every row, so printing it twenty
 * times spends the width that the path — the part that differs — needs. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
