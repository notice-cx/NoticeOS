import { Check, CircleDollarSign } from "lucide-react";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import { wallMetricTiles, type WallWidget } from "@shared/wall-layout";
import { PropertyFavicon } from "@/components/PropertyFavicon";
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
import { monthRevenue, yesterdayTotal, type MonthPace } from "@/lib/wall-revenue";

// The Wall's revenue widget: the month so far, where it lands, yesterday's
// money, and the month as a line against last month's total. The arithmetic
// is `lib/wall-revenue`; this file only draws it.
//
// The shared comparison tile keeps the month's facts beside a contained chart.

type RevenueAsset = Pick<AssetCard, "id" | "displayName" | "icons" | "revenueProjection" | "dailyRevenue">;

export interface RevenueHeroProps {
  portfolio: PortfolioBand;
  assets: readonly RevenueAsset[];
  /** The Wall's clock, which "yesterday" is asked on; this render's own when
   * absent. */
  nowMs?: number;
  timeZone?: string;
  widget?: WallWidget;
}

export function RevenueHero({ portfolio, assets, nowMs, timeZone, widget }: RevenueHeroProps) {
  const model = monthRevenue(portfolio, assets);
  const yesterday = yesterdayTotal(assets, nowMs ?? Date.now(), timeZone);

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
  const priorMonth = pace ? formatPeriodMonth(pace.previousPeriod) : "";

  const comparisonDirection = pace?.changePercent == null ? null : pace.changePercent > 0 ? "above" : pace.changePercent < 0 ? "below" : "level with";
  const movement: MetricMovement | undefined = pace?.changePercent == null ? undefined : {
    label: `${formatPercent(Math.abs(pace.changePercent))}% ${comparisonDirection}`,
    direction: pace.changePercent > 0 ? "up" : pace.changePercent < 0 ? "down" : "flat",
    tone: pace.changePercent > 0 ? "positive" : pace.changePercent < 0 ? "negative" : "neutral",
    basis: `vs ${priorMonth}`,
    meaning: `Projected revenue ${formatPercent(Math.abs(pace.changePercent))}% ${comparisonDirection} recorded ${priorMonth} revenue`,
  };
  const actual = pace?.points.filter(point => !point.projected) ?? [];
  const projected = pace?.points.filter(point => point.projected) ?? [];
  const forecast = projected.length > 0 && actual.length > 0 ? [actual.at(-1)!, ...projected] : projected;
  const point = (reading: MonthPace["points"][number]) => ({ t: reading.date, v: reading.cumulative });
  const first = pace?.points[0], last = pace?.points.at(-1);
  const chartProps: Omit<MetricComparisonChartProps, "label" | "className"> | undefined = pace && first && last ? {
    current: actual.map(point), forecast: forecast.map(point),
    previousTotal: pace.previousTotal === null ? undefined : { value: pace.previousTotal, label: `${priorMonth} ${formatUsd(pace.previousTotal)}` },
    domain: { start: first.date, end: last.date },
    showLabels: false,
    tone: "revenue",
  } : undefined;
  const secondary = yesterday ? [yesterdayFact(yesterday)] : [];
  const projection = pace ? <div className="wall-revenue-projection">
    <span data-revenue-pace>{formatUsd(pace.projected)}</span>
    <span className="wall-metric-note">Projected month</span>
  </div> : undefined;
  const note = model.waiting || model.revenue === null && model.previousMonth ? <>
    {model.waiting ? <span data-revenue-waiting>{model.waiting}</span> : null}
    {model.revenue === null && model.previousMonth ? <span data-revenue-previous-month>
    {formatPeriodMonthYear(model.previousMonth.period)} {formatUsd(model.previousMonth.revenue)}{model.previousMonth.reported < model.previousMonth.sites ? <> · {model.previousMonth.reported} of {model.previousMonth.sites} assets</> : null}
  </span> : null}</> : undefined;
  const provisional = model.state === "forecast" ? "Provisional revenue" : undefined;
  return <section aria-label="Revenue this month" data-metrics-configured={widget?.settings?.metrics !== undefined || undefined} data-wall-revenue={model.revenue === null ? "waiting" : pace ? "pace" : "figure"}>
    {wallMetricTiles(widget ?? { id: "revenue", type: "revenue", width: 1 }).map(tile => <WallMetricBinding key={tile.id} tile={tile} configured={widget?.settings?.metrics !== undefined}>
    <CumulativeCompareMetric
      title={model.periodIsCurrent ? "Revenue this month" : `${month} revenue`}
      icon={CircleDollarSign} expanded className="wall-revenue-metric"
      value={model.revenue === null ? null : <span title={provisional}>
        {provisional ? <span className="sr-only">{provisional} </span> : null}
        <span data-revenue-figure>{formatUsd(model.revenue)}</span>
      </span>}
      movement={movement} secondary={secondary} note={note}
      chartProps={chartProps} chartCenter={projection} chartUnavailable={model.waiting ?? "No projection available"}
    />
    </WallMetricBinding>)}
  </section>;
}

function yesterdayFact(total: NonNullable<ReturnType<typeof yesterdayTotal<RevenueAsset>>>): NonNullable<CumulativeCompareMetricProps["secondary"]>[number] {
  const basis = total.basis && `${formatSeriesDate(total.basis.date)} · ${total.basis.label ?? total.basis.timeZone}`;
  return {
    label: "Yesterday", dividerBefore: true,
    value: total.amount === null
      ? <span data-revenue-yesterday="none" className="wall-revenue-unreported">Not reported yet</span>
      : <span data-revenue-yesterday={total.reported < total.sites ? "some" : "all"}>
        <span data-revenue-yesterday-figure>{formatUsd(total.amount, { cents: true })}</span>
      </span>,
    note: <span className="wall-revenue-sites" role="group" aria-label={basis ? `Reports for ${basis}` : "Yesterday’s reports"}>
      {total.coverage.map(({ asset, reported }) => {
        const status = `${asset.displayName} · ${reported ? "Reported" : "Waiting for report"}`;
        return <span key={asset.id} role="img" aria-label={status} title={status} data-revenue-site={reported ? "reported" : "waiting"}>
          <PropertyFavicon domain={asset.id} displayName={asset.displayName} icons={asset.icons} scheme="dark" />
          {reported ? <span className="wall-revenue-reported-badge" aria-hidden="true"><Check /></span> : null}
        </span>;
      })}
    </span>,
  };
}
