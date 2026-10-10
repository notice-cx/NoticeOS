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
  /** Open on the scoreboard and the first few terms (best rank first; a
   * snapshot holds one collection, so there is no movement to sort by), with
   * the rest one click away. */
  collapsed?: boolean;
  /** How many terms the collapsed shape shows before the disclosure. */
  collapsedRows?: number;
  className?: string;
}

/**
 * The tracked SERP panel: scoreboard first, rows second, grouped by the bet
 * each term measures where the panel names one.
 *
 * Three semantics the rendering preserves:
 * - A query with no `bestRank` has no result inside the tracked depth; it is
 *   not "not ranking". The empty cell reads `>20` (the depth), never a dash.
 * - An unstated depth stays unstated: with no `trackedDepth` the cell falls
 *   back to an em dash rather than naming a depth nobody pulled to.
 * - Unknown AI Overviews are unknown: the AI tiles count only rows the panel
 *   could answer for and quote that denominator.
 *
 * No panel renders nothing at all, never an empty scoreboard. A provider
 * failure keeps its row as an explicit unknown (alert glyph and em dash, never
 * `>depth`) and tints the board; three attempts across the family-wide
 * backoff ladder settle the tint instead of escalating it.
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
  // Terms, not (term, device) rows: the panel reads each term on every device.
  const rows = serpPanelTerms(panel);
  const clusters = groupByLabel(rows);
  const failedCalls = panel.queries.filter((row) => row.providerStatus).length;
  // Retry spend is family-wide: two unread calls with 2 + 1 attempts have
  // exhausted the same ladder as one call with 3, so this is a sum, not a max.
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
          Search terms
        </h3>
        {/* The collection every number below belongs to, stated once. */}
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

      {/* Two questions, one divider: where we rank, and what the AI Overview does. */}
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
          {/* Denominators, not percentages. */}
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

/** The first rows are dense (no organic-neighborhood lanes); opening the
 * disclosure draws the full clustered board in place. */
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

/** One cluster: its count line, then its terms. An unlabelled run gets no
 * heading and no count line; it is never a cluster called "Unlabelled". */
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

/** A cluster's headline, from the same `serpPanelScoreboard` derivation the
 * tiles use. The AI clause appears only where a term was actually checked. */
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
 * Labelled clusters in first-appearance (config) order, then one trailing
 * unlabelled run. A panel that labels nothing is one unlabelled group, which
 * renders as a flat list. Within a cluster the rows sort by rank.
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

/** One scoreboard figure, at the page's scale rather than the Wall's `Stat`. */
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

/**
 * What one panel collection covers: the day, the surfaces it read, the
 * market, the depth. Exported so the Growth tab names the same scope in the
 * same words. A site that saved no market gets none named, never a default.
 * The market's spaces do not break, so a phone wraps before it.
 */
export function serpPanelScope(panel: SerpPanelSnapshot): string {
  const depth = panel.trackedDepth;
  return [
    formatCalendarDate(panel.reportDate),
    surfacesRead(serpPanelTerms(panel)),
    panel.market === null ? "" : marketLabel(panel.market).replaceAll(" ", "\u00a0"),
    depth === null ? "" : `top ${formatInt(depth)} read`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Read off the rows, never a constant: nothing names a device the snapshot
 * did not observe. */
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

/** Best rank first, unranked last, then alphabetical: a total order, so the
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
  /** Drop the organic-neighborhood lanes. */
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
        {/* A blank slot for a surface whose overview never loaded, so the
            desktop mark cannot slide under the phone column. */}
        <AiOverviewGlyphs readings={row.devices} unknownSurface="blank" />
        <span className="sr-only">
          {ranked ? "ranked" : "no result inside tracked depth"}
        </span>
      </div>
      {dense ? null : <SerpComposition devices={row.devices} />}
    </li>
  );
}

/** The current neighborhood of one term, one lane per surface. No lane
 * renders for an unread page: an empty neighborhood is a stronger claim than
 * unknown. */
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

/** The best rank across the surfaces the term was read on; where they
 * disagree the hover says both. `>20` says the pull looked that deep and the
 * term was past it; a dash is only for an unknown depth or an unread page. */
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

/** Path only: the host is this asset on every row. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}
