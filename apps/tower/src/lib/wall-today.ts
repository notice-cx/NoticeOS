import type { Ga4RealtimeAsset } from "@noticeos/contract";
import type { AssetCard } from "@shared/wall";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { offsetCalendarDate } from "./intraday-pace";
import { completedRealtimeMinutes, currentRealtimeDay, realtimeComparison } from "./realtime-day";
import { calendarDayStart, calendarOffset, reportingCalendarTrend } from '@shared/reporting-calendar';

/** Daily users on the display calendar; shifted reporting boundaries are estimates. */
export function todayUserCounts(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number) {
  const displayZone = asset.activeUsers.calendarAdjusted ? asset.activeUsers.timeZone : undefined;
  const activityZone = currentRealtimeDay(snapshot, nowMs, displayZone)?.timeZone ?? displayZone ?? (snapshot?.status === "success" ? snapshot.timeZone : null);
  const trend = reportingCalendarTrend(asset.activeUsers, activityZone ?? asset.activeUsers.timeZone);
  const timeZone = trend.timeZone ?? null;
  let date: string | null = null;
  try { if (timeZone) date = revenueCalendarDate(new Date(nowMs), timeZone); } catch { date = null; }
  let activityDate: string | null = null;
  try { if (activityZone) activityDate = revenueCalendarDate(new Date(nowMs), activityZone); } catch { activityDate = null; }
  const referenceDate = date ? offsetCalendarDate(date, -7) : null;
  const daily = new Map([...(trend.contextSeries ?? []), ...trend.series].map(point => [point.t, point.v]));
  const count = (day: string | null) => { const value = day ? daily.get(day) : null; return value != null && Number.isFinite(value) && value >= 0 ? value : null; };
  return { date, referenceDate, timeZone, today: count(date), reference: count(referenceDate),
    todayEstimated: date !== null && (trend.estimatedDates?.includes(date) ?? false),
    referenceEstimated: referenceDate !== null && (trend.estimatedDates?.includes(referenceDate) ?? false),
    activityDateMatches: date !== null && activityDate === date };
}

/** Convert activity to an approximate user count using last week's measured
 * users per user-minute. Missing current minutes follow last week's profile,
 * scaled by activity on matching minutes, rather than counting gaps as zero. */
export function estimatedTodayUsers(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number) {
  const daily = todayUserCounts(asset, snapshot, nowMs);
  const day = currentRealtimeDay(snapshot, nowMs, daily.timeZone ?? undefined);
  if (!day || day.timeZone !== daily.timeZone || day.date !== daily.date || daily.reference === null || daily.reference <= 0) return null;
  const comparison = realtimeComparison(day);
  const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
  if (!comparison) return null;
  const prior = comparison.minutes;
  // Compare against the prior calendar day's actual length, including DST.
  const referenceMinutes = (calendarDayStart(calendarOffset(daily.referenceDate!, 1), day.timeZone) - calendarDayStart(daily.referenceDate!, day.timeZone)) / 60_000;
  const baseline = prior.reduce((sum, value) => sum + value, 0) * referenceMinutes / prior.length;
  if (baseline <= 0) return null;
  const minutes = completedRealtimeMinutes(day, nowMs);
  const through = minutes.findLastIndex(value => value !== null);
  if (through < 0) return null;
  let observed = 0, matchedPrior = 0, elapsedPrior = 0, observedMinutes = 0;
  for (let i = 0; i <= through; i++) {
    elapsedPrior += prior[i]!;
    const value = minutes[i] ?? null;
    if (value === null) continue;
    if (!valid(value)) return null;
    observed += value;
    matchedPrior += prior[i]!;
    observedMinutes++;
  }
  if (observedMinutes < 15 || matchedPrior <= 0) return null;
  const estimate = daily.reference * (elapsedPrior / baseline) * (observed / matchedPrior);
  if (!Number.isFinite(estimate) || estimate > Number.MAX_SAFE_INTEGER) return null;
  return {
    users: Math.max(daily.today ?? 0, Math.round(estimate)),
    through: new Date(Date.parse(day.startAt) + (through + 1) * 60_000).toISOString(),
    observedMinutes,
    estimatedMinutes: through + 1 - observedMinutes,
    estimatedReferenceMinutes: comparison.estimatedMinutes,
  };
}
