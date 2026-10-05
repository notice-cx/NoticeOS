import { distortedByTimeZoneChange, type SignalTrend } from './wall';

const DAY = 86_400_000;
export const REVENUE_HISTORY_DAYS = 84;
export interface RevenueDay { date: string; amountMinor: number }
export interface RevenueHoliday { date: string; name: string }
/** A declared source contract, never inferred from an operator preference. */
export interface RevenueReportingClock { readonly timeZone: string; readonly readyAfterMinute: number }
export interface RevenueProjection {
  period: string;
  status: 'ready' | 'no-revenue' | 'waiting-revenue' | 'waiting-traffic' | 'insufficient-history' | 'unmatched-traffic';
  reason: string | null;
  reportedThrough: string | null;
  earnedMinor: number | null;
  projectedMinor: number | null;
  dailyPaceMinor: number | null;
  previousPeriod: string;
  previousMonthMinor: number | null;
  changePercent: number | null;
  historyDays: number;
  holidayHistoryDays: number;
  points: { date: string; cumulativeMinor: number; projected: boolean }[];
}
export const shiftRevenueDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  for (let date = start; date <= end; date = shiftRevenueDate(date, 1)) result.push(date);
  return result;
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Where the source's clock stands: the calendar day `now` falls on in
 * `timeZone`, and minutes since that day's midnight. */
function revenueClock(now: Date, timeZone: string): { today: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return { today: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

/** The newest day a complete daily revenue report is expected for at `now`:
 * yesterday once the declared source cutoff passes, the day before until then.
 * There is no universal provider zone or readiness cutoff. */
export function revenueExpectedThrough(now: Date, clock: RevenueReportingClock): string {
  if (!Number.isInteger(clock.readyAfterMinute) || clock.readyAfterMinute < 0 || clock.readyAfterMinute >= 1440) {
    throw new Error('A declared revenue-report readiness cutoff is required.');
  }
  const { today, minutes } = revenueClock(now, clock.timeZone);
  return shiftRevenueDate(today, minutes >= clock.readyAfterMinute ? -1 : -2);
}

/** A stored-data forecast, never a financial-ledger row. Weekday traffic uses
 * the latest four occurrences, weighted 4/3/2/1. Earnings use the median rate
 * of up to seven nearest traffic days in the last eight weeks.
 *
 * `clock` is the source's explicit reporting contract (D42). It decides which
 * month is projected and which reports are expected; ledger booking periods
 * and ordinary timestamps remain independent. */
export function projectRevenue(now: Date, clock: RevenueReportingClock, revenue: RevenueDay[], traffic: SignalTrend, holidays: RevenueHoliday[] = []): RevenueProjection {
  const { today } = revenueClock(now, clock.timeZone);
  const period = today.slice(0, 7);
  const monthStart = `${period}-01`;
  const previousEnd = shiftRevenueDate(monthStart, -1);
  const previousPeriod = previousEnd.slice(0, 7);
  const monthEnd = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0, 12)).toISOString().slice(0, 10);
  const expectedThrough = revenueExpectedThrough(now, clock);
  const historyStart = shiftRevenueDate(today, -REVENUE_HISTORY_DAYS);
  const days = new Map(revenue.filter(day => day.date >= historyStart && day.date <= expectedThrough && Number.isSafeInteger(day.amountMinor)).map(day => [day.date, day.amountMinor]));
  const reportedThrough = [...days.keys()].sort().at(-1) ?? null;
  const currentDates = dateRange(monthStart, reportedThrough ?? previousEnd);
  const completeCurrent = currentDates.every(date => days.has(date));
  const earnedMinor = currentDates.length > 0 && completeCurrent ? currentDates.reduce((sum, date) => sum + days.get(date)!, 0) : null;
  const previousDates = dateRange(`${previousPeriod}-01`, previousEnd);
  const previousMonthMinor = previousDates.every(date => days.has(date)) ? previousDates.reduce((sum, date) => sum + days.get(date)!, 0) : null;
  const base: RevenueProjection = { period, status: 'no-revenue', reason: 'Connect a daily revenue source.', reportedThrough, earnedMinor, projectedMinor: null, dailyPaceMinor: null, previousPeriod, previousMonthMinor, changePercent: null, historyDays: 0, holidayHistoryDays: 0, points: [] };
  if (!reportedThrough) return base;
  if (reportedThrough < expectedThrough || !completeCurrent) return { ...base, status: 'waiting-revenue', reason: 'Waiting for complete revenue reports.' };
  if (!traffic.collectedAt || !Number.isFinite(Date.parse(traffic.collectedAt)) || now.getTime() - Date.parse(traffic.collectedAt) > 2 * DAY || Date.parse(traffic.collectedAt) > now.getTime()) return { ...base, status: 'waiting-traffic', reason: 'Waiting for a fresh traffic report.' };
  const sessions = new Map([...(traffic.contextSeries ?? []), ...traffic.series]
    .filter(point => point.t >= historyStart && point.t < today && (traffic.provisionalFrom === null || point.t < traffic.provisionalFrom) && Number.isFinite(point.v) && point.v >= 0 && !distortedByTimeZoneChange(traffic.timeZoneChanges, point.t))
    .map(point => [point.t, point.v]));
  const latestTraffic = [...sessions.keys()].sort().at(-1);
  // GA4 keeps a day provisional until it is collected at D+2 (bead `ro-wo0j`),
  // so yesterday's traffic may still be settling when yesterday's revenue is in.
  // Traffic only feeds the rate history and weekday pattern, both from final
  // days, so one settling day is accepted — only when the provider marks it
  // provisional; a stalled collector still waits (bead `ro-eqda`).
  const trafficThrough = traffic.provisionalFrom !== null && traffic.provisionalFrom <= expectedThrough ? shiftRevenueDate(expectedThrough, -1) : expectedThrough;
  if (!latestTraffic || latestTraffic < trafficThrough) return { ...base, status: 'waiting-traffic', reason: 'Waiting for complete traffic days.' };
  const matched = [...days].flatMap(([date, amountMinor]) => {
    const count = sessions.get(date);
    return date >= shiftRevenueDate(today, -56) && count !== undefined && count > 0 && amountMinor >= 0 ? [{ date, sessions: count, rate: amountMinor / count }] : [];
  });
  base.historyDays = matched.length;
  if (matched.length < 21) return { ...base, status: 'insufficient-history', reason: `Learning from traffic and revenue · ${matched.length}/21 days.` };
  const holidayDates = new Set(holidays.map(holiday => holiday.date));
  const holidaySamples = holidays.flatMap(holiday => {
    const count = sessions.get(holiday.date);
    if (count === undefined) return [];
    const neighbours = [...sessions].filter(([date]) => !holidayDates.has(date) && weekday(date) === weekday(holiday.date) && date >= shiftRevenueDate(holiday.date, -28) && date <= shiftRevenueDate(holiday.date, 28)).map(([, value]) => value);
    const baseline = neighbours.length >= 3 ? median(neighbours) : 0;
    return baseline > 0 ? [{ name: holiday.name, ratio: count / baseline }] : [];
  });
  base.holidayHistoryDays = holidaySamples.length;
  const holidayRatio = new Set(holidaySamples.map(day => day.name)).size >= 2 ? median(holidaySamples.map(day => day.ratio)) : null;
  const pattern = Array.from({ length: 7 }, (_, day) => [...sessions]
    .filter(([date]) => date >= shiftRevenueDate(today, -28) && weekday(date) === day && !holidayDates.has(date))
    .sort(([a], [b]) => b.localeCompare(a)).slice(0, 4));
  if (pattern.some(points => points.length < 2)) return { ...base, status: 'waiting-traffic', reason: 'Need two complete traffic weeks.' };
  let cumulativeMinor = 0;
  let futureMinor = 0;
  let futureDays = 0;
  const points: RevenueProjection['points'] = [];
  for (const date of dateRange(monthStart, monthEnd)) {
    const recorded = days.get(date);
    if (date <= reportedThrough && recorded !== undefined) {
      cumulativeMinor += recorded;
      points.push({ date, cumulativeMinor, projected: false });
      continue;
    }
    const prior = pattern[weekday(date)]!;
    const weight = prior.reduce((sum, _, index) => sum + 4 - index, 0);
    if (holidayDates.has(date) && !sessions.has(date) && holidayRatio === null) return { ...base, status: 'insufficient-history', reason: 'Need more holiday traffic history for this month.' };
    const predictedSessions = sessions.get(date) ?? (prior.reduce((sum, [, value], index) => sum + value * (4 - index), 0) / weight) * (holidayDates.has(date) ? holidayRatio! : 1);
    // Refuse extrapolation far outside observed traffic volumes. A missing
    // comparable day is not zero earnings; neither is missing provider data.
    const similar = matched.filter(day => day.sessions >= predictedSessions / 2 && day.sessions <= predictedSessions * 2)
      .sort((a, b) => Math.abs(Math.log(a.sessions / predictedSessions)) - Math.abs(Math.log(b.sessions / predictedSessions)) || b.date.localeCompare(a.date)).slice(0, 7);
    if (predictedSessions > 0 && similar.length < 3) return { ...base, status: 'unmatched-traffic', reason: 'Recent traffic is outside the revenue history.' };
    const estimate = predictedSessions === 0 ? 0 : Math.round(predictedSessions * median(similar.map(day => day.rate)));
    cumulativeMinor += estimate;
    futureMinor += estimate;
    futureDays++;
    points.push({ date, cumulativeMinor, projected: true });
  }
  return { ...base, status: 'ready', reason: null, projectedMinor: cumulativeMinor, dailyPaceMinor: futureDays ? Math.round(futureMinor / futureDays) : 0,
    changePercent: previousMonthMinor !== null && previousMonthMinor > 0 ? (cumulativeMinor / previousMonthMinor - 1) * 100 : null, points };
}
