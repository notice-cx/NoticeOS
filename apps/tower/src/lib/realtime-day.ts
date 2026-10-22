import type { Ga4RealtimeAsset, Ga4RealtimeDay } from '@noticeos/contract';
import { revenueCalendarDate } from '@shared/daily-revenue';

/** A saved previous day is never a chart labelled Today. */
export function currentRealtimeDay(snapshot: Ga4RealtimeAsset | undefined, nowMs: number): Ga4RealtimeDay | null {
  if (snapshot?.status !== 'success' || !snapshot.realtimeDay) return null;
  const day = snapshot.realtimeDay;
  try {
    return day.date === revenueCalendarDate(new Date(nowMs), day.timeZone) ? day : null;
  } catch { return null; }
}

/** Plot completed minutes only: the current partial minute would look like a
 * traffic drop. Missing reports break a line; they never become zero. */
export function completedRealtimeMinutes(day: Ga4RealtimeDay, nowMs: number): (number | null)[] {
  const completed = Math.floor((nowMs - Date.parse(day.startAt)) / 60_000);
  return day.minutes.map((value, index) => index < completed ? value : null);
}
