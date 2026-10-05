import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
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
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { InfoTooltip } from "@/components/InfoTooltip";
import { DeltaChip, paceTone, performanceTone } from "@/components/DeltaChip";
import { PanelReviewBadge } from "@/components/PanelReviewBadge";
import { PriorityBar } from "@/components/PriorityBar";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { ReportFreshness } from "@/components/ReportFreshness";
import { SeverityDot } from "@/components/SeverityDot";
import { openAlertsLabel } from "@/lib/severity";
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
import { useConnections } from "@/hooks/useConnections";

/**
 * THE PORTFOLIO'S ONE COMPARISON TABLE — one row per asset (bead `ro-78qo.7`).
 *
 * Home built this for its own bottom half (`ro-78qo.6`) and `/assets` is its
 * second surface, so it moved out of `HomeRoute.tsx` rather than being copied:
 * doc 21's whole argument is that two components drawing one shape is how a desk
 * grows two vocabularies for one fact, and "how is each asset doing" is asked on
 * both screens with the same columns.
 *
 * WHY IT LIVES UNDER `routes/` AND NOT `components/`. The registry (doc 14) is
 * for the vocabulary a surface is composed FROM — `Kpi`, `Sparkline`,
 * `ListPanel`. This is one page's layout over one payload slice, shared with the
 * page that summarises it, which is the same call `AssetDetailRoute`'s strips
 * made. It is not a shape a third surface would reach for: an asset's own page
 * shows one asset, and the Wall has its own compact site rows.
 *
 * ORDER IS THE CALLER'S. Home never sorts — the seed order is what makes spatial
 * memory hold, so each site is where it was yesterday whether or not it had a good
 * week — and `/assets` hands over an already-ordered list plus the `sort` it
 * ordered by, which is what lets the header row say which column is doing it.
 *
 * Each column is one fact the asset page states in full, so the row is a scan
 * line rather than a summary: identity, state, today, the shape of the range
 * with its move, the month's money, open work, and whether the nightly report
 * arrived. Every cell that has no answer says so — an em dash with its reason,
 * "not booked" — and never a zero, which would claim something was measured.
 */

/** The orderings the header row can ask for. `seed` is the payload's own and is
 * what a second press of the active header returns to. */
export type AssetSortKey =
  | "seed"
  | "name"
  | "alerts"
  | "work"
  | "users"
  | "net"
  | "trend"
  | "report";

/** Which way the comparator behind each key runs, as a glyph on the active
 * header. Every one of them is WORST FIRST except the two whose order is a
 * reading order rather than a ranking (name, and time since a report). */
const SORT_DIRECTION: Record<Exclude<AssetSortKey, "seed">, "asc" | "desc"> = {
  name: "asc",
  alerts: "desc",
  work: "desc",
  users: "desc",
  net: "desc",
  trend: "desc",
  report: "asc",
};

export interface AssetsTableProps {
  /** In the order they are to be drawn. */
  assets: AssetCard[];
  nowMs: number;
  ga4Realtime?: Ga4RealtimePayload | undefined;
  /**
   * How many days of each asset's daily series the sparkline column draws.
   *
   * Home has no range selector and passes nothing; `/assets` has one and passes
   * the range, which is doc 21's "range changes re-derive every sparkline on the
   * page" for this column. The payload holds 28 days, so a wider window draws
   * what exists rather than inventing days nobody reported.
   */
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
  nowMs,
  ga4Realtime,
  rangeDays = TABLE_SPARK_DAYS,
  sort,
  onSort,
  empty,
}: AssetsTableProps) {
  const navigate = useNavigate();
  const { credentials, items } = useConnections();
  // Core work stays visible; an unread project keeps its unknown state.
  const period = assets[0]?.netPeriod ?? null;
  // The one booking state the whole column shares, or null when the column
  // holds both kinds and the header cannot speak for it. Assets with no money
  // at all do not vote: "not booked" is neither side of the split.
  const booking = sharedBookingState(assets);

  // A caller with its own Add a site (or a filter hiding every row) passes
  // its own empty state; everyone else gets the door (bead `ro-ujb9.96.6.18`).
  if (assets.length === 0) return <>{empty ?? <NoSitesYet />}</>;

  return (
    // Below 40rem of container width, each asset reflows into a labelled card:
    // its key status and the › that opens it, with the rest folded (`AssetRow`).
    //
    // AND IN A BOX UNDER 64REM THE COLUMNS SIT CLOSER (bead `ro-ujb9.163`).
    // A 13-inch laptop at 1280 leaves the table a 982px card, and eight
    // columns with 12px each side scrolled sideways inside it, hiding Reported —
    // the column that says whether a site is still sending. Every column stays;
    // their padding goes from 12px to 8px until the box is 64rem wide, the
    // compact density of a data table. Below 40rem the rows stack as before.
    <Table stacked className={DENSE_BELOW_64REM}>
      {/* EVERY HEADER ON ONE LINE. "USERS · TODAY" and "7-DAY" broke across
          two — "7-" over "DAY" — which is a header row that costs a whole
          extra line of the table's height to say less. Short words and
          `whitespace-nowrap`: a header is two or three words and the cell
          under it is what has to be able to give. */}
      <TableHeader className="[&_th]:whitespace-nowrap">
        <TableRow>
          <SortableHead label="Site" sortKey="name" sort={sort} onSort={onSort} />
          <SortableHead label="State" sortKey="alerts" sort={sort} onSort={onSort} />
          <SortableHead
            label="Daily users"
            sortKey="users"
            sort={sort}
            onSort={onSort}
            align="end"
          />
          {/* Each column names its own window, which is what lets the cells
              below it stay unlabelled at row height. How the line is drawn — a
              trailing 7-day average — is the line's own readout, with each
              point's date, value and reported days; stated again on the header
              it pushed the row past the card at 1440 and clipped Reported.

              THE MOVE RIDES ITS LINE (bead `ro-ujb9.96.6.10`). The range's
              change against the range before it was a column of its own headed
              "28-day", which needed a paragraph to say what it compared; beside
              the users line it is doc 21's KPI unit — the shape and its delta —
              and this header, which names the users and the window, is the one
              that orders by it. */}
          <SortableHead
            label={`Users · ${rangeDays}d`}
            sortKey="trend"
            sort={sort}
            onSort={onSort}
          />
          {/* GOOGLE AND BING AS ONE MEASUREMENT (bead `ro-78qo.35`). A
              comparison table states clicks; it does not state Google's beside
              Bing's and leave the reader to add them. The two providers' own
              lines belong to a chart with a legend — the asset page's Growth
              pair — and not to a 96px cell. "Search" is in the name so a
              portfolio with ad and affiliate clicks cannot read it as those. */}
          <TableHead>Search clicks · {rangeDays}d</TableHead>
          {/* THE BOOKING STATE, SAID ONCE. Six identical "Forecast" chips down
              a column are six copies of one fact; the header carries it
              whenever every row agrees, and only a row that DIFFERS from its
              column wears a chip of its own (bead `ro-78qo.6`). Exceptions are
              marked, the rule is stated. */}
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
          <SortableHead
            label="Reported"
            sortKey="report"
            sort={sort}
            onSort={onSort}
            align="end"
          />
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.map((asset) => (
          <AssetRow
            key={asset.id}
            asset={asset}
            nowMs={nowMs}
            rangeDays={rangeDays}
            ga4Realtime={ga4Realtime?.assets.find(
              (snapshot) => snapshot.asset === asset.id,
            )}
            columnBooking={booking}
            tasks
            connections={{ credentials, items }}
            onOpen={() => navigate(tabPath(asset.id, siteOpensOn(asset), `?range=${rangeDays}`))}
          />
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * A column header that orders the table, or a plain one when nobody is
 * listening.
 *
 * ONE DIRECTION PER COLUMN, and a second press returns to the payload's seed
 * order. Every ordering here has a side that is the question — most open alerts,
 * most urgent work, longest since a report — and offering its reverse would put
 * "the calmest asset first" one press away from the answer, in a control that
 * has to say which of the two it is on. Pressing the active column again is the
 * way back, which is the same gesture without the second state.
 *
 * The button fills the cell rather than sitting inside it, so the thumb target
 * is the header a thumb aims at (doc 21's 44px floor); below `sm` the whole
 * header row is hidden by `Table stacked`, which is why `/assets` keeps its
 * `<select>` as well — that one is the phone's only way to sort.
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
          {/* The arrow is the column's own state, so it is drawn only on the
              one doing the ordering — eight permanent glyphs in a header row is
              eight copies of "this is sortable". A pointer resting on a header
              gets a faint one, which is where the affordance belongs: on the
              thing under the cursor, at the moment it is being considered.

              IT TAKES NO WIDTH (bead `ro-ujb9.163`). Laid out beside the label,
              the invisible arrow held 16px open in every sortable header — and
              five of the eight columns are as wide as their header, so /assets
              ran 77px wider than Home's identical table at 1280. It hangs in
              the header's padding instead, before a right-aligned label (the
              Material data-table placement), after a left-aligned one. */}
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
 * no money to state at all (bead `ro-uwo.2`: booked money leads, an estimate
 * may take the cell only under a label that says what it is). */
export function bookingState(asset: AssetCard): "booked" | "forecast" | null {
  if (figureHasMoney(asset.booked)) return "booked";
  if (figureHasMoney(asset.forecast)) return "forecast";
  return null;
}

/**
 * The booking state EVERY row with money shares, or null.
 *
 * This is what lets the Net column say "forecast" once in its header instead of
 * stamping an identical chip on all six rows — and it goes back to null the
 * moment one asset reconciles, at which point the rows differ and each has to
 * say which it is. A column of six chips is one fact printed six times; a
 * column where only the exception is marked is the same information at a sixth
 * of the ink.
 */
function sharedBookingState(assets: AssetCard[]): "booked" | "forecast" | null {
  const states = new Set(
    assets.map(bookingState).filter((state): state is "booked" | "forecast" => state !== null),
  );
  return states.size === 1 ? [...states][0]! : null;
}

/**
 * The trend cell's tone, by the same rule the strip colours a delta with.
 *
 * Under ±2% a movement is weather, not a verdict (doc 21), and a table where
 * every row is faintly green or faintly red says nothing louder than one that is
 * honestly grey. Up is good for active users, so the mapping needs no argument.
 */
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

/**
 * THE WHOLE SERIES, CONTEXT AND ALL (bead `ro-78qo.35`).
 *
 * `contextSeries` was calculation-only pre-roll while the payload's window was
 * 28 days and nothing could ask for more. It is 62 days now and `series` is
 * still 28, so the two together ARE the ninety days the range selector offers —
 * and a caller that read `series` alone would draw 28 days under a label saying
 * three months. Windowing is by DATE (`windowSeries`), so a shorter range slices
 * the same combined line and gets exactly the days it asked for.
 */
function wholeSeries(trend: SignalTrend) {
  return [...(trend.contextSeries ?? []), ...trend.series];
}

/**
 * This range against the range before it, for one asset's users.
 *
 * Exported because `/assets` ORDERS by it and the cell that prints it must be
 * the same arithmetic (doc 14): a column sorted by one derivation and labelled
 * by another is a table that disagrees with itself. It returns `null` — and the
 * cell draws a dash with the reason on hover — whenever the payload does not
 * reach back a whole range before this one, which at 90 days it never does:
 * ninety against the ninety before them would need half a year of history.
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
  nowMs,
  rangeDays,
  ga4Realtime,
  columnBooking,
  tasks,
  connections,
  onOpen,
}: {
  asset: AssetCard;
  nowMs: number;
  rangeDays: number;
  ga4Realtime: Ga4RealtimeAsset | undefined;
  /** What the Net column's header already says, or null when the rows differ
   * and each has to say it for itself. */
  columnBooking: "booked" | "forecast" | null;
  /** Include the core Tasks cell. */
  tasks: boolean;
  /** Where each source's status comes from (`sourceReadings`). */
  connections: ConnectionReads;
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
  // the one still being counted. The VALUE is the asset's own daily series and
  // needs no realtime lane at all; `pace` above is the only part that does.
  const today = trend.series.at(-1) ?? null;
  const todayIsOpen = lastPointIsProvisional(trend.series, trend.provisionalFrom);
  // The range's own window, BY DATE rather than by point count, so a provider
  // that missed three days draws a gap instead of a silently wider window —
  // and over the WHOLE series, so ninety days is ninety days.
  const drawn = windowSeries(wholeSeries(trend), rangeDays);
  const clicks = windowSeries(wholeSeries(asset.searchClicks), rangeDays);
  const booking = bookingState(asset);
  const sources = sourceReadings(asset.id, asset.dataSources, connections, nowMs);

  // ON A PHONE A SITE IS ITS KEY STATUS AND A › (bead `ro-ujb9.13`). The
  // stacked card drew all eight columns, 330px a site, so three sites needed
  // three screens and the first screen held one. It now holds the name, the
  // state marks, today, the users line and the tasks — whether the site is
  // fine and whether it needs you — and folds search clicks, net and the report
  // age, which the site's own page (the row's › opens it) leads with. The
  // report's state is already one of the State marks. The desk keeps every
  // column.
  return (
    <TableRow opens foldedWhenStacked onClick={onOpen} data-asset-row={asset.id} data-subject={`asset:${asset.id}`}>
      <TableCell>
        {/* `truncate` on the link carries `white-space: nowrap`, so without a
            cap here the cell's MINIMUM width is the whole display name and the
            column can never give anything back — the truncation was decorative
            (bead `ro-pbzu.10`). The cap is what makes it real, and it tightens
            with the density below 64rem (bead `ro-ujb9.163`): the full name is
            the link's hover and the site's own page. */}
        <div className="flex min-w-0 max-w-44 items-center gap-2 @max-[64rem]:max-w-36 @max-[40rem]:max-w-none">
          <PropertyFavicon domain={asset.id} displayName={asset.displayName} />
          {/* The row navigates on click, which a keyboard cannot do — so the
              name stays a real link and is what Tab reaches.

              AND ON A PHONE IT IS A THUMB TARGET (`ro-md80`, doc 21). It is a
              flex item, so its computed display is `block` rather than `inline`
              — it is a control, not a word inside a sentence, and the audit
              measured it at 31×20px for a three-letter name. The 44px floor is claimed on
              both axes below `sm`, and `truncate` goes with it: the ellipsis
              exists for the desk COLUMN, and a stacked card has the whole card
              width to spell a name in. */}
          <Link
            to={tabPath(asset.id, siteOpensOn(asset), `?range=${rangeDays}`)}
            onClick={(event) => event.stopPropagation()}
            // Keyed to the TABLE'S box, not the screen (bead ro-ujb9.13): a
            // tablet's narrow card is the same stacked card, thumb and all, and
            // its first line is the 44px the card's › is drawn against.
            className="min-w-0 rounded-sm font-medium underline-offset-4 outline-none hover:underline @max-[40rem]:inline-flex @max-[40rem]:min-h-11 @max-[40rem]:min-w-11 @max-[40rem]:items-center @min-[40rem]:truncate focus-visible:ring-2 focus-visible:ring-ring"
            title={asset.displayName}
          >
            {asset.displayName}
          </Link>
          <PanelReviewBadge
            review={asset.panelReview}
            latestPanelDate={asset.latestPanelDate}
            nowMs={nowMs}
          />
        </div>
      </TableCell>

      {/* ONE LINE: A DOT, A STAGE WORD, AND TWO GLYPHS.
          The dot is the asset's worst open severity — the one thing on this row
          allowed to be red — and it leads the cell rather than trailing the
          name, so the column reads as a column of states instead of a column of
          names with something occasionally stuck to them.

          THE MODE IS A GLYPH, not "· Automation enabled". Whether the OS may
          act on an asset is a standing permission that changes about once in its
          life, and spelling it on all six rows wrapped every one of them onto a
          second line — 238px of a 1142px table spent saying the same thing six
          times (bead `ro-pbzu.10` fixed the width, `ro-78qo.6` the line). Two
          shapes, never colour alone, each with the sentence on hover and the
          word in the accessible name.

          AND THE SETUP RING IS GONE FROM THIS ROW (2026-09-05, design review on
          `ro-78qo.6`). `ro-28ma` put it here as a third fact — the stage word
          says WHICH stage, the ring how far through its checklist — and the
          argument still holds where it has room. It does not have room here: at
          16px, beside the mode glyph, a part-filled segmented ring reads as a
          spinner, and it drew on five of six rows, so the column's loudest shape
          was the one nobody could decode. The fraction is not lost — the asset's
          Overview banner states it ("2 of 4 done"), which is the page an
          operator opens when the stage word is the thing they doubted.

          SOURCE MARKS share the connection status used across the desk: each is its
          source's status as the asset's Data sources row and Integrations give
          it, so Home cannot call an asset fine while one of its sources fails. */}
      <TableCell label="State" className="text-xs text-muted-foreground">
        <span className="flex items-center gap-x-1.5">
          <SeverityDot
            severity={asset.worstSeverity}
            title={openAlertsLabel(asset.openError, asset.openWarn)}
          />
          <DataSourceIcons sources={sources} />
        </span>
      </TableCell>

      {/* DAILY USERS COME FROM THE ASSET'S OWN DAILY SERIES; only the PACE
          needs the realtime snapshot (bead `ro-78qo.6`). Reading both off
          `intradayUsersPace` printed a dash on every row the moment GA4's
          realtime lane went quiet — six dashes over a payload that had the
          numbers and had just drawn them as sparklines two columns over.
          When the newest point is a SETTLED past day rather than the one the
          provider is still counting, the figure is muted and its day is
          printed beside it, so the daily figure names the day it represents
          — and a day that only a hover names
          is one a glance never sees (bead `ro-ujb9.96.6.10`). */}
      <TableCell label="Daily users" className="text-right">
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
                column open (bead `ro-ujb9.163`). */}
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
            {/* The hours the pace compares, under it (bead ro-trai.43). No
                percent until they can carry one (`PACE_VERDICT_MINIMUM`). */}
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

      {/* THE SHAPE BEHIND THE PERCENTAGE. A delta says which way and how far; it
          cannot say whether the asset has been climbing all range or fell off a
          cliff on Tuesday and has been flat since — and those two are different
          mornings under one identical "+4%". Doc 21's `cell` size, so the same
          line is drawn here and in the strip at the two widths the vocabulary
          allows, and its tone is the verdict beside it. */}
      <TableCell label={`Users · ${rangeDays}d`}>
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

      {/* ORGANIC SEARCH CLICKS, the second thing an operator compares across a
          portfolio (bead `ro-78qo.35`). No percentage column of its own: two
          delta columns side by side is a table asking to be read twice, and the
          line already says which way this one is going. */}
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
          that says what it is (bead `ro-uwo.2`). The two are never added, and a
          month with neither says "not booked" rather than $0.

          THE LABEL IS THE COLUMN'S WHENEVER EVERY ROW AGREES (bead
          `ro-78qo.6`). Both sides used to wear a chip, which was right while the
          column mixed them and became six identical "Forecast" pills the moment
          it did not — one fact printed six times, in the loudest thing in the
          cell. The chip is now the EXCEPTION's: it appears only on a row whose
          booking state differs from the one its header states, which is the row
          a reader actually has to notice. */}
      {/* THE MONTH'S FIGURE AND THE MONTHS BEHIND IT, in one cell (bead
          `ro-78qo.35`). Doc 21 principle 2: a number without its series is
          noise. A column of its own would have made a second Net header for one
          fact — the number and its shape are the same fact — so the line sits
          under the figure the way a `Kpi`'s does.

          RAW MONTHS, never averaged: seven periods of a monthly series is seven
          MONTHS, and on an asset with six months of history that mean is a
          straight line with the one dip worth seeing smoothed out of it. Muted,
          because the movement of net carries no verdict — a month that fell
          because an annual invoice landed is not a worse month — and hollow at
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

      {tasks ? <TableCell label="Tasks" className="text-xs tabular-nums">
        {asset.work === null ? (
          // No task project for this site, or one the last read could not
          // open: either way nothing was counted, so no count is drawn. Which
          // project a site reads is set on Settings, never named here.
          <Dash title="No task data" />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{asset.work.open} open</span>
            {/* A rank, not a severity (doc 14, bead ro-ujb9.240): the count
                wears the ink of the bar's top segments, never amber. */}
            {asset.work.highPriority !== null && asset.work.highPriority > 0 ? (
              <UrgentCount count={asset.work.highPriority} />
            ) : null}
            {/* WHAT KIND OF 12 THIS IS — `PriorityBar`, at cell width.
                "12 open · 3 urgent" is two numbers; the bar is where they sit in
                the queue's shape, and it is drawn ONLY from a real distribution,
                never a flat one invented from the total. */}
            <WorkPriorityBar work={asset.work} />
          </span>
        )}
      </TableCell> : null}

      {/* The column is headed "Reported", so the cell is "16h ago" — the
          component's own "Updated " prefix is what pushed this onto two lines
          in a 100px column, and it was saying the header's word again. */}
      <TableCell label="Reported" className="whitespace-nowrap text-right" foldWhenStacked>
        <ReportFreshness
          iso={asset.pulseReceivedAt}
          nowMs={nowMs}
          label={false}
          declared={asset.noNightlyReport}
        />
      </TableCell>


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
 * WHY A LINE IS NOT DRAWN, as a state rather than a sentence (bead
 * `ro-ujb9.96.6.10`): "No days reported yet", "Only 2 days reported". Below
 * `MIN_TREND_POINTS` two dots joined by a segment read as a trend the data
 * cannot support, so the cell or KPI draws nothing and this is its reason.
 * Exported so `/assets`' strip states its gaps in the same words.
 */
export function seriesGapReason(points: number, unit: "day" | "month" = "day"): string {
  if (points === 0) return `No ${unit}s reported yet`;
  return `Only ${points} ${unit}${points === 1 ? "" : "s"} reported`;
}

/**
 * THE RANGE'S MOVE, beside the line it describes.
 *
 * A comparison nobody can defend is not drawn smaller or greyer; it is not
 * drawn (doc 14). No earlier range to compare with — every row at ninety days,
 * since the payload holds ninety — and an earlier range that totalled nothing
 * both leave the line alone; two sides that are not like-for-like say so.
 */
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

/** Nothing measured. An em dash rather than a zero, which would claim it was —
 * and, wherever the cell knows one, an accessible reason (doc 21 principle 8). */
function Dash({ title = "Nothing measured yet" }: { title?: string }) {
  return <InfoTooltip label={title} trigger="—">{title}</InfoTooltip>;
}

export default AssetsTable;
