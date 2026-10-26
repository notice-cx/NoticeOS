import type { Ga4RealtimeAsset } from "@noticeos/contract";
import type { AssetCard } from "@shared/wall";
import { revenueCalendarDate } from "@shared/daily-revenue";
import { offsetCalendarDate } from "./intraday-pace";
import { completedRealtimeMinutes, currentRealtimeDay } from "./realtime-day";

/** Daily distinct users come only from an exact daily observation, never summed activity buckets. */
export function todayUserCounts(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number) {
  const activityZone = currentRealtimeDay(snapshot, nowMs)?.timeZone ?? (snapshot?.status === "success" ? snapshot.timeZone : null);
  const timeZone = asset.activeUsers.timeZone ?? null;
  let date: string | null = null;
  try { if (timeZone) date = revenueCalendarDate(new Date(nowMs), timeZone); } catch { date = null; }
  let activityDate: string | null = null;
  try { if (activityZone) activityDate = revenueCalendarDate(new Date(nowMs), activityZone); } catch { activityDate = null; }
  const referenceDate = date ? offsetCalendarDate(date, -7) : null;
  const daily = new Map([...(asset.activeUsers.contextSeries ?? []), ...asset.activeUsers.series].map(point => [point.t, point.v]));
  const count = (day: string | null) => { const value = day ? daily.get(day) : null; return value != null && Number.isFinite(value) && value >= 0 ? value : null; };
  return { date, referenceDate, timeZone, today: count(date), reference: count(referenceDate), activityDateMatches: date !== null && activityDate === date };
}

/** Convert activity to an approximate user count using last week's measured
 * users per user-minute. Missing current minutes follow last week's profile,
 * scaled by activity on matching minutes, rather than counting gaps as zero. */
export function estimatedTodayUsers(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number) {
  const daily = todayUserCounts(asset, snapshot, nowMs);
  const day = currentRealtimeDay(snapshot, nowMs);
  if (!day || day.timeZone !== daily.timeZone || day.date !== daily.date || daily.reference === null || daily.reference <= 0) return null;
  if (asset.activeUsers.timeZoneChanges.some(change => change.effectiveOn > daily.referenceDate! && change.effectiveOn <= day.date)) return null;
  // Clock-aligned comparison arrays omit/repeat minutes across a DST change,
  // so they cannot calibrate against a full daily distinct-user observation.
  const offsets = new Intl.DateTimeFormat('en-US', { timeZone: day.timeZone, timeZoneName: 'longOffset' });
  const offset = (at: number) => offsets.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
  const start = Date.parse(day.startAt);
  if (offset(start) !== offset(start - 7 * 86_400_000) || offset(start) !== offset(Date.parse(day.endAt) - 1)) return null;
  const prior = day.sameDayLastWeek;
  const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
  // A full-day calibration cannot use an incomplete or DST-ambiguous baseline.
  if (!prior || prior.length !== day.minutes.length || !prior.every(valid)) return null;
  const baseline = prior.reduce((sum, value) => sum + value, 0);
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
  };
}
