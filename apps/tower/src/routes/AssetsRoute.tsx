import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ASSET_STATUS_LABEL, assetStatusLabel } from "@shared/asset-detail";
import { sourceReadings, sourcesSummary } from "@shared/connection-status";
import { ageMs, formatAge } from "@shared/freshness";
import { siteCount, siteNoun } from "@shared/site-noun";
import {
  DEFAULT_RANGE_DAYS,
  SURFACE_RANGES,
  windowSeries,
} from "@shared/surface";
import type {
  AssetCard as AssetData,
  SeriesPoint,
  Severity,
  WallPayload,
} from "@shared/wall";
import { AddSiteButton } from "@/components/AddSite";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { priorityFill } from "@/components/PriorityBar";
import { ReadFailed } from "@/components/ReadFailed";
import { SegmentBar } from "@/components/SegmentBar";
import { portfolioHeadline, portfolioHeadlineWord } from "@/lib/portfolio-headline";
import { SeverityDot } from "@/components/SeverityDot";
import { STATE_TONE, type StateTone } from "@/components/StateChip";
import { FilterControls, FilterFold, FilterToggle } from "@/components/surface/FilterBar";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import {
  formatInt,
  formatCalendarDate,
  formatPeriodMonth,
  formatPeriodMonthYear,
  formatMoney,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AssetsTable,
  bookingState,
  seriesGapReason,
  usersDelta,
  type AssetSortKey,
} from "@/routes/assets/AssetsTable";
import { metricWindow } from "@/routes/asset-detail/overview-metrics";

type AutomationKey = "all" | "on" | "observe";
type AttentionKey = "all" | "open" | "clear";

/** doc 17 maps `sense_only` to ONE pair of words — "Monitor only" and
 * "Automation enabled" — and the asset page has always used them. This index
 * said "Observe only" and "Automation on" for the same two states, so the chip
 * an operator clicks here named the fact differently from the page it opens
 * (bead `ro-06ww`). */
const AUTOMATION_LABEL: Record<Exclude<AutomationKey, "all">, string> = {
  on: "Automation enabled",
  observe: "Monitor only",
};

/** Automation filters use StateChip's affirmative / declined tones. */
const AUTOMATION_TONE: Record<Exclude<AutomationKey, "all">, StateTone> = {
  on: "affirmative",
  observe: "declined",
};

const ATTENTION_LABEL: Record<Exclude<AttentionKey, "all">, string> = {
  open: "Has open alerts",
  clear: "All clear",
};

/**
 * `summary` is how the line above the table names the ordering; `null` on the
 * default, which the summary says nothing about because it is not a choice.
 *
 * THE SELECT AND THE HEADER ROW ARE ONE CONTROL (bead `ro-78qo.7`). The table's
 * header cells sort on a press, which is what a comparison table owes a pointer;
 * below `sm` that header row is hidden entirely (`Table stacked`), so this
 * `<select>` is the phone's only way to reorder — and both write the same
 * `?sort=`, so the two can never disagree about what the table is showing.
 */
const SORTS: { value: AssetSortKey; label: string; summary: string | null }[] = [
  { value: "seed", label: "Default order", summary: null },
  { value: "name", label: "Name (A–Z)", summary: "name" },
  { value: "alerts", label: "Most open alerts", summary: "open alerts" },
  { value: "work", label: "Most urgent work", summary: "urgent work" },
  { value: "users", label: "Latest daily users", summary: "latest daily users" },
  // The move column follows the range, so the words that name it cannot be
  // fixed at seven days any more (bead `ro-78qo.35`).
  { value: "trend", label: "Best move over the range", summary: "the move over the range" },
  { value: "net", label: "Most net", summary: "net" },
  {
    value: "report",
    label: "Longest since a report",
    summary: "time since the last report",
  },
];

function openAlerts(card: AssetData): number {
  return card.openError + card.openWarn;
}

/**
 * A fact the payload does not carry, sunk to the bottom of a descending sort.
 *
 * Finite on purpose: `-Infinity - -Infinity` is `NaN`, which makes a comparator
 * inconsistent and hands the operator an arbitrary order. Every real count here
 * is ≥ 0, so −1 sorts below all of them and subtracts from itself cleanly.
 *
 * It is also NOT a zero. "No beads snapshot for this asset" and "no urgent work"
 * are different claims, and a sort that ranked them together would put an
 * unmeasured asset among the calm ones.
 */
const UNKNOWN = -1;

function urgentWork(card: AssetData): number {
  return card.work?.highPriority ?? UNKNOWN;
}

function openWork(card: AssetData): number {
  return card.work?.open ?? UNKNOWN;
}

function latestDailyUsers(card: AssetData): number {
  return card.activeUsers.series.at(-1)?.v ?? UNKNOWN;
}

/**
 * The net this row STATES, or null when it states none.
 *
 * A sentinel would not do here and does everywhere else on this page: net is
 * signed, so any number chosen to mean "unmeasured" is a number some asset could
 * really have. Null travels instead and `unknownLast` puts it at the bottom,
 * which keeps "nothing booked" out of the run of losses it would otherwise join.
 */
function netOf(card: AssetData): number | null {
  const state = bookingState(card);
  if (state === null) return null;
  return state === "booked" ? card.booked.net : card.forecast.net;
}

/** Descending, with an unmeasured row last whichever way the numbers run. */
function unknownLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Epoch ms of the latest report; 0 for an asset that has never sent one, which
 * is the oldest possible answer and therefore leads the "longest since"
 * ascending sort — a silent asset is exactly what that ordering is for. */
function reportedAt(card: AssetData): number {
  if (card.pulseReceivedAt === null) return 0;
  const parsed = Date.parse(card.pulseReceivedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Every non-default ordering, each worst-first so the top of the table is the
 * asset the operator most likely came for. `Array.prototype.sort` is stable, so
 * ties fall back to the payload's seed order rather than to chance.
 *
 * IT TAKES THE RANGE, because one of them depends on it: the move column is the
 * range's own `periodDelta` since bead `ro-78qo.35`, and a table ordered by one
 * derivation while its column prints another is a table that disagrees with
 * itself (doc 14). At ninety days that comparison is null on every row — the
 * payload holds ninety days and cannot reach back a second ninety — so the
 * ordering falls to seed order there, which is what `unknownLast` already does
 * for a row nobody can rank.
 */
function comparatorFor(
  sort: Exclude<AssetSortKey, "seed">,
  rangeDays: number,
): (a: AssetData, b: AssetData) => number {
  switch (sort) {
    case "name":
      return (a, b) => a.displayName.localeCompare(b.displayName);
    case "alerts":
      return (a, b) => openAlerts(b) - openAlerts(a) || b.openError - a.openError;
    case "work":
      return (a, b) => urgentWork(b) - urgentWork(a) || openWork(b) - openWork(a);
    case "users":
      return (a, b) => latestDailyUsers(b) - latestDailyUsers(a);
    case "trend":
      return (a, b) =>
        unknownLast(
          usersDelta(a, rangeDays)?.percent ?? null,
          usersDelta(b, rangeDays)?.percent ?? null,
        );
    case "net":
      return (a, b) => {
        const currency = (card: AssetData) => bookingState(card) === 'booked' ? card.booked.currency : card.forecast.currency;
        const left = currency(a), right = currency(b);
        return left === right ? unknownLast(netOf(a), netOf(b))
          : (left ?? '~').localeCompare(right ?? '~');
      };
    case "report":
      return (a, b) => reportedAt(a) - reportedAt(b);
  }
}

/** Portfolio summaries are independent of the table's filters. Only traffic
 * follows the selected day range; latest status and monthly money do not.
 * Filters, ordering and traffic range remain shareable URL state. */
export function AssetsRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  // Tasks is a core capability even when its latest reading is unavailable.
  const realtime = useGa4Realtime();
  const now = useNow();
  const [params, setParams] = useSearchParams();

  const status = params.get("status") ?? "all";
  const automation = readKey<AutomationKey>(params.get("automation"), [
    "all",
    "on",
    "observe",
  ]);
  const attention = readKey<AttentionKey>(params.get("attention"), [
    "all",
    "open",
    "clear",
  ]);
  const sort = readKey<AssetSortKey>(
    params.get("sort"),
    SORTS.map((option) => option.value),
  );
  const range = readRange(params.get("range"));

  function setFilter(name: string, value: string) {
    const next = new URLSearchParams(params);
    // The default never occupies the query string, so a cleared page is `/assets`
    // and two operators who narrowed to the same view produce the same link.
    if (
      value === "all" ||
      (name === "sort" && value === "seed") ||
      (name === "range" && value === String(DEFAULT_RANGE_DAYS))
    ) {
      next.delete(name);
    }
    else next.set(name, value);
    // `replace`: a filter is a view of one page, not a place — the back button
    // should leave Assets, not walk backwards through every control touched.
    setParams(next, { replace: true });
  }

  const assets = data?.assets ?? [];
  const matches = assets.filter(
    (card) =>
      (status === "all" || card.status === status) &&
      (automation === "all" ||
        card.senseOnly === (automation === "observe")) &&
      (attention === "all" ||
        (attention === "open" ? openAlerts(card) > 0 : openAlerts(card) === 0)),
  );
  const visible =
    sort === "seed" ? matches : [...matches].sort(comparatorFor(sort, range));

  const activeFilterCount = [status, automation, attention].filter((value) => value !== "all").length;
  const narrowed = activeFilterCount > 0;
  const ordered = sort !== "seed";

  /**
   * Counts are over the WHOLE portfolio, not over what the other controls have
   * already narrowed. "How many assets are live" is a fact about the portfolio
   * and stays true whatever else is picked; a count that moved every time
   * another control did would be a fourth number on a page whose summary line
   * already reconciles the arithmetic.
   */
  const statusCounts = new Map<string, number>();
  for (const card of assets) {
    statusCounts.set(card.status, (statusCounts.get(card.status) ?? 0) + 1);
  }
  // The five canonical stages always appear, in lifecycle order, even at zero:
  // the vocabulary is the asset lifecycle, not whatever this store happens to
  // hold today. A status a migration added and the Tower has never seen is
  // appended rather than dropped, the same stance `assetStatusLabel` takes —
  // including one that arrives only in the URL, so a link can never leave the
  // control showing nothing at all.
  const statusOptions = [
    ...Object.keys(ASSET_STATUS_LABEL),
    ...[
      ...new Set([
        ...statusCounts.keys(),
        ...(status === "all" ? [] : [status]),
      ]),
    ]
      .filter((value) => !(value in ASSET_STATUS_LABEL))
      .sort(),
  ];

  const observeOnly = assets.filter((card) => card.senseOnly).length;
  const withOpen = assets.filter((card) => openAlerts(card) > 0);
  // The bucket's dot shows the WORST thing inside it, so a portfolio with one
  // error does not advertise itself in warning amber.
  const worstOpen: Severity | null =
    withOpen.length === 0
      ? null
      : withOpen.some((card) => card.openError > 0)
        ? "error"
        : "warn";

  const filterSummary: string[] = [];
  if (status !== "all") {
    filterSummary.push(`status: ${assetStatusLabel(status).toLowerCase()}`);
  }
  if (automation !== "all") {
    filterSummary.push(
      `automation: ${AUTOMATION_LABEL[automation].toLowerCase()}`,
    );
  }
  if (attention !== "all") {
    filterSummary.push(`attention: ${ATTENTION_LABEL[attention].toLowerCase()}`);
  }
  const noun = siteNoun(assets.length);
  const sortSummary = SORTS.find((option) => option.value === sort)?.summary;
  const summary = [
    narrowed
      ? `${visible.length} of ${assets.length} ${noun}`
      : `${assets.length} ${noun}`,
    ...filterSummary,
    ...(sortSummary ? [`sorted by ${sortSummary}`] : []),
  ].join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Sites"
        actions={
          // Opens Add a site over this page (bead `ro-ujb9.96.7.5`): adding a
          // site is one question, not a page of its own.
          <AddSiteButton>
            <Plus aria-hidden /> Add a site
          </AddSiteButton>
        }
        meta={
          data && assets.length > 0 ? (
            <span className="text-xs text-muted-foreground" data-assets-age>
              updated {formatAge(ageMs(now, data.generatedAt))} ago
            </span>
          ) : undefined
        }
      />

      {/* THE MACHINERY ARRIVES WITH SOMETHING TO COMPARE (bead
          `ro-ujb9.128`). Filters, a sort, a range and a strip adding the
          sites up are how two or more sites are compared; over none they are
          twelve controls round an empty state, and over one they filter a
          single row. So no sites is the header's Add a site and one empty
          state, and one site is its row. */}
      {!data ? (
        isError ? (
          <ReadFailed title="Couldn't load your sites" subject="read:sites" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] flex-1 place-items-center text-muted-foreground">Loading…</div>
        )
      ) : assets.length === 0 ? (
        <section data-surface-hero data-assets-empty className="rounded-[10px] border border-border bg-card px-4 py-3">
          <EmptyState title="No sites yet" />
        </section>
      ) : assets.length === 1 ? (
        <section data-surface-hero className="rounded-[10px] border border-border bg-card p-1">
          <AssetsTable assets={assets} nowMs={now} ga4Realtime={realtime.data} />
        </section>
      ) : (
        <FilterFold active={activeFilterCount} label="Filters & sort">
          {/* The fold's one press shares the range's row on a phone: the
              period stays in view (it changes what every number means), the
              filters and the sort wait behind the button (doc 21's phone first
              screen, bead `ro-ujb9.13`). */}
          <div className="flex flex-wrap items-end justify-between gap-2" data-assets-traffic-controls>
            <FilterToggle />
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
              <span className="text-xs font-medium text-muted-foreground max-sm:sr-only">Traffic period</span>
              <RangeSelector value={range} label="Traffic period" onChange={(days) => setFilter("range", String(days))} />
            </div>
          </div>
          <FilterControls
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
            marks={{ "data-assets-filters": "" }}
          >
            <label className="sr-only" htmlFor="assets-status">
              Status
            </label>
            <select
              id="assets-status"
              className={fieldClass}
              value={status}
              onChange={(event) => setFilter("status", event.target.value)}
            >
              <option value="all">All stages · {assets.length}</option>
              {statusOptions.map((value) => (
                <option key={value} value={value}>
                  {assetStatusLabel(value)} · {statusCounts.get(value) ?? 0}
                </option>
              ))}
            </select>

            <FilterChips
              legend="Automation"
              name="automation"
              value={automation}
              onPick={setFilter}
              options={[
                { value: "all", label: "All", count: assets.length },
                {
                  value: "on",
                  label: AUTOMATION_LABEL.on,
                  count: assets.length - observeOnly,
                  glyph: <ToneDot tone={AUTOMATION_TONE.on} />,
                },
                {
                  value: "observe",
                  label: AUTOMATION_LABEL.observe,
                  count: observeOnly,
                  glyph: <ToneDot tone={AUTOMATION_TONE.observe} />,
                },
              ]}
            />

            <FilterChips
              legend="Attention"
              name="attention"
              value={attention}
              onPick={setFilter}
              options={[
                { value: "all", label: "All", count: assets.length },
                {
                  value: "open",
                  label: ATTENTION_LABEL.open,
                  count: withOpen.length,
                  glyph: <SeverityDot severity={worstOpen} size="sm" />,
                },
                {
                  value: "clear",
                  label: ATTENTION_LABEL.clear,
                  count: assets.length - withOpen.length,
                  glyph: <SeverityDot severity={null} healthy size="sm" />,
                },
              ]}
            />

            <label className="sr-only" htmlFor="assets-sort">
              Sort
            </label>
            <select
              id="assets-sort"
              className={cn(fieldClass, "ml-auto")}
              value={sort}
              onChange={(event) => setFilter("sort", event.target.value)}
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FilterControls>

          <div data-surface-hero className="grid gap-3.5 max-sm:order-last lg:grid-cols-6">
            <section aria-labelledby="assets-status-scope" className="hidden overflow-hidden rounded-[10px] border border-border bg-card sm:block lg:col-span-3">
              <SectionLabel id="assets-status-scope" title="Latest status" className="min-h-10 border-b border-border/60 px-4 py-2" />
              <KpiStrip columns={3}>
                <PortfolioAssetsKpi assets={assets} nowMs={now} />
                <OpenAlertsKpi payload={data} />
                <OpenTasksKpi assets={assets} />
              </KpiStrip>
            </section>
            <section aria-labelledby="assets-traffic-scope" className="overflow-hidden rounded-[10px] border border-border bg-card lg:col-span-2">
              <SectionLabel id="assets-traffic-scope" title={`Traffic · ${range} days`} className="sr-only sm:not-sr-only sm:min-h-10 sm:border-b sm:border-border/60 sm:px-4 sm:py-2" />
              <KpiStrip columns={2}>
                <LatestDailyUsersKpi assets={assets} rangeDays={range} />
                <UsersRangeKpi assets={assets} rangeDays={range} />
              </KpiStrip>
            </section>
            <section aria-labelledby="assets-financials-scope" className="hidden overflow-hidden rounded-[10px] border border-border bg-card sm:block">
              <SectionLabel id="assets-financials-scope" title={`Money · ${formatPeriodMonthYear(data.portfolio.period)}`} className="min-h-10 border-b border-border/60 px-4 py-2" />
              <KpiStrip columns={1}>
                <NetKpi portfolio={data.portfolio} />
              </KpiStrip>
            </section>
          </div>

          <p
            className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground"
            data-assets-summary
          >
            <span>{summary}</span>
            {narrowed || ordered ? (
              <Link
                to={{ search: range === DEFAULT_RANGE_DAYS ? "" : `?range=${range}` }}
                replace
                className="font-medium text-foreground underline-offset-4 outline-none hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear
              </Link>
            ) : null}
          </p>

          <section className="rounded-[10px] border border-border bg-card p-1">
            <AssetsTable
              assets={visible}
              nowMs={now}
              ga4Realtime={realtime.data}
              rangeDays={range}
              sort={sort}
              onSort={(key) => setFilter("sort", key)}
              empty={
                // Not "No sites yet": there are sites, and a control hides
                // them. The line just above names those controls and holds
                // Clear, the way back — so this says only that nothing
                // matches, not a second copy of the filters with directions.
                <EmptyState title="No sites match these filters" />
              }
            />
          </section>
        </FilterFold>
      )}
    </div>
  );
}

/**
 * ALL THREE WINDOWS, at last (bead `ro-78qo.35`).
 *
 * This page shipped offering 7 and 28 only, because the wall payload carried 28
 * days of each asset's daily series and a 90d button would have drawn 28 days of
 * line under a label claiming three months. The payload reaches back ninety now
 * — `contextSeries` is 62 days beside a 28-day `series` — so the selector is
 * doc 21's own `SURFACE_RANGES` and nothing here narrows it.
 */
function readRange(value: string | null): number {
  const days = Number(value);
  return (SURFACE_RANGES as readonly number[]).includes(days)
    ? days
    : DEFAULT_RANGE_DAYS;
}

/**
 * THE PORTFOLIO'S DAILY ACTIVE USERS: every asset's own series, summed by day.
 *
 * By DATE rather than by position, because the assets do not report in step — a
 * provider that missed Tuesday for one asset must not shift that asset's
 * Wednesday onto the portfolio's Tuesday. A day nobody reported is absent
 * entirely rather than zero, which is the same rule every series on this desk
 * keeps.
 */
function portfolioUsersSeries(assets: AssetData[]): SeriesPoint[] {
  const byDay = new Map<string, number>();
  for (const asset of assets) {
    // The context holds the earlier dates required by the 90-day control.
    // One asset/date contributes once even if a payload overlaps both arrays.
    const perAsset = new Map([
      ...(asset.activeUsers.contextSeries ?? []),
      ...asset.activeUsers.series,
    ].map((point) => [point.t, point.v]));
    for (const [date, value] of perAsset) {
      byDay.set(date, (byDay.get(date) ?? 0) + value);
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({ t, v }));
}

/** The earliest day any asset is still counting, which is the first day the
 * portfolio's own total is incomplete. Null when every provider has closed its
 * books. */
function portfolioProvisionalFrom(assets: AssetData[]): string | null {
  const days = assets
    .map((asset) => asset.activeUsers.provisionalFrom)
    .filter((day): day is string => day !== null);
  return days.length === 0 ? null : days.reduce((a, b) => (a < b ? a : b));
}

/** How much of the portfolio is actually receiving data, as a count and a
 * shape. The strip is drawn from two sites, so there is always a count.
 *
 * The bar is TWO segments and not five: doc 21 spends colour on severity and
 * provider only, so a five-colour lifecycle ramp would be the decorative palette
 * the whole rethink exists to remove. Receiving is foreground ink, the rest is
 * the muted track, and the caption says which is which — in the words each
 * source's own mark uses, so it needs no note on how it was derived. */
function PortfolioAssetsKpi({ assets, nowMs }: { assets: AssetData[]; nowMs: number }) {
  // An asset receives data when one of its sources is Working — the status its
  // own marks and Data sources rows show (bead `ro-ujb9.96.7.16`).
  const { credentials, items } = useConnections();
  const live = assets.filter((card) =>
    sourcesSummary(sourceReadings(card.id, card.dataSources, { credentials, items }, nowMs)).counts.working > 0).length;
  const rest = assets.length - live;

  return (
    <Kpi
      label="Sites"
      value={formatInt(assets.length)}
      improvement="none"
      caption={`${live} receiving data${rest ? ` · ${rest} unconfirmed` : ""}`}
      footer={
        <SegmentBar
          className="mt-2"
          ariaLabel={`${live} of ${siteCount(assets.length)} receiving data`}
          data-assets-lifecycle=""
          segments={[
            { name: "live", value: live, fill: "bg-foreground" },
            { name: "rest", value: rest, fill: "bg-muted-foreground/30" },
          ]}
        />
      }
    />
  );
}

/**
 * Below this a line is two dots joined by a segment, which the eye reads as a
 * trend the data cannot support — `Kpi`'s own floor, restated here because this
 * page has to decide between drawing the line and DECLARING that it cannot
 * (doc 21's third answer) before it hands the series over. The declared reason
 * is the table's own (`seriesGapReason`), so a row and the strip above it say
 * a missing line the same way.
 */
const MIN_SPARK_POINTS = 3;

/** A point-in-time count the store keeps no by-day record of: its KPI shows
 * its composition when there is one, and this reason when there is not. */
const NO_DAILY_HISTORY = "No daily history kept";

/** The newest reported day is not necessarily today. Its raw daily trend uses
 * the selected traffic range; the point remains provisional while counting. */
function LatestDailyUsersKpi({ assets, rangeDays }: { assets: AssetData[]; rangeDays: number }) {
  const series = windowSeries(portfolioUsersSeries(assets), rangeDays);
  const provisionalFrom = portfolioProvisionalFrom(assets);
  const latest = series.at(-1) ?? null;
  const reporting = assets.filter(
    (card) => card.activeUsers.series.at(-1)?.t === latest?.t,
  ).length;

  if (latest === null) {
    return (
      <Kpi
        label="Latest daily users"
        value="—"
        improvement="up"
        seriesUnavailable={seriesGapReason(0)}
      />
    );
  }

  const drawable = series.length >= MIN_SPARK_POINTS;
  return (
    <Kpi
      label="Latest daily users"
      value={formatInt(latest.v)}
      improvement="up"
      caption={<><time dateTime={latest.t}>{formatCalendarDate(latest.t)}</time> · {reporting} of {siteCount(assets.length)}</>}
      spark={drawable ? series : undefined}
      seriesUnavailable={drawable ? undefined : seriesGapReason(series.length)}
      sparkAverage={false}
      sparkProvisionalFrom={provisionalFrom}
    />
  );
}

/**
 * AVERAGE DAILY USERS, against the average over the previous window.
 *
 * This is the one figure on the page the range selector exists for: the average,
 * the comparison and the line all move together when it changes (doc 21's
 * "range changes re-derive every delta, sparkline and chart"). The comparison is
 * `periodDelta`, so it excludes the day the providers are still counting and
 * withdraws its colour when the two sides do not cover the same number of
 * reported days — and it draws a dash with the reason when the payload does not
 * reach back a whole range before this one, which 28 days of history cannot.
 */
function UsersRangeKpi({
  assets,
  rangeDays,
}: {
  assets: AssetData[];
  rangeDays: number;
}) {
  const series = portfolioUsersSeries(assets);
  const provisionalFrom = portfolioProvisionalFrom(assets);
  const window = metricWindow([{
    series,
    contextSeries: [],
    collectedAt: null,
    provisionalFrom,
    timeZoneChanges: assets.flatMap((asset) => asset.activeUsers.timeZoneChanges),
  }], rangeDays, "mean");
  const drawn = window.settled;
  const delta = window.delta;

  if (drawn.length === 0) {
    return (
      <Kpi
        label={`Avg. daily users · ${rangeDays}d`}
        value="—"
        improvement="up"
        seriesUnavailable={seriesGapReason(0)}
      />
    );
  }

  const drawable = drawn.length >= MIN_SPARK_POINTS;
  return (
    <Kpi
      label={`Avg. daily users · ${rangeDays}d`}
      value={window.value === null ? "—" : formatInt(window.value)}
      improvement="up"
      delta={delta}
      caption={`${drawn.length} reported days`}
      // The one fact the label cannot carry: this is the SUM of the sites,
      // not an average of them. The days it averages over are the caption.
      explanation="Every site's users added together"
      spark={drawable ? drawn : undefined}
      seriesUnavailable={drawable ? undefined : seriesGapReason(drawn.length)}
      // Seven days of a seven-day window is one flat point per day: the average
      // is drawn only where there is enough series behind it to smooth.
      sparkAverage={rangeDays >= 14}
      sparkProvisionalFrom={provisionalFrom}
    />
  );
}

/**
 * MONEY LEADS (D13). The same figure `/financials` and Home state, chosen by the
 * same rule (`portfolioHeadline`) rather than re-derived — three surfaces
 * quoting three nets would be worse than one surface quoting none.
 *
 * Its movement carries NO VERDICT (doc 21): a month whose net fell because an
 * annual invoice landed is not a worse month, so the KPI shows its COMPOSITION
 * instead and spends no colour on a direction it cannot judge.
 */
function NetKpi({ portfolio }: { portfolio: WallPayload["portfolio"] }) {
  const lead = portfolioHeadline(portfolio);
  const openPeriod = portfolio.periodIsCurrent ? portfolio.period : null;
  const monthLabel = `Net · ${formatPeriodMonth(portfolio.period)}`;

  if (lead === null) {
    return (
      <Kpi
        label={monthLabel}
        value="—"
        improvement="none"
        caption={`no revenue or costs for ${formatPeriodMonth(portfolio.period)} yet`}
        seriesUnavailable={seriesGapReason(portfolio.netTrendAll.length, "month")}
      />
    );
  }

  // THE SERIES IS THE RAW MONTHLY NET, not a trailing average (bead
  // `ro-78qo.18`): seven periods of a monthly series is seven months, and on a
  // portfolio with six months of history that mean is almost a straight line
  // with the one dip worth seeing smoothed out of it.
  const months = portfolio.netTrendAll;
  const drawable = months.length >= MIN_SPARK_POINTS;
  return (
    <Kpi
      label={monthLabel}
      value={formatMoney(lead.figure.net, lead.figure.currency)}
      improvement="none"
      caption={
        <>
          revenue {formatMoney(lead.figure.revenue, lead.figure.currency)} · cost{" "}
          {formatMoney(lead.figure.cost, lead.figure.currency)} · {portfolioHeadlineWord(lead.state)}
        </>
      }
      spark={drawable ? months : undefined}
      seriesUnavailable={drawable ? undefined : seriesGapReason(months.length, "month")}
      sparkAverage={false}
      sparkProvisionalFrom={openPeriod}
      format={(value) => formatMoney(value, portfolio.netTrendCurrency)}
    />
  );
}

/** The portfolio's open exceptions as ONE number, split by severity beneath it.
 * Falling is GOOD here, which is what `improvement="down"` tells the strip. The
 * count is the wall payload's own attention list, so this KPI and `/alerts`
 * cannot disagree about how many conditions are open tonight. */
function OpenAlertsKpi({ payload }: { payload: WallPayload }) {
  const items = payload.attention;
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.filter((item) => item.severity === "warn").length;

  if (items.length === 0) {
    return (
      <Kpi
        label="Open alerts"
        value="0"
        valueTone="healthy"
        improvement="down"
        caption="all clear"
        // The count is point-in-time and the store keeps no by-day record of
        // it, so what this number normally shows is its COMPOSITION — and a
        // zero has none. `/alerts` names the bead that would give it a line.
        seriesUnavailable={NO_DAILY_HISTORY}
      />
    );
  }

  return (
    <Kpi
      label="Open alerts"
      value={formatInt(items.length)}
      improvement="down"
      caption={
        <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
          {errors > 0 ? (
            <span className="font-medium text-error">
              {errors} {errors === 1 ? "error" : "errors"}
            </span>
          ) : null}
          {errors > 0 && warnings > 0 ? <span aria-hidden>·</span> : null}
          {warnings > 0 ? (
            <span className="font-medium text-warn">
              {warnings} {warnings === 1 ? "warning" : "warnings"}
            </span>
          ) : null}
        </span>
      }
      footer={
        <SegmentBar
          className="mt-2"
          ariaLabel={`${errors} of ${items.length} open alerts are errors, ${warnings} are warnings`}
          title={`${errors} error and ${warnings} warning flags are open.`}
          data-alert-split=""
          segments={[
            { name: "error", value: errors, fill: "bg-error" },
            { name: "warn", value: warnings, fill: "bg-warn" },
          ]}
        />
      }
    />
  );
}

/**
 * THE PORTFOLIO'S QUEUE, and how much of it is urgent.
 *
 * An asset whose beads snapshot could not be read contributes NOTHING and is
 * counted as unmeasured, so the figure wears a `+` and the caption says how many
 * assets are behind it — the same lower-bound honesty Home's inbox tile keeps. A
 * total that silently treated an unread repo as zero would be the calmest
 * possible reading of the least information.
 */
function OpenTasksKpi({ assets }: { assets: AssetData[] }) {
  const measured = assets.filter((card) => card.work !== null);
  const open = measured.reduce((sum, card) => sum + (card.work?.open ?? 0), 0);
  const urgent = measured.reduce(
    (sum, card) => sum + (card.work?.highPriority ?? 0),
    0,
  );
  const complete = measured.length === assets.length && assets.length > 0;

  if (measured.length === 0) {
    return (
      <Kpi
        label="Open tasks"
        value="—"
        improvement="down"
        seriesUnavailable="No task data yet"
      />
    );
  }

  return (
    <Kpi
      label="Open tasks"
      value={`${formatInt(open)}${complete ? "" : "+"}`}
      improvement="down"
      caption={
        complete
          ? urgent > 0
            ? `${urgent} urgent`
            : "none urgent"
          : `${measured.length} of ${siteCount(assets.length)} measured`
      }
      // An open queue shows how it divides; an empty one has no shape, and
      // the task hub is read as it stands, not kept by day.
      seriesUnavailable={open > 0 ? undefined : NO_DAILY_HISTORY}
      footer={
        open > 0 ? (
          <SegmentBar
            className="mt-2"
            ariaLabel={`${urgent} of ${open} open tasks are urgent`}
            title={`${urgent} of the ${open} open tasks are P0 or P1.`}
            data-task-urgency=""
            // A rank, not a severity (doc 14, bead ro-ujb9.240): the urgent
            // share wears the top of `PriorityBar`'s ink ramp, the rest its
            // default band — the table's bars below, never amber.
            segments={[
              { name: "urgent", value: urgent, fill: priorityFill(0) },
              { name: "rest", value: open - urgent, fill: priorityFill(2) },
            ]}
          />
        ) : null
      }
    />
  );
}

/** A query value the page still understands, or the default. An `?sort=` a
 * bookmark carried from an older build must not silently order the table by
 * something this page cannot name in its summary line. */
function readKey<K extends string>(
  value: string | null,
  allowed: readonly K[],
): K {
  return allowed.includes(value as K) ? (value as K) : (allowed[0] as K);
}

/** The dot a `StateChip` draws, on its own — the sanctioned way for a control to
 * carry a state's meaning color without a rival mapping (see `STATE_TONE`).
 * `aria-hidden` because the chip's own words already say which state it is. */
function ToneDot({ tone }: { tone: StateTone }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATE_TONE[tone].dot)}
    />
  );
}

interface FilterChipOption {
  value: string;
  label: string;
  count: number;
  /** The registry glyph for this state. Absent on the "All" option, which is
   * the absence of a state rather than one more of them. */
  glyph?: ReactNode;
}

/**
 * One three-way filter, as chips carrying their glyph and their count.
 *
 * Route layout over a payload slice, not a registry component (doc 14's rule for
 * `AssetDetailRoute`'s strips): it exists to put the assets index's own counts
 * on screen, and a second surface wanting this would earn it an entry then. It
 * is not a rival to `KnobEditor`'s segmented control either — that one STAGES a
 * changeset op into the cart, this one narrows a view.
 */
function FilterChips({
  legend,
  name,
  value,
  options,
  onPick,
}: {
  legend: string;
  name: string;
  value: string;
  options: FilterChipOption[];
  onPick: (name: string, value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={legend}
      className="inline-flex flex-wrap items-center gap-1"
      data-assets-filter={name}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(name, option.value)}
            /* The choice dialect of `ui/pill.ts` (bead `ro-s4rg`) — the same
               box and the same pair as /work's filter row and the asset
               wizard's choices, which is what it was a third copy of. The
               phone thumb floor arrives with it. */
            className={cn(pillChoiceClass, pillChoiceStateClass(active))}
          >
            {/* Hidden from the accessible name: the words beside it already
                say which state this is, and a dot's own label ("Warning") read
                out in front of them would name the state twice. */}
            {option.glyph ? (
              <span aria-hidden className="inline-flex">
                {option.glyph}
              </span>
            ) : null}
            <span>
              {option.label}{" "}
              <span className="tabular-nums">{option.count}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default AssetsRoute;
