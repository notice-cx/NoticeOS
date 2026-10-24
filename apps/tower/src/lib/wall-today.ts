import type { Ga4RealtimeAsset } from "@noticeos/contract";
import type { AssetCard } from "@shared/wall";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { offsetCalendarDate } from "./intraday-pace";
import { currentRealtimeDay } from "./realtime-day";

/** Daily distinct users come only from an exact daily observation, never summed activity buckets. */
export function todayUserCounts(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number) {
  const activityZone = currentRealtimeDay(snapshot, nowMs)?.timeZone ?? (snapshot?.status === "success" ? snapshot.timeZone : null);
  const timeZone = asset.activeUsers.timeZone ?? activityZone;
  let date: string | null = null;
  try { if (timeZone) date = revenueCalendarDate(new Date(nowMs), timeZone); } catch { date = null; }
  let activityDate: string | null = null;
  try { if (activityZone) activityDate = revenueCalendarDate(new Date(nowMs), activityZone); } catch { activityDate = null; }
  const referenceDate = date ? offsetCalendarDate(date, -7) : null;
  const daily = new Map([...(asset.activeUsers.contextSeries ?? []), ...asset.activeUsers.series].map(point => [point.t, point.v]));
  const count = (day: string | null) => { const value = day ? daily.get(day) : null; return value != null && Number.isFinite(value) && value >= 0 ? value : null; };
  return { date, referenceDate, timeZone, today: count(date), reference: count(referenceDate), activityDateMatches: date !== null && activityDate === date };
}
