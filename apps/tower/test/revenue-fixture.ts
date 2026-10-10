import type { RevenueHolidayCalendar } from '@noticeos/contract';
import type { WorkspaceStore } from '@noticeos/postgres';
import { writeMediavine } from './money';
import { type TestSignalValue, writeSignalRun } from './collected-metrics';
import { shiftRevenueDate } from '../shared/revenue-projection';
import { revenueHolidays } from '../worker/revenue-holidays';

/** The public holidays the synthetic history is shaped by, for `year`. */
export function syntheticRevenueHolidays(calendar: RevenueHolidayCalendar, year: number): Set<string> {
  return new Set(revenueHolidays(calendar, year).map(day => day.date));
}

/** One synthetic day: 1,000 sessions on a weekday, 100 at the weekend, a
 * tenth of that on a holiday, earning 2¢ a session. The one definition of the
 * fixture's traffic and money, so a check can derive what a report or a
 * projection over it should say instead of copying a number. */
export function syntheticRevenueDay(date: string, holidays: ReadonlySet<string>): { sessions: number; amountMinor: number } {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const sessions = (weekday === 0 || weekday === 6 ? 100 : 1000) * (holidays.has(date) ? 0.1 : 1);
  return { sessions, amountMinor: sessions * 2 };
}

/** Synthetic daily traffic and money for SQL and browser checks, in `store`:
 * Mediavine's daily revenue and GA4's sessions and active users; the site
 * must be there first. `traffic: false` seeds the money alone, a site whose
 * first source is ad revenue. */
export async function seedRevenueHistory(store: WorkspaceStore, asset: string, at: string, through: string,
  calendar: RevenueHolidayCalendar = 'none', { traffic = true }: { traffic?: boolean } = {}) {
  const start = shiftRevenueDate(through, -83);
  const holidays = syntheticRevenueHolidays(calendar, Number(through.slice(0, 4)));
  const days: [string, number][] = [];
  const sessions: TestSignalValue[] = [];
  for (let date = start; date <= through; date = shiftRevenueDate(date, 1)) {
    const day = syntheticRevenueDay(date, holidays);
    days.push([date, day.amountMinor]);
    for (const metric of ['sessions', 'active_users']) sessions.push({ date, metric, value: day.sessions });
  }
  await writeMediavine(store, [{ id: 'forecast-revenue', asset, siteId: 'forecast-site', start, end: through, attemptedAt: at, days, recordedAt: at }]);
  if (traffic) {
    await writeSignalRun(store, {
      id: 'forecast-traffic', asset, integration: 'ga4', credentialRef: 'synthetic', propertyRef: '123456', finishedAt: at,
      windowStart: start, windowEnd: through, providerRows: 84, observationCount: 168,
    }, sessions);
  }
}
