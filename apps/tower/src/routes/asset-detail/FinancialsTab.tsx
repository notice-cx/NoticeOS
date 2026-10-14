import { useId } from "react";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { revenueCalendarDate, revenueNoun, revenueTimeZone, siteRevenueWindow } from "@shared/daily-revenue";
import { DailyRevenuePanel } from "@/components/DailyRevenuePanel";
import { PageAnswer } from "@/components/surface/PageAnswer";
import { BarStrip } from "@/components/viz/BarStrip";
import { PaceBar } from "@/components/viz/PaceBar";
import { formatMoney, formatPeriodMonth, formatPeriodMonthLong, formatPeriodMonthYear, formatSignedMoney } from "@/lib/format";
import type { MonthDays, MonthEquation } from "@/lib/money-page";
import { Equation } from "@/routes/financials/MonthHero";
import { AssetLedger } from "./AssetLedger";
import { ledgerMonth, type LedgerMonth } from "./overview-metrics";
import { siteEquation, siteEstimatePace, siteLastMonth, siteMonthDays, type EstimatePace } from "./site-money";
import { useRange } from "./useRange";

/**
 * One site's money, drawn the way the Money page draws the portfolio's: the
 * month as revenue − cost = net, its ad revenue days against the usual day
 * and the month so far against the month before; then its daily estimates
 * over the header's range, and its accounting months side by side.
 */
export function FinancialsTab({ data, nowMs }: { data: AssetDetailFor<"financials">; nowMs: number }) {
  const { days } = useRange();
  // Ending yesterday on the source's reporting clock.
  const history = siteRevenueWindow(data.dailyRevenue, nowMs, revenueTimeZone(data.dailyRevenue, data.osTimeZone), days);
  // The month in the Overview's own terms (`ledgerMonth`): booked when it
  // has booked rows, its estimates otherwise.
  const money = ledgerMonth(data.ledger);
  const equation = money ? siteEquation(data.ledger, money, revenueCalendarDate(new Date(nowMs), data.osTimeZone).slice(0, 7)) : null;
  // The estimates' month is the reporting clock's, which a ledger month
  // never moves: the newest day the source owes.
  const estimateMonth = history.to.slice(0, 7);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {money && equation ? (
        <SiteMonth
          money={money}
          equation={equation}
          forecast={forecastBeside(data, money)}
          days={siteMonthDays(data.dailyRevenue, estimateMonth, history.to, data.asset.id, data.asset.displayName)}
          pace={siteEstimatePace(data.dailyRevenue, estimateMonth, history.to)}
          noun={revenueNoun(data.dailyRevenue?.bySource)}
          lastMonth={siteLastMonth(data.ledger, equation)}
        />
      ) : (
        <PageAnswer answer="No money recorded yet" marks={{ "data-surface-hero": "", "data-site-money-answer": "none" }} />
      )}
      {/* The month's figures are the hero's; the panel draws the range. */}
      <DailyRevenuePanel history={history} range={days} totals={false} setupHref={`/assets/${encodeURIComponent(data.asset.id)}/sources`} />
      <div id="pnl"><div id="ledger">
        <AssetLedger ledger={data.ledger} ledgerRecordedAt={data.freshness.ledgerRecordedAt} nowMs={nowMs} />
      </div></div>
    </div>
  );
}

/** A booked month's estimates, stated beside it and never added in: the
 * forecast's net when the month also carries one. */
function forecastBeside(data: AssetDetailFor<"financials">, money: LedgerMonth): { net: number; currency: string } | null {
  if (money.booking !== "booked") return null;
  const figure = data.ledger.periods.find((period) => period.period === money.period)?.forecast.figure;
  if (!figure || figure.currency === null || (figure.revenue === 0 && figure.cost === 0)) return null;
  return { net: figure.net, currency: figure.currency };
}

/**
 * The month as one equation, revenue − cost = net, the net the largest figure
 * on the screen, with the booking it is read from. Beside it, the month's ad
 * revenue days against the usual day and the month so far against the month
 * before on one ruler, both estimates and saying so; a site with no daily
 * revenue source draws its booked months instead, and its booked revenue
 * against last month's.
 */
function SiteMonth({
  money,
  equation,
  forecast,
  days,
  pace,
  lastMonth,
  noun,
}: {
  money: LedgerMonth;
  equation: MonthEquation;
  forecast: { net: number; currency: string } | null;
  days: MonthDays | null;
  pace: EstimatePace | null;
  lastMonth: { period: string; revenue: number | null };
  /** What the daily figures are called: `revenueNoun` of their sources. */
  noun: string;
}) {
  const id = useId();
  const reported = days?.days.filter((day) => day.v !== null).length ?? 0;
  const dollars = (value: number) => formatMoney(value, "USD");
  const cents = (value: number) => formatMoney(value, "USD", { cents: true });
  const ledger = (value: number) => formatMoney(value, equation.currency);
  const estimates = pace !== null && (pace.previousTotal !== null || pace.previousAtSameDay !== null);
  const months = money.series.slice(-6);
  return (
    <section
      aria-labelledby={id}
      data-surface-hero=""
      data-site-money-answer={money.booking}
      className="@container relative flex min-w-0 flex-col gap-5 overflow-hidden rounded-xl bg-card p-5 shadow-raised ring-1 ring-border/70 @md:p-6"
    >
      <span aria-hidden className="pointer-events-none absolute -end-24 -top-32 size-80 rounded-full bg-financial-revenue/10 blur-3xl" />
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <h2 id={id} className="m-0 text-xs font-medium text-muted-foreground">
            <span className="whitespace-nowrap">{formatPeriodMonthYear(equation.period)}{equation.open ? " so far" : ""}</span>
            {" · "}
            <span className="whitespace-nowrap">{money.booking === "booked" ? "booked" : "estimated, nothing booked yet"}</span>
          </h2>
          <Equation equation={equation} />
          {forecast ? (
            <p className="m-0 text-sm text-muted-foreground" data-site-money-forecast="">
              <span className="whitespace-nowrap">
                forecast <b className="font-semibold text-foreground">{formatSignedMoney(forecast.net, forecast.currency)}</b> not booked yet
              </span>
            </p>
          ) : null}
        </div>
        {days && reported >= 3 ? (
          <div className="flex max-w-sm min-w-0 flex-[1_1_16rem] flex-col gap-1.5" data-money-days="">
            <span className="text-xs font-medium text-muted-foreground">{noun} a day · estimates</span>
            <BarStrip
              data={days.days}
              partial={days.partial}
              tone="text-financial-revenue"
              baseline={days.usualDay !== null ? { value: days.usualDay, label: `usual ${cents(days.usualDay)} a day` } : null}
              format={cents}
              ariaLabel={`${noun} a day, ${formatPeriodMonthLong(days.days[0]!.t.slice(0, 7))}`}
              className="h-20"
            />
          </div>
        ) : months.length >= 3 ? (
          <div className="flex max-w-sm min-w-0 flex-[1_1_16rem] flex-col gap-1.5" data-money-months="">
            <span className="text-xs font-medium text-muted-foreground">Net by month · {money.booking === "booked" ? "booked" : "estimated"}</span>
            <BarStrip
              data={months}
              tone="text-financial-revenue"
              // The month still being counted is short by construction.
              provisionalFrom={equation.open ? equation.period : null}
              format={ledger}
              ariaLabel={`Net by month, ${formatPeriodMonthLong(months[0]!.t)} to ${formatPeriodMonthLong(months.at(-1)!.t)}`}
              className="h-20"
            />
          </div>
        ) : null}
      </div>
      {estimates ? (
        <PaceBar
          value={pace.value}
          label={`${formatPeriodMonth(pace.period)} so far`}
          previousAtSameDay={pace.previousAtSameDay}
          previousTotal={pace.previousTotal}
          previousLabel={formatPeriodMonth(pace.previousPeriod)}
          tone="text-financial-revenue"
          format={dollars}
        />
      ) : equation.revenue !== null && equation.revenue > 0 && lastMonth.revenue !== null ? (
        <PaceBar
          value={equation.revenue}
          label={`${formatPeriodMonth(equation.period)}${equation.open ? " so far" : ""}`}
          previousAtSameDay={null}
          previousTotal={lastMonth.revenue}
          previousLabel={formatPeriodMonth(lastMonth.period)}
          tone="text-financial-revenue"
          format={ledger}
        />
      ) : null}
    </section>
  );
}
