import { CircleDollarSign } from "lucide-react";
import type { WordLevel } from "@shared/views";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import { wallMetricTiles, type WallWidget } from "@shared/wall-layout";
import { WallMetricBinding } from "./WallMetricEditing";
import { CumulativeCompareMetric, type CumulativeCompareMetricProps, type MetricComparisonChartProps, type MetricMovement } from "@/components/wall/MetricWidgets";
import {
  formatPercent,
  formatPeriodMonth,
  formatPeriodMonthLong,
  formatPeriodMonthYear,
  formatUsd,
  formatSeriesDate,
} from "@/lib/format";
import { monthRevenue, yesterdayTotal, type MonthPace, type YesterdayTotal } from "@/lib/wall-revenue";

// The Wall's revenue widget: the month so far, where it lands, yesterday's
// money, and the month as a line against last month's total. The arithmetic
// is `lib/wall-revenue`; this file only draws it.
//
// The shared comparison tile keeps the month's facts beside a contained chart.

export interface RevenueHeroProps {
  portfolio: PortfolioBand;
  assets: readonly Pick<AssetCard, "revenueProjection" | "dailyRevenue">[];
  /** The Wall's clock, which "yesterday" is asked on; this render's own when
   * absent. */
  nowMs?: number;
  /** The words of the view the TV is drawn for: "business" calls an estimate
   * "so far", as Home's money does; the other levels say "est.". */
  wordLevel?: WordLevel;
  widget?: WallWidget;
}

export function RevenueHero({ portfolio, assets, nowMs, wordLevel = "operational", widget }: RevenueHeroProps) {
  const business = wordLevel === "business";
  const model = monthRevenue(portfolio, assets);
  const yesterday = yesterdayTotal(assets, nowMs ?? Date.now());

  if (model === null) {
    return (
      <section
        aria-label="Revenue this month"
        className="flex min-w-0 items-center gap-3 text-wall-body text-muted-foreground"
        data-wall-revenue="none"
      >
        <CircleDollarSign className="size-6 shrink-0" aria-hidden />
        No revenue source
      </section>
    );
  }

  const month = model.periodIsCurrent
    ? formatPeriodMonthLong(model.period)
    : formatPeriodMonthYear(model.period);
  const { pace } = model;

  const comparisonDirection = pace?.changePercent == null ? null : pace.changePercent > 0 ? "above" : pace.changePercent < 0 ? "below" : "level with";
  const movement: MetricMovement | undefined = pace?.changePercent == null ? undefined : {
    label: `${formatPercent(Math.abs(pace.changePercent))}% ${comparisonDirection}`,
    direction: pace.changePercent > 0 ? "up" : pace.changePercent < 0 ? "down" : "flat",
    tone: pace.changePercent > 0 ? "positive" : pace.changePercent < 0 ? "negative" : "neutral",
    basis: `projected vs ${formatPeriodMonth(pace.previousPeriod)} total`,
    meaning: `Projected revenue ${formatPercent(Math.abs(pace.changePercent))}% ${comparisonDirection} ${formatPeriodMonth(pace.previousPeriod)} total`,
  };
  const actual = pace?.points.filter(point => !point.projected) ?? [];
  const projected = pace?.points.filter(point => point.projected) ?? [];
  const forecast = projected.length > 0 && actual.length > 0 ? [actual.at(-1)!, ...projected] : projected;
  const point = (reading: MonthPace["points"][number]) => ({ t: reading.date, v: reading.cumulative });
  const first = pace?.points[0], last = pace?.points.at(-1);
  const chartProps: Omit<MetricComparisonChartProps, "label" | "className"> | undefined = pace && first && last ? {
    current: actual.map(point), forecast: forecast.map(point),
    previousTotal: pace.previousTotal === null ? undefined : { value: pace.previousTotal, label: `${formatPeriodMonth(pace.previousPeriod)} total ${formatUsd(pace.previousTotal)}` },
    domain: { start: first.date, end: last.date },
    startLabel: `${formatPeriodMonth(model.period)} ${first.day}`,
    endLabel: `${formatPeriodMonth(model.period)} ${last.day}`,
    tone: "revenue",
  } : undefined;
  const secondary: CumulativeCompareMetricProps["secondary"] = [
    ...(pace ? [{ label: "Projected month", value: <span data-revenue-pace>{formatUsd(pace.projected)}</span>, labelPosition: "below" as const }] : []),
    ...(yesterday ? [yesterdayFact(yesterday, business)] : []),
    ...(pace ? [{ label: pace.daysLeft === 1 ? "day left" : "days left", value: pace.daysLeft, size: "detail" as const, labelPosition: "below" as const }] : []),
  ];
  const note = model.waiting || model.revenue === null && model.previousMonth ? <>
    {model.waiting ? <span data-revenue-waiting>{model.waiting}</span> : null}
    {model.revenue === null && model.previousMonth ? <span data-revenue-previous-month>
    {formatPeriodMonthYear(model.previousMonth.period)} {formatUsd(model.previousMonth.revenue)} est.{model.previousMonth.reported < model.previousMonth.sites ? <> · {model.previousMonth.reported} of {model.previousMonth.sites} assets</> : null}
  </span> : null}</> : undefined;
  return <section aria-label="Revenue this month" data-metrics-configured={widget?.settings?.metrics !== undefined || undefined} data-wall-revenue={model.revenue === null ? "waiting" : pace ? "pace" : "figure"}>
    {wallMetricTiles(widget ?? { id: "revenue", type: "revenue", width: 1 }).map(tile => <WallMetricBinding key={tile.id} tile={tile} configured={widget?.settings?.metrics !== undefined}>
    <CumulativeCompareMetric
      title={model.periodIsCurrent ? "Revenue this month" : `${month} revenue`}
      icon={CircleDollarSign} expanded context="USD"
      value={model.revenue === null ? null : <span data-revenue-figure>{formatUsd(model.revenue)}</span>}
      valueNote={`${month}${model.revenue !== null && model.state === "forecast" ? business ? " · so far" : " · estimated" : ""}`}
      movement={movement} secondary={secondary} note={note}
      chartProps={chartProps} chartUnavailable={model.waiting ?? "No projection available"}
    />
    </WallMetricBinding>)}
  </section>;
}

/** Provider reporting dates and coverage stay with the amount they qualify. */
function yesterdayFact(total: YesterdayTotal, business: boolean): NonNullable<CumulativeCompareMetricProps["secondary"]>[number] {
  const basis = total.basis ? `${formatSeriesDate(total.basis.date)} · ${total.basis.label ?? total.basis.timeZone}` : "provider days";
  if (total.mixedBasis) return {
    label: "Yesterday", dividerBefore: true,
    value: <span data-revenue-yesterday="mixed">—</span>,
    note: `Mixed report days · ${total.reported} of ${total.sites} assets · no total`,
  };
  if (total.amount === null) return {
    label: "Yesterday", dividerBefore: true, size: "detail",
    value: <span data-revenue-yesterday="none">Not reported yet</span>, note: basis,
  };
  return {
    label: "Yesterday", dividerBefore: true,
    value: <span data-revenue-yesterday={total.reported < total.sites ? "some" : "all"}><span data-revenue-yesterday-figure>{formatUsd(total.amount, { cents: true })}</span></span>,
    note: `${basis} · ${business ? "so far" : "est."}${total.reported < total.sites ? ` · ${total.reported} of ${total.sites} assets` : ""}`,
  };
}
