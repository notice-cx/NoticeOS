// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatClock, formatNextRun, localTimezoneLabel, localScheduleFields, nextCollectionRun, scheduleLabel, utcRunReference } from '@shared/scheduled-jobs';

describe('viewer-local workflow times', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  it('converts dates and weekdays across midnight and keeps an exact UTC reference', () => {
    expect(formatNextRun('2026-09-10T04:00:00Z', 'America/Los_Angeles')).toBe('Wed, Sep 9, 21:00');
    expect(utcRunReference('2026-09-10T04:00:00Z')).toBe('Thu, Sep 10, 04:00 UTC');
    expect(scheduleLabel('0 4 * * 4', 'UTC', now, 'America/Los_Angeles')).toBe('Wednesday at 21:00');
    expect(localScheduleFields('0 4 * * 4', 'UTC', 'America/Los_Angeles', now)).toEqual({ time: '21:00', minute: '0', weekday: '3' });
  });
  it('handles non-whole-hour offsets without losing the minute', () => {
    expect(scheduleLabel('5 * * * *', 'UTC', now, 'Asia/Kathmandu')).toBe('Hourly at :50');
    expect(scheduleLabel('10,30,50 * * * *', 'UTC', now, 'Asia/Kolkata')).toBe('Hourly at :40, :00, :20');
    expect(scheduleLabel('5 * * * *', 'Asia/Kathmandu', now, 'America/Los_Angeles')).toBe('Hourly at :20');
  });
  it('keeps an existing UTC schedule fixed while locally saved timing follows daylight saving', () => {
    const afterDst = Date.parse('2026-11-02T12:00:00Z');
    expect(localTimezoneLabel(now, 'America/Los_Angeles')).toBe('PDT');
    expect(localTimezoneLabel(afterDst, 'America/Los_Angeles')).toBe('PST');
    expect(scheduleLabel('0 4 * * *', 'UTC', afterDst, 'America/Los_Angeles')).toBe('Daily at 20:00');
    expect(scheduleLabel('0 21 * * *', 'America/Los_Angeles', afterDst, 'America/Los_Angeles')).toBe('Daily at 21:00');
  });
  /* Formatters are built once per option set and reused, so a reused one must
     still honour each call's own zone and instant. */
  it('gives the same answers when a formatter is reused across zones and instants', () => {
    expect(formatClock('2026-09-10T04:30:00Z', 'America/Los_Angeles')).toBe('21:30');
    expect(formatClock('2026-09-10T04:30:00Z', 'UTC')).toBe('04:30');
    expect(formatClock(Date.parse('2026-09-10T05:00:00Z'), 'Asia/Kolkata')).toBe('10:30');
    expect(formatNextRun('2026-09-10T04:00:00Z', 'UTC')).toBe('Thu, Sep 10, 04:00');
    expect(formatNextRun('2026-09-10T04:00:00Z', 'America/Los_Angeles')).toBe('Wed, Sep 9, 21:00');
    expect(localTimezoneLabel(now, 'America/Los_Angeles')).toBe('PDT');
    expect(localTimezoneLabel(now, 'UTC')).toBe('UTC');
  });
});

/* A newly mapped source's row names when its collection next runs: the saved
   schedule of the one job that collects its provider, never a guess. */
describe('the next run of the collection behind a provider', () => {
  const now = Date.parse('2026-09-09T12:07:00Z');
  it('reads the job that collects the provider, on its default schedule', () => {
    expect(nextCollectionRun('google', null, now)).toBe('2026-09-09T12:15:00.000Z');
    expect(nextCollectionRun('mediavine', {}, now)).toBe('2026-09-09T12:10:00.000Z');
  });
  it('follows a saved schedule in its own timezone', () => {
    const saved = { counters: { enabled: true, cron: '0 4 * * *', timezone: 'America/Los_Angeles' } };
    expect(nextCollectionRun('google', saved, now)).toBe('2026-09-10T11:00:00.000Z');
  });
  it('has no next run for a paused schedule or a provider no job collects', () => {
    expect(nextCollectionRun('google', { counters: { enabled: false, cron: '*/15 * * * *' } }, now)).toBeNull();
    expect(nextCollectionRun('example-provider', null, now)).toBeNull();
  });
});
