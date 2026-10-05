import Holidays from 'date-holidays';
import type { RevenueHolidayCalendar } from '@noticeos/contract';
import type { RevenueHoliday } from '../shared/revenue-projection';

// Calendar dates come from the maintained date-holidays dataset. No traffic
// multipliers or asset-specific behavior are supplied by this module.
const calendars = new Map<string, RevenueHoliday[]>();
export function revenueHolidays(calendar: RevenueHolidayCalendar | undefined, year: number): RevenueHoliday[] {
  if (!calendar || calendar === 'none') return [];
  const key = `${calendar}:${year}`;
  const cached = calendars.get(key);
  if (cached) return cached;
  const days = new Map<string, string>();
  for (const country of calendar.split(',')) {
    const holidays = new Holidays(country, { types: ['public'], languages: 'en' });
    for (const y of [year - 1, year]) {
      for (const holiday of holidays.getHolidays(y)) {
        days.set(holiday.date.slice(0, 10), holiday.name.replace(/ \(substitute day\)$/i, ''));
      }
    }
  }
  const result = [...days].map(([date, name]) => ({ date, name }));
  if (calendars.size >= 6) calendars.delete(calendars.keys().next().value!);
  calendars.set(key, result);
  return result;
}
