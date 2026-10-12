import { SegmentBar } from "@/components/SegmentBar";
import { BarStrip } from "@/components/viz/BarStrip";
import { PaceBar } from "@/components/viz/PaceBar";
import { formatPercent, formatPeriodMonth, formatPeriodMonthLong, formatUsd } from "@/lib/format";
import type { HomeMoney } from "@/lib/home-money";
import { cn } from "@/lib/utils";

const usd = (value: number) => formatUsd(value);
const cents = (value: number) => formatUsd(value, { cents: true });

/** The ink of each site's share, strongest first; past the fourth they share the last. */
const SHARE_FILL = ["bg-financial-revenue", "bg-financial-revenue/65", "bg-financial-revenue/40", "bg-financial-revenue/25"] as const;

/**
 * Home's lead: the month so far as the largest figure on the screen, where it
 * is heading against last month's total, the month's days as bars with the
 * usual day dashed, and which sites earned it. Raised, because it is the one
 * region the screen leads with.
 */
export function MoneyHero({ money, className }: { money: HomeMoney; className?: string }) {
  const month = formatPeriodMonthLong(money.period);
  const previous = money.previousPeriod ? formatPeriodMonthLong(money.previousPeriod) : null;
  const total = money.bySite.reduce((sum, site) => sum + site.amount, 0);
  return (
    <section
      aria-label={`Revenue, ${month} so far`}
      data-money-hero=""
      className={cn("relative flex min-w-0 flex-col gap-5 overflow-hidden rounded-xl bg-card p-6 shadow-raised ring-1 ring-border/70", className)}
    >
      <span aria-hidden className="pointer-events-none absolute -end-24 -top-32 size-80 rounded-full bg-financial-revenue/10 blur-3xl" />
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Revenue, {month} so far</span>
          {money.soFar === null ? (
            <span className="text-figure-sm text-muted-foreground" data-money-figure="">not reported yet</span>
          ) : (
            <span className="flex items-baseline gap-2" data-money-figure="">
              <span className="text-display tabular-nums text-foreground">{usd(money.soFar)}</span>
              {money.estimated ? <span className="text-sm font-medium text-muted-foreground">est.</span> : null}
            </span>
          )}
          <span className="text-sm text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
            {money.projected !== null ? (
              <>
                Heading for <b>{usd(money.projected)}</b>
                {money.changePercent !== null && previous ? (
                  <>
                    {" · "}
                    <span className={cn("font-semibold", money.changePercent < 0 ? "text-warn" : "text-trend-positive")}>
                      {formatPercent(Math.abs(money.changePercent))}% {money.changePercent < 0 ? "under" : "over"}
                    </span>{" "}
                    {previous}
                  </>
                ) : null}
                {money.daysLeft !== null ? ` · ${money.daysLeft} ${money.daysLeft === 1 ? "day" : "days"} left` : null}
              </>
            ) : (
              money.waiting ?? "No pace yet"
            )}
          </span>
        </div>
        {money.days.length >= 3 ? (
          <div className="w-full max-w-sm flex-1">
            <BarStrip
              data={money.days}
              tone="text-financial-revenue"
              baseline={money.usualDay !== null ? { value: money.usualDay, label: `usual ${cents(money.usualDay)} a day` } : null}
              format={cents}
              ariaLabel={`Revenue a day, ${month}`}
              className="h-20"
            />
          </div>
        ) : null}
      </div>
      {money.soFar !== null && (money.projected !== null || money.previousTotal !== null) ? (
        <PaceBar
          value={money.soFar}
          label={`${formatPeriodMonth(money.period)} so far`}
          previousAtSameDay={null}
          previousTotal={money.previousTotal}
          previousLabel={money.previousPeriod ? formatPeriodMonth(money.previousPeriod) : "Last month"}
          projected={money.projected}
          tone="text-financial-revenue"
          format={usd}
          showValue={false}
        />
      ) : null}
      {money.bySite.length >= 2 && total > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-4" data-money-by-site="">
          <span className="text-xs font-medium text-muted-foreground">Where {month} came from</span>
          <SegmentBar
            ariaLabel={`${month} revenue by site: ${money.bySite.map((site) => `${site.name} ${usd(site.amount)}`).join(", ")}`}
            className="h-2"
            segments={money.bySite.map((site, index) => ({ name: site.id, value: site.amount, fill: SHARE_FILL[Math.min(index, SHARE_FILL.length - 1)]! }))}
          />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground">
            {money.bySite.map((site, index) => (
              <span key={site.id} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <span className={cn("size-2 rounded-full", SHARE_FILL[Math.min(index, SHARE_FILL.length - 1)])} />
                {site.name} <b className="font-semibold text-foreground">{usd(site.amount)}</b> · {formatPercent((site.amount / total) * 100)}%
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
