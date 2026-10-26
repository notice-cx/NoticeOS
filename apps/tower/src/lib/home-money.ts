// Home's money, read once from what the Wall's revenue widget already reads
// (`monthRevenue`, each site's projection): the month so far against where it
// is heading and last month's total, the month's days as bars, and which
// sites earned it. A day no source reported is left out, never a zero.
import { shiftRevenueDate } from "@shared/revenue-projection";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import type { BarStripContributor, BarStripPoint } from "@/components/viz/BarStrip";
import { assetContributors } from "@/lib/asset-contributors";
import { monthRevenue, yesterdayTotal } from "@/lib/wall-revenue";

export interface HomeMoney {
  /** "2026-10". */
  period: string;
  /** The month so far, in dollars; null while nothing has reported. */
  soFar: number | null;
  /** Booked revenue is final; forecast is an estimate and says so. */
  estimated: boolean;
  /** Where the month is heading, or null while there is no pace. */
  projected: number | null;
  previousPeriod: string | null;
  previousTotal: number | null;
  /** The projection against last month's total, or null. */
  changePercent: number | null;
  daysLeft: number | null;
  /** Why there is no pace yet, in the projection's own words. */
  waiting: string | null;
  /** The month's reported days, summed over the sites that reported each. */
  days: BarStripPoint[];
  contributors?: BarStripContributor[];
  /** The mean of the reported days, or null with fewer than three. */
  usualDay: number | null;
  /** Each earning site's share of the month so far, largest first. */
  bySite: { id: string; name: string; amount: number }[];
}

/** Each site's reported days this month, from its cumulative projection: a
 * day's revenue is its running total less the day before's. */
function reportedDays(asset: Pick<AssetCard, "revenueProjection">): Map<string, number> {
  const days = new Map<string, number>();
  const points = asset.revenueProjection?.points ?? [];
  let before = 0;
  for (const point of points) {
    if (point.projected) break;
    days.set(point.date, (point.cumulativeMinor - before) / 100);
    before = point.cumulativeMinor;
  }
  return days;
}

/** One site's reported days this month, oldest first. */
export function siteDays(asset: Pick<AssetCard, "revenueProjection">): BarStripPoint[] {
  return [...reportedDays(asset).entries()].map(([t, v]) => ({ t, v }));
}

export function homeMoney(portfolio: PortfolioBand, assets: readonly AssetCard[]): HomeMoney | null {
  const model = monthRevenue(portfolio, assets);
  if (!model) return null;
  const byDate = new Map<string, Record<string, number>>();
  for (const asset of assets) {
    for (const [date, amount] of reportedDays(asset)) {
      const contributions = byDate.get(date) ?? {};
      contributions[asset.id] = amount;
      byDate.set(date, contributions);
    }
  }
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([t, contributions]) => ({ t, v: Object.values(contributions).reduce((sum, value) => sum + value, 0), contributions }));
  const usualDay = days.length >= 3 ? days.reduce((sum, day) => sum + (day.v ?? 0), 0) / days.length : null;
  const bySite = assets
    .flatMap((asset) => {
      const earned = asset.revenueProjection?.status === "ready" ? asset.revenueProjection.earnedMinor : null;
      return earned !== null && earned !== undefined && earned > 0 ? [{ id: asset.id, name: asset.displayName, amount: earned / 100 }] : [];
    })
    .sort((a, b) => b.amount - a.amount);
  return {
    period: model.period,
    soFar: model.revenue,
    estimated: model.state === "forecast",
    projected: model.pace?.projected ?? null,
    previousPeriod: model.pace?.previousPeriod ?? model.previousMonth?.period ?? null,
    previousTotal: model.pace?.previousTotal ?? null,
    changePercent: model.pace?.changePercent ?? null,
    daysLeft: model.pace?.daysLeft ?? null,
    waiting: model.waiting,
    days,
    contributors: assetContributors(assets).filter((source) => days.some((day) => source.id in day.contributions)),
    usualDay,
    bySite,
  };
}

export interface YesterdayMoney {
  date: string;
  amount: number;
  /** The same weekday a week before, when the month holds it. */
  weekBefore: number | null;
  changePercent: number | null;
  /** The days up to yesterday, at most the last fourteen. */
  days: BarStripPoint[];
}

/** Yesterday's revenue across the sites with its week-ago day, or null when
 * yesterday has not been reported on one clock. */
export function yesterdayMoney(assets: readonly AssetCard[], nowMs: number, days: readonly BarStripPoint[], timeZone?: string): YesterdayMoney | null {
  const total = yesterdayTotal(assets, nowMs, timeZone);
  if (!total || total.amount === null || !total.basis) return null;
  const date = total.basis.date;
  const weekAgo = days.find((day) => day.t === shiftRevenueDate(date, -7))?.v ?? null;
  return {
    date,
    amount: total.amount,
    weekBefore: weekAgo,
    changePercent: weekAgo !== null && weekAgo > 0 ? ((total.amount - weekAgo) / weekAgo) * 100 : null,
    days: days.filter((day) => day.t <= date).slice(-14),
  };
}
