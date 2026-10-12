import { shiftLabel } from "@shared/surface";
import type { AssetCard, PortfolioBand, SeriesPoint } from "@shared/wall";
import type { AnswerFigure } from "@/components/surface/PageAnswer";
import { formatInt, formatPercent, formatSeriesDate, formatUsd } from "@/lib/format";
import { monthRevenue } from "@/lib/wall-revenue";

// The portfolio's readings that are not Home's money hero: yesterday's
// visitors across the sites, the word for the hour, and the month and the
// visitors as an index page's answer figures.

export interface PeopleYesterday {
  /** The latest settled day any site reported. */
  date: string;
  total: number;
  /** The same weekday a week before, over the sites that reported both days. */
  previous: number | null;
  changePercent: number | null;
  /** The last fourteen settled days, summed across sites. */
  series: SeriesPoint[];
}

/** Yesterday's visitors across the sites: the latest day every provider has
 * finished counting, never a provisional one, summed over the sites that
 * reported it. Missing is left out, never a zero. */
export function peopleYesterday(assets: readonly AssetCard[]): PeopleYesterday | null {
  const settled = assets.map((asset) => {
    const { series, provisionalFrom } = asset.activeUsers;
    return series.filter((point) => provisionalFrom === null || point.t < provisionalFrom);
  }).filter((series) => series.length > 0);
  if (settled.length === 0) return null;
  const date = settled.map((series) => series.at(-1)!.t).sort().at(-1)!;
  const previousDate = shiftLabel(date, -7);
  let total = 0;
  let previous = 0;
  let both = 0;
  const byDate = new Map<string, number>();
  for (const series of settled) {
    const index = new Map(series.map((point) => [point.t, point.v]));
    const today = index.get(date);
    if (today === undefined) continue;
    total += today;
    const before = index.get(previousDate);
    if (before !== undefined) {
      previous += before;
      both += 1;
    }
    for (const point of series) byDate.set(point.t, (byDate.get(point.t) ?? 0) + point.v);
  }
  const series = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([t, v]) => ({ t, v }));
  const comparable = both > 0 && previous > 0;
  return {
    date,
    total,
    previous: comparable ? previous : null,
    changePercent: comparable ? ((total - previous) / previous) * 100 : null,
    series,
  };
}

/** The word for the hour, on the reader's own clock. */
export function greeting(nowMs: number): string {
  const hour = new Date(nowMs).getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** The month's money as one figure, the same derivation Home's hero and the
 * Wall use: the pace while there is one, else the month so far, else nothing.
 * "October heading for $1,310 ↑ 16%". */
export function monthFigure(portfolio: PortfolioBand, assets: readonly AssetCard[]): AnswerFigure | null {
  const money = monthRevenue(portfolio, assets);
  if (!money) return null;
  const month = formatSeriesDate(`${money.period}-01`).replace(/\s\d+$/, "");
  if (money.pace) {
    const change = money.pace.changePercent;
    return {
      label: `${month} projected`,
      value: formatUsd(money.pace.projected),
      note: change === null ? undefined : `${change >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(change))}%`,
      mark: "month-figure",
    };
  }
  return money.revenue === null ? null : { label: `${month} so far`, value: formatUsd(money.revenue), mark: "month-figure" };
}

/** Yesterday's visitors across the sites as one figure, or nothing. */
export function visitorsFigure(assets: readonly AssetCard[]): AnswerFigure | null {
  const people = peopleYesterday(assets);
  return people ? { label: "Visitors yesterday", value: formatInt(people.total), mark: "visitors-figure" } : null;
}
