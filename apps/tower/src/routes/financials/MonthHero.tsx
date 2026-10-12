import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { SegmentBar } from "@/components/SegmentBar";
import { BarStrip } from "@/components/viz/BarStrip";
import { PaceBar } from "@/components/viz/PaceBar";
import { formatMoney, formatPercent, formatPeriodMonth, formatPeriodMonthLong, formatPeriodMonthYear, formatSignedMoney } from "@/lib/format";
import type { MonthDays, MonthEquation, SiteShare } from "@/lib/money-page";
import { cn } from "@/lib/utils";
import { SHARE_FILL } from "@/routes/home/MoneyHero";

/** Home's ramp for each site's share, strongest first; past the fourth they
 * share the last. */
const shareFill = (index: number) => SHARE_FILL[Math.min(index, SHARE_FILL.length - 1)]!;

export interface MonthHeroProps {
  equation: MonthEquation;
  /** The month's days as reported, or null when no daily source covers it. */
  days: MonthDays | null;
  lastMonth: { period: string; revenue: number | null };
  /** Where an open month is heading, the number Home and the TV state. */
  pace: { projected: number; daysLeft: number } | null;
  bySite: readonly SiteShare[];
  className?: string;
}

/**
 * Money's lead: the month as one equation, revenue less cost is net, with the
 * net the largest figure on the screen; its days as bars against the usual
 * day; the month against last month's whole total (and, while it is open,
 * where it is heading); and which sites earned it.
 */
export function MonthHero({ equation, days, lastMonth, pace, bySite, className }: MonthHeroProps) {
  const id = useId();
  const { currency, open } = equation;
  const whole = (value: number) => formatMoney(value, currency);
  const cents = (value: number) => formatMoney(value, currency, { cents: true });
  const month = formatPeriodMonthLong(equation.period);
  const reported = days?.days.filter((day) => day.v !== null).length ?? 0;
  const total = bySite.reduce((sum, site) => sum + site.amount, 0);
  const context: ReactNode[] = [
    open && pace ? <>Heading for <b>{whole(pace.projected)}</b> revenue · <b>{pace.daysLeft}</b> {pace.daysLeft === 1 ? "day" : "days"} left</> : null,
    equation.confirmed !== null && equation.turnover !== null && equation.turnover > 0
      ? <span data-money-confirmed="">{equation.confirmed === 0 ? "none confirmed yet" : <><b>{whole(equation.confirmed)}</b> of {whole(equation.turnover)} confirmed</>}</span>
      : null,
  ].filter((part) => part !== null);

  return (
    <section
      aria-labelledby={id}
      data-surface-hero=""
      data-money-answer={open ? "open" : "closed"}
      className={cn("@container relative flex min-w-0 flex-col gap-5 overflow-hidden rounded-xl bg-card p-5 shadow-raised ring-1 ring-border/70 @md:p-6", className)}
    >
      <span aria-hidden className="pointer-events-none absolute -end-24 -top-32 size-80 rounded-full bg-financial-revenue/10 blur-3xl" />
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <h2 id={id} className="m-0 text-xs font-medium whitespace-nowrap text-muted-foreground">
            {formatPeriodMonthYear(equation.period)}
            {open ? " so far" : ""}
          </h2>
          <Equation equation={equation} />
          {context.length > 0 ? (
            <p className="m-0 flex flex-wrap gap-x-1.5 text-sm text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground" data-money-context="">
              {context.map((part, index) => (
                <span key={index} className="whitespace-nowrap">
                  {index > 0 ? "· " : null}
                  {part}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        {days && reported >= 3 ? (
          <div className="flex max-w-sm min-w-0 flex-[1_1_16rem] flex-col gap-1.5" data-money-days="">
            <BarStrip
              data={days.days}
              partial={days.partial}
              tone="text-financial-revenue"
              baseline={days.usualDay !== null ? { value: days.usualDay, label: `usual ${cents(days.usualDay)} a day` } : null}
              format={cents}
              ariaLabel={`Revenue a day, ${month}`}
              className="h-20"
            />
            {days.short.length > 0 ? <ShortSources short={days.short} /> : null}
          </div>
        ) : null}
      </div>

      {equation.revenue !== null && currency !== null && (lastMonth.revenue !== null || (open && pace)) ? (
        <PaceBar
          value={equation.revenue}
          label={`${formatPeriodMonth(equation.period)}${open ? " so far" : ""}`}
          previousAtSameDay={null}
          previousTotal={lastMonth.revenue}
          previousLabel={formatPeriodMonth(lastMonth.period)}
          projected={open ? pace?.projected ?? null : null}
          tone="text-financial-revenue"
          format={whole}
          showValue={false}
        />
      ) : null}

      {bySite.length >= 2 && total > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4" data-money-by-site="">
          <span className="text-xs font-medium text-muted-foreground">Where {month} came from</span>
          <SegmentBar
            ariaLabel={`${month} revenue by site: ${bySite.map((site) => `${site.name} ${whole(site.amount)}`).join(", ")}`}
            className="h-2"
            segments={bySite.map((site, index) => ({ name: site.id, value: site.amount, fill: shareFill(index) }))}
          />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {bySite.map((site, index) => (
              <span key={site.id} className="inline-flex items-center gap-1.5 whitespace-nowrap" data-money-site-share={site.id}>
                <span aria-hidden className={cn("size-2 rounded-full", shareFill(index))} />
                {site.name} <b className="font-semibold text-foreground">{whole(site.amount)}</b> · {formatPercent((site.amount / total) * 100)}%
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Revenue − cost = net. The net is the answer, so it is the largest figure;
 * revenue wears its identity ink, cost and the operators stay neutral. A cost
 * nobody recorded is named, and the net then says it is revenue only.
 */
function Equation({ equation }: { equation: MonthEquation }) {
  const { currency } = equation;
  return (
    <dl className="m-0 flex flex-wrap items-end gap-x-2.5 gap-y-2 tabular-nums @md:gap-x-4" data-money-equation="">
      <Term mark="money-revenue" label="Revenue">
        <span className="text-figure-sm text-financial-revenue @md:text-figure">{formatMoney(equation.revenue, currency)}</span>
      </Term>
      <Operator>−</Operator>
      <Term mark="money-cost" label="Cost">
        {equation.costRecorded ? (
          <span className="text-figure-sm text-foreground @md:text-figure">{formatMoney(equation.cost, currency)}</span>
        ) : (
          <span className="text-sm font-medium text-muted-foreground">none recorded</span>
        )}
      </Term>
      <Operator>=</Operator>
      <Term mark="money-net" label="Net">
        <span className={cn("text-figure @md:text-display", equation.net !== null && equation.net < 0 ? "text-muted-foreground" : "text-foreground")}>
          {formatSignedMoney(equation.net, currency)}
        </span>
        {equation.costRecorded ? null : <span className="ms-2 text-sm font-medium text-muted-foreground">revenue only</span>}
      </Term>
    </dl>
  );
}

function Term({ mark, label, children }: { mark: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" {...{ [`data-${mark}`]: "" }}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      {/* Every figure sits in a box as tall as the net's, so the three labels
          share one line however different the figures' sizes. */}
      <dd className="m-0 flex min-h-[2.1rem] flex-wrap content-end items-baseline whitespace-nowrap leading-none @md:min-h-[2.9rem]">{children}</dd>
    </div>
  );
}

function Operator({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden className="pb-0.5 text-figure-sm leading-none font-normal text-muted-foreground/70 @md:pb-1.5">
      {children}
    </div>
  );
}

/** Which source missed the outlined days, and how many it reported: each a
 * door to that site's own money. */
function ShortSources({ short }: { short: MonthDays["short"] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0 text-micro text-muted-foreground" data-money-short-sources="">
      {short.map((source) => (
        <li key={source.asset}>
          <Link
            to={`/assets/${encodeURIComponent(source.asset)}/financials`}
            className="inline-flex items-baseline gap-1 whitespace-nowrap hover:text-foreground max-sm:min-h-11 max-sm:items-center"
          >
            {source.name}
            <span className="font-medium tabular-nums text-warn">
              {source.reported}/{source.owed} days
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
