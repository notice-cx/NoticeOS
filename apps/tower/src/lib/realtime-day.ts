import type { Ga4RealtimeAsset, Ga4RealtimeDay } from '@noticeos/contract';
import { revenueCalendarDate } from '@shared/daily-revenue';
import { calendarDayStart, calendarOffset } from '@shared/reporting-calendar';

/** A saved previous day is never a chart labelled Today. */
export function currentRealtimeDay(snapshot: Ga4RealtimeAsset | undefined, nowMs: number, displayTimeZone?: string): Ga4RealtimeDay | null {
  if (snapshot?.status !== 'success' || !snapshot.realtimeDay) return null;
  const day = snapshot.realtimeDay;
  try {
    if (day.date !== revenueCalendarDate(new Date(nowMs), day.timeZone)) return null;
    if (!displayTimeZone || displayTimeZone === day.timeZone) return day;
    const date = revenueCalendarDate(new Date(nowMs), displayTimeZone);
    const start = calendarDayStart(date, displayTimeZone), end = calendarDayStart(calendarOffset(date, 1), displayTimeZone);
    const length = (end - start) / 60_000;
    const shift = (start - Date.parse(day.startAt)) / 60_000;
    const minutes = Array.from({ length }, (_, index) => day.minutes[index + shift] ?? null);
    const sameDayLastWeek = day.sameDayLastWeek ? Array.from({ length }, (_, index) => day.sameDayLastWeek![index + shift] ?? null) : null;
    return { ...day, date, timeZone: displayTimeZone, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), minutes, sameDayLastWeek };
  } catch { return null; }
}

/** Plot completed minutes only: the current partial minute would look like a
 * traffic drop. Missing reports break a line; they never become zero. */
export function completedRealtimeMinutes(day: Ga4RealtimeDay, nowMs: number): (number | null)[] {
  const completed = Math.floor((nowMs - Date.parse(day.startAt)) / 60_000);
  return day.minutes.map((value, index) => index < completed ? value : null);
}

/** Historical gaps, including repeated DST minutes, use mean observed activity. */
export function realtimeComparison(day: Ga4RealtimeDay) {
  const prior = day.sameDayLastWeek;
  if (!prior || prior.length !== day.minutes.length) return null;
  const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
  const known = prior.filter(valid);
  if (!known.length) return null;
  const average = known.reduce((sum, value) => sum + value, 0) / known.length;
  return { minutes: prior.map(value => valid(value) ? value : average), estimatedMinutes: prior.length - known.length };
}

/** Hourly means of minute activity, never hourly distinct users. An hour with
 * paired observations uses exactly the same minutes for both plotted means. */
export function realtimeActivity(day: Ga4RealtimeDay, nowMs: number) {
  const minutes = completedRealtimeMinutes(day, nowMs);
  const comparison = realtimeComparison(day);
  const start = Date.parse(day.startAt);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: day.timeZone, hour: '2-digit', hourCycle: 'h23' });
  const buckets = Array.from({ length: 24 }, () => ({ today: [] as number[], prior: [] as number[], pairedToday: [] as number[], pairedPrior: [] as number[] }));
  let todaySum = 0, priorSum = 0, comparedMinutes = 0, through = -1;
  for (let index = 0; index < minutes.length; index++) {
    const hour = Number(clock.format(start + index * 60_000));
    const bucket = buckets[hour]!;
    const today = minutes[index] ?? null, prior = comparison?.minutes[index] ?? null;
    if (today !== null) bucket.today.push(today);
    if (prior !== null) bucket.prior.push(prior);
    if (today !== null && prior !== null) {
      bucket.pairedToday.push(today); bucket.pairedPrior.push(prior);
      todaySum += today; priorSum += prior; comparedMinutes++; through = index;
    }
  }
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    hours: buckets.map((bucket, hour) => ({ hour,
      today: mean(bucket.pairedToday.length ? bucket.pairedToday : bucket.today),
      prior: mean(bucket.pairedPrior.length ? bucket.pairedPrior : bucket.prior),
      observedMinutes: bucket.today.length })),
    comparedMinutes,
    estimatedComparisonMinutes: comparison?.estimatedMinutes ?? 0,
    change: comparedMinutes >= 15 && priorSum >= 100 ? (todaySum / priorSum - 1) * 100 : null,
    through: through < 0 ? null : new Date(start + (through + 1) * 60_000).toISOString(),
    hasPrior: comparison !== null,
  };
}
