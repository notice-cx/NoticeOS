import { moneyCurrency, sumMoneyFigures } from '@noticeos/contract/money';
import { DailyRevenuePanel } from "@/components/DailyRevenuePanel";
import { revenueWindowDays, type PortfolioDailyRevenue } from "@shared/daily-revenue";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  PERIOD_PATTERN,
  PROVENANCE_LABEL,
  type CostProvenance,
  type DomainOrder,
  type DomainSchedule,
  type FinancialCostLine,
  type FinancialMonth,
  type FinancialProperty,
  type FinancialsPayload,
  type MoneyFigure,
  type RecurringCost,
} from "@shared/financials";
import { integrationLabel } from "@shared/integrations";
import { type SeriesPointOrGap } from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";
import { CollectionEditor } from "@/components/CollectionEditor";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { PageHeader } from "@/components/PageHeader";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { monthRevenue } from "@/lib/wall-revenue";
import { SavesPaused } from "@/components/SavesPaused";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SegmentBar } from "@/components/SegmentBar";
import { StateChip, type StateChipProps, type StatusSubject } from "@/components/StateChip";
import { HeroChart, type HeroSeries } from "@/components/surface/HeroChart";
import { SectionLabel, eyebrowClass } from "@/components/surface/SectionLabel";
import { Sparkline } from "@/components/surface/Sparkline";
import { fieldClass } from "@/components/ui/field";
import { pillControlClass } from "@/components/ui/pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFinancials } from "@/hooks/useFinancials";
import { useWall } from "@/hooks/useWall";
import { useIntegrations } from "@/hooks/useIntegrations";
import { FinancialsPeriodError } from "@/lib/api";
import {
  formatPeriodMonth,
  formatPeriodMonthLong,
  formatPeriodMonthYear,
  formatPercent,
  formatSignedMoney,
  formatMoney,
  formatUsd,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/** Cents, everywhere on this page: it exists to be reconciled against a
 * receipt, and a column of rounded figures does not add up to its own total. */
const CENTS = { cents: true } as const;

/** The three series' identity, stated once for the strip and the chart:
 * revenue cyan and solid, cost violet and dashed, net in plain ink and dotted. */
const SERIES = {
  revenue: { name: "Revenue", tone: "revenue", lineStyle: "solid" },
  cost: { name: "Cost", tone: "cost", lineStyle: "dashed" },
  // Identity, not performance: signed geometry carries profit/loss.
  net: { name: "Net", tone: "primary", lineStyle: "dotted" },
} as const satisfies Record<string, Omit<HeroSeries, "points">>;

/**
 * /financials: am I making money, and where? The strip states the answer, the
 * chart under it carries the shape, and everything read one cell at a time is
 * a collapsed panel underneath. Overhead sits on asset #0 in its own line and
 * asset nets carry direct costs only, because splitting shared cost needs an
 * allocation key nobody measured. The month is the page's range and lives in
 * the URL, so it is a link and a bookmark; the page defaults to the latest
 * month holding rows.
 */
export default function FinancialsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const { data, isPending, error } = useFinancials(requestedPeriod);

  /** The URL named a month the ledger cannot answer: not the same event as a
   * ledger that failed. */
  const missingPeriod =
    requestedPeriod !== null && error instanceof FinancialsPeriodError
      ? error
      : null;

  /** What the header's selector offers, from whichever answer arrived. */
  const picker = missingPeriod
    ? missingPeriod.periods.length > 0 && requestedPeriod !== null
      ? { period: requestedPeriod, periods: missingPeriod.periods }
      : null
    : data && data.periods.length > 0
      ? { period: data.period, periods: data.periods }
      : null;

  /* The open month is said once, beside the month it qualifies; the hollow dot
     is the chart's own mark for an unfinished period. */
  const monthToDate =
    !missingPeriod && data && !data.empty && data.period >= data.currentPeriod;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Money"
        /* The page's one question, not a fact about how the payload chose a
           period. */
        actions={
          /* The selector survives a bad month: its value is the month that is
             not there, which `PeriodPicker` tolerates, so picking any month in
             the list fires a change. */
          picker ? (
            <span className="flex flex-wrap items-center gap-2">
              {monthToDate ? (
                <span data-month-to-date>
                  <StateChip label="Month to date" tone="na" dot="hollow" subject={`period:${picker.period}`} />
                </span>
              ) : null}
              <PeriodPicker
                period={picker.period}
                periods={picker.periods}
                onSelect={(next) => setSearchParams({ period: next })}
              />
            </span>
          ) : null
        }
      />

      {isPending ? (
        <EmptyState title="Loading the ledger…" />
      ) : missingPeriod ? (
        <MissingPeriod period={requestedPeriod ?? ""} periods={missingPeriod.periods} />
      ) : !data ? (
        /* Only a ledger that never answered: a failed refresh keeps the
           last-good figures on screen. The way out is the button. */
        <EmptyState
          title="The ledger did not answer"
          hint={
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-sm text-foreground hover:bg-muted",
                pillControlClass,
              )}
            >
              Reload
            </button>
          }
        />
      ) : data.empty ? (
        <FirstRun data={data} />
      ) : (
        <Ledger data={data} />
      )}
    </div>
  );
}

/** The requested month as the reader should see it named back: a real month in
 * words, and anything else quoted as the string it is, so "January 2020" and
 * `“last-quarter”` are visibly different mistakes. */
function requestedPeriodLabel(period: string): string {
  return PERIOD_PATTERN.test(period) ? formatPeriodMonthYear(period) : `“${period}”`;
}

/**
 * A `?period=` the ledger cannot answer: where a bookmark to last quarter's
 * month lands. The months the ledger has are the answer. A ledger holding no
 * month at all is the first-run state, and says what to connect.
 */
function MissingPeriod({ period, periods }: { period: string; periods: string[] }) {
  const newest = periods[periods.length - 1];
  if (periods.length === 0) {
    return (
      <div data-period-missing={period}>
        <NothingRecorded />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-period-missing={period}>
      <EmptyState title={`Nothing recorded for ${requestedPeriodLabel(period)}`} />
      {periods.length > 0 ? (
        <nav aria-label="Months the ledger holds" className="flex flex-wrap gap-2">
          {[...periods].reverse().map((option) => (
            <Link
              key={option}
              /* The newest month is what the page opens on by itself, so it is
                 the bare URL — following it leaves no stale month in the
                 address bar to be bookmarked a second time. */
              to={option === newest ? "/financials" : `/financials?period=${option}`}
              data-period-link={option === newest ? "latest" : option}
              className={cn(
                "rounded-md border border-border px-2 py-1 text-sm tabular-nums hover:bg-muted",
                pillControlClass,
                "max-sm:inline-flex max-sm:items-center",
              )}
            >
              {formatPeriodMonthYear(option)}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

/** A ledger with no row at all: the title, and the one step that fills it,
 * connecting a revenue source, as a link. */
function NothingRecorded() {
  return (
    <EmptyState
      title="No money recorded yet"
      hint={
        <Link
          to="/integrations"
          data-first-run-link
          className="font-medium text-foreground underline underline-offset-4 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
        >
          Connect a revenue source →
        </Link>
      }
    />
  );
}

/** The first run is the two steps, not instructions for them: revenue is
 * connected on another page, so that is a link; costs are declared here, so
 * the cost registers open in place. */
function FirstRun({ data }: { data: FinancialsPayload }) {
  return (
    <>
      <NothingRecorded />
      <Panel title="Declared costs" mark="costs" configSurface defaultOpen>
        <Costs
          period={data.period}
          currentPeriod={data.currentPeriod}
          recurringCosts={data.recurringCosts}
          domainOrders={data.domainOrders}
          schedule={data.domains}
          properties={data.properties}
        />
      </Panel>
    </>
  );
}

/**
 * Which month the page describes. A native `<select>` rather than a
 * `RangeSelector`: there can be dozens of months, and the platform control
 * brings keyboard navigation, type-ahead and the phone's own wheel. Newest
 * first, because this list is read to find a month.
 */
function PeriodPicker({
  period,
  periods,
  onSelect,
}: {
  period: string;
  periods: string[];
  onSelect: (period: string) => void;
}) {
  // The shown month is one of `periods` in every case the ledger can actually
  // produce. Carrying it anyway costs a line and means a select whose value is
  // missing from its own options can never render blank.
  const options = periods.includes(period) ? periods : [...periods, period].sort();
  return (
    <select
      aria-label="Accounting period"
      value={period}
      onChange={(event) => onSelect(event.target.value)}
      className={fieldClass}
      data-period-picker
    >
      {[...options].reverse().map((option) => (
        <option key={option} value={option}>
          {formatPeriodMonthYear(option)}
        </option>
      ))}
    </select>
  );
}

/**
 * A collapsed card that mounts its body only when open: a closed `<details>`
 * still lays its contents out, so not rendering is the only honest reading of
 * "not visible by default". Local to this page because it is `Card` plus an
 * eyebrow and a chevron.
 */
function Panel({
  title,
  count,
  children,
  className,
  configSurface = false,
  mark,
  defaultOpen = false,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
  className?: string;
  /** A register deliberately shown on a view route, the surface audit's own
   * opt-out, so the owner chips inside it are not counted against the view. */
  configSurface?: boolean;
  /** A `data-panel` handle, so a test addresses a panel by what it is rather
   * than by the words in its header. */
  mark?: string;
  /** Open on arrival — only where the panel IS the next step (the first run's
   * cost registers). */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={cn("rounded-[10px] border border-border bg-card", className)}
      data-panel={mark}
      data-panel-open={open ? "" : undefined}
      data-config-surface={configSurface ? "" : undefined}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-start",
          pillControlClass,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform",
            open && "rotate-90",
          )}
        />
        <span className={eyebrowClass}>{title}</span>
        {count ? (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </button>
      {open ? <div className="border-t border-border/60 p-4">{children}</div> : null}
    </section>
  );
}

/** A net is a level, not a trend: ink for any amount, muted for a loss or
 * nothing. Never green for being positive and never red: an asset that has not
 * been given a revenue source has not failed at anything. */
function netClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value < 0 ? "text-muted-foreground" : "";
}


/** One month's figures as a series point, in the ledger's own monthly grain. */
function monthly(
  months: readonly FinancialMonth[],
  read: (month: FinancialMonth) => number | null,
): SeriesPoint[] {
  if (moneyCurrency(months.map(month => month.total)) === null) return [];
  const values = months.map(month => read(month));
  return values.some(value => value === null) ? [] : months.map((month, index) => ({ t: month.period, v: values[index]! }));
}

/** The page's answer, once the ledger has one. Everything below the hero is a
 * collapsed panel: the shape of the money is what the page is opened for. */
function PortfolioRevenue({ history, sites }: { history: PortfolioDailyRevenue; sites: number | null }) {
  // One site's coverage line would restate "5 of 5 days reported" beside the
  // figure; from two sites it says which one missed days.
  const coverage = (sites ?? history.sources.length) > 1 && history.sources.length > 0;
  const sourceNames = new Map(history.sources.map(source => [source.asset, source.displayName]));
  // A day owes only the sources already reporting by then.
  const notesByDate = Object.fromEntries(history.coverage.map(day => [day.date,
    `${day.reported} of ${day.reported + day.missingAssets.length} daily sources reported${day.missingAssets.length ? ` · Missing: ${day.missingAssets.map(asset => sourceNames.get(asset) ?? 'Unknown site').join(', ')}` : ''}`,
  ]));
  const partialDates = history.coverage.filter(day => day.reported > 0 && day.missingAssets.length > 0).map(day => day.date);
  return <DailyRevenuePanel history={history} range={revenueWindowDays(history.from, history.to)}
    title="Daily revenue" notesByDate={notesByDate} partialDates={partialDates} totals={false}
    setupHref="/integrations"
    context={coverage ? <SourceCoverage history={history} /> : null} />;
}

/** Each source and how many of the window's days it reported. A source that
 * missed days wears the warn ink on its own count; each is a door to that
 * asset's own financials. */
function SourceCoverage({ history }: { history: PortfolioDailyRevenue }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0" data-source-coverage>
      {history.sources.map((source) => {
        // Its days are the ones since it first reported.
        const owed = history.coverage.filter((day) => day.date >= source.since);
        const days = owed.length;
        const reported = owed.filter(
          (day) => !day.missingAssets.includes(source.asset),
        ).length;
        const short = days > 0 && reported < days;
        return (
          <li key={source.asset} data-source-coverage-asset={source.asset}>
            <Link
              to={`/assets/${encodeURIComponent(source.asset)}/financials`}
              className="inline-flex items-center gap-1.5 hover:text-foreground max-sm:min-h-11"
            >
              <PropertyFavicon domain={source.asset} displayName={source.displayName} />
              <span className="underline-offset-4 hover:underline">{source.displayName}</span>
              {days > 0 ? (
                <span className={cn("tabular-nums", short ? "font-medium text-warn" : undefined)}>
                  {reported}/{days} days
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Ledger({ data }: { data: FinancialsPayload }) {
  // How many sites the installation has, from the sidebar's own read already
  // in the cache, so a month in which only one of several sites earned keeps
  // its by-site table. Null until that read answers.
  const wall = useWall().data;
  const sites = wall?.assets.length ?? null;
  /* The open month is the calendar month the store is standing in, as the
     Worker worked it out on the operator's saved clock, not off `period`:
     June is not provisional because somebody chose to look at it. */
  const openPeriod = data.currentPeriod;
  /* Every month up to and including the selected one, so the strip's deltas
     and sparklines end at the month it describes. */
  const upto = data.months.filter((month) => month.period <= data.period);
  const shown = upto.at(-1);
  const shownIsOpen = data.period >= openPeriod;

  if (!shown) {
    // The same answer a refused month gets: its name, and the months that
    // hold something as the way out.
    return <MissingPeriod period={data.period} periods={data.periods} />;
  }

  const revenue = monthly(upto, (month) => month.total.revenue);
  const cost = monthly(upto, (month) => month.total.cost);
  const net = monthly(upto, (month) => month.total.net);

  /** The month's whole turnover, both sides, split by what has settled.
   * MAGNITUDES, not signed sums: revenue and cost each have to be checked
   * against a statement, a net of zero can hide two large unsettled sides, and
   * a negative estimated adjustment is still money nobody has checked — summed
   * with its sign it would shrink the unsettled share it belongs to. */
  const settled = shown.booked.currency === null ? null : Math.abs(shown.booked.revenue) + Math.abs(shown.booked.cost);
  const trendCurrency = moneyCurrency(upto.map(month => month.total));
  // Whether any cost has been written down at all: a month with no cost line
  // and a zero total has costs nobody recorded, not costs of zero.
  const costRecorded = data.costLines.length > 0 || shown.total.cost !== 0;

  return (
    <>
      {/* One answer first: the month's net in a sentence, the pace Home and
          the TV say under it while the month is open, and revenue, cost and
          what is confirmed beside it. A cost nobody recorded is a dash. */}
      <MoneyAnswer shown={shown} shownIsOpen={shownIsOpen} costRecorded={costRecorded} settled={settled} wall={wall} />

      {data.dailyRevenue ? <PortfolioRevenue history={data.dailyRevenue} sites={sites} /> : null}

      <PropertySplit
        properties={data.properties}
        overhead={data.overhead}
        period={data.period}
        openPeriod={openPeriod}
        sites={sites}
      />

      <Panel
        title="Month by month"
        count={`${data.months.length} months`}
        mark="months"
      >
          <div className="mb-4">
            {/* Net is drawn, not inferred: the scale takes a signed domain, so
                the page's headline figure is a line rather than a subtraction
                performed by eye. */}
            <HeroChart
              title="Monthly performance"
              series={[
                { ...SERIES.revenue, points: revenue },
                { ...SERIES.cost, points: cost },
                { ...SERIES.net, points: net },
              ]}
              range={upto.length}
              height={220}
              /* A monthly ledger has nothing to smooth and two overlapping
                 translucent areas read as a third colour that means nothing —
                 so: lines, no trailing average, no fill. */
              average={false}
              area={false}
              format={(value) => formatMoney(value, trendCurrency)}
              formatValue={(value) => formatMoney(value, trendCurrency, CENTS)}
              provisionalFrom={openPeriod}
              ariaLabel="Revenue, cost and net for the whole ledger, month by month"
            />
          </div>
        <MonthlyTable months={data.months} openPeriod={openPeriod} />
      </Panel>

      {/* A disclosure with nothing behind it is a box to open for nothing. */}
      {data.costLines.length > 0 ? (
        <Panel
          title="Where the cost comes from"
          count={`${data.costLines.length} lines`}
          mark="cost-breakdown"
        >
          <CostBreakdown lines={data.costLines} recurringCosts={data.recurringCosts} />
        </Panel>
      ) : null}

      {/* The two registers are deliberately on a view page, which is what
          `data-config-surface` declares: these two tables are the files, and
          correcting a price here is why they are on the page that spends them. */}
      <Panel
        title="Declared costs"
        mark="costs"
        configSurface
      >
        <Costs
          period={data.period}
          currentPeriod={openPeriod}
          recurringCosts={data.recurringCosts}
          domainOrders={data.domainOrders}
          schedule={data.domains}
          properties={data.properties}
        />
      </Panel>

      {/* No About panel: each fact sits on the figure it qualifies, as a
          shape. */}
    </>
  );
}

/**
 * The month's answer. While the month is open, the revenue pace is the one
 * Home's brief and the TV state (`monthRevenue`), so it is one number on every
 * screen. A cost nobody recorded is "none recorded", and the net says "revenue
 * only", never a green net over a $0 nobody counted.
 */
function MoneyAnswer({ shown, shownIsOpen, costRecorded, settled, wall }: {
  shown: FinancialMonth;
  shownIsOpen: boolean;
  costRecorded: boolean;
  settled: number | null;
  wall: ReturnType<typeof useWall>["data"];
}) {
  const currency = shown.total.currency;
  const month = formatPeriodMonthLong(shown.period).replace(/\s\d{4}$/, "");
  const pace = shownIsOpen && wall ? monthRevenue(wall.portfolio, wall.assets)?.pace ?? null : null;
  const detail = [
    pace ? `on pace for ${formatUsd(pace.projected)} revenue · ${pace.daysLeft} ${pace.daysLeft === 1 ? "day" : "days"} left` : null,
    costRecorded ? null : "revenue only",
  ].filter(Boolean).join(" · ") || undefined;
  return (
    <PageAnswer
      answer={`${month} net ${formatSignedMoney(shown.total.net, currency)}${shownIsOpen ? " so far" : ""}`}
      detail={detail}
      figures={[
        { label: "Revenue", value: formatMoney(shown.total.revenue, currency), tone: "text-financial-revenue", mark: "money-revenue" },
        costRecorded
          ? { label: "Cost", value: formatMoney(shown.total.cost, currency), mark: "money-cost" }
          : { label: "Cost", value: "—", note: "none recorded", mark: "money-cost" },
        { label: "Confirmed", value: formatMoney(settled, shown.booked.currency), mark: "money-confirmed" },
      ]}
      marks={{ "data-surface-hero": "", "data-money-answer": shownIsOpen ? "open" : "closed" }}
    />
  );
}

/**
 * Where the money is, asset by asset: the page's one visible table. The share
 * bar answers which asset is carrying this month; the net-by-month sparkline
 * in every row answers which one is getting better.
 */
function PropertySplit({
  properties,
  overhead,
  period,
  openPeriod,
  sites,
}: {
  properties: FinancialProperty[];
  overhead: MoneyFigure;
  period: string;
  /** The month the STORE is standing in — the one point on any line here that
   * is still being counted, drawn hollow wherever it appears. */
  openPeriod: string;
  /** The installation's site count, or null before it is known. */
  sites: number | null;
}) {
  const owned = properties.filter((property) => !property.isOs);
  /* One site is its own split: every row of a by-site table over one site
     equals its total, and with nothing shared there is nothing to allocate.
     The table stays while an overhead line pays for more than the site. */
  const several = (sites ?? owned.length) > 1;
  const overheadExists = overhead.cost !== 0 || overhead.revenue !== 0;
  if (!several && !overheadExists) return null;
  // "Sites, direct" is the total minus the overhead; with no overhead it is
  // the total again, so it goes with the overhead row.
  const subtotal = several && overheadExists;
  const direct = sumMoneyFigures(owned.map(property => property.figure));
  const portfolio = sumMoneyFigures([...owned.map(property => property.figure), overhead]);
  const directNet = direct.net;
  const portfolioNet = portfolio.net;
  const periodRevenue = portfolio.revenue;

  return (
    <section className="rounded-[10px] border border-border bg-card">
      {/* The two-tier read is the table's own last three rows: assets' direct
          net, the shared overhead, the portfolio net. */}
      <SectionLabel
        title="By site"
        caption={formatPeriodMonthYear(period)}
        className="px-4 pb-1 pt-3"
      />
      <div className="px-2 pb-2 sm:px-4 sm:pb-4">
        {/* `stacked`: Net would otherwise be off the right edge at 390px. */}
        <Table stacked>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>Net · by month</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Direct cost</TableHead>
              <TableHead className="text-right">Net</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {owned.map((property) => (
              <TableRow key={property.asset} data-subject={`asset:${property.asset}`}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-2">
                    {/* Identity is the glyph everywhere else in this Tower, and
                        it sits OUTSIDE the link so the link's box stays exactly
                        the words — see the note below. */}
                    <PropertyFavicon
                      domain={property.asset}
                      displayName={property.displayName}
                    />
                    {/* The name is the card's one way out on a phone, so it needs the
                        44px thumb floor: `inline-flex` makes the box 44px and
                        `-my-3` returns 24 of them, so the cell keeps its 20px. */}
                    <Link
                      to={`/assets/${encodeURIComponent(property.asset)}/financials`}
                      /* `min-w-11` as well as `min-h-11`: the floor is 44px on
                         both axes, claimed into the padding and the gap
                         between cards, where no other control is. */
                      className="hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center"
                    >
                      {property.displayName}
                    </Link>
                  </span>
                </TableCell>
                {/* Which way this asset is going. The line is muted: net's movement
                    is not a verdict. `average={false}` because these are
                    monthly points with no noise to smooth away. */}
                <TableCell label="Net · by month" dropWhenStacked>
                  <PropertyTrend
                    property={property}
                    period={period}
                    openPeriod={openPeriod}
                  />
                </TableCell>
                <TableCell label="Revenue" className="text-right tabular-nums">
                  {/* Nothing reported is a dash, not $0.00: the cell itself tells an
                      unreported month from a zero one. */}
                  {property.revenueReported ? (
                    formatMoney(property.figure.revenue, property.figure.currency, CENTS)
                  ) : (
                    <span data-revenue-unreported={property.asset}>
                      <InfoTooltip label={`${property.displayName}: no revenue reported`} trigger="—">
                        No revenue reported
                      </InfoTooltip>
                    </span>
                  )}
                  {/* Which asset is carrying the month: the one question a
                      column of dollar figures makes the reader do arithmetic
                      for. Absent when the period earned nothing at all: a
                      share of zero is not a small share, and an empty track
                      on every row would be a proportion of nothing. */}
                  {property.revenueReported && property.figure.currency === portfolio.currency && property.figure.revenue !== null && periodRevenue !== null && periodRevenue > 0 ? (
                    <RevenueShare
                      name={property.displayName}
                      revenue={property.figure.revenue}
                      total={periodRevenue}
                    />
                  ) : null}
                </TableCell>
                <TableCell label="Direct cost" className="text-right tabular-nums">
                  {formatMoney(property.figure.cost, property.figure.currency, CENTS)}
                </TableCell>
                <TableCell
                  label="Net"
                  className={cn("text-right tabular-nums", netClass(property.figure.net))}
                >
                  {formatSignedMoney(property.figure.net, property.figure.currency, CENTS)}
                </TableCell>
              </TableRow>
            ))}
            {/* The three summary rows carry no line: a total's trajectory is the
                chart at the top of the page. */}
            {subtotal ? (
              <TableRow className="border-t-2 border-border">
                <TableCell className="font-medium">Sites, direct</TableCell>
                <TableCell />
                <TableCell />
                <TableCell />
                <TableCell
                  label="Net"
                  className={cn("text-right font-semibold tabular-nums", netClass(directNet))}
                >
                  {formatSignedMoney(directNet, direct.currency, CENTS)}
                </TableCell>
              </TableRow>
            ) : null}
            {/* The OS line is the whole reason nothing above it is allocated.
                Splitting $200 of Claude Code six ways needs a key nobody
                measured; subtracting it once, in the open, needs nothing. */}
            {overheadExists ? <TableRow className={subtotal ? undefined : "border-t-2 border-border"}>
              <TableCell className="font-medium">
                Overhead
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  shared, allocated to no site
                </span>
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell label="Direct cost" className="text-right tabular-nums">
                {formatMoney(overhead.cost, overhead.currency, CENTS)}
              </TableCell>
              <TableCell label="Net" className={cn("text-right tabular-nums", netClass(overhead.net))}>
                {formatSignedMoney(overhead.net, overhead.currency, CENTS)}
              </TableCell>
            </TableRow> : null}
            <TableRow className="border-t-2 border-border">
              <TableCell className="font-semibold">Total net</TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell
                label="Net"
                className={cn("text-right text-lg font-semibold tabular-nums", netClass(portfolioNet))}
              >
                {formatSignedMoney(portfolioNet, portfolio.currency, CENTS)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** A line needs three points before it is a trend rather than a slope drawn
 * through two readings; below that the cell prints a dash and says why on
 * hover, the same floor as the month table's own sparkline column. */
const MIN_TREND_MONTHS = 3;

/** The dash a trend cell prints under that floor, with its reason on demand
 * from a hover, a key or a tap. */
function TooShortForATrend() {
  const reason = `Needs ${MIN_TREND_MONTHS} months of history`;
  return <InfoTooltip label={`No trend: ${reason}`} trigger="—">{reason}</InfoTooltip>;
}

/**
 * One asset's net, month by month. The series stops at the month the table
 * describes, and nothing is interpolated: the payload carries a point only for
 * a month the asset has a ledger row in.
 */
function PropertyTrend({
  property,
  period,
  openPeriod,
}: {
  property: FinancialProperty;
  period: string;
  openPeriod: string;
}) {
  /* The asset's own month axis, holes included: a sparkline spaces its points
     by position, so the payload carries the axis, a month it booked nothing
     in is null, and the line breaks over it rather than bridging it. */
  const currency = moneyCurrency(property.months.flatMap(month => month.figure === null ? [] : [month.figure]));
  const series: SeriesPointOrGap[] = property.months
    .filter((month) => month.period <= period)
    .map((month) => ({
      t: month.period,
      v: currency === null || month.figure?.currency !== currency ? null : month.figure.net,
    }));

  /* Three readings, not three positions: an axis of ten months holding two
     figures is still two figures. */
  const booked = series.filter((point) => point.v !== null);
  if (booked.length < MIN_TREND_MONTHS) {
    return <TooShortForATrend />;
  }

  return (
    <span className="block" data-property-trend={property.asset}>
      <Sparkline
        data={series}
        size="cell"
        average={false}
        readout
        tone="muted"
        provisionalFrom={openPeriod}
        format={(value) => formatMoney(value, currency, CENTS)}
        ariaLabel={`${property.displayName} net by month, ${series[0]!.t} to ${series.at(-1)!.t}`}
      />
    </span>
  );
}

/** One asset's slice of the period's revenue, as the shape beside the figure.
 * The dollars are in the cell above it and the exact percentage in the hover. */
function RevenueShare({
  name,
  revenue,
  total,
}: {
  name: string;
  revenue: number;
  total: number;
}) {
  const percent = formatPercent((revenue / total) * 100);
  return (
    <SegmentBar
      className="mt-1"
      ariaLabel={`${name} earned ${percent}% of the period's revenue`}
      segments={[
        { name: "asset", value: revenue, fill: "bg-foreground/70" },
        { name: "rest", value: total - revenue, fill: "bg-muted-foreground/25" },
      ]}
      title={`${percent}% of the period's revenue`}
      data-revenue-share={name}
    />
  );
}

/** The trajectory, one row per month, with a sparkline cell for the shape.
 * Behind a disclosure because the chart above answers "is this getting better"
 * and this table answers "what exactly did July book". */
function MonthlyTable({
  months,
  openPeriod,
}: {
  months: FinancialMonth[];
  openPeriod: string;
}) {
  const net = monthly(months, (month) => month.total.net);

  return (
    <div className="flex flex-col gap-3">
      {/* `stacked`: five money columns run past a 390px screen, and Net and
          Reconciled would be the two that fall off the right edge. */}
      <Table stacked>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Reconciled</TableHead>
            <TableHead className="text-right">Net to date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {months.map((month, index) => (
            <TableRow key={month.period}>
              <TableCell className="font-medium tabular-nums">
                {month.period}
                {/* The month still being counted: the chart's hollow mark and
                    the header chip's words, at row size. */}
                {month.period >= openPeriod ? (
                  <span
                    className="ms-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"
                    data-month-open
                  >
                    <span aria-hidden className="size-2 rounded-full border border-current" />
                    to date
                  </span>
                ) : null}
              </TableCell>
              <TableCell label="Revenue" className="text-right tabular-nums">
                {formatMoney(month.total.revenue, month.total.currency, CENTS)}
              </TableCell>
              <TableCell label="Cost" className="text-right tabular-nums">
                {formatMoney(month.total.cost, month.total.currency, CENTS)}
              </TableCell>
              <TableCell
                label="Net"
                className={cn("text-right font-semibold tabular-nums", netClass(month.total.net))}
              >
                {formatSignedMoney(month.total.net, month.total.currency, CENTS)}
              </TableCell>
              {/* Booked and estimated are never added into `net` above — the
                  column states how much of that figure has actually settled. */}
              <TableCell
                label="Reconciled"
                className="text-right tabular-nums text-muted-foreground"
              >
                {month.booked.revenue === 0 && month.booked.cost === 0
                  ? <InfoTooltip label={`${formatPeriodMonth(month.period)}: nothing reconciled yet`} trigger="—">Nothing reconciled yet</InfoTooltip>
                  : formatSignedMoney(month.booked.net, month.booked.currency, CENTS)}
              </TableCell>
              {/* The row's own shape: net up to and including this month. */}
              <TableCell label="Net to date" className="text-right" dropWhenStacked>
                {index >= 2 ? (
                  <Sparkline
                    data={net.slice(0, index + 1)}
                    size="cell"
                    average={false}
                    readout
                    tone="muted"
                    provisionalFrom={openPeriod}
                    format={(value) => formatMoney(value, moneyCurrency(months.map(item => item.total)), CENTS)}
                    ariaLabel={`Net by month through ${month.period}`}
                  />
                ) : (
                  <TooShortForATrend />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * How a cost figure came to be known, as a glyph. All four faces stay in the
 * quiet half of the palette: provenance is not severity. They separate on
 * weight and on the dot's shape rather than on hue, so the ladder reads the
 * same on a grayscale screen, and it runs from measured down to
 * unaccounted-for. The chip replaces the word rather than sitting beside it.
 */
const PROVENANCE_CHIP: Readonly<
  Record<CostProvenance, Pick<StateChipProps, "tone" | "dot" | "attention">>
> = Object.freeze({
  metered: { tone: "neutral", dot: "solid" },
  stated: { tone: "affirmative", dot: "solid" },
  amortized: { tone: "na", dot: "solid" },
  unclassified: { tone: "na", dot: "hollow", attention: true },
});

/* The chip is the word and nothing else: the labels are the operator's own
   words for the four kinds (shared/financials.ts). */
function ProvenanceChip({ provenance, subject }: { provenance: CostProvenance; subject: StatusSubject }) {
  const face = PROVENANCE_CHIP[provenance];
  return (
    <StateChip
      subject={subject}
      label={PROVENANCE_LABEL[provenance]}
      tone={face.tone}
      dot={face.dot}
      attention={face.attention ?? false}
    />
  );
}

/**
 * Where a cost line came from, named the way the operator names it: the
 * subscription's own label, the provider's product name for a metered bill,
 * "Domain orders" for the amortized terms. The store's keys are how the rows
 * are filed, not how anyone says them.
 */
function costSourceLabel(source: string | null, recurringCosts: readonly RecurringCost[]): string {
  if (source === null) return "—";
  if (source.startsWith("recurring:")) {
    const id = source.slice("recurring:".length);
    return recurringCosts.find((cost) => cost.id === id)?.label ?? id;
  }
  if (source.startsWith("metered:")) {
    const id = source.slice("metered:".length);
    return integrationLabel(id, id);
  }
  if (source === "domains") return "Domain orders";
  return source;
}

function CostBreakdown({
  lines,
  recurringCosts,
}: {
  lines: FinancialCostLine[];
  recurringCosts: readonly RecurringCost[];
}) {
  const total = sumMoneyFigures(lines.map(line => ({ currency: line.currency, revenue: 0, cost: line.amount, net: -line.amount })));
  return (
    <div className="flex flex-col gap-3">
      {/* `stacked`: the Source column, what a figure is checked against, is
          the one that would be truncated at 390px. */}
      <Table stacked>
        <TableHeader>
          <TableRow>
            <TableHead>Family</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={`${line.family}:${line.source ?? "none"}:${line.currency}`}>
              <TableCell className="font-medium">{line.family}</TableCell>
              <TableCell label="Type">
                <ProvenanceChip provenance={line.provenance} subject={`cost:${line.family}:${line.source ?? "none"}`} />
              </TableCell>
              <TableCell label="Source" className="text-muted-foreground" data-cost-source={line.source ?? ""}>
                {costSourceLabel(line.source, recurringCosts)}
                {line.rows > 1 ? (
                  <span className="ml-1.5 text-xs tabular-nums">×{line.rows}</span>
                ) : null}
              </TableCell>
              <TableCell label="Amount" className="text-right tabular-nums">
                {formatMoney(line.amount, line.currency, CENTS)}
              </TableCell>
            </TableRow>
          ))}
          <TableRow className="border-t-2 border-border">
            <TableCell className="font-semibold" colSpan={3}>
              Total
            </TableCell>
            <TableCell label="Amount" className="text-right font-semibold tabular-nums">
              {formatMoney(total.cost, total.currency, CENTS)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

/** Cents kept out of a running float sum until the end — the same rule the
 * payload's minor units enforce, restated here because these two figures are
 * summed in the browser from what the config files declare. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Is this subscription booking in the shown month? `to` absent means live. */
function bookingIn(cost: RecurringCost, period: string): boolean {
  if (cost.from > period) return false;
  return cost.to === undefined || cost.to >= period;
}

/** The accounting month after `period` (`YYYY-MM`), by hand — no `Date`, so no
 * viewer timezone in a label that has none. */
function nextPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** A domain term that runs out this month or next: domain figures are what
 * was paid, often a first-year price, so what the operator can act on is when
 * that price changes. */
function renewsSoon(term: DomainSchedule, currentPeriod: string): boolean {
  return term.lastPeriod >= currentPeriod && term.lastPeriod <= nextPeriod(currentPeriod);
}

/** One asset's declared monthly cost — every recurring row live this month plus
 * every domain order still amortizing into it. */
interface DeclaredLine {
  asset: string;
  displayName: string;
  perMonth: number;
}

function declaredByAsset(
  period: string,
  recurringCosts: RecurringCost[],
  schedule: DomainSchedule[],
  properties: FinancialProperty[],
): DeclaredLine[] {
  const totals = new Map<string, number>();
  const add = (asset: string, amount: number) =>
    totals.set(asset, (totals.get(asset) ?? 0) + amount);
  for (const cost of recurringCosts) {
    if (bookingIn(cost, period)) add(cost.asset, cost.amountUsdPerMonth);
  }
  for (const order of schedule) {
    if (order.firstPeriod <= period && order.lastPeriod >= period) {
      add(order.asset, order.perMonth);
    }
  }
  return [...totals.entries()]
    .map(([asset, perMonth]) => ({
      asset,
      // The ledger's own name for the asset where the period has one; the id
      // otherwise, which is a domain and reads as itself. A declared cost can
      // name an asset that booked nothing this month — that is exactly the case
      // this section exists to make visible.
      displayName: properties.find((p) => p.asset === asset)?.displayName ?? asset,
      perMonth: round2(perMonth),
    }))
    .sort((a, b) => b.perMonth - a.perMonth);
}

/**
 * The inputs, on the page that spends them: the subscriptions nobody meters
 * (`recurring-costs`) and the domain orders being amortized (`domain-costs`).
 * Nothing here may filter or sort the rows: the editor addresses a row by its
 * index (`/costs/3`), so a filtered table would rewrite a different
 * subscription. The asset dimension is therefore a summary above the tables.
 * On a deployment that cannot write the page says why once, above them
 * (`SavesPaused`). Money keeps its Save: each cell commits with its own Save
 * or Enter, never as it is left.
 */
function Costs({
  period,
  currentPeriod,
  recurringCosts,
  domainOrders,
  schedule,
  properties,
}: {
  period: string;
  /** The month the reader is standing in — what "renews soon" counts from. */
  currentPeriod: string;
  recurringCosts: RecurringCost[];
  domainOrders: DomainOrder[];
  schedule: DomainSchedule[];
  properties: FinancialProperty[];
}) {
  const declared = declaredByAsset(period, recurringCosts, schedule, properties);
  // Which asset ids exist comes from the integration matrix, not from
  // `properties`: that is this period's ledger split, so an asset that has
  // booked nothing yet is not in it.
  const { data: matrix } = useIntegrations();
  const known = (matrix?.assets ?? []).map((asset) => asset.id);
  // An empty list is "the matrix has not answered", and refuses nothing.
  const assetOptions = known.length === 0 ? undefined : { asset: known };
  const declaredTotal = round2(declared.reduce((sum, line) => sum + line.perMonth, 0));
  const paid = round2(domainOrders.reduce((sum, order) => sum + order.paidUsd, 0));
  const amortizing = schedule.filter(
    (order) => order.firstPeriod <= period && order.lastPeriod >= period,
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <SavesPaused />
      {/* Every cell is its own field with its own Save, and every save answers
          with an Undo beside it. */}
      {declaredTotal > 0 ? (
        <DeclaredRunRate lines={declared} total={declaredTotal} />
      ) : null}

      <CollectionEditor
        register="recurring-costs"
        statesReadOnly={false}
        rows={recurringCosts}
        slug="financials-recurring-cost"
        fieldOptions={assetOptions}
      />

      <CollectionEditor
        register="domain-costs"
        rows={domainOrders}
        slug="financials-domain-order"
        fieldOptions={assetOptions}
        /* The two facts every row has and no field holds. A domain order is a
           prepaid annual term, so what the ledger books every month is the
           price over twelve. `schedule` is the payload's own amortization of
           these same rows, looked up by the name the row is filed under. */
        derived={[
          {
            /* The amount and the twelve months it is spread over, both in the
               cell. */
            name: "amortized",
            label: "Per month",
            render: (row) => {
              const term = schedule.find((order) => order.domain === row.key);
              if (term === undefined) return <span className="text-muted-foreground">—</span>;
              const renewal = nextPeriod(term.lastPeriod);
              return (
                <span className="flex flex-col items-start gap-0.5">
                  <span className="tabular-nums">{formatUsd(term.perMonth, CENTS)}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {term.firstPeriod} → {term.lastPeriod}
                  </span>
                  {renewsSoon(term, currentPeriod) ? (
                    <span data-domain-renews={term.domain}>
                      <StateChip
                        tone="caution"
                        label={`Renews ${formatPeriodMonth(renewal)} ${renewal.slice(0, 4)}`}
                        subject={`domain:${term.domain}`}
                      />
                    </span>
                  ) : null}
                </span>
              );
            },
          },
        ]}
        /* The facts no row carries, in the slot a subtitle already has: the
           orders, the cash already spent, and how many are still being spread
           across the shown month. */
        describe={
          domainOrders.length === 0 ? undefined : (
            <span className="tabular-nums" data-domain-terms>
              {domainOrders.length} {domainOrders.length === 1 ? "order" : "orders"} ·{" "}
              {formatUsd(paid, CENTS)} paid · {amortizing} amortizing this month
            </span>
          )
        }
        /* The read-only sentence is a fact about the deployment, and the page
           states it once above both tables. */
        statesReadOnly={false}
      />
    </div>
  );
}

/**
 * What each asset costs per month by declaration: the grouped read the two
 * flat tables cannot give. Deliberately not the *Direct cost* column above:
 * that is what the ledger booked, and this is what the files say should book.
 * They differ whenever `cost-import` has not run for the month yet.
 */
function DeclaredRunRate({ lines, total }: { lines: DeclaredLine[]; total: number }) {
  return (
    <div className="flex flex-col gap-2" data-declared-run-rate>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel title="Declared, by site" />
        <span className="text-sm font-semibold tabular-nums">
          {formatUsd(total, CENTS)}/mo
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => {
          const percent = formatPercent((line.perMonth / total) * 100);
          return (
            <li
              key={line.asset}
              className="flex items-center gap-2"
              data-declared-asset={line.asset}
            >
              <PropertyFavicon domain={line.asset} displayName={line.displayName} />
              <span className="min-w-0 flex-1 truncate text-sm">{line.displayName}</span>
              <span className="tabular-nums text-sm">{formatUsd(line.perMonth, CENTS)}</span>
              <SegmentBar
                className="w-20 shrink-0"
                ariaLabel={`${line.displayName} is ${percent}% of the declared monthly cost`}
                title={`${percent}% of the declared monthly cost`}
                segments={[
                  { name: "asset", value: line.perMonth, fill: "bg-foreground/70" },
                  { name: "rest", value: total - line.perMonth, fill: "bg-muted-foreground/25" },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
