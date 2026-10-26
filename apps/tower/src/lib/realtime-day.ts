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

/** Hourly means of minute activity, never hourly distinct users. An hour with
 * paired observations uses exactly the same minutes for both plotted means. */
export function realtimeActivity(day: Ga4RealtimeDay, nowMs: number) {
  const minutes = completedRealtimeMinutes(day, nowMs);
  const start = Date.parse(day.startAt);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: day.timeZone, hour: '2-digit', hourCycle: 'h23' });
  const buckets = Array.from({ length: 24 }, () => ({ today: [] as number[], prior: [] as number[], pairedToday: [] as number[], pairedPrior: [] as number[] }));
  let todaySum = 0, priorSum = 0, comparedMinutes = 0, through = -1;
  let observedSum = 0, observedMinutes = 0;
  for (let index = 0; index < minutes.length; index++) {
    const hour = Number(clock.format(start + index * 60_000));
    const bucket = buckets[hour]!;
    const today = minutes[index] ?? null, prior = day.sameDayLastWeek?.[index] ?? null;
    if (today !== null) {
      bucket.today.push(today);
      observedSum += today; observedMinutes++;
    }
    if (prior !== null) bucket.prior.push(prior);
    if (today !== null && prior !== null) {
      bucket.pairedToday.push(today); bucket.pairedPrior.push(prior);
      todaySum += today; priorSum += prior; comparedMinutes++; through = index;
    }
  }
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    todayAverage: observedMinutes ? observedSum / observedMinutes : null,
    // Both comparison figures cover the same minutes as the pace percentage.
    pairedTodayAverage: comparedMinutes ? todaySum / comparedMinutes : null,
    priorAverage: comparedMinutes ? priorSum / comparedMinutes : null,
    observedMinutes,
    hours: buckets.map((bucket, hour) => ({ hour,
      today: mean(bucket.pairedToday.length ? bucket.pairedToday : bucket.today),
      prior: mean(bucket.pairedPrior.length ? bucket.pairedPrior : bucket.prior),
      observedMinutes: bucket.today.length })),
    comparedMinutes,
    change: comparedMinutes >= 15 && priorSum >= 100 ? (todaySum / priorSum - 1) * 100 : null,
    through: through < 0 ? null : new Date(start + (through + 1) * 60_000).toISOString(),
    hasPrior: day.sameDayLastWeek?.some(value => value !== null) ?? false,
  };
}
