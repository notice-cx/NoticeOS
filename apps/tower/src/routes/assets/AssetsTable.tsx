import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { tabPath } from "@/routes/asset-detail/AssetTabs";
import { UrgentCount } from "@/routes/tasks/task-face";
import { siteOpensOn } from "@shared/first-run";
import {
  deltaMeaning,
  lastPointIsProvisional,
  periodDelta,
  windowSeries,
  type PeriodDelta,
} from "@shared/surface";
import { figureHasMoney, type AssetCard, type SignalTrend, type WorkSummary } from "@shared/wall";
import { NoSitesYet } from "@/components/AddSite";
import { BookingChip } from "@/components/BookingChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { DeltaChip, paceTone, performanceTone } from "@/components/DeltaChip";
import { PriorityBar } from "@/components/PriorityBar";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Sparkline, type SeriesTone } from "@/components/surface/Sparkline";
import { pillControlClass } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInt, formatPercent, formatPeriodMonth, formatPeriodMonthYear, formatSeriesDate, formatSignedMoney } from "@/lib/format";
import { intradayUsersPace, paceWindowLabel } from "@/lib/intraday-pace";
import { MIN_TREND_POINTS } from "@/lib/series";
import { cn } from "@/lib/utils";
import { StateChip } from "@/components/StateChip";
import { useSiteIssues } from "@/hooks/useSiteIssues";
import { siteHealth, type SiteHealth } from "@/lib/site-health";

/**
 * The portfolio's comparison table, one row per asset, shared by Home and
 * `/assets`. Order is the caller's: Home never sorts, so each site stays where
 * it was. A cell with no answer is an em dash with its reason, never a zero.
 */

/** The orderings the header row can ask for. `seed` is the payload's own and is
 * what a second press of the active header returns to. */
export type AssetSortKey =
  | "seed"
  | "name"
  | "health"
  | "work"
  | "users"
  | "net"
  | "trend";

/** Which way the comparator behind each key runs, as a glyph on the active
 * header. Every one of them is WORST FIRST except name, whose order is a
 * reading order rather than a ranking. */
const SORT_DIRECTION: Record<Exclude<AssetSortKey, "seed">, "asc" | "desc"> = {
  name: "asc",
  health: "desc",
  work: "desc",
  users: "desc",
  net: "desc",
  trend: "desc",
};

export interface AssetsTableProps {
  /** In the order they are to be drawn. */
  assets: AssetCard[];
  nowMs: number;
  ga4Realtime?: Ga4RealtimePayload | undefined;
  /** How many days of each asset's daily series the sparkline column draws.
   * Home passes nothing; `/assets` passes its range. A wider window draws what
   * exists rather than inventing days nobody reported. */
  rangeDays?: number;
  /** The ordering the caller applied, so the header can mark the column doing
   * it. Absent means the header row is not a control at all. */
  sort?: AssetSortKey;
  onSort?: (key: AssetSortKey) => void;
  /** Shown in place of the table when there is nothing to draw. Defaults to
   * "No sites yet" with Add a site beside it (`NoSitesYet`). */
  empty?: ReactNode;
}

/** Home's window, and the payload's own: `activeUsers` is the last 28 days and
 * nothing on that page can ask for more. */
export const TABLE_SPARK_DAYS = 28;

/** The compact density, keyed to the table's own box (the `@container` that
 * `Table stacked` draws) and only while it still has columns: from 40rem, where
 * rows stop stacking, to 64rem. A sortable header's padding is its button's
 * (`SortableHead`), so only the plain headers are narrowed here. */
const DENSE_BELOW_64REM =
  "@min-[40rem]:@max-[64rem]:[&_td]:px-2 @min-[40rem]:@max-[64rem]:[&_th:not([aria-sort])]:px-2";

export function AssetsTable({
  assets,
  ga4Realtime,
  rangeDays = TABLE_SPARK_DAYS,
  sort,
  onSort,
  empty,
}: AssetsTableProps) {
  const navigate = useNavigate();
  // The one health word per site: the same derivation as Home's strip and the
  // site's own header.
  const issues = useSiteIssues();
  // Core work stays visible; an unread project keeps its unknown state.
  const period = assets[0]?.netPeriod ?? null;
  // The one booking state the whole column shares, or null when the column
  // holds both kinds and the header cannot speak for it. Assets with no money
  // at all do not vote: "not booked" is neither side of the split.
  const booking = sharedBookingState(assets);

  // A caller with its own Add a site (or a filter hiding every row) passes
  // its own empty state; everyone else gets the door.
  if (assets.length === 0) return <>{empty ?? <NoSitesYet />}</>;

  return (
    // Below 40rem of container width, each asset reflows into a labelled card:
    // its key status and the › that opens it, with the rest folded (`AssetRow`).
    // In a box under 64rem the columns sit closer (12px to 8px padding), so
    // eight columns fit a 13-inch laptop's card without sideways scroll.
    <Table stacked className={DENSE_BELOW_64REM}>
      {/* Every header on one line: short words and `whitespace-nowrap`, so the
          cell under it is what gives. */}
      <TableHeader className="[&_th]:whitespace-nowrap">
        <TableRow>
          <SortableHead label="Site" sortKey="name" sort={sort} onSort={onSort} />
          <SortableHead label="Health" sortKey="health" sort={sort} onSort={onSort} />
          <SortableHead
            label="Visitors"
            sortKey="users"
            sort={sort}
            onSort={onSort}
            align="end"
          />
          {/* Each column names its own window, which lets the cells below it
              stay unlabelled. The move rides its line: the range's change is
              the delta beside the users line, and this header, which names
              the users and the window, is the one that orders by it. */}
          <SortableHead
            label={`Visitors · ${rangeDays}d`}
            sortKey="trend"
            sort={sort}
            onSort={onSort}
          />
          {/* Google and Bing as one measurement: the two providers' own lines
              belong to the asset page's Growth chart, not a 96px cell.
              "Search" is in the name so ad and affiliate clicks cannot be
              read as this. */}
          <TableHead>Search clicks · {rangeDays}d</TableHead>
          {/* The booking state, said once: the header carries it whenever
              every row agrees, and only a row that differs from its column
              wears a chip of its own. */}
          <SortableHead
            label={`Net${period ? ` · ${formatPeriodMonth(period)}` : ""}`}
            sortKey="net"
            sort={sort}
            onSort={onSort}
            align="end"
            suffix={
              booking ? (
                <span className="font-normal normal-case tracking-normal">
                  {" · "}
                  {booking === "booked" ? "reconciled" : "forecast"}
                </span>
              ) : null
            }
          />
          <SortableHead label="Tasks" sortKey="work" sort={sort} onSort={onSort} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.map((asset) => (
          <AssetRow
            key={asset.id}
            asset={asset}
            rangeDays={rangeDays}
            ga4Realtime={ga4Realtime?.assets.find(
              (snapshot) => snapshot.asset === asset.id,
            )}
            columnBooking={booking}
            tasks
            health={siteHealth(asset, issues)}
            onOpen={() => navigate(tabPath(asset.id, siteOpensOn(asset), `?range=${rangeDays}`))}
          />
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A column header that orders the table, or a plain one with no `onSort`. One
 * direction per column; a second press returns to seed order. Below `sm` the
 * header row is hidden, so `/assets` keeps a `<select>` for phones.
 */
function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  align = "start",
  suffix,
}: {
  label: string;
  sortKey: Exclude<AssetSortKey, "seed">;
  sort?: AssetSortKey;
  onSort?: (key: AssetSortKey) => void;
  align?: "start" | "end";
  suffix?: ReactNode;
}) {
  const active = sort === sortKey;
  const Glyph = SORT_DIRECTION[sortKey] === "asc" ? ArrowUp : ArrowDown;

  if (!onSort) {
    return (
      <TableHead className={align === "end" ? "text-right" : undefined}>
        {label}
        {suffix}
      </TableHead>
    );
  }

  return (
    <TableHead className={cn("p-0", align === "end" && "text-right")} aria-sort={
      active ? (SORT_DIRECTION[sortKey] === "asc" ? "ascending" : "descending") : "none"
    }>
      <button
        type="button"
        onClick={() => onSort(active ? "seed" : sortKey)}
        className={cn(
          "group/sort inline-flex w-full items-center px-3 py-2 uppercase tracking-wider @max-[64rem]:px-2",
          align === "end" && "justify-end",
          active ? "text-foreground" : "hover:text-foreground",
          pillControlClass,
          "motion-safe:transition-colors",
        )}
        title={
          active
            ? `Ordered by ${label.toLowerCase()} — press again for the default order`
            : `Order by ${label.toLowerCase()}`
        }
      >
        <span className="relative">
          {label}
          {suffix}
          {/* The arrow is drawn only on the column doing the ordering, faintly
              on hover elsewhere. It takes no width: laid out beside the label
              it would hold 16px open in every sortable header, so it hangs in
              the header's padding instead, before a right-aligned label and
              after a left-aligned one. */}
          <Glyph
            aria-hidden
            className={cn(
              "absolute top-1/2 size-3 -translate-y-1/2 motion-safe:transition-opacity",
              align === "end" ? "right-full mr-0.5" : "left-full ml-0.5",
              active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-40",
            )}
          />
        </span>
      </button>
    </TableHead>
  );
}

/** Which side of the ledger's honesty split a row states, or null when it has
 * no money to state at all: booked money leads, and an estimate may take the
 * cell only under a label that says what it is. */
export function bookingState(asset: AssetCard): "booked" | "forecast" | null {
  if (figureHasMoney(asset.booked)) return "booked";
  if (figureHasMoney(asset.forecast)) return "forecast";
  return null;
}

/** The booking state every row with money shares, or null: what lets the Net
 * column say "forecast" once in its header, until one asset reconciles and
 * each row has to say which it is. */
function sharedBookingState(assets: AssetCard[]): "booked" | "forecast" | null {
  const states = new Set(
    assets.map(bookingState).filter((state): state is "booked" | "forecast" => state !== null),
  );
  return states.size === 1 ? [...states][0]! : null;
}

/** The trend cell's tone, by the same rule the strip colours a delta with:
 * under ±2% a movement is weather, not a verdict. Up is good for active users. */
const TREND_VERDICT_FLOOR_PERCENT = 2;

/**
 * A movement is a verdict only while the comparison stands and the change is
 * big enough to be one — the same four withdrawals `Kpi` makes, so a row's
 * sparkline and the strip above it cannot disagree about when green is earned.
 */
function deltaTone(delta: PeriodDelta | null): SeriesTone {
  if (delta === null || !delta.comparable || delta.percent === null) return "muted";
  if (Math.abs(delta.percent) < TREND_VERDICT_FLOOR_PERCENT) return "muted";
  return delta.percent > 0 ? "positive" : "negative";
}

/** The whole series, context and all: `contextSeries` (62 days) and `series`
 * (28) together are the ninety days the range selector offers, and a caller
 * that read `series` alone would draw 28 days under a label saying three
 * months. Windowing is by date (`windowSeries`). */
function wholeSeries(trend: SignalTrend) {
  return [...(trend.contextSeries ?? []), ...trend.series];
}

/**
 * This range against the range before it, for one asset's users. Exported
 * because `/assets` orders by it and the cell that prints it must be the same
 * arithmetic. `null`, and the cell draws a dash with the reason on hover,
 * whenever the payload does not reach back a whole range before this one,
 * which at 90 days it never does.
 */
export function usersDelta(asset: AssetCard, rangeDays: number): PeriodDelta | null {
  const trend = asset.activeUsers;
  return periodDelta(
    wholeSeries(trend),
    rangeDays,
    trend.timeZoneChanges,
    trend.provisionalFrom,
  );
}

function AssetRow({
  asset,
  rangeDays,
  ga4Realtime,
  columnBooking,
  tasks,
  health,
  onOpen,
}: {
  asset: AssetCard;
  rangeDays: number;
  ga4Realtime: Ga4RealtimeAsset | undefined;
  /** What the Net column's header already says, or null when the rows differ
   * and each has to say it for itself. */
  columnBooking: "booked" | "forecast" | null;
  /** Include the core Tasks cell. */
  tasks: boolean;
  /** The site's one health word (`siteHealth`), the column's verdict. */
  health: SiteHealth;
  onOpen: () => void;
}) {
  const pace = intradayUsersPace(asset, ga4Realtime);
  const trend = asset.activeUsers;
  // This range against the range before it — the one comparison the selector
  // re-derives, and the tone every line on this row takes.
  const delta = usersDelta(asset, rangeDays);
  const clicksDelta = periodDelta(
    wholeSeries(asset.searchClicks),
    rangeDays,
    asset.searchClicks.timeZoneChanges,
    asset.searchClicks.provisionalFrom,
  );
  // The newest day the provider has reported for this asset, and whether it is
  // the one still being counted. The value is the asset's own daily series;
  // `pace` above is the only part that needs the realtime lane.
  const today = trend.series.at(-1) ?? null;
  const todayIsOpen = lastPointIsProvisional(trend.series, trend.provisionalFrom);
  // The range's own window, by date rather than by point count, so a provider
  // that missed three days draws a gap instead of a silently wider window.
  const drawn = windowSeries(wholeSeries(trend), rangeDays);
  const clicks = windowSeries(wholeSeries(asset.searchClicks), rangeDays);
  const booking = bookingState(asset);

  // On a phone a site is its key status and a ›: the stacked card holds the
  // name, the state marks, today, the users line and the tasks, and folds
  // search clicks, net and the report age, which the site's own page leads
  // with. The desk keeps every column.
  return (
    <TableRow opens foldedWhenStacked onClick={onOpen} data-asset-row={asset.id} data-subject={`asset:${asset.id}`}>
      <TableCell>
        {/* `truncate` on the link carries `white-space: nowrap`, so without a
            cap here the cell's minimum width is the whole display name and the
            column can never give anything back. The cap tightens with the
            density below 64rem; the full name is the link's hover. */}
        <div className="flex min-w-0 max-w-44 items-center gap-2 @max-[64rem]:max-w-36 @max-[40rem]:max-w-none">
          <PropertyFavicon domain={asset.id} displayName={asset.displayName} />
          {/* The row navigates on click, which a keyboard cannot do, so the
              name stays a real link and is what Tab reaches. On a phone it is
              a thumb target: the 44px floor is claimed on both axes below
              `sm`, and `truncate` goes with it, because a stacked card has the
              whole card width to spell a name in. */}
          <Link
            to={tabPath(asset.id, siteOpensOn(asset), `?range=${rangeDays}`)}
            onClick={(event) => event.stopPropagation()}
            // Keyed to the table's box, not the screen: a tablet's narrow card
            // is the same stacked card, thumb and all.
            className="min-w-0 rounded-sm font-medium underline-offset-4 outline-none hover:underline @max-[40rem]:inline-flex @max-[40rem]:min-h-11 @max-[40rem]:min-w-11 @max-[40rem]:items-center @min-[40rem]:truncate focus-visible:ring-2 focus-visible:ring-ring"
            title={asset.displayName}
          >
            {asset.displayName}
          </Link>
        </div>
      </TableCell>

      {/* The site's one health word: the same word Home's strip and the
          site's own header say, from the same open problems. The sources
          themselves are on the site's Data sources tab. */}
      <TableCell label="Health" className="text-xs">
        <StateChip label={health.word} tone={health.tone} subject={`asset:${asset.id}`} />
      </TableCell>

      {/* Daily users come from the asset's own daily series; only the pace
          needs the realtime snapshot, so a quiet realtime lane cannot blank
          the column. When the newest point is a settled past day, the figure
          is muted and its day is printed beside it. */}
      <TableCell label="Visitors" className="text-right">
        {today === null ? (
          <Dash />
        ) : (
          // The day sits UNDER the number, as its caption: beside it, a narrow
          // daily users column broke "Sep 5" across two lines.
          <span
            className={cn(
              "inline-flex flex-col items-end tabular-nums",
              !todayIsOpen && "text-muted-foreground",
            )}
            data-users-day={todayIsOpen ? "open" : today.t}
          >
            {/* The pace drops under the figure rather than holding a narrow
                column open. */}
            <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
              {todayIsOpen ? (
                <InfoTooltip label="About today's users" trigger={formatInt(today.v)} className="text-sm text-foreground">
                  So far today, still being counted
                </InfoTooltip>
              ) : formatInt(today.v)}
              {pace?.paceChange == null ? null : (
                <DeltaChip
                  value={pace.paceChange}
                  render={(value) => `${formatPercent(value)}%`}
                  tone={paceTone(pace.paceChange)}
                  className="text-xs"
                />
              )}
            </span>
            {/* The hours the pace compares, under it. No percent until they
                can carry one (`PACE_VERDICT_MINIMUM`). */}
            {todayIsOpen && pace?.paceChange != null ? (
              <span className="whitespace-nowrap text-[11px] leading-tight text-muted-foreground" data-pace-window="shown">
                {paceWindowLabel(pace)}
              </span>
            ) : null}
            {todayIsOpen ? null : (
              <time dateTime={today.t} className="whitespace-nowrap text-[11px] leading-tight">
                {formatSeriesDate(today.t)}
              </time>
            )}
          </span>
        )}
      </TableCell>

      {/* The shape behind the percentage: a delta cannot say whether the asset
          climbed all range or fell off a cliff on Tuesday. The `cell` size, so
          the same line is drawn here and in the strip; its tone is the verdict
          beside it. */}
      <TableCell label={`Visitors · ${rangeDays}d`} foldWhenStacked>
        {drawn.length >= MIN_TREND_POINTS ? (
          // Wraps rather than holding the column open: when the table is
          // tight the move drops under its line instead of widening the row.
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="block" data-users-spark onClick={(event) => event.stopPropagation()}>
              <Sparkline
                data={drawn}
                size="cell"
                tone={deltaTone(delta)}
                area
                readout
                provisionalFrom={trend.provisionalFrom}
                ariaLabel={`${asset.displayName} daily active users, ${drawn[0]!.t} to ${drawn.at(-1)!.t}`}
              />
            </span>
            <UsersMove delta={delta} />
          </span>
        ) : (
          <Dash title={seriesGapReason(drawn.length)} />
        )}
      </TableCell>

      {/* Organic search clicks. No percentage column of its own: two delta
          columns side by side is a table asking to be read twice. */}
      <TableCell label={`Search clicks · ${rangeDays}d`} foldWhenStacked>
        {clicks.length >= MIN_TREND_POINTS ? (
          <span className="block" data-clicks-spark onClick={(event) => event.stopPropagation()}>
            <Sparkline
              data={clicks}
              size="cell"
              tone={deltaTone(clicksDelta)}
              area
              readout
              provisionalFrom={asset.searchClicks.provisionalFrom}
              ariaLabel={`${asset.displayName} organic search clicks, ${clicks[0]!.t} to ${clicks.at(-1)!.t}`}
            />
          </span>
        ) : (
          // Which search source is connected is the State column's marks; the
          // dash says only how much of a line there is.
          <Dash title={seriesGapReason(clicks.length)} />
        )}
      </TableCell>

      {/* Booked money leads; an estimate may take the cell only under a label
          that says what it is. The two are never added, and a month with
          neither says "not booked" rather than $0. The chip is the
          exception's: it appears only on a row whose booking state differs
          from the one its header states. */}
      {/* The month's figure and the months behind it, in one cell. Raw months,
          never averaged: seven periods of a monthly series is seven months.
          Muted, because the movement of net carries no verdict, and hollow at
          the month the store is still standing in. */}
      <TableCell label={`Net · ${formatPeriodMonthYear(asset.netPeriod)}`} className="text-right tabular-nums" foldWhenStacked>
        {booking === null ? (
          <span className="text-muted-foreground">not booked</span>
        ) : (
          <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5">
            {booking === columnBooking ? <span className="text-xs text-muted-foreground sm:hidden">{booking === "forecast" ? "Estimated" : "Booked"}</span> : <BookingChip state={booking} subject={`net:${asset.id}`} />}
            {formatSignedMoney(
              booking === "booked" ? asset.booked.net : asset.forecast.net,
              booking === "booked" ? asset.booked.currency : asset.forecast.currency,
            )}
          </span>
        )}
        {asset.netByMonth.length >= MIN_TREND_POINTS ? (
          <span className="mt-1 block" data-net-spark onClick={(event) => event.stopPropagation()}>
            <Sparkline
              data={asset.netByMonth}
              size="cell"
              tone="muted"
              average={false}
              readout
              provisionalFrom={asset.netByMonthProvisionalFrom}
              format={(value) => formatSignedMoney(value, asset.netByMonthCurrency, { cents: true })}
              ariaLabel={`${asset.displayName} net by month, ${asset.netByMonth[0]!.t} to ${asset.netByMonth.at(-1)!.t}`}
            />
          </span>
        ) : null}
      </TableCell>

      {tasks ? <TableCell label="Tasks" className="text-xs tabular-nums" foldWhenStacked>
        {asset.work === null ? (
          // No task project for this site, or one the last read could not
          // open: either way nothing was counted, so no count is drawn. Which
          // project a site reads is set on Settings, never named here.
          <Dash title="No task data" />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{asset.work.open} open</span>
            {/* A rank, not a severity: the count wears the ink of the bar's
                top segments, never amber. */}
            {asset.work.highPriority !== null && asset.work.highPriority > 0 ? (
              <UrgentCount count={asset.work.highPriority} />
            ) : null}
            {/* What kind of 12 this is: `PriorityBar`, at cell width, drawn
                only from a real distribution, never a flat one invented from
                the total. */}
            <WorkPriorityBar work={asset.work} />
          </span>
        )}
      </TableCell> : null}

    </TableRow>
  );
}

/** The queue's shape at table width, or nothing when the snapshot did not carry
 * a distribution: no `priorities` means no bar, never a flat one made up from
 * the total. */
function WorkPriorityBar({ work }: { work: WorkSummary }) {
  if (work.priorities === null) return null;
  const total = work.priorities.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  return <PriorityBar bands={work.priorities} total={total} className="w-12 shrink-0" />;
}

/**
 * Why a line is not drawn, as a state: "No days reported yet", "Only 2 days
 * reported". Below `MIN_TREND_POINTS` two dots joined by a segment read as a
 * trend the data cannot support. Exported so `/assets`' strip states its gaps
 * in the same words.
 */
export function seriesGapReason(points: number, unit: "day" | "month" = "day"): string {
  if (points === 0) return `No ${unit}s reported yet`;
  return `Only ${points} ${unit}${points === 1 ? "" : "s"} reported`;
}

/** The range's move, beside the line it describes. A comparison nobody can
 * defend is not drawn: no earlier range to compare with, or an earlier range
 * that totalled nothing, both leave the line alone. */
function UsersMove({ delta }: { delta: PeriodDelta | null }) {
  if (delta === null || delta.percent === null) return null;
  const meaning = `Active users over ${deltaMeaning(delta)}.`;
  if (!delta.comparable) {
    return <InfoTooltip label="Why users are not comparable" trigger="Not comparable">{meaning}</InfoTooltip>;
  }
  return (
    <DeltaChip
      value={delta.percent}
      render={(value) => `${formatPercent(value)}%`}
      tone={performanceTone(delta.percent)}
      className="text-xs"
      meaning={meaning}
    />
  );
}

/** Nothing measured: an em dash rather than a zero, which would claim it was,
 * and an accessible reason wherever the cell knows one. */
function Dash({ title = "Nothing measured yet" }: { title?: string }) {
  return <InfoTooltip label={title} trigger="—">{title}</InfoTooltip>;
}

export default AssetsTable;
