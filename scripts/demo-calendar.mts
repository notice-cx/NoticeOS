// The public demo's synthetic work calendar for the Wall's strip: one feed
// holding the fictional operator's fixed weekly schedule, in UTC, answered in
// the ordinary calendar read's shape and window. Display data only, as the
// demo's live traffic is: no feed is fetched and nothing is written.
import { demoScenarioHash, generateDemoScenario, shiftDemoDay, type DemoScenario } from './demo-scenario.mjs';
import { demoCountdown } from './demo-display.mjs';
import type { CalendarUpcoming, UpcomingMeeting } from '../packages/contract/src/calendar-upcoming.js';

/** The ordinary read's window and cap (workers/ingest/src/calendar.ts). */
const WINDOW_MS = 48 * 3_600_000, LIMIT = 20;
const FEED = 'Work';

/** A weekly slot: UTC weekdays (Sunday 0), start "HH:MM", length in minutes,
 * and a title naming the site by its prefix when it is about one. */
interface Slot { readonly days: readonly number[]; readonly start: string; readonly minutes: number; readonly title: string; readonly site?: string }
// Spread from a European morning to an American afternoon, so a visitor in
// either sees what is next.
const WEEK: readonly Slot[] = [
  { days: [2, 4], start: '08:00', minutes: 20, title: 'Morning metrics review' },
  { days: [1], start: '14:00', minutes: 45, title: 'Weekly portfolio review' },
  { days: [1, 2, 3, 4, 5], start: '16:00', minutes: 15, title: 'Daily check-in' },
  { days: [1], start: '20:30', minutes: 30, title: 'licensing call', site: 'pw' },
  { days: [2], start: '17:30', minutes: 45, title: 'holiday menu planning', site: 'wp' },
  { days: [2], start: '21:30', minutes: 30, title: 'customer interview', site: 'lb' },
  { days: [3], start: '15:00', minutes: 30, title: 'export roadmap', site: 'lb' },
  { days: [3], start: '19:00', minutes: 30, title: 'source-save follow-up', site: 'pw' },
  { days: [3], start: '21:00', minutes: 30, title: 'onboarding review', site: 'fr' },
  { days: [4], start: '18:00', minutes: 45, title: 'pricing plan', site: 'fr' },
  { days: [4], start: '21:00', minutes: 30, title: 'ad revenue check', site: 'wp' },
  { days: [5], start: '17:00', minutes: 30, title: 'Weekly numbers review' },
  { days: [5], start: '20:00', minutes: 30, title: 'Release notes' },
  { days: [6], start: '15:00', minutes: 120, title: 'recipe photo shoot', site: 'wp' },
  { days: [0], start: '18:00', minutes: 30, title: 'Week ahead planning' },
];

function refuse(): never { throw new Error('Demo calendar reading refused.'); }

/** Readings for one validated scenario; the same minute always reads the same. */
export function createDemoCalendar(input: DemoScenario): { read(nowMs: number): CalendarUpcoming } {
  const scenario = generateDemoScenario(input.manifest);
  if (demoScenarioHash(scenario) !== demoScenarioHash(input)) refuse();
  const names = new Map(scenario.assets.map(asset => [asset.prefix, asset.name]));
  const review = demoCountdown(scenario);
  const meeting = (title: string, startMs: number, minutes: number): UpcomingMeeting => ({ calendar: FEED, title,
    startsAt: new Date(startMs).toISOString(), endsAt: new Date(startMs + minutes * 60_000).toISOString(), allDay: false, location: null });
  return Object.freeze({
    read(nowMs: number): CalendarUpcoming {
      if (!Number.isFinite(nowMs)) refuse();
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const candidates: UpcomingMeeting[] = [];
      // Yesterday through two days ahead covers anything in progress and the whole window.
      for (let offset = -1; offset <= 2; offset++) {
        const date = shiftDemoDay(today, offset), weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
        for (const slot of WEEK.filter(entry => entry.days.includes(weekday))) {
          const title = slot.site ? `${names.get(slot.site) ?? refuse()} ${slot.title}` : slot.title;
          candidates.push(meeting(title, Date.parse(`${date}T${slot.start}:00.000Z`), slot.minutes));
        }
      }
      candidates.push(meeting(review.label, Date.parse(review.targetAt), 90));
      const meetings = candidates
        .filter(entry => { const start = Date.parse(entry.startsAt); return start >= nowMs ? start <= nowMs + WINDOW_MS : Date.parse(entry.endsAt) > nowMs; })
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.title.localeCompare(b.title))
        .slice(0, LIMIT);
      return { fetchedAt: new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString(), feedsConfigured: 1, feedsOk: 1,
        calendars: [{ id: FEED, color: null, status: 'ok' }], meetings };
    },
  });
}
