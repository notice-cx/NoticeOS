export * from '../../../scripts/scheduled-jobs.mjs';
import { SCHEDULED_JOBS, type ScheduleOverrides, type ScheduleStatus, type ScheduledJob } from '../../../scripts/scheduled-jobs.mjs';
import { Cron } from 'croner';

export interface ScheduledJobsPayload {
  overrides: ScheduleOverrides | null;
  runtime: ScheduleStatus | null;
  runtimeFresh: boolean;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The jobs that collect, whose schedule is changed with the collection rather
 * than in System health: `WORKFLOW_GROUPS`' "Business signals". Every other job
 * keeps its editor where it runs (System health or Workflows).
 */
export const COLLECTION_GROUP = 'Business signals';
export function isCollectionJob(job: { group: string }): boolean {
  return job.group === COLLECTION_GROUP;
}

/**
 * The collections a connection's Manage panel schedules. A collection no
 * connection feeds is scheduled in Settings → Data collection; the job's
 * declared `connections` decides which.
 */
export function connectionCollections(provider: string): ScheduledJob[] {
  return SCHEDULED_JOBS.filter((job) => isCollectionJob(job) && (job.connections ?? []).includes(provider));
}

/** The collections no connection feeds: Settings → Data collection's rows. */
export function settingsCollections(): ScheduledJob[] {
  return SCHEDULED_JOBS.filter((job) => isCollectionJob(job) && (job.connections ?? []).length === 0);
}

/**
 * Where a collection's schedule is changed, as a link: the Manage panel of the
 * first of its connections that is connected (`?connect=` opens it there), or
 * Settings → Data collection for one no connection feeds. Null for a
 * collection whose connections are all unconnected — nothing collects, so
 * there is no schedule to change.
 */
export function scheduleHref(job: ScheduledJob, connected: (provider: string) => boolean): string | null {
  const connections = job.connections ?? [];
  if (connections.length === 0) return '/settings#data-collection';
  const provider = connections.find(connected);
  return provider === undefined ? null : `/integrations?connect=${encodeURIComponent(provider)}`;
}

/** One `Intl.DateTimeFormat` per option set, reused: building one costs ~40x
 * using one, and the operations list formats hundreds of times per render. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let cached = FORMATTERS.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en', options);
    FORMATTERS.set(key, cached);
  }
  return cached;
}

/** The browser's zone, re-read at most once a minute, so a machine that
 * changes zone is followed without rebuilding a formatter on every call. */
let zone: { name: string; at: number } | null = null;
export function localTimezone(): string {
  const now = Date.now();
  if (!zone || Math.abs(now - zone.at) > 60_000) zone = { name: Intl.DateTimeFormat().resolvedOptions().timeZone, at: now };
  return zone.name;
}
export function localTimezoneLabel(value: string | number = Date.now(), timeZone = localTimezone()): string { return formatter({ timeZone, timeZoneName: 'short' }).formatToParts(new Date(value)).find((part) => part.type === 'timeZoneName')?.value ?? localTimezone(); }

/** Hour and minute on a 24-hour clock, in `timeZone`. */
export function formatClock(value: string | number, timeZone = localTimezone()): string {
  return formatter({ timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function scheduleLabel(cron: string, timezone = 'UTC', now = Date.now(), displayTimezone = localTimezone()): string {
  const [minute, hour, , , day] = cron.split(' ');
  if (minute === '*' && hour === '*' && day === '*') return 'Every minute';
  if (minute?.startsWith('*/') && hour === '*' && day === '*') return `Every ${minute.slice(2)} minutes`;
  const timer = new Cron(cron, { timezone, paused: true });
  const next = timer.nextRun(new Date(now));
  timer.stop();
  if (!next) return 'No upcoming run';
  const parts = formatter({ timeZone: displayTimezone, hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23' }).formatToParts(next);
  const part = (kind: string) => parts.find((value) => value.type === kind)?.value;
  if (hour === '*' && day === '*') {
    const shift = Number(part('minute')) - next.getUTCMinutes();
    // Resolve each minute through the schedule's timezone; half-hour and
    // quarter-hour offsets must not be rounded to an hour.
    const localMinutes = minute!.split(',').map((value) => {
      const tick = new Cron(`${value} * * * *`, { timezone, paused: true });
      const date = tick.nextRun(new Date(now)); tick.stop();
      return date ? String((date.getUTCMinutes() + shift + 60) % 60).padStart(2, '0') : value;
    });
    return `Hourly at :${localMinutes.join(', :')}`;
  }
  if (!/^\d+$/.test(hour ?? '') || !/^\d+$/.test(minute ?? '')) return 'Custom schedule';
  const time = `${part('hour')}:${part('minute')}`;
  if (day === '*') return `Daily at ${time}`;
  if (WEEKDAYS[Number(day)]) return `${part('weekday')} at ${time}`;
  return 'Custom schedule';
}

export function formatNextRun(value: string, timeZone = localTimezone()): string {
  return formatter({
    timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

export function utcRunReference(value: string): string { return `${formatNextRun(value, 'UTC')} UTC`; }

export function localScheduleFields(cron: string, timezone: string, displayTimezone = localTimezone(), now = Date.now()) {
  const timer = new Cron(cron, { timezone, paused: true });
  const next = timer.nextRun(new Date(now)); timer.stop();
  const parts = formatter({ timeZone: displayTimezone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(next ?? new Date(now));
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value ?? '00';
  return { time: `${get('hour')}:${get('minute')}`, minute: String(Number(get('minute'))), weekday: String(WEEKDAYS.indexOf(get('weekday'))) };
}
