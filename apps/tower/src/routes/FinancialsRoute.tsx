import { moneyCurrency } from "@noticeos/contract/money";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { revenueWindowDays, type PortfolioDailyRevenue } from "@shared/daily-revenue";
import {
  PERIOD_PATTERN,
  type DomainOrder,
  type DomainSchedule,
  type FinancialMonth,
  type FinancialProperty,
  type FinancialsPayload,
  type RecurringCost,
} from "@shared/financials";
import type { SeriesPoint } from "@shared/wall";
import { CollectionEditor } from "@/components/CollectionEditor";
import { DailyRevenuePanel } from "@/components/DailyRevenuePanel";
import { EmptyState } from "@/components/EmptyState";
import { InfoTooltip } from "@/components/InfoTooltip";
import { PageHeader } from "@/components/PageHeader";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SavesPaused } from "@/components/SavesPaused";
import { SegmentBar } from "@/components/SegmentBar";
import { StateChip } from "@/components/StateChip";
import { HeroChart, type HeroSeries } from "@/components/surface/HeroChart";
import { SectionLabel, eyebrowClass } from "@/components/surface/SectionLabel";
import { Sparkline } from "@/components/surface/Sparkline";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useStructuralSave } from "@/hooks/useConfigSave";
import { recurringPriceId, recurringPriceOps } from "@/lib/recurring-price";
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
import { useIntegrations } from "@/hooks/useIntegrations";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { useWall } from "@/hooks/useWall";
import { FinancialsPeriodError } from "@/lib/api";
import {
  formatMoney,
  formatPercent,
  formatPeriodMonth,
  formatPeriodMonthYear,
  formatSeriesDate,
  formatSignedMoney,
  formatUsd,
} from "@/lib/format";
import { lastMonthRevenue, monthDays, monthEquation, monthsThrough, revenueBySite, siteMoneyRows } from "@/lib/money-page";
import { cn } from "@/lib/utils";
import { monthRevenue } from "@/lib/wall-revenue";
import { CostComposition } from "@/routes/financials/CostComposition";
import { MonthHero } from "@/routes/financials/MonthHero";
import { RevenueComposition } from "@/routes/financials/RevenueComposition";
import { SiteMoneyRows, TooShortForATrend, TrendDates } from "@/routes/financials/SiteMoneyRows";

/** Cents, everywhere on this page: it exists to be reconciled against a
 * receipt, and a column of rounded figures does not add up to its own total. */
const CENTS = { cents: true } as const;

/** The three series' identity in the month-by-month chart: revenue cyan and
 * solid, cost violet and dashed, net in plain ink and dotted. */
const SERIES = {
  revenue: { name: "Revenue", tone: "revenue", lineStyle: "solid" },
  cost: { name: "Cost", tone: "cost", lineStyle: "dashed" },
  // Identity, not performance: signed geometry carries profit/loss.
  net: { name: "Net", tone: "primary", lineStyle: "dotted" },
} as const satisfies Record<string, Omit<HeroSeries, "points">>;

/**
 * /financials: am I making money, and where? The month is drawn as revenue
 * less cost is net, with its days, its pace and its sites; everything read one
 * cell at a time is a collapsed panel underneath. Overhead sits on asset #0 in
 * its own line and site nets carry direct costs only, because splitting shared
 * cost needs an allocation key nobody measured. The month is the page's range
 * and lives in the URL, so it is a link and a bookmark; the page defaults to
 * the latest month holding rows.
 */
export default function FinancialsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const { data, isPending, error, isPlaceholderData } = useFinancials(requestedPeriod);
  /** The month being read while the previous one stays on screen. */
  const loadingPeriod = isPlaceholderData && requestedPeriod !== null && requestedPeriod !== data?.period ? requestedPeriod : null;

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
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 p-4 md:p-6">
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
              {loadingPeriod ? (
                <span role="status" data-status-for={`period:${loadingPeriod}`} data-period-loading={loadingPeriod}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
                  {`Loading ${requestedPeriodLabel(loadingPeriod)}`}
                </span>
              ) : null}
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
          title="The ledger could not be read"
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
        // The shown month, dimmed, until the month being read replaces it.
        <div aria-busy={loadingPeriod !== null} className={cn("transition-opacity", loadingPeriod !== null && "opacity-60")}>
          <Ledger data={data} />
        </div>
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
          bookedThrough={data.periods.reduce((latest, month) => month > latest ? month : latest, data.currentPeriod)}
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
  const iconsOf = useSiteIcons();
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
              <PropertyFavicon domain={source.asset} icons={iconsOf(source.asset)} displayName={source.displayName} />
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

/**
 * The month, drawn. Laid out by its own width rather than the window's: the
 * desk's sidebar or a portrait monitor leaves the page less than the
 * viewport. The month as an equation with its days, its pace and its sites
 * leads; the cost side of the equation sits beside it; then every site ranked
 * by what it earned, and the months before. Everything read one cell at a
 * time is a collapsed panel underneath.
 */
function Ledger({ data }: { data: FinancialsPayload }) {
  // How many sites the installation has, from the sidebar's own read already
  // in the cache, so a month in which only one of several sites earned keeps
  // its by-site rows. Null until that read answers.
  const wall = useWall().data;
  const sites = wall?.assets.length ?? null;
  /* The open month is the calendar month the store is standing in, as the
     Worker worked it out on the operator's saved clock, not off `period`:
     June is not still counting because somebody chose to look at it. */
  const openPeriod = data.currentPeriod;
  /* Every month up to and including the selected one, so the chart and the
     lines end at the month the page describes. */
  const upto = monthsThrough(data);
  const shown = upto.at(-1);

  if (!shown) {
    // The same answer a refused month gets: its name, and the months that
    // hold something as the way out.
    return <MissingPeriod period={data.period} periods={data.periods} />;
  }

  const equation = monthEquation(shown, openPeriod, data.costLines.length);
  // While the month is open, its revenue pace is the one Home's answer and the
  // TV state (`monthRevenue`), so it is one number on every screen.
  const model = equation.open && wall && equation.currency === "USD" ? monthRevenue(wall.portfolio, wall.assets) : null;
  const pace = model?.period === shown.period && model.pace ? { projected: model.pace.projected, daysLeft: model.pace.daysLeft } : null;
  const projections = new Map((wall?.assets ?? []).map((asset) => [asset.id, asset.revenueProjection]));
  const rows = siteMoneyRows(data.properties, data.period, equation.open, equation.revenue, equation.currency, projections);
  const trendCurrency = moneyCurrency(upto.map((month) => month.total));

  return (
    <div className="@container flex flex-col gap-5" data-money-ledger="">
      <div className="grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0">
        <MonthHero
          equation={equation}
          days={data.dailyRevenue ? monthDays(data.dailyRevenue) : null}
          lastMonth={lastMonthRevenue(data.months, shown.period, equation.currency)}
          pace={pace}
          bySite={revenueBySite(data.properties, equation.currency)}
          className={cn("@3xl:col-span-2", data.costLines.length > 0 ? "@6xl:col-span-8" : "@6xl:col-span-12")}
        />
        {/* A cost side with nothing behind it is a box for nothing: the
            equation already says none was recorded. */}
        {data.costLines.length > 0 ? (
          <CostComposition
            lines={data.costLines}
            recurringCosts={data.recurringCosts}
            period={data.period}
            className="self-start @3xl:col-span-2 @6xl:col-span-4"
          />
        ) : null}
        {/* The month's revenue by source: ads, subscriptions and the rest,
            each under the name its source gives it. */}
        {data.revenueLines && data.revenueLines.length > 0 ? (
          <RevenueComposition
            lines={data.revenueLines}
            period={data.period}
            className="@3xl:col-span-2 @6xl:col-span-12"
          />
        ) : null}
        <SiteMoneyRows
          rows={rows}
          overhead={data.overhead}
          period={data.period}
          openPeriod={openPeriod}
          sites={sites}
          className="@3xl:col-span-2 @6xl:col-span-12"
        />
        {upto.length >= 2 ? (
          <section aria-label="Month by month" data-money-months="" className="rounded-xl bg-card px-5 pt-4 pb-3 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-12">
            {/* Net is drawn, not inferred: the scale takes a signed domain, so
                the page's headline figure is a line rather than a subtraction
                performed by eye. */}
            <HeroChart
              title="Month by month"
              series={[
                { ...SERIES.revenue, points: monthly(upto, (month) => month.total.revenue) },
                { ...SERIES.cost, points: monthly(upto, (month) => month.total.cost) },
                { ...SERIES.net, points: monthly(upto, (month) => month.total.net) },
              ]}
              range={upto.length}
              height={200}
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
          </section>
        ) : null}
      </div>

      {data.dailyRevenue ? (
        <Panel title="Day by day" count={formatPeriodMonthYear(data.period)} mark="days">
          <PortfolioRevenue history={data.dailyRevenue} sites={sites} />
        </Panel>
      ) : null}

      <Panel title="Every month" count={`${data.months.length} months`} mark="months">
        <MonthlyTable months={data.months} openPeriod={openPeriod} />
      </Panel>

      {/* The two registers are deliberately on a view page, which is what
          `data-config-surface` declares: these two tables are the files, and
          correcting a price here is why they are on the page that spends them. */}
      <Panel title="Declared costs" mark="costs" configSurface>
        <Costs
          period={data.period}
          currentPeriod={openPeriod}
          bookedThrough={data.periods.reduce((latest, month) => month > latest ? month : latest, openPeriod)}
          recurringCosts={data.recurringCosts}
          domainOrders={data.domainOrders}
          schedule={data.domains}
          properties={data.properties}
        />
      </Panel>
    </div>
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
                {index < 2 ? (
                  <TooShortForATrend />
                ) : net.length === 0 ? (
                  <Sparkline data={[]} size="cell" emptyReason="Months in different currencies" ariaLabel={`Net by month through ${formatSeriesDate(month.period)}`} />
                ) : (
                  <span className="ms-auto flex w-24 flex-col">
                    <Sparkline
                      data={net.slice(0, index + 1)}
                      size="cell"
                      average={false}
                      readout
                      tone="muted"
                      provisionalFrom={openPeriod}
                      format={(value) => formatMoney(value, moneyCurrency(months.map(item => item.total)), CENTS)}
                      ariaLabel={`Net by month, ${formatSeriesDate(net[0]!.t)} to ${formatSeriesDate(month.period)}`}
                    />
                    <TrendDates first={net[0]!.t} last={month.period} />
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
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
  bookedThrough,
  recurringCosts,
  domainOrders,
  schedule,
  properties,
}: {
  period: string;
  /** The month the reader is standing in — what "renews soon" counts from. */
  currentPeriod: string;
  bookedThrough: string;
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
        rowActions={(row, disabled) => (
          <NewRecurringPrice rows={recurringCosts} index={Number(row.token)} disabled={disabled} bookedThrough={bookedThrough} />
        )}
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
  const iconsOf = useSiteIcons();
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
              <PropertyFavicon domain={line.asset} icons={iconsOf(line.asset)} displayName={line.displayName} />
              <span className="min-w-0 flex-1 break-words text-sm">{line.displayName}</span>
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


function NewRecurringPrice({ rows, index, disabled, bookedThrough }: {
  rows: RecurringCost[];
  index: number;
  disabled: boolean;
  bookedThrough: string;
}) {
  const save = useStructuralSave();
  const titleId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState(rows);
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const cost = rows[index]!;

  async function submit() {
    if (disabled || inFlight.current) return;
    setError(null);
    let operations;
    try {
      if (JSON.stringify(snapshot[index]) !== JSON.stringify(rows[index])) {
        throw new Error("This recurring cost changed. Close the form and try again.");
      }
      operations = recurringPriceOps(rows, index, amount, month, recurringPriceId(cost.id), bookedThrough);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      if (await save({ ...operations, label: `New price · ${cost.label}`, slug: "financials-new-recurring-price" })) {
        setOpen(false);
        setAmount("");
        setMonth("");
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  if (disabled && !open) return null;
  return (
    <Popover open={open} onOpenChange={(next) => {
      if (inFlight.current) return;
      if (next) setSnapshot(rows);
      setOpen(next);
    }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled || saving}
          aria-label={`New price for ${cost.label}`}>
          New price
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-labelledby={titleId} className="w-80 max-w-[calc(100vw-1rem)]">
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <h4 id={titleId} className="text-sm font-medium">New price · {cost.label}</h4>
          <p className="text-xs text-muted-foreground">Original price ends the month before. Earliest new month: {nextPeriod(bookedThrough)}.</p>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            USD / month
            <input className={fieldClass} type="number" inputMode="decimal" min="0" step="any"
              value={amount} disabled={disabled || saving} onChange={(event) => { setAmount(event.target.value); setError(null); }} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            First month
            <input className={fieldClass} type="month" min={nextPeriod(bookedThrough)} value={month} disabled={disabled || saving}
              aria-describedby={error ? errorId : undefined} aria-invalid={error ? true : undefined}
              onChange={(event) => { setMonth(event.target.value); setError(null); }} />
          </label>
          {error ? <p id={errorId} role="alert" className="text-xs text-error">{error}</p> : null}
          {disabled ? <p role="status" className="text-xs text-muted-foreground">Saves paused</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={disabled || saving}>{saving ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
