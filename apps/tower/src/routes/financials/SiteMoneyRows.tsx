import { sumMoneyFigures } from "@noticeos/contract/money";
import { useId, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FinancialProperty, MoneyFigure } from "@shared/financials";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { InfoTooltip } from "@/components/InfoTooltip";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { Sparkline } from "@/components/surface/Sparkline";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { formatMoney, formatPercent, formatPeriodMonth, formatPeriodMonthLong, formatPeriodMonthYear, formatSeriesDate, formatSignedMoney } from "@/lib/format";
import { siteNetSeries, type SiteChange, type SiteMoneyRow } from "@/lib/money-page";
import { cn } from "@/lib/utils";

/** Cents: these rows are reconciled against receipts, and a column of rounded
 * figures does not add up to its own total. */
const CENTS = { cents: true } as const;

/** The ruled columns, dropped before a name is: the site and its money on a
 * phone; revenue and net from about 512px, direct cost from 672px, the net's
 * months from 768px and the share of the month from 1024px. Literal so the
 * stylesheet generator sees every one. */
const COLUMNS =
  "grid-cols-[minmax(0,1fr)_auto] @lg:grid-cols-[minmax(0,1fr)_8.5rem_8rem] @2xl:grid-cols-[minmax(0,1fr)_8.5rem_6rem_8rem] @3xl:grid-cols-[minmax(0,1fr)_6.5rem_8.5rem_6rem_8rem] @5xl:grid-cols-[minmax(10rem,1.2fr)_minmax(6.5rem,1fr)_8.5rem_minmax(6rem,1fr)_6rem_8rem]";

/** A net is a level, not a trend: ink for any amount, muted for a loss.
 * Never green for being positive and never red: a site that has not been
 * given a revenue source has not failed at anything. */
function netClass(value: number | null): string {
  return value === null || value < 0 ? "text-muted-foreground" : "text-foreground";
}

/**
 * Where the money is, site by site, ranked by what each earned: its revenue
 * with its change, its slice of the month, its direct cost and net, and its
 * net month by month. Overhead is its own row, allocated to no site, and the
 * last row is the month's net. One site with nothing shared draws nothing:
 * every row would equal its total.
 */
export function SiteMoneyRows({
  rows,
  overhead,
  period,
  openPeriod,
  sites,
  className,
}: {
  rows: readonly SiteMoneyRow[];
  overhead: MoneyFigure;
  period: string;
  /** The month the store is standing in: the one point on any line here still
   * being counted, drawn hollow. */
  openPeriod: string;
  /** The installation's site count, or null before it is known. */
  sites: number | null;
  className?: string;
}) {
  const id = useId();
  const owned = rows.map((row) => row.property);
  const several = (sites ?? owned.length) > 1;
  const overheadExists = overhead.cost !== 0 || overhead.revenue !== 0;
  if (!several && !overheadExists) return null;
  // "Sites, direct" is the total less the overhead; with no overhead it is the
  // total again, so it comes with the overhead row.
  const subtotal = several && overheadExists;
  const direct = sumMoneyFigures(owned.map((property) => property.figure));
  const portfolio = sumMoneyFigures([...owned.map((property) => property.figure), overhead]);

  return (
    <section aria-labelledby={id} data-money-sites="" className={cn("@container flex min-w-0 flex-col rounded-xl bg-card ring-1 ring-border/70", className)}>
      <SectionLabel id={id} title="By asset" caption={formatPeriodMonthYear(period)} className="px-5 pt-4 pb-2" />
      <div role="table" aria-labelledby={id} className="flex flex-col pb-1">
        <div role="row" className={cn("grid gap-x-4 border-b border-border/60 px-5 pb-1.5 text-micro font-medium text-muted-foreground", COLUMNS)}>
          <span role="columnheader">Asset</span>
          <span role="columnheader" className="hidden @3xl:block">Net by month</span>
          <span role="columnheader" className="text-end">
            Revenue<span className="@lg:hidden"> · net</span>
          </span>
          <span role="columnheader" className="hidden @5xl:block">Share of month</span>
          <span role="columnheader" className="hidden text-end @2xl:block">Direct cost</span>
          <span role="columnheader" className="hidden text-end @lg:block">Net</span>
        </div>
        {rows.map((row, index) => (
          <SiteRow key={row.property.asset} row={row} index={index} period={period} openPeriod={openPeriod} />
        ))}
        {subtotal ? <SummaryRow label="Assets, direct" figure={direct} mark="direct" strong /> : null}
        {overheadExists ? (
          <SummaryRow
            label="Overhead"
            caption="shared, allocated to no asset"
            figure={overhead}
            mark="overhead"
            cost
            ruled={!subtotal}
          />
        ) : null}
        <SummaryRow label="Total net" figure={portfolio} mark="total" strong large ruled />
      </div>
    </section>
  );
}

function SiteRow({ row, index, period, openPeriod }: { row: SiteMoneyRow; index: number; period: string; openPeriod: string }) {
  const { property, share, change } = row;
  const { figure } = property;
  const iconsOf = useSiteIcons();
  return (
    <div
      role="row"
      data-subject={`asset:${property.asset}`}
      data-money-site={property.asset}
      className={cn("viz-arrive grid items-center gap-x-4 border-b border-border/40 px-5 py-2.5 hover:bg-muted/30", COLUMNS)}
      style={{ "--viz-i": index } as CSSProperties}
    >
      <span role="rowheader" className="flex min-w-0 items-center gap-2.5">
        <PropertyFavicon domain={property.asset} icons={iconsOf(property.asset)} displayName={property.displayName} />
        {/* The name is the row's one way out, so on a phone it takes the 44px
            thumb floor: `inline-flex` grows the box and `-my-3` gives the row
            its height back. */}
        <Link
          to={`/assets/${encodeURIComponent(property.asset)}/financials`}
          title={property.displayName}
          className="min-w-0 break-words text-sm font-medium text-foreground hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center"
        >
          {property.displayName}
        </Link>
      </span>
      <span role="cell" className="hidden min-w-0 @3xl:flex">
        <NetTrend property={property} period={period} openPeriod={openPeriod} />
      </span>
      <span role="cell" className="flex flex-col items-end gap-0.5 tabular-nums">
        {property.revenueReported ? (
          <span className="text-sm font-semibold whitespace-nowrap text-foreground">{formatMoney(figure.revenue, figure.currency, CENTS)}</span>
        ) : (
          <span className="text-xs whitespace-nowrap text-muted-foreground" data-revenue-unreported={property.asset}>
            none reported
          </span>
        )}
        {change ? <Change change={change} /> : null}
        <span className={cn("text-micro whitespace-nowrap @lg:hidden", netClass(figure.net))}>
          net {formatSignedMoney(figure.net, figure.currency, CENTS)}
        </span>
      </span>
      <span role="cell" className="hidden min-w-0 items-center gap-2 @5xl:flex">
        {share !== null ? <Share name={property.displayName} share={share} index={index} /> : <span className="sr-only">no share</span>}
      </span>
      <span role="cell" className="hidden text-end text-sm whitespace-nowrap tabular-nums text-muted-foreground @2xl:block">
        {formatMoney(figure.cost, figure.currency, CENTS)}
      </span>
      <span role="cell" className={cn("hidden text-end text-sm whitespace-nowrap tabular-nums @lg:block", netClass(figure.net))} data-money-site-net="">
        {formatSignedMoney(figure.net, figure.currency, CENTS)}
      </span>
    </div>
  );
}

/** A closed month against the month before is a completed comparison and
 * wears its verdict; an open month's projection is an estimate and stays in
 * neutral ink. */
function Change({ change }: { change: SiteChange }) {
  const against = formatPeriodMonth(change.against);
  const heading = change.kind === "heading";
  const meaning = heading
    ? `heading ${formatPercent(Math.abs(change.percent))}% ${change.percent < 0 ? "under" : "over"} ${formatPeriodMonthLong(change.against)}`
    : `${formatPercent(Math.abs(change.percent))}% ${change.percent < 0 ? "down" : "up"} on ${formatPeriodMonthLong(change.against)}`;
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" data-money-change={change.kind}>
      <DeltaChip
        value={change.percent}
        render={(n) => `${formatPercent(n)}%`}
        tone={heading ? "neutral" : performanceTone(change.percent)}
        meaning={meaning}
        className="text-micro"
      />
      <span className="text-micro text-muted-foreground">{heading ? `pace vs ${against}` : `vs ${against}`}</span>
    </span>
  );
}

/** The site's slice of the month's revenue: the length is the answer, the
 * percentage at its end the figure. */
function Share({ name, share, index }: { name: string; share: number; index: number }) {
  const percent = formatPercent(share * 100);
  return (
    <>
      <span
        role="img"
        aria-label={`${name} earned ${percent}% of the month's revenue`}
        data-revenue-share={name}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-viz-track"
      >
        <span className="viz-grow-x block h-full rounded-full bg-financial-revenue/70" style={{ width: `${Math.max(2, share * 100)}%`, "--viz-i": index } as CSSProperties} />
      </span>
      <span aria-hidden className="w-9 shrink-0 text-end text-micro tabular-nums text-muted-foreground">
        {percent}%
      </span>
    </>
  );
}

/** A line needs three readings before it is a trend rather than a slope drawn
 * through two; below that the cell says why on hover, focus or tap. */
const MIN_TREND_MONTHS = 3;

export function TooShortForATrend() {
  const reason = `Needs ${MIN_TREND_MONTHS} months of history`;
  return <InfoTooltip label={`No trend: ${reason}`} trigger="—">{reason}</InfoTooltip>;
}

/** One site's net month by month, stopping at the month the row describes.
 * Muted: net's movement is not a verdict. */
function NetTrend({ property, period, openPeriod }: { property: FinancialProperty; period: string; openPeriod: string }) {
  const { series, currency } = siteNetSeries(property, period);
  if (series.filter((point) => point.v !== null).length < MIN_TREND_MONTHS) return <TooShortForATrend />;
  return (
    <span className="flex w-24 min-w-0 flex-col" data-property-trend={property.asset}>
      <Sparkline
        data={series}
        size="cell"
        average={false}
        readout
        tone="muted"
        provisionalFrom={openPeriod}
        format={(value) => formatMoney(value, currency, CENTS)}
        ariaLabel={`${property.displayName} net by month, ${formatSeriesDate(series[0]!.t)} to ${formatSeriesDate(series.at(-1)!.t)}`}
      />
      <TrendDates first={series[0]!.t} last={series.at(-1)!.t} />
    </span>
  );
}

/** The months a small line covers, under it: a line nobody can place in time
 * answers nothing. */
export function TrendDates({ first, last }: { first: string; last: string }) {
  return (
    <span aria-hidden className="flex justify-between gap-2 text-micro whitespace-nowrap tabular-nums text-muted-foreground" data-trend-dates="">
      <time dateTime={first}>{formatSeriesDate(first)}</time>
      <time dateTime={last}>{formatSeriesDate(last)}</time>
    </span>
  );
}

/** A row the table adds up to: its label, and its net in the net column (and
 * the overhead's cost in the cost column). */
function SummaryRow({
  label,
  caption,
  figure,
  mark,
  cost = false,
  strong = false,
  large = false,
  ruled = false,
}: {
  label: string;
  caption?: ReactNode;
  figure: MoneyFigure;
  mark: string;
  cost?: boolean;
  strong?: boolean;
  large?: boolean;
  ruled?: boolean;
}) {
  return (
    <div
      role="row"
      data-money-summary={mark}
      className={cn("grid items-baseline gap-x-4 px-5 py-2.5", COLUMNS, ruled ? "border-t-2 border-border" : "border-b border-border/40")}
    >
      <span role="rowheader" className={cn("min-w-0 text-sm", strong ? "font-semibold" : "font-medium")}>
        {label}
        {caption ? <span className="block text-xs font-normal text-muted-foreground @2xl:ms-2 @2xl:inline">{caption}</span> : null}
      </span>
      {cost ? (
        <span role="cell" className="hidden text-end text-sm whitespace-nowrap tabular-nums text-muted-foreground @2xl:col-[-3/-2] @2xl:block">
          {formatMoney(figure.cost, figure.currency, CENTS)}
        </span>
      ) : null}
      <span
        role="cell"
        className={cn(
          "col-[-2/-1] text-end whitespace-nowrap tabular-nums",
          large ? "text-figure-sm" : "text-sm",
          strong && "font-semibold",
          netClass(figure.net),
        )}
      >
        {formatSignedMoney(figure.net, figure.currency, CENTS)}
      </span>
    </div>
  );
}
