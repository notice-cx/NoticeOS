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

/**
 * Cents, everywhere on this page.
 *
 * The Wall rounds to whole dollars because a glance never reconciles against a
 * receipt. This page exists to BE reconciled — an operator checking $23.28 of
 * amortized domains against a Porkbun invoice cannot do it against "$23", and a
 * column of rounded figures does not add up to its own total.
 */
const CENTS = { cents: true } as const;

/**
 * THE THREE SERIES' IDENTITY, stated once for the strip and the chart (doc 14
 * § Tokens, bead `ro-ujb9.12`): revenue cyan and solid, cost violet and
 * dashed, net in plain ink and dotted. The strip's sparklines wear the same
 * ink as the lines under "Month by month", so a KPI and its line are read as
 * one series before a label is; the delta chip beside each carries the verdict.
 */
const SERIES = {
  revenue: { name: "Revenue", tone: "revenue", lineStyle: "solid" },
  cost: { name: "Cost", tone: "cost", lineStyle: "dashed" },
  // Identity, not performance: signed geometry carries profit/loss.
  net: { name: "Net", tone: "primary", lineStyle: "dotted" },
} as const satisfies Record<string, Omit<HeroSeries, "points">>;

/**
 * /financials — **am I making money, and where?** (doc 14, bead `ro-78qo.16`).
 *
 * ONE QUESTION, AND THE FIRST SCREEN IS THE WHOLE ANSWER. Until this rebuild
 * the page opened on five stacked cards of the same weight — a hatched bar
 * chart, a month table, an asset table, a cost table, two register editors and
 * a gaps list — 4,410px at 1440 with seven paragraphs and three config-file
 * chips on the way down. The reader had to assemble the answer. Now the strip
 * states it (net, revenue, cost, what has been reconciled, what is still a
 * forecast), the chart under it carries the shape, and everything that is
 * READ ONE CELL AT A TIME — the month table, the cost breakdown, the two
 * registers — is a collapsed panel underneath.
 *
 * AND NOTHING ON IT IS A PARAGRAPH (bead `ro-ujb9.96.6.9`, doc 14 principle
 * 3a). The About, the known-gaps panel and five tooltips carried seven
 * paragraphs; each fact is now a shape on the figure it qualifies.
 *
 * TWO-TIER BY CONSTRUCTION, and it is the reason this page exists rather than a
 * per-asset margin column on the Wall. Most of the portfolio's cost pays for
 * all of it — Claude Code, the Cloudflare plan — and splitting that across six
 * assets needs an allocation key nobody measured. So overhead sits on asset
 * #0 in its own line, asset nets carry DIRECT costs only, and the reader
 * subtracts once, visibly. A single blended margin per asset would look more
 * finished and be less true.
 *
 * THE MONTH IS THE PAGE'S RANGE (doc 14 gives every surface one range control;
 * on an accounting page that control is the month, not `7d · 28d · 90d`). It
 * lives in the URL, never in component state: a month is then a LINK the
 * operator can send, a bookmark that survives a reload, and a back button that
 * steps through what he actually looked at. The page defaults to the latest
 * month holding rows, and the header says when that is not this month (bead
 * `ro-69vb`).
 */
export default function FinancialsRoute() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedPeriod = searchParams.get("period");
  const { data, isPending, error } = useFinancials(requestedPeriod);

  /**
   * The URL named a month the ledger cannot answer (bead `ro-dm67`).
   *
   * It is not the same event as a ledger that failed, and it used to render as
   * one: the reader got "The ledger did not answer" and — because the selector
   * is drawn from a payload that never arrived — no way out but editing the
   * URL. A bookmark to last quarter's month is exactly the link a finance page
   * receives, and it lands here.
   */
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

  /* THE OPEN MONTH IS SAID ONCE, beside the month it qualifies (bead
     `ro-ujb9.96.6.9`). It used to be a caption under two KPIs, a word in the
     month table, a tooltip sentence and an About paragraph — four places for
     one fact. The hollow dot is the chart's own mark for an unfinished period. */
  const monthToDate =
    !missingPeriod && data && !data.empty && data.period >= data.currentPeriod;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3.5 p-4 md:p-6">
      <PageHeader
        title="Money"
        /* THE PAGE'S ONE QUESTION, not a fact about the query behind it (doc
           21). This slot used to read "latest month with rows" whenever the
           ledger's newest month was not the calendar one — a sentence about how
           the payload chose a period, which is the sort of thing a database
           says and an operator does not ask. The month picker opposite names
           the month in full ("August 2026") and a reader standing in September
           can see it; what nothing else on the page said was what the page is
           FOR. */
        actions={
          /* THE SELECTOR SURVIVES A BAD MONTH (bead `ro-dm67`). It is the page's
             standing way to move, and it vanished on exactly the state that
             needed it. On a refused month its value is the month that is NOT
             there — which `PeriodPicker` already tolerates, mirrors the URL the
             reader is on, and, unlike parking it on a real month, means picking
             any month in the list actually fires a change instead of silently
             re-selecting what is already selected. */
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
        /* ONLY A LEDGER THAT NEVER ANSWERED (bead `ro-ujb9.96.6.9`). A failed
           refresh keeps the last-good figures on screen — the query holds its
           data through a refetch error — which the old hint promised in a
           sentence while `isError` blanked the page anyway. The way out is the
           button, not an instruction to reload. */
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
 * A `?period=` the ledger cannot answer (bead `ro-dm67`).
 *
 * This is where a bookmark to last quarter's month lands, and it used to land
 * on "The ledger did not answer" — a sentence about a broken database, for a
 * URL that is merely out of date, with the selector gone because it is drawn
 * from a payload that never arrived. A finance page receives exactly this link,
 * so it answers with the months it HAS.
 *
 * THE MONTHS ARE THE ANSWER, NOT A SENTENCE ABOUT THEM (bead
 * `ro-ujb9.96.6.9`): the title names the miss and the row of months under it
 * is the way out. A ledger holding no month at all is the first-run state, and
 * says what to connect rather than that there is nothing to fall back to.
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

/**
 * A ledger with no row at all: the title, and the one step that fills it —
 * connecting a revenue source — as a link rather than a sentence describing
 * where to go (bead `ro-ujb9.96.6.9`).
 */
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

/**
 * THE FIRST RUN IS THE TWO STEPS, NOT INSTRUCTIONS FOR THEM (bead
 * `ro-ujb9.96.6.9`). The page used to say "connect a revenue source in
 * Integrations and configure operating costs" and then show neither. Revenue is
 * connected on another page, so that is a link; costs are declared HERE, so the
 * cost registers open in place — the step is the control.
 */
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
 * Which month the page describes — doc 14's page-wide range, in the grain an
 * accounting page has (bead `ro-69vb`).
 *
 * A NATIVE `<select>`, not a `RangeSelector`. The options are a plain list of
 * months with no state, no glyph and no severity, and there can be dozens of
 * them; the platform control brings keyboard navigation, type-ahead and the
 * phone's own wheel for free, which three pills cannot.
 *
 * NEWEST FIRST, which is the opposite of the trajectory table below on purpose:
 * that table is read for a shape, so it runs in calendar order; this list is
 * read to FIND a month, and the month wanted is almost always the one that just
 * closed.
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
 * A collapsed card (doc 14 principle 3: everything read one cell at a time
 * lives behind a disclosure).
 *
 * IT MOUNTS ITS BODY ONLY WHEN OPEN, which is the difference between a page
 * that is quiet and one that merely looks it. A closed `<details>` still lays
 * its contents out — Chrome reports boxes for a `content-visibility: hidden`
 * subtree — so the first cut of this page measured 3,795px at 1440 with
 * nothing but a 1,350px column on screen, and `surface:audit` counted six
 * paragraphs and a config path nobody could see. Not rendering is the only
 * honest reading of "not visible by default".
 *
 * Local to this page rather than a registry component: it is `Card` plus an
 * eyebrow and a chevron, and a fourth container in the registry is exactly what
 * doc 14 counts as a near-duplicate.
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
  /** A register deliberately shown on a view route — the audit's own opt-out
   * (`scripts/README.md`), so the owner chips inside it are not counted as the
   * chips doc 14 keeps off a view surface. */
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

/** A net is a level, not a trend (doc 14 principle 5; D45): ink for any
 * amount, muted for a loss or nothing — never green for being positive and
 * never red: an asset that has not been given a revenue source has not failed
 * at anything. */
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

/**
 * The page's answer, once the ledger has one.
 *
 * Everything below the hero is a collapsed panel, and that ordering is the
 * whole redesign: the shape of the money is what the page is opened for, and
 * reconciling one figure against a receipt is a job done one cell at a time by
 * somebody who came looking for it.
 */
function PortfolioRevenue({ history, sites }: { history: PortfolioDailyRevenue; sites: number | null }) {
  // One site's coverage line would restate "5 of 5 days reported" beside the
  // figure (bead `ro-ujb9.129`); from two sites it says which one missed days.
  const coverage = (sites ?? history.sources.length) > 1 && history.sources.length > 0;
  const sourceNames = new Map(history.sources.map(source => [source.asset, source.displayName]));
  // A day owes only the sources already reporting by then (bead `ro-rd6r`).
  const notesByDate = Object.fromEntries(history.coverage.map(day => [day.date,
    `${day.reported} of ${day.reported + day.missingAssets.length} daily sources reported${day.missingAssets.length ? ` · Missing: ${day.missingAssets.map(asset => sourceNames.get(asset) ?? 'Unknown site').join(', ')}` : ''}`,
  ]));
  const partialDates = history.coverage.filter(day => day.reported > 0 && day.missingAssets.length > 0).map(day => day.date);
  return <DailyRevenuePanel history={history} range={revenueWindowDays(history.from, history.to)}
    title="Daily revenue" notesByDate={notesByDate} partialDates={partialDates} totals={false}
    setupHref="/integrations"
    context={coverage ? <SourceCoverage history={history} /> : null} />;
}

/**
 * EACH SOURCE AND HOW MANY OF THE WINDOW'S DAYS IT REPORTED (bead
 * `ro-ujb9.96.6.9`) — the coverage the panel used to spell out in two
 * sentences ("daily source coverage: …", "3 days have partial reports …").
 * A source that missed days wears the warn ink on its own count, so the
 * one to chase is the one that looks different; each is a door to that
 * asset's own financials.
 */
function SourceCoverage({ history }: { history: PortfolioDailyRevenue }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0" data-source-coverage>
      {history.sources.map((source) => {
        // Its days are the ones since it first reported (bead `ro-rd6r`).
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
  // How many sites the installation has — the sidebar's own read, already in
  // the cache — so a month in which only one of several sites earned keeps its
  // by-site table (bead `ro-ujb9.129`). Null until that read answers.
  const wall = useWall().data;
  const sites = wall?.assets.length ?? null;
  /* The OPEN month is the calendar month the STORE is standing in, as the
     Worker worked it out on the operator's saved clock when it built this
     payload — not off `period`: the reader may have selected June, and June is
     not provisional because somebody chose to look at it. */
  const openPeriod = data.currentPeriod;
  /* Every month up to and including the selected one. The strip describes the
     SELECTED month, so its deltas and sparklines have to end there too: a
     sparkline running past the month the number above it states would be two
     different periods drawn as one unit. */
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
      {/* ONE ANSWER FIRST (D45): the month's net in a sentence, the pace
          Home and the TV say under it while the month is open, and revenue,
          cost and what is confirmed beside it. A cost nobody recorded is a
          dash, never $0 (doc 14 principle 8). */}
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
            {/* NET IS DRAWN NOW, NOT INFERRED (bead `ro-78qo.28`). This chart
                carried revenue and cost and a footnote saying the distance
                between them was the net, because `HeroChart`'s scale was
                zero-based and a month at −$224 had nowhere to go. The scale
                takes a signed domain since that bead, so the page's headline
                figure is a line the operator can point at rather than a
                subtraction they perform by eye — and the footnote goes with it,
                because the third toggle says the same thing without a sentence. */}
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

      {/* THE TWO REGISTERS ARE DELIBERATELY ON A VIEW PAGE (bead `ro-x5gu.2`),
          which is what `data-config-surface` declares: doc 14 keeps owner chips
          and config paths off view surfaces, and these two tables ARE the files
          — correcting a price here is the whole reason they were brought onto
          the page that spends them. */}
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

      {/* NO ABOUT AND NO "WHAT THIS PAGE DOES NOT KNOW" (bead
          `ro-ujb9.96.6.9`). Seven paragraphs lived behind those two panels, and
          each now sits on the figure it qualifies, as a shape: the open month
          is the header chip and the chart's hollow point; the estimated share
          is Reconciled's second number and bar; the two-tier read is the
          by-asset table's own direct / overhead / net rows; an asset nothing
          reported revenue for is a dash; a domain about to renew wears a
          chip. */}
    </>
  );
}

/**
 * THE MONTH'S ANSWER (D45). "September net +$135 so far", and while the month
 * is open the revenue pace Home's brief and the TV state (`monthRevenue`, the
 * one derivation), so September is one number on every screen. A cost nobody
 * recorded is "none recorded", and the net says "revenue only", never a green
 * net over a $0 nobody counted.
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
 * WHERE THE MONEY IS, asset by asset — the page's one visible table (doc 14's
 * index template: one `Table` or one `ListPanel`).
 *
 * TWO SHAPES, TWO QUESTIONS (bead `ro-78qo.29`). The share bar answers which
 * asset is carrying THIS month; on a portfolio where one asset is essentially
 * all the revenue that answer is known before the page loads, and the second
 * question — which one is getting BETTER — is the interesting one. Only a
 * series can answer it, so doc 14 puts a net-by-month `Sparkline` in every row.
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
  /* ONE SITE IS ITS OWN SPLIT (bead `ro-ujb9.129`). Every row of a by-site
     table over one site equals its total, which reads as a broken report, and
     with nothing shared there is nothing to allocate: the strip above already
     states the site's money. The table stays while a cost pays for more than
     the site — an overhead line — and then the site's own row is its direct
     subtotal, so "Sites, direct" would repeat it. From two sites the table is
     as it always was. */
  const several = (sites ?? owned.length) > 1;
  const overheadExists = overhead.cost !== 0 || overhead.revenue !== 0;
  if (!several && !overheadExists) return null;
  // "Sites, direct" is the total minus the overhead; with no overhead it is
  // the total again, one figure twice (D45), so it goes with the overhead row.
  const subtotal = several && overheadExists;
  const direct = sumMoneyFigures(owned.map(property => property.figure));
  const portfolio = sumMoneyFigures([...owned.map(property => property.figure), overhead]);
  const directNet = direct.net;
  const portfolioNet = portfolio.net;
  const periodRevenue = portfolio.revenue;

  return (
    <section className="rounded-[10px] border border-border bg-card">
      {/* The two-tier read is the table's own last three rows — assets' direct
          net, the shared overhead, the portfolio net — so it needs no tooltip
          explaining how costs are allocated (bead `ro-ujb9.96.6.9`). */}
      <SectionLabel
        title="By site"
        caption={formatPeriodMonthYear(period)}
        className="px-4 pb-1 pt-3"
      />
      <div className="px-2 pb-2 sm:px-4 sm:pb-4">
        {/* `stacked` (bead `ro-md80`): Net was entirely off the right edge at
            390px — the column the split exists to state. */}
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
                    {/* THE NAME IS THE CARD'S ONE WAY OUT (bead `ro-zmyq`). On a
                        phone this table is six stacked cards and this link is
                        the only control on each of them, drawn at 20px — under
                        the thumb floor `ro-md80` set, and not a button, a
                        field, a palette row or a nav row, which is how it
                        survived that sweep. `inline-flex` makes the box 44px
                        and `-my-3` returns 24 of them, so the cell keeps the
                        20px it had and the six cards cost the page nothing. */}
                    <Link
                      to={`/assets/${encodeURIComponent(property.asset)}/financials`}
                      /* `min-w-11` as well as `min-h-11`: the floor is 44px on
                         BOTH axes, and a three-letter name measured 31px wide. The width is
                         claimed the same way the height is — into the padding
                         and the gap between cards, where no other control is. */
                      className="hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center"
                    >
                      {property.displayName}
                    </Link>
                  </span>
                </TableCell>
                {/* WHICH WAY THIS ASSET IS GOING — the question the three money
                    columns beside it cannot answer, however carefully they are
                    read. The line is MUTED: net's movement is not a verdict,
                    and an asset with no revenue source wired has not failed at
                    anything (doc 14). `average={false}` because these are
                    monthly points, and there is no noise in six of them to
                    smooth away. */}
                <TableCell label="Net · by month" dropWhenStacked>
                  <PropertyTrend
                    property={property}
                    period={period}
                    openPeriod={openPeriod}
                  />
                </TableCell>
                <TableCell label="Revenue" className="text-right tabular-nums">
                  {/* NOTHING REPORTED IS A DASH, NOT $0.00 (bead
                      `ro-ujb9.96.6.9`). A zero here used to be qualified by a
                      paragraph under "what this page does not know"; the cell
                      itself now tells an unreported month from a zero one. */}
                  {property.revenueReported ? (
                    formatMoney(property.figure.revenue, property.figure.currency, CENTS)
                  ) : (
                    <span data-revenue-unreported={property.asset}>
                      <InfoTooltip label={`${property.displayName}: no revenue reported`} trigger="—">
                        No revenue reported
                      </InfoTooltip>
                    </span>
                  )}
                  {/* WHICH ASSET IS CARRYING THE MONTH — the one question a
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
            {/* The three summary rows carry no line: a total's trajectory is
                the chart at the top of the page, drawn with an axis and a
                legend, and repeating it at 96px would be the same fact in two
                places (doc 14). */}
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

/**
 * A line needs three points before it is a trend rather than a slope drawn
 * through two readings. Below that the cell prints a dash and says why on
 * hover — the same floor, for the same reason, as the month table's own
 * sparkline column.
 */
const MIN_TREND_MONTHS = 3;

/** The dash a trend cell prints under that floor, with its reason on demand —
 * the reason as a label, not the argument for it (bead `ro-ujb9.96.6.9`) —
 * from a hover, a key or a tap, where a `title` answered only the hover (bead
 * `ro-ujb9.14`). */
function TooShortForATrend() {
  const reason = `Needs ${MIN_TREND_MONTHS} months of history`;
  return <InfoTooltip label={`No trend: ${reason}`} trigger="—">{reason}</InfoTooltip>;
}

/**
 * ONE ASSET'S NET, MONTH BY MONTH — the row's own shape (bead `ro-78qo.29`).
 *
 * The series stops at the month the table describes: the figures beside it are
 * August's, and a line running into September under them would be two periods
 * drawn as one. Nothing is interpolated — the payload carries a point only for
 * a month the asset actually has a ledger row in, so an asset that booked
 * nothing in July has no July point rather than a manufactured zero.
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
  /* THE ASSET'S OWN MONTH AXIS, HOLES INCLUDED (bead `ro-78qo.37`). A
     sparkline spaces its points by POSITION, so a series carrying only the
     months that booked something would draw January, June and August as three
     consecutive months — a claim about which months these are that the ledger
     never made. The payload carries the axis; a month it booked nothing in is
     null, and the line breaks over it rather than bridging it. */
  const currency = moneyCurrency(property.months.flatMap(month => month.figure === null ? [] : [month.figure]));
  const series: SeriesPointOrGap[] = property.months
    .filter((month) => month.period <= period)
    .map((month) => ({
      t: month.period,
      v: currency === null || month.figure?.currency !== currency ? null : month.figure.net,
    }));

  /* Three READINGS, not three positions: an axis of ten months holding two
     figures is still two figures, and the floor is about what the ledger
     recorded rather than how far apart it recorded it. */
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

/**
 * One asset's slice of the period's revenue, as the shape beside the figure.
 *
 * The bar is never the only place a number appears — the dollars are in the
 * cell directly above it and the exact percentage is in the hover — so it is
 * doing the one job a figure cannot.
 */
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

/**
 * The trajectory, one row per month, with a sparkline cell for the shape.
 *
 * It is behind a disclosure now because the CHART above answers "is this
 * getting better or worse" and this table answers "what exactly did July book"
 * — a different question, asked by somebody holding an invoice.
 */
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
      {/* `stacked` (bead `ro-md80`): five money columns run 134px past a 390px
          screen, and Net and Reconciled — the two the operator opened the page
          for — were the two that fell off the right edge. */}
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
              {/* The row's own shape: net up to and including this month, so a
                  reader scanning down sees the trajectory the chart draws
                  without leaving the table (doc 14's `Sparkline` cell). */}
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
 * HOW A COST FIGURE CAME TO BE KNOWN, as a glyph rather than a word to read.
 *
 * All four faces stay in the quiet half of the palette on purpose: provenance
 * is not severity, and an amortized domain is not a problem. They separate on
 * WEIGHT and on the dot's shape rather than on hue, so the ladder reads the
 * same on a grayscale screen — and it runs in the order an operator trusts the
 * figure, from measured down to unaccounted-for.
 *
 * The chip REPLACES the word rather than sitting beside it: the label inside it
 * is that word (doc 14, one representation per fact).
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
   words for the four kinds (shared/financials.ts), so the glossary tooltip each
   one used to carry is gone (bead `ro-ujb9.96.6.9`). */
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
 * WHERE A COST LINE CAME FROM, NAMED THE WAY THE OPERATOR NAMES IT (bead
 * `ro-ujb9.96.6.9`): the subscription's own label from the register he wrote
 * it in, the provider's product name for a metered bill, "Domain orders" for
 * the amortized terms. The store's keys (`recurring:claude-code-max`,
 * `metered:dataforseo`) are how the rows are filed, not how anyone says them —
 * and printing them beside a chip that already says "Subscription" stated the
 * kind twice.
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
      {/* `stacked` (bead `ro-md80`): the Source column — the whole point of the
          table, since it is what a figure can be checked against — was the one
          truncated at 390px. */}
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

/**
 * A DOMAIN TERM THAT RUNS OUT THIS MONTH OR NEXT (bead `ro-ujb9.96.6.9`).
 *
 * The page used to carry a paragraph warning that domain figures are what was
 * paid — often a first-year price — not what renewal costs, so the forward run
 * rate is higher than shown. What the operator can act on is WHEN that price
 * changes, so the order whose term is about to end wears the date instead.
 */
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
 * THE INPUTS, ON THE PAGE THAT SPENDS THEM (bead `ro-x5gu.2`).
 *
 * Everything above is the ledger — what booked. This is the two files it books
 * FROM, and it is where they are corrected: the subscriptions nobody meters
 * (`recurring-costs`) and the domain orders being amortized (`domain-costs`).
 * The two provenance chips in the breakdown above — *Stated* and *Amortized* —
 * point at exactly these two tables.
 *
 * NOTHING HERE MAY FILTER OR SORT THE ROWS. Both cross the payload verbatim and
 * in file order because the editor addresses a row by its INDEX (`/costs/3`) —
 * a filtered table would send that pointer for whichever row happened to be
 * first on screen and quietly rewrite a different subscription. So the asset
 * dimension is a SUMMARY above the tables rather than a filter on them.
 *
 * ON A DEPLOYMENT THAT CANNOT WRITE, both tables lose every control and show
 * a lock, and the page says why ONCE, above them (`SavesPaused`, bead
 * `ro-p8qq`) — where the operator would have edited.
 *
 * MONEY KEEPS ITS SAVE (bead `ro-ujb9.96.7.12`): each cell commits with its own
 * Save or Enter, never as it is left, and says "Saved · Undo" or "Not saved"
 * under itself — GitLab Pajamas' rule that financial data is never autosaved.
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
  // WHICH ASSET IDS EXIST comes from the integration matrix, not from
  // `properties` (bead `ro-x5gu.10`). `properties` is this period's ledger
  // split, so an asset that has booked nothing yet is not in it — offering that
  // as the picker would refuse a perfectly real asset the month it is wired up.
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
      {/* No "about cost editing" tooltip (bead `ro-ujb9.96.6.9`): every cell
          is its own field with its own Save, and every save answers with an
          Undo beside it — the control says what it does. */}
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
        /* THE TWO FACTS EVERY ROW HAS AND NO FIELD HOLDS (bead `ro-x5gu.11`).
           A domain order is a prepaid annual term, so what the ledger books
           every month is the price over twelve — arithmetic, never a stored
           value. `schedule` is the payload's own amortization of these same
           rows, so the column restates nothing: it looks the row up by the name
           it is filed under. It carries no control, because nothing writes it. */
        derived={[
          {
            /* The amount and the twelve months it is spread over, both in the
               cell — the header needs no sentence saying how it is worked
               out (bead `ro-ujb9.96.6.9`). */
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
        /* The facts no ROW carries, in the slot a subtitle already has, as
           figures (bead `ro-ujb9.96.6.17`): the orders, the cash already
           spent, and how many are still being spread across the shown month.
           How one order books is the Per month column, so no sentence here
           restates the amortization rule. */
        describe={
          domainOrders.length === 0 ? undefined : (
            <span className="tabular-nums" data-domain-terms>
              {domainOrders.length} {domainOrders.length === 1 ? "order" : "orders"} ·{" "}
              {formatUsd(paid, CENTS)} paid · {amortizing} amortizing this month
            </span>
          )
        }
        /* The read-only sentence is a fact about the DEPLOYMENT, and the page
           states it once above both tables. */
        statesReadOnly={false}
      />
    </div>
  );
}

/**
 * WHAT EACH ASSET COSTS PER MONTH BY DECLARATION — the grouped read the two
 * flat tables cannot give, and the only place on this page the asset dimension
 * is not the ledger's.
 *
 * It is deliberately NOT the *Direct cost* column above: that is what the
 * ledger booked for the shown month, and this is what the files say SHOULD
 * book. They differ whenever `cost-import` has not run for the month yet, which
 * is the first thing an operator wants to know when a figure looks low.
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
