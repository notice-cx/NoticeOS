// The calendar RPC's contract: what the Wall is shown, and what the Tower can
// never be handed. Two things are pinned: the wall-clock-to-instant arithmetic
// across both DST transitions, and the boundary — a secret ICS link reads the
// whole calendar for whoever holds it, so a failing feed must be reportable
// without the URL appearing in a single byte of output.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { exports as workerExports } from 'cloudflare:workers';
import { javascriptInstant, openWorkspaceStore } from '@noticeos/postgres';
import { putCredential, resolveCredential } from '../src/credentials.js';
import {
  CALENDAR_CACHE_TTL_MS,
  CALENDAR_USER_AGENT,
  calendarUpcoming as readCalendarUpcoming,
  CalendarReadError,
  parseIcsEvents,
} from '../src/calendar.js';
import { pgCount, storedCount, reset, asOwner } from './helpers.js';

/** The secret in these URLs is the point: no assertion may ever find it. */
const WORK_SECRET = 'w0rk-pr1vate-supersecret';
const WORK_URL = `https://calendar.google.com/calendar/ical/work%40example.test/private-${WORK_SECRET}/basic.ics`;
const PERSONAL_SECRET = 'h0me-pr1vate-supersecret';
const PERSONAL_URL = `https://calendar.google.com/calendar/ical/home%40example.test/private-${PERSONAL_SECRET}/basic.ics`;

const LA = 'America/Los_Angeles';

/** Monday, mid-morning UTC. The 48-hour window runs to Wednesday noon. */
const NOW = Date.parse('2026-08-10T12:00:00.000Z');

let testCache: Cache;
async function resetCalendarCache() {
  testCache = await caches.open(crypto.randomUUID());
  await asOwner("DELETE FROM noticeos.integration_leases WHERE lease_key LIKE 'calendar-read:%'");
}
beforeEach(async () => {
  await reset();
  await resetCalendarCache();
  vi.restoreAllMocks();
});
const calendarUpcoming: typeof readCalendarUpcoming = (ownedEnv, options = {}) =>
  readCalendarUpcoming(ownedEnv, { cache: testCache, ...options });

// --- fixtures ---------------------------------------------------------------

/** A whole calendar, CRLF-joined the way a feed actually arrives. */
function ics(...lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NoticeOS//calendar test//EN',
    ...lines,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function vevent(...lines: string[]): string[] {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

/** A timed LA event with a `SUMMARY`, half an hour long. */
function laEvent(uid: string, day: string, time: string, summary: string): string[] {
  return vevent(
    `UID:${uid}`,
    `DTSTART;TZID=${LA}:${day}T${time}00`,
    `DTEND;TZID=${LA}:${day}T${time}00`,
    `SUMMARY:${summary}`,
  );
}

/**
 * Only the isolated store and fixture encryption key come from the test pool.
 * Feed addresses are explicit synthetic inputs; no inherited provider binding
 * can cause a request to the operator's calendar.
 */
function feedEnv(feeds?: Record<string, string>): IngestEnv {
  return (feeds === undefined
    ? { NOTICEOS_WORKSPACE_PROFILE: 'standalone', STORE: env.STORE, CREDENTIALS_KEY: env.CREDENTIALS_KEY }
    : { NOTICEOS_WORKSPACE_PROFILE: 'standalone', STORE: env.STORE, CREDENTIALS_KEY: env.CREDENTIALS_KEY, CALENDAR_FEEDS: JSON.stringify(feeds) }) as unknown as IngestEnv;
}

type FeedReply = string | number | Error;

/**
 * Route feed url -> reply. A string is served as a calendar, a number as that
 * HTTP status, an Error is thrown at the transport level the way a dead uplink
 * or a DNS failure arrives.
 */
function feedFetch(replies: Record<string, FeedReply>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; userAgent: string | null }>;
} {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    calls.push({
      url,
      userAgent: new Headers(init?.headers ?? {}).get('user-agent'),
    });
    const reply = replies[url];
    if (reply === undefined) throw new Error(`unexpected fetch: ${url}`);
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') {
      return new Response('no', { status: reply });
    }
    return new Response(reply, {
      headers: { 'content-type': 'text/calendar; charset=utf-8' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** One work feed, one clock reading. */
async function upcoming(body: string, nowMs = NOW) {
  const { fetchImpl, calls } = feedFetch({ [WORK_URL]: body });
  const payload = await calendarUpcoming(feedEnv(), {
    nowMs,
    fetchImpl,
    rawFeeds: JSON.stringify({ work: WORK_URL }),
  });
  return { payload, calls };
}

/** What each meeting is, as one comparable string. */
function starts(payload: { meetings: Array<{ startsAt: string }> }): string[] {
  return payload.meetings.map((meeting) => meeting.startsAt);
}

// --- the parser -------------------------------------------------------------

describe('ICS parsing', () => {
  it('unfolds continuation lines by removing exactly one fold character', () => {
    // RFC 5545 folds with a break plus ONE space or tab, and that character
    // belongs to the folding, not to the value. Feeds fold at 75 octets without
    // caring where the words are, so a fold lands mid-word constantly: rejoining
    // with a space inserted would corrupt every long summary in the calendar. A
    // space that IS part of the value therefore arrives doubled. Both
    // continuation characters appear in the wild.
    const events = parseIcsEvents(
      ics(
        ...vevent(
          'UID:folded',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
          'SUMMARY:Quarterly plan',
          ' ning with the whole',
          '  team about the roadmap',
          '\t and the budget',
          'LOCATION:Conference room B',
        ),
      ),
      'work',
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe(
      'Quarterly planning with the whole team about the roadmap and the budget',
    );
    expect(events[0]?.location).toBe('Conference room B');
  });

  it('unescapes the punctuation ICS has to escape', () => {
    const events = parseIcsEvents(
      ics(
        ...vevent(
          'UID:escaped',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
          'SUMMARY:Budget\\, scope\\; and the C:\\\\ drive',
          'LOCATION:Line one\\nLine two',
        ),
      ),
      'work',
    );

    expect(events[0]?.title).toBe('Budget, scope; and the C:\\ drive');
    expect(events[0]?.location).toBe('Line one\nLine two');
  });

  it('reads all four date forms', () => {
    const events = parseIcsEvents(
      ics(
        'X-WR-TIMEZONE:America/Los_Angeles',
        ...vevent(
          'UID:zoned',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
          'SUMMARY:Zoned',
        ),
        ...vevent(
          'UID:utc',
          'DTSTART:20260811T163000Z',
          'DTEND:20260811T170000Z',
          'SUMMARY:UTC',
        ),
        ...vevent(
          'UID:floating',
          'DTSTART:20260811T090000',
          'DTEND:20260811T093000',
          'SUMMARY:Floating',
        ),
        ...vevent(
          'UID:allday',
          'DTSTART;VALUE=DATE:20260811',
          'DTEND;VALUE=DATE:20260812',
          'SUMMARY:All day',
        ),
      ),
      'work',
    );

    const byTitle = new Map(
      events.map((event) => [
        event.title,
        {
          startsAt: new Date(event.startMs).toISOString(),
          endsAt: new Date(event.endMs).toISOString(),
          allDay: event.allDay,
        },
      ]),
    );
    expect(byTitle.get('Zoned')).toEqual({
      startsAt: '2026-08-11T16:00:00.000Z',
      endsAt: '2026-08-11T16:30:00.000Z',
      allDay: false,
    });
    expect(byTitle.get('UTC')).toEqual({
      startsAt: '2026-08-11T16:30:00.000Z',
      endsAt: '2026-08-11T17:00:00.000Z',
      allDay: false,
    });
    // A floating time has no zone of its own, so it is read in the feed's.
    expect(byTitle.get('Floating')).toEqual({
      startsAt: '2026-08-11T16:00:00.000Z',
      endsAt: '2026-08-11T16:30:00.000Z',
      allDay: false,
    });
    // Midnight in the FEED's zone, and an exclusive end per DTEND semantics.
    expect(byTitle.get('All day')).toEqual({
      startsAt: '2026-08-11T07:00:00.000Z',
      endsAt: '2026-08-12T07:00:00.000Z',
      allDay: true,
    });
  });

  it('applies X-WR-TIMEZONE to events that appear before it', () => {
    // Nothing in the format promises the calendar's zone is declared before the
    // events that need it, so the document is read in two passes. A one-pass
    // parser resolves this all-day event against UTC and puts it on the wrong
    // calendar day for everyone west of Greenwich.
    const events = parseIcsEvents(
      ics(
        ...vevent(
          'UID:early-allday',
          'DTSTART;VALUE=DATE:20260811',
          'DTEND;VALUE=DATE:20260812',
          'SUMMARY:All day',
        ),
        'X-WR-TIMEZONE:America/Los_Angeles',
      ),
      'work',
    );
    expect(new Date(events[0]!.startMs).toISOString()).toBe(
      '2026-08-11T07:00:00.000Z',
    );
  });

  it('reads a floating time as UTC when the feed declares no timezone', () => {
    const events = parseIcsEvents(
      ics(
        ...vevent(
          'UID:floating-no-feed-zone',
          'DTSTART:20260811T090000',
          'DTEND:20260811T093000',
          'SUMMARY:Floating',
        ),
      ),
      'work',
    );
    expect(new Date(events[0]!.startMs).toISOString()).toBe(
      '2026-08-11T09:00:00.000Z',
    );
  });

  it('converts a zoned wall clock correctly on both sides of both DST transitions', () => {
    // 09:30 local, four times, two of them an hour either side of a transition.
    // US DST in 2026 begins Sunday 8 March and ends Sunday 1 November, so the
    // same wall clock is UTC-8 twice and UTC-7 twice. A conversion that added a
    // fixed offset — or read the offset at the wrong instant — gets two of these
    // four wrong.
    const events = parseIcsEvents(
      ics(
        ...laEvent('before-spring', '20260307', '0930', 'Before spring forward'),
        ...laEvent('after-spring', '20260309', '0930', 'After spring forward'),
        ...laEvent('before-fall', '20261031', '0930', 'Before fall back'),
        ...laEvent('after-fall', '20261102', '0930', 'After fall back'),
      ),
      'work',
    );

    expect(
      events.map((event) => [
        event.title,
        new Date(event.startMs).toISOString(),
      ]),
    ).toEqual([
      ['Before spring forward', '2026-03-07T17:30:00.000Z'],
      ['After spring forward', '2026-03-09T16:30:00.000Z'],
      ['Before fall back', '2026-10-31T16:30:00.000Z'],
      ['After fall back', '2026-11-02T17:30:00.000Z'],
    ]);
  });

  it('ignores the DTSTART lines inside VTIMEZONE and VALARM', () => {
    // A VTIMEZONE's transition rules are DTSTART lines, and an alarm has a
    // trigger. Neither is a meeting, and a parser that collects properties
    // without tracking the open component turns both into one.
    const events = parseIcsEvents(
      ics(
        'BEGIN:VTIMEZONE',
        `TZID:${LA}`,
        'BEGIN:DAYLIGHT',
        'DTSTART:19700308T020000',
        'TZOFFSETFROM:-0800',
        'TZOFFSETTO:-0700',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        ...vevent(
          'UID:with-alarm',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
          'SUMMARY:Real meeting',
          'BEGIN:VALARM',
          'TRIGGER:-PT10M',
          'ACTION:DISPLAY',
          'DESCRIPTION:Reminder',
          'END:VALARM',
        ),
      ),
      'work',
    );

    expect(events.map((event) => event.title)).toEqual(['Real meeting']);
  });

  it('refuses a 200 that is not a calendar at all', async () => {
    // A rotated link answers with an HTML sign-in page, status 200. Fetched is
    // not parsed, and only parsed earns the feed its `feedsOk`.
    const { payload } = await upcoming('<!doctype html><title>Sign in</title>');
    expect(payload.feedsConfigured).toBe(1);
    expect(payload.feedsOk).toBe(0);
    expect(payload.meetings).toEqual([]);
  });

  it('skips a cancelled event', async () => {
    const { payload } = await upcoming(
      ics(
        ...vevent(
          'UID:called-off',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
          'SUMMARY:Called off',
          'STATUS:CANCELLED',
        ),
        ...laEvent('still-on', '20260811', '1000', 'Still on'),
      ),
    );

    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Still on']);
  });

  it('falls back to a placeholder title rather than a blank one', async () => {
    const { payload } = await upcoming(
      ics(
        ...vevent(
          'UID:untitled',
          `DTSTART;TZID=${LA}:20260811T090000`,
          `DTEND;TZID=${LA}:20260811T093000`,
        ),
      ),
    );
    expect(payload.meetings[0]?.title).toBe('Busy');
    expect(payload.meetings[0]?.location).toBeNull();
  });
});

// --- recurrence -------------------------------------------------------------

describe('recurrence expansion', () => {
  it('holds a daily series to the same wall clock across a spring forward', async () => {
    // The 8th of March is the transition. 09:30 local is 17:30Z the day before
    // and 16:30Z the day after — the same meeting, two offsets. Adding 24 hours
    // of milliseconds per occurrence would report the second one an hour early.
    const body = ics(
      ...vevent(
        'UID:daily-standup',
        `DTSTART;TZID=${LA}:20260306T093000`,
        `DTEND;TZID=${LA}:20260306T094500`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
      ),
    );

    const { payload } = await upcoming(body, Date.parse('2026-03-07T12:00:00Z'));
    expect(starts(payload)).toEqual([
      '2026-03-07T17:30:00.000Z',
      '2026-03-08T16:30:00.000Z',
    ]);
  });

  it('holds a daily series to the same wall clock across a fall back', async () => {
    const body = ics(
      ...vevent(
        'UID:daily-standup',
        `DTSTART;TZID=${LA}:20261030T093000`,
        `DTEND;TZID=${LA}:20261030T094500`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
      ),
    );

    const { payload } = await upcoming(body, Date.parse('2026-10-31T12:00:00Z'));
    expect(starts(payload)).toEqual([
      '2026-10-31T16:30:00.000Z',
      '2026-11-01T17:30:00.000Z',
    ]);
  });

  it('skips the off weeks of a fortnightly BYDAY series', async () => {
    // Tuesdays and Thursdays, every OTHER week, from Tuesday 4 August.
    const body = ics(
      ...vevent(
        'UID:fortnightly',
        `DTSTART;TZID=${LA}:20260804T090000`,
        `DTEND;TZID=${LA}:20260804T093000`,
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH',
        'SUMMARY:Fortnightly sync',
      ),
    );

    // The Thursday of the DTSTART week is on.
    const first = await upcoming(body, Date.parse('2026-08-05T12:00:00Z'));
    expect(starts(first.payload)).toEqual(['2026-08-06T16:00:00.000Z']);

    // The Tuesday of the NEXT week is not — INTERVAL=2 skips that whole week.
    await resetCalendarCache();
    const off = await upcoming(body, Date.parse('2026-08-10T12:00:00Z'));
    expect(off.payload.meetings).toEqual([]);

    // And the week after that is on again.
    await resetCalendarCache();
    const third = await upcoming(body, Date.parse('2026-08-17T12:00:00Z'));
    expect(starts(third.payload)).toEqual(['2026-08-18T16:00:00.000Z']);
  });

  it('stops a series at COUNT, which includes the first occurrence', async () => {
    const body = ics(
      ...vevent(
        'UID:two-only',
        `DTSTART;TZID=${LA}:20260804T090000`,
        `DTEND;TZID=${LA}:20260804T093000`,
        'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2',
        'SUMMARY:Two Tuesdays',
      ),
    );

    // Occurrence two of two.
    const second = await upcoming(body, Date.parse('2026-08-10T12:00:00Z'));
    expect(starts(second.payload)).toEqual(['2026-08-11T16:00:00.000Z']);

    // There is no third.
    await resetCalendarCache();
    const third = await upcoming(body, Date.parse('2026-08-17T12:00:00Z'));
    expect(third.payload.meetings).toEqual([]);
  });

  it('stops a series at UNTIL', async () => {
    const body = ics(
      ...vevent(
        'UID:until-tomorrow',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        // Inclusive, and expressed as an instant: the 11th's 16:00Z occurrence
        // is past it by nine hours.
        'RRULE:FREQ=DAILY;UNTIL=20260811T070000Z',
        'SUMMARY:Ends soon',
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-10T16:00:00.000Z']);
  });

  it('drops the instances EXDATE names', async () => {
    const body = ics(
      ...vevent(
        'UID:with-exdate',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        `EXDATE;TZID=${LA}:20260811T090000`,
        'SUMMARY:Standup',
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-10T16:00:00.000Z']);
  });

  it('matches an EXDATE written as a UTC instant', async () => {
    // The same moment, spelled the other way. Occurrence identity is the
    // INSTANT, so both spellings drop the same instance.
    const body = ics(
      ...vevent(
        'UID:with-utc-exdate',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        'EXDATE:20260811T160000Z',
        'SUMMARY:Standup',
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-10T16:00:00.000Z']);
  });

  it('lets a RECURRENCE-ID override replace the instance it names', async () => {
    // A moved instance arrives as a second VEVENT sharing the UID. The rule must
    // not also produce the instance it stands in for, or the meeting shows twice
    // — once where it was and once where it is.
    const body = ics(
      ...vevent(
        'UID:standup',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
      ),
      ...vevent(
        'UID:standup',
        `RECURRENCE-ID;TZID=${LA}:20260811T090000`,
        `DTSTART;TZID=${LA}:20260811T110000`,
        `DTEND;TZID=${LA}:20260811T113000`,
        'SUMMARY:Standup (moved to 11)',
      ),
    );

    const { payload } = await upcoming(body);
    expect(
      payload.meetings.map((meeting) => [meeting.startsAt, meeting.title]),
    ).toEqual([
      ['2026-08-10T16:00:00.000Z', 'Standup'],
      ['2026-08-11T18:00:00.000Z', 'Standup (moved to 11)'],
    ]);
  });

  it('keeps an override that was retitled but not moved', async () => {
    // Its DTSTART still equals the instance it replaces, so the suppression that
    // stops the double-draw must not erase the override itself.
    const body = ics(
      ...vevent(
        'UID:standup',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
      ),
      ...vevent(
        'UID:standup',
        `RECURRENCE-ID;TZID=${LA}:20260811T090000`,
        `DTSTART;TZID=${LA}:20260811T090000`,
        `DTEND;TZID=${LA}:20260811T093000`,
        'SUMMARY:Standup (guest speaker)',
      ),
    );

    const { payload } = await upcoming(body);
    expect(
      payload.meetings.map((meeting) => [meeting.startsAt, meeting.title]),
    ).toEqual([
      ['2026-08-10T16:00:00.000Z', 'Standup'],
      ['2026-08-11T16:00:00.000Z', 'Standup (guest speaker)'],
    ]);
  });

  it('lets an override replace the series FIRST occurrence', async () => {
    // "This event, moved" on the first instance names DTSTART itself, so the
    // suppression has to reach the base occurrence and not just rule-generated
    // ones — otherwise the meeting shows at both its old and its new time.
    const body = ics(
      ...vevent(
        'UID:standup',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY;COUNT=2',
        'SUMMARY:Standup',
      ),
      ...vevent(
        'UID:standup',
        `RECURRENCE-ID;TZID=${LA}:20260810T090000`,
        `DTSTART;TZID=${LA}:20260810T133000`,
        `DTEND;TZID=${LA}:20260810T140000`,
        'SUMMARY:Standup (pushed to afternoon)',
      ),
    );

    const { payload } = await upcoming(body);
    expect(
      payload.meetings.map((meeting) => [meeting.startsAt, meeting.title]),
    ).toEqual([
      ['2026-08-10T20:30:00.000Z', 'Standup (pushed to afternoon)'],
      ['2026-08-11T16:00:00.000Z', 'Standup'],
    ]);
  });

  it('reads a cancelled override as the instance being called off', async () => {
    const body = ics(
      ...vevent(
        'UID:standup',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
      ),
      ...vevent(
        'UID:standup',
        `RECURRENCE-ID;TZID=${LA}:20260811T090000`,
        `DTSTART;TZID=${LA}:20260811T090000`,
        `DTEND;TZID=${LA}:20260811T093000`,
        'SUMMARY:Standup',
        'STATUS:CANCELLED',
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-10T16:00:00.000Z']);
  });

  it('expands a monthly series by month day', async () => {
    const body = ics(
      ...vevent(
        'UID:monthly-day',
        `DTSTART;TZID=${LA}:20260715T090000`,
        `DTEND;TZID=${LA}:20260715T093000`,
        'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
        'SUMMARY:Invoicing',
      ),
    );

    const { payload } = await upcoming(body, Date.parse('2026-08-14T12:00:00Z'));
    expect(starts(payload)).toEqual(['2026-08-15T16:00:00.000Z']);
  });

  it('expands a monthly series by ordinal weekday', async () => {
    // The second Tuesday: 14 July, then 11 August.
    const body = ics(
      ...vevent(
        'UID:monthly-ordinal',
        `DTSTART;TZID=${LA}:20260714T090000`,
        `DTEND;TZID=${LA}:20260714T093000`,
        'RRULE:FREQ=MONTHLY;BYDAY=2TU',
        'SUMMARY:Board meeting',
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-11T16:00:00.000Z']);
  });

  it('expands a monthly series counted from the end of the month', async () => {
    // The last Friday of August 2026 is the 28th.
    const body = ics(
      ...vevent(
        'UID:monthly-last',
        `DTSTART;TZID=${LA}:20260731T090000`,
        `DTEND;TZID=${LA}:20260731T093000`,
        'RRULE:FREQ=MONTHLY;BYDAY=-1FR',
        'SUMMARY:Retro',
      ),
    );

    const { payload } = await upcoming(body, Date.parse('2026-08-27T12:00:00Z'));
    expect(starts(payload)).toEqual(['2026-08-28T16:00:00.000Z']);
  });

  it('degrades an RRULE outside the supported subset to its base event', async () => {
    // FREQ=YEARLY and a BYSETPOS rule are both outside the subset. Neither may
    // throw, neither costs the feed its `feedsOk`, and the base occurrence still
    // shows — a thin answer rather than a wrong one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = ics(
      ...vevent(
        'UID:yearly',
        `DTSTART;TZID=${LA}:20260811T090000`,
        `DTEND;TZID=${LA}:20260811T093000`,
        'RRULE:FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=11',
        'SUMMARY:Anniversary',
      ),
      ...vevent(
        'UID:bysetpos',
        `DTSTART;TZID=${LA}:20260811T140000`,
        `DTEND;TZID=${LA}:20260811T143000`,
        'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
        'SUMMARY:Last working day',
      ),
    );

    const { payload } = await upcoming(body);
    expect(payload.feedsOk).toBe(1);
    expect(
      payload.meetings.map((meeting) => [meeting.startsAt, meeting.title]),
    ).toEqual([
      ['2026-08-11T16:00:00.000Z', 'Anniversary'],
      ['2026-08-11T21:00:00.000Z', 'Last working day'],
    ]);
    // Logged as a documented limit — one aggregate line per feed with counts
    // by FREQ, never one line per event.
    const codes = warn.mock.calls.map((call) => String(call[0]));
    const lines = codes.filter((line) => line.includes('calendar_rrule_unsupported'));
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!) as { unsupported: Record<string, number> };
    expect(logged.unsupported).toEqual({ YEARLY: 1, MONTHLY: 1 });
  });

  it('keeps an all-day recurring event a whole number of DAYS long', async () => {
    // A weekly Friday-to-Monday away weekend. The occurrence that starts Friday
    // 30 October crosses the fall-back transition, so it is 73 hours long, not
    // 72 — and its exclusive end has to be midnight on the Monday. Carrying the
    // base event's duration in milliseconds instead of days would end it at
    // 23:00 on the Sunday, which is the wrong calendar day.
    const body = ics(
      'X-WR-TIMEZONE:America/Los_Angeles',
      ...vevent(
        'UID:weekend',
        'DTSTART;VALUE=DATE:20261016',
        'DTEND;VALUE=DATE:20261019',
        'RRULE:FREQ=WEEKLY;BYDAY=FR',
        'SUMMARY:Away',
      ),
    );

    const { payload } = await upcoming(body, Date.parse('2026-10-30T12:00:00Z'));
    expect(payload.meetings).toEqual([
      {
        calendar: 'work',
        title: 'Away',
        // Midnight PDT on the Friday (UTC-7), midnight PST on the Monday (-8).
        startsAt: '2026-10-30T07:00:00.000Z',
        endsAt: '2026-11-02T08:00:00.000Z',
        allDay: true,
        location: null,
      },
    ]);
  });
});

// --- the window the Wall sees -----------------------------------------------

describe('the upcoming window', () => {
  it('reports the next 48 hours plus whatever is in progress, and stores nothing', async () => {
    const body = ics(
      ...vevent(
        'UID:over',
        'DTSTART:20260810T090000Z',
        'DTEND:20260810T100000Z',
        'SUMMARY:Already over',
      ),
      ...vevent(
        'UID:running',
        'DTSTART:20260810T113000Z',
        'DTEND:20260810T123000Z',
        'SUMMARY:In progress',
      ),
      ...vevent(
        'UID:soon',
        'DTSTART:20260810T150000Z',
        'DTEND:20260810T160000Z',
        'SUMMARY:Later today',
      ),
      ...vevent(
        'UID:edge',
        'DTSTART:20260812T120000Z',
        'DTEND:20260812T130000Z',
        'SUMMARY:Last minute of the window',
      ),
      ...vevent(
        'UID:beyond',
        'DTSTART:20260812T120001Z',
        'DTEND:20260812T130000Z',
        'SUMMARY:One second too late',
      ),
    );

    const { payload } = await upcoming(body);
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual([
      'In progress',
      'Later today',
      'Last minute of the window',
    ]);
    expect(payload.fetchedAt).toBe('2026-08-10T12:00:00.000Z');
    expect(payload.feedsConfigured).toBe(1);
    expect(payload.feedsOk).toBe(1);

    // Display state, not evidence: this path writes no rows at all.
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(0);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.flags`)).toBe(0);
  });

  it('reports a multi-day all-day event that began before the lookback', async () => {
    // Non-recurring events are a finite list, so the 24-hour expansion floor
    // does not apply to them: a week of leave that started on Saturday is still
    // in progress on Monday.
    const body = ics(
      'X-WR-TIMEZONE:America/Los_Angeles',
      ...vevent(
        'UID:leave',
        'DTSTART;VALUE=DATE:20260808',
        'DTEND;VALUE=DATE:20260815',
        'SUMMARY:Annual leave',
      ),
    );

    const { payload } = await upcoming(body);
    expect(payload.meetings).toEqual([
      {
        calendar: 'work',
        title: 'Annual leave',
        startsAt: '2026-08-08T07:00:00.000Z',
        endsAt: '2026-08-15T07:00:00.000Z',
        allDay: true,
        location: null,
      },
    ]);
  });

  it('sorts by start then title and caps the list at twenty', async () => {
    const many: string[] = [];
    // Two at the same minute, deliberately out of alphabetical order.
    many.push(...laEvent('tie-b', '20260810', '0800', 'Zebra'));
    many.push(...laEvent('tie-a', '20260810', '0800', 'Aardvark'));
    for (let index = 0; index < 25; index += 1) {
      const hour = String(9 + Math.floor(index / 2)).padStart(2, '0');
      const minute = index % 2 === 0 ? '00' : '30';
      many.push(
        ...laEvent(`bulk-${index}`, '20260810', `${hour}${minute}`, `Meeting ${index}`),
      );
    }

    const { payload } = await upcoming(ics(...many));
    expect(payload.meetings).toHaveLength(20);
    expect(payload.meetings.slice(0, 3).map((meeting) => meeting.title)).toEqual([
      'Aardvark',
      'Zebra',
      'Meeting 0',
    ]);
    // Ascending, with nothing past the cap.
    expect(starts(payload)).toEqual([...starts(payload)].sort());
  });

  it('tags each meeting with the calendar label it came from', async () => {
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(2);
    expect(
      payload.meetings.map((meeting) => [meeting.calendar, meeting.title]),
    ).toEqual([
      ['work', 'Work thing'],
      ['personal', 'Dentist'],
    ]);
  });

  it('asks each feed once, over its own request, under an honest User-Agent', async () => {
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    expect(calls.map((call) => call.url).sort()).toEqual(
      [WORK_URL, PERSONAL_URL].sort(),
    );
    expect(calls.map((call) => call.userAgent)).toEqual([
      CALENDAR_USER_AGENT,
      CALENDAR_USER_AGENT,
    ]);
  });
});

// --- isolation, configuration, and the cache --------------------------------

describe('feed isolation', () => {
  it('keeps the working feed when the other one fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = feedFetch({
      [WORK_URL]: 503,
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    // Two configured, one usable — and the operator can see exactly that.
    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(1);
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Dentist']);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"code":"http_503"');
  });

  it('names a feed that is not a calendar and one that is too large', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = feedFetch({
      [WORK_URL]: '<!doctype html><title>Sign in</title>',
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'x'.repeat(4 * 1024 * 1024))),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(0);
    expect(payload.meetings).toEqual([]);
    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('"code":"not_calendar"');
    expect(logged).toContain('"code":"too_large"');
  });

  it('survives a feed that never answers at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const { fetchImpl } = feedFetch({
      [WORK_URL]: timeout,
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });
    expect(payload.feedsOk).toBe(1);
    expect(payload.meetings).toHaveLength(1);
  });

  it('reports no configured feeds when the secret is absent', async () => {
    // `env` carries no CALENDAR_FEEDS binding, which is the un-set-up state.
    const { fetchImpl, calls } = feedFetch({});
    const payload = await calendarUpcoming(feedEnv(), { nowMs: NOW, fetchImpl });

    expect(payload).toEqual({
      fetchedAt: '2026-08-10T12:00:00.000Z',
      feedsConfigured: 0,
      feedsOk: 0,
      calendars: [],
      meetings: [],
    });
    expect(calls).toEqual([]);
  });

  it('reads the feed map out of the Worker binding', async () => {
    // The RPC takes no arguments, so `env.CALENDAR_FEEDS` is the only way in.
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
    });

    const payload = await calendarUpcoming(feedEnv({ work: WORK_URL }), {
      nowMs: NOW,
      fetchImpl,
    });

    expect(calls.map((call) => call.url)).toEqual([WORK_URL]);
    expect(payload.feedsConfigured).toBe(1);
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Work thing']);
  });

  it('reports no configured feeds when the secret is unparseable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl, calls } = feedFetch({});
    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: '{"work": ',
    });

    expect(payload.feedsConfigured).toBe(0);
    expect(payload.feedsOk).toBe(0);
    expect(payload.meetings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('counts a label with no url as configured, and never as ok', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
    });
    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: '' }),
    });

    // A typo has to be VISIBLE. Dropping the entry would make it read as `1 of
    // 1` — indistinguishable from a calendar that was never configured, forever.
    // Counted, it reads as one degraded feed out of two, which is what the Wall
    // renders coverage from.
    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(1);
    // It still holds its slot and its colour, so identity does not shuffle —
    // and it says which KIND of broken it is, which is the actionable part.
    expect(payload.calendars).toEqual([
      { id: 'work', color: null, status: 'ok' },
      { id: 'personal', color: null, status: 'misconfigured' },
    ]);
    // Nothing is asked of the network on its behalf.
    expect(calls.map((call) => call.url)).toEqual([WORK_URL]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"code":"config_missing_url"');
  });

  it('counts an entry whose value is not a url at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = feedFetch({});
    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      // Every way an operator can get the shape wrong.
      rawFeeds: JSON.stringify({ work: 42, personal: {}, shared: { color: '#fff' } }),
    });

    expect(payload.feedsConfigured).toBe(3);
    expect(payload.feedsOk).toBe(0);
    expect(payload.calendars.map((calendar) => calendar.id)).toEqual([
      'work',
      'personal',
      'shared',
    ]);
  });
});

// --- invitations the operator has not accepted ------------------------------

describe('invitation responses', () => {
  // The work feed's url embeds this address as its calendar id, which is how the
  // operator's own RSVP is found with no extra configuration.
  const SELF = 'work@example.test';

  /** One invited event, with the operator's answer as `partStat`. */
  function invited(partStat: string | null, summary: string): string[] {
    return vevent(
      `UID:invite-${summary.replace(/\W+/g, '-')}`,
      `DTSTART;TZID=${LA}:20260810T090000`,
      `DTEND;TZID=${LA}:20260810T093000`,
      `SUMMARY:${summary}`,
      'ORGANIZER;CN=Someone Else:mailto:organizer@example.test',
      'ATTENDEE;CN=Someone Else;PARTSTAT=ACCEPTED:mailto:organizer@example.test',
      partStat === null
        ? `ATTENDEE;CN=The Operator:mailto:${SELF}`
        : `ATTENDEE;CN=The Operator;PARTSTAT=${partStat};RSVP=TRUE:mailto:${SELF}`,
    );
  }

  it('shows an invitation the operator accepted', async () => {
    const { payload } = await upcoming(ics(...invited('ACCEPTED', 'Accepted')));
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Accepted']);
  });

  it('hides declined, tentative, and unanswered invitations', async () => {
    // A maybe is not a plan, and an unopened invitation is not either.
    const { payload } = await upcoming(
      ics(
        ...invited('DECLINED', 'Declined'),
        ...invited('TENTATIVE', 'Tentative'),
        ...invited('NEEDS-ACTION', 'Unanswered'),
        ...invited('ACCEPTED', 'Accepted'),
      ),
    );
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Accepted']);
    // The feed itself is perfectly healthy — this is a filter, not a failure.
    expect(payload.feedsOk).toBe(1);
  });

  it('treats an attendee line with no PARTSTAT as unanswered', async () => {
    // RFC 5545's default is NEEDS-ACTION. This is the one branch where a
    // provider that omits the param costs the operator a real meeting, so it is
    // pinned deliberately: flipping it is a one-line change in `selfPartStat`.
    const { payload } = await upcoming(ics(...invited(null, 'No partstat')));
    expect(payload.meetings).toEqual([]);
  });

  it('shows a solo event, which has no guest list to answer', async () => {
    const { payload } = await upcoming(
      ics(...laEvent('solo', '20260810', '0900', 'Focus block')),
    );
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Focus block']);
  });

  it('shows an event the operator organized for other people', async () => {
    // Google writes the organizer in as an attendee, accepted.
    const { payload } = await upcoming(
      ics(
        ...vevent(
          'UID:i-called-it',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:My own meeting',
          `ORGANIZER;CN=The Operator:mailto:${SELF}`,
          `ATTENDEE;CN=The Operator;PARTSTAT=ACCEPTED:mailto:${SELF}`,
          'ATTENDEE;CN=Guest;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:guest@example.test',
        ),
      ),
    );
    // The GUEST not having answered is none of the Wall's business.
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['My own meeting']);
  });

  it('shows an event whose guest list does not include the operator', async () => {
    // Someone else's meeting, visible on a shared calendar. There is no answer of
    // the operator's to respect, so hiding it would be inventing one.
    const { payload } = await upcoming(
      ics(
        ...vevent(
          'UID:not-mine',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Someone elses meeting',
          'ATTENDEE;PARTSTAT=DECLINED:mailto:someone@example.test',
          'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:another@example.test',
        ),
      ),
    );
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual([
      'Someone elses meeting',
    ]);
  });

  it('finds the operator behind a heavily folded, heavily parameterized line', async () => {
    // Real ATTENDEE lines fold at 75 octets and carry a pile of params, one of
    // which can hold a quoted colon. Getting the value boundary wrong here reads
    // the address as empty and silently stops filtering anything.
    const { payload } = await upcoming(
      ics(
        ...vevent(
          'UID:folded-attendee',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Declined but wordy',
          'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINE',
          ' D;RSVP=TRUE;CN="The Operator: Chief of Nothing";X-NUM-GUESTS=0:mai',
          ` lto:${SELF}`,
        ),
      ),
    );
    expect(payload.meetings).toEqual([]);
  });

  it('keeps a declined single instance from reappearing at its old time', async () => {
    // Declining one standup arrives as an override VEVENT with the operator
    // DECLINED. It must still suppress the instance it replaces — otherwise the
    // rule regenerates the original and the meeting the operator just declined
    // comes back.
    const body = ics(
      ...vevent(
        'UID:standup',
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${SELF}`,
      ),
      ...vevent(
        'UID:standup',
        `RECURRENCE-ID;TZID=${LA}:20260811T090000`,
        `DTSTART;TZID=${LA}:20260811T090000`,
        `DTEND;TZID=${LA}:20260811T093000`,
        'SUMMARY:Standup',
        `ATTENDEE;PARTSTAT=DECLINED:mailto:${SELF}`,
      ),
    );

    const { payload } = await upcoming(body);
    expect(starts(payload)).toEqual(['2026-08-10T16:00:00.000Z']);
  });

  it('lets an explicitly named address override the one in the url', async () => {
    // A feed whose url says nothing useful about whose calendar it is, or an
    // operator with a second address on the invitation.
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(
        ...vevent(
          'UID:two-addresses',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Declined under the other address',
          `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${SELF}`,
          'ATTENDEE;PARTSTAT=DECLINED:mailto:Operator@Example.Test',
        ),
      ),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({
        // The declared address wins, so the DECLINED line is now the operator's
        // and the url-derived ACCEPTED one is somebody else's.
        work: { url: WORK_URL, email: 'operator@example.test' },
      }),
    });
    expect(payload.meetings).toEqual([]);
  });

  it('matches a declared address case-insensitively', async () => {
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(
        ...vevent(
          'UID:mixed-case',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Declined',
          'ATTENDEE;PARTSTAT=DECLINED:MAILTO:Operator@Example.Test',
        ),
      ),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: { url: WORK_URL, email: 'OPERATOR@example.TEST' } }),
    });
    expect(payload.meetings).toEqual([]);
  });

  it('filters nothing on a calendar whose id is not a person', async () => {
    // A shared, holiday, or resource calendar has a synthetic Google id that
    // looks like an address but is not the operator's. Guessing it as the
    // operator's identity would hide real events, so filtering stays off.
    const sharedUrl =
      'https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/private-shared5ecret/basic.ics';
    const { fetchImpl } = feedFetch({
      [sharedUrl]: ics(
        ...vevent(
          'UID:on-a-shared-calendar',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Team offsite',
          'ATTENDEE;PARTSTAT=DECLINED:mailto:abc123@group.calendar.google.com',
          'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:someone@example.test',
        ),
      ),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ team: sharedUrl }),
    });
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual(['Team offsite']);
  });

  it('filters nothing on a feed that is not a Google ical url', async () => {
    const otherUrl = 'https://mail.example.test/exports/calendar-5ecret.ics';
    const { fetchImpl } = feedFetch({
      [otherUrl]: ics(
        ...vevent(
          'UID:elsewhere',
          `DTSTART;TZID=${LA}:20260810T090000`,
          `DTEND;TZID=${LA}:20260810T093000`,
          'SUMMARY:Imported meeting',
          `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${SELF}`,
        ),
      ),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ other: otherUrl }),
    });
    // No `/ical/<id>/` segment to read an identity out of, so nothing is hidden.
    expect(payload.meetings.map((meeting) => meeting.title)).toEqual([
      'Imported meeting',
    ]);
  });
});

describe('the configured calendars', () => {
  it('lists every configured feed in config order, including the one that failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = feedFetch({
      [WORK_URL]: 500,
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      // Personal first, so the assertion cannot pass on alphabetical order.
      rawFeeds: JSON.stringify({ personal: PERSONAL_URL, work: WORK_URL }),
    });

    // A surface keys its identity color off this list, so it cannot depend on
    // which feeds answered or which have a meeting today.
    expect(payload.calendars).toEqual([
      { id: 'personal', color: null, status: 'ok' },
      { id: 'work', color: null, status: 'unreachable' },
    ]);
    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(1);
  });

  it('classifies each failure by whether the operator or the world has to move', async () => {
    // One count saying 1 of 5 answered hides five different problems; three
    // need the operator to edit the secret and two need Google to cooperate.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = 'https://calendar.google.com/calendar/ical/a%40example.test/private-refused/basic.ics';
    const slow = 'https://calendar.google.com/calendar/ical/b%40example.test/private-slow/basic.ics';
    const signIn = 'https://calendar.google.com/calendar/ical/c%40example.test/private-signin/basic.ics';
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';

    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
      [refused]: 403,
      [slow]: timeout,
      [signIn]: '<!doctype html><title>Sign in</title>',
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({
        healthy: WORK_URL,
        rotated: refused,
        slow,
        'sign-in': signIn,
        typo: '',
        scheme: 'httpx://calendar.example/whatever',
      }),
    });

    expect(payload.calendars).toEqual([
      { id: 'healthy', color: null, status: 'ok' },
      // Discovered by asking. A 403 usually means a rotated link, but a code
      // cannot tell that from a bad afternoon at Google, so it is not promised.
      { id: 'rotated', color: null, status: 'unreachable' },
      { id: 'slow', color: null, status: 'unreachable' },
      // Fetched, but what came back was not a calendar.
      { id: 'sign-in', color: null, status: 'unreachable' },
      // Knowable before the network was touched.
      { id: 'typo', color: null, status: 'misconfigured' },
      { id: 'scheme', color: null, status: 'misconfigured' },
    ]);
    // `feedsOk` is exactly the count of `ok`, so the two facts cannot disagree.
    expect(payload.feedsOk).toBe(1);
    expect(payload.feedsConfigured).toBe(6);
    // A misconfigured feed is never asked for over the network.
    expect(calls.map((call) => call.url).sort()).toEqual(
      [WORK_URL, refused, slow, signIn].sort(),
    );
  });

  it('keeps each feed status through a cached round', async () => {
    // The status describes the round `fetchedAt` names, so a poll served from
    // cache must report the same statuses rather than a fresh-looking all-ok.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: 500,
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });
    const rawFeeds = JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL });

    const first = await calendarUpcoming(feedEnv(), { nowMs: NOW, fetchImpl, rawFeeds });
    const cached = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + 60_000,
      fetchImpl,
      rawFeeds,
    });

    expect(calls).toHaveLength(2);
    expect(cached.calendars).toEqual(first.calendars);
    expect(cached.calendars).toEqual([
      { id: 'work', color: null, status: 'unreachable' },
      { id: 'personal', color: null, status: 'ok' },
    ]);
    expect(cached.feedsOk).toBe(1);
    expect(cached.fetchedAt).toBe(first.fetchedAt);
  });

  it('lets an unreachable feed recover on the next round', async () => {
    // `unreachable` is a statement about one round, not a verdict on the feed.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempt = 0;
    const fetchImpl = (async (): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) return new Response('no', { status: 503 });
      return new Response(ics(...laEvent('w', '20260810', '0900', 'Work thing')), {
        headers: { 'content-type': 'text/calendar' },
      });
    }) as typeof fetch;
    const rawFeeds = JSON.stringify({ work: WORK_URL });

    const down = await calendarUpcoming(feedEnv(), { nowMs: NOW, fetchImpl, rawFeeds });
    expect(down.calendars).toEqual([{ id: 'work', color: null, status: 'unreachable' }]);

    const recovered = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + CALENDAR_CACHE_TTL_MS,
      fetchImpl,
      rawFeeds,
    });
    expect(recovered.calendars).toEqual([{ id: 'work', color: null, status: 'ok' }]);
    expect(recovered.feedsOk).toBe(1);
  });

  it('carries the color the operator pinned on a calendar', async () => {
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({
        // The long form pins a color; the bare url form leaves it to the surface.
        work: { url: WORK_URL, color: 'oklch(62% 0.19 260)' },
        personal: PERSONAL_URL,
      }),
    });

    expect(payload.calendars).toEqual([
      { id: 'work', color: 'oklch(62% 0.19 260)', status: 'ok' },
      { id: 'personal', color: null, status: 'ok' },
    ]);
    // Both forms are still fetched, and the color never becomes part of the url.
    expect(calls.map((call) => call.url).sort()).toEqual(
      [WORK_URL, PERSONAL_URL].sort(),
    );
    expect(payload.meetings).toHaveLength(2);
  });

  it('drops a color that could escape a style attribute, keeping the calendar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({
        work: { url: WORK_URL, color: 'red; background: url(//evil.test)' },
      }),
    });

    // The swatch is refused; the meetings are not. Escaping is still the
    // surface's job — this is the second lock, not the only one.
    // A refused colour is not a feed failure: it fetched and parsed, so `ok`.
    expect(payload.calendars).toEqual([{ id: 'work', color: null, status: 'ok' }]);
    expect(payload.meetings).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"code":"config_unusable_color"');
  });

  it('refetches when the operator recolors a calendar', async () => {
    // Config is part of the cache key, so a recolor takes effect on the next
    // poll instead of waiting out the five-minute TTL.
    const body = ics(...laEvent('w', '20260810', '0900', 'Work thing'));
    const { fetchImpl, calls } = feedFetch({ [WORK_URL]: body });

    await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: { url: WORK_URL, color: '#7aa2f7' } }),
    });
    const recolored = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + 1_000,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: { url: WORK_URL, color: '#f7768e' } }),
    });

    expect(calls).toHaveLength(2);
    expect(recolored.calendars).toEqual([
      { id: 'work', color: '#f7768e', status: 'ok' },
    ]);
  });
});

describe('the fetch cache', () => {
  it('fetches once inside the window and again after it', async () => {
    const body = ics(...laEvent('w', '20260812', '0900', 'Work thing'));
    const { fetchImpl, calls } = feedFetch({ [WORK_URL]: body });
    const rawFeeds = JSON.stringify({ work: WORK_URL });

    // The Wall polls every 60s; five minutes of polls is one fetch.
    for (const offset of [0, 60_000, 120_000, CALENDAR_CACHE_TTL_MS - 1]) {
      const payload = await calendarUpcoming(feedEnv(), {
        nowMs: NOW + offset,
        fetchImpl,
        rawFeeds,
      });
      // A cached round keeps the stamp of the fetch it came from.
      expect(payload.fetchedAt).toBe('2026-08-10T12:00:00.000Z');
    }
    expect(calls).toHaveLength(1);

    const refetched = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + CALENDAR_CACHE_TTL_MS,
      fetchImpl,
      rawFeeds,
    });
    expect(calls).toHaveLength(2);
    expect(refetched.fetchedAt).toBe('2026-08-10T12:05:00.000Z');
  });

  it('recomputes the window from cached bytes instead of serving a stale answer', async () => {
    // The cache holds the FETCH. A meeting that ends between two polls has to
    // leave the list on the next one, without asking the feed again.
    const body = ics(
      ...vevent(
        'UID:ending',
        'DTSTART:20260810T113000Z',
        'DTEND:20260810T120100Z',
        'SUMMARY:About to end',
      ),
    );
    const { fetchImpl, calls } = feedFetch({ [WORK_URL]: body });
    const rawFeeds = JSON.stringify({ work: WORK_URL });

    const during = await calendarUpcoming(feedEnv(), { nowMs: NOW, fetchImpl, rawFeeds });
    expect(during.meetings.map((meeting) => meeting.title)).toEqual(['About to end']);

    const after = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + 120_000,
      fetchImpl,
      rawFeeds,
    });
    expect(after.meetings).toEqual([]);
    expect(after.fetchedAt).toBe('2026-08-10T12:00:00.000Z');
    expect(calls).toHaveLength(1);
  });

  it('refetches when the operator changes which calendars are configured', async () => {
    const { fetchImpl, calls } = feedFetch({
      [WORK_URL]: ics(...laEvent('w', '20260810', '0900', 'Work thing')),
      [PERSONAL_URL]: ics(...laEvent('p', '20260810', '1000', 'Dentist')),
    });

    await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL }),
    });
    const both = await calendarUpcoming(feedEnv(), {
      nowMs: NOW + 1_000,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    expect(calls).toHaveLength(3);
    expect(both.feedsConfigured).toBe(2);
    expect(both.meetings).toHaveLength(2);
  });
});

describe('the feed url is a credential', () => {
  it('never puts a feed url in an error, a log line, or the payload', async () => {
    // Every failure mode at once, including the one that matters most: workerd
    // puts the request URL inside some transport errors, so the error a failing
    // `fetch` throws must never be copied into ours.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = new Error(
      `connection refused: GET ${WORK_URL} (internal error; reference = 0d9f4a2c)`,
    );
    const { fetchImpl } = feedFetch({
      [WORK_URL]: leaky,
      [PERSONAL_URL]: 403,
    });

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: WORK_URL, personal: PERSONAL_URL }),
    });

    expect(payload.feedsConfigured).toBe(2);
    expect(payload.feedsOk).toBe(0);

    const emitted = [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]
      .flat()
      .map((entry) => String(entry));
    expect(emitted.length).toBeGreaterThan(0);
    for (const line of emitted) {
      expect(line).not.toContain(WORK_SECRET);
      expect(line).not.toContain(PERSONAL_SECRET);
      expect(line).not.toContain('calendar.google.com');
    }
    // What IS reported: the operator's label and a coarse code.
    expect(emitted.join('\n')).toContain('"calendar":"work"');
    expect(emitted.join('\n')).toContain('"code":"unreachable"');
    expect(emitted.join('\n')).toContain('"code":"http_403"');
    expect(JSON.stringify(payload)).not.toContain(WORK_SECRET);
  });

  it('reports a url the operator mistyped without echoing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl, calls } = feedFetch({});

    const payload = await calendarUpcoming(feedEnv(), {
      nowMs: NOW,
      fetchImpl,
      rawFeeds: JSON.stringify({ work: `httpx://calendar.example/${WORK_SECRET}` }),
    });

    expect(payload.feedsConfigured).toBe(1);
    expect(payload.feedsOk).toBe(0);
    expect(calls).toEqual([]);
    const emitted = warn.mock.calls.flat().map((entry) => String(entry));
    for (const line of emitted) expect(line).not.toContain(WORK_SECRET);
    expect(emitted.join('\n')).toContain('"code":"unsupported_scheme"');
  });
});

describe('round hygiene', () => {
  it('collapses field-for-field twin events into one meeting', async () => {
    // Google's auto-generated events can land in one calendar twice under
    // different UIDs (two booking emails, one flight). Twins are one fact.
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(
        ...laEvent('booking-1', '20260810', '0910', 'Check in for flight (WN 1533)'),
        ...laEvent('booking-2', '20260810', '0910', 'Check in for flight (WN 1533)'),
        ...laEvent('other', '20260810', '0910', 'Same minute, different meeting'),
      ),
    });

    const payload = await calendarUpcoming(feedEnv({ work: WORK_URL }), {
      nowMs: NOW,
      fetchImpl,
    });

    expect(
      payload.meetings.filter((m) => m.title.includes('WN 1533')),
    ).toHaveLength(1);
    // Different in any field is two facts — the same minute is not enough.
    expect(payload.meetings).toHaveLength(2);
  });

  it('a cold contender refuses without borrowing another request or duplicating its provider read', async () => {
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return new Response(ics(...laEvent('w', '20260810', '0900', 'Standup')));
    }) as unknown as typeof fetch;
    const first = calendarUpcoming(feedEnv({ work: WORK_URL }), { nowMs: NOW, fetchImpl });
    await reading;
    try {
      await expect(calendarUpcoming(feedEnv({ work: WORK_URL }), { nowMs: NOW, fetchImpl }))
        .rejects.toMatchObject({ code: 'calendar_read_in_progress' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { release(); }
    const completed = await first;
    const second = await calendarUpcoming(feedEnv({ work: WORK_URL }), { nowMs: NOW + 1_000, fetchImpl });
    expect(second.meetings).toEqual(completed.meetings);
    expect(second.fetchedAt).toBe(completed.fetchedAt);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logs degraded rules as one aggregate line per feed, at fetch time only', async () => {
    // One warn line per event per poll would be thousands an hour on a
    // calendar of yearly birthdays. The round that fetched the bytes says it
    // once, with counts; a poll served from cache says nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const yearly = (uid: string, summary: string) =>
      vevent(
        `UID:${uid}`,
        `DTSTART;TZID=${LA}:20260810T090000`,
        `DTEND;TZID=${LA}:20260810T093000`,
        'RRULE:FREQ=YEARLY',
        `SUMMARY:${summary}`,
      );
    const { fetchImpl } = feedFetch({
      [WORK_URL]: ics(...yearly('b1', 'Birthday A'), ...yearly('b2', 'Birthday B')),
    });

    await calendarUpcoming(feedEnv({ work: WORK_URL }), { nowMs: NOW, fetchImpl });
    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('calendar_rrule_unsupported'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'calendar_rrule_unsupported',
      calendar: 'work',
      unsupported: { YEARLY: 2 },
    });

    warn.mockClear();
    await calendarUpcoming(feedEnv({ work: WORK_URL }), {
      nowMs: NOW + 60_000,
      fetchImpl,
    });
    expect(
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('calendar_rrule_unsupported')),
    ).toHaveLength(0);
  });
});


describe('workspace-owned completed calendar rounds', () => {
  it('a lost cache waits for the persisted cooldown without another provider fetch, then recovers', async () => {
    const owned = feedEnv({ work: WORK_URL });
    const fixture = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Saved meeting')) });
    await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    const cold = await caches.open(crypto.randomUUID());
    await expect(calendarUpcoming(owned, { nowMs: NOW + 60_000, fetchImpl: fixture.fetchImpl, cache: cold }))
      .rejects.toMatchObject({ code: 'calendar_read_in_progress', nextAttemptAt: new Date(NOW + CALENDAR_CACHE_TTL_MS).toISOString() });
    expect(fixture.calls).toHaveLength(1);
    const recovered = await calendarUpcoming(owned, { nowMs: NOW + CALENDAR_CACHE_TTL_MS, fetchImpl: fixture.fetchImpl, cache: cold });
    expect(recovered.meetings.map(meeting => meeting.title)).toEqual(['Saved meeting']);
    expect(fixture.calls).toHaveLength(2);
  });

  it('refuses provider work without a resolved workspace owner', async () => {
    const fetchImpl = vi.fn(async () => new Response('unused')) as typeof fetch;
    await expect(calendarUpcoming({ NOTICEOS_WORKSPACE_PROFILE: 'standalone', CALENDAR_FEEDS: JSON.stringify({ work: WORK_URL }) } as IngestEnv,
      { nowMs: NOW, fetchImpl })).rejects.toMatchObject({ code: 'calendar_read_ownership_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a terminated invocation’s persisted lease expires before a new owner fetches', async () => {
    const owned = feedEnv({ work: WORK_URL });
    const fixture = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Saved meeting')) });
    await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    const refreshAt = NOW + CALENDAR_CACHE_TTL_MS;
    // The invocation died after its claim, before publishing/releasing. Only
    // the persisted lease survives; no pending promise is supplied to a caller.
    await asOwner(`UPDATE noticeos.integration_leases SET owner = 'terminated-fixture',
      expires_at = '${new Date(refreshAt + 30_000).toISOString()}'
      WHERE lease_key LIKE 'calendar-read:%'`);
    const cold = await caches.open(crypto.randomUUID());
    await expect(calendarUpcoming(owned, { nowMs: refreshAt + 29_999, fetchImpl: fixture.fetchImpl, cache: cold }))
      .rejects.toMatchObject({ code: 'calendar_read_in_progress' });
    expect(fixture.calls).toHaveLength(1);
    const result = await calendarUpcoming(owned, { nowMs: refreshAt + 30_000, fetchImpl: fixture.fetchImpl, cache: cold });
    expect(result.fetchedAt).toBe(new Date(refreshAt + 30_000).toISOString());
    expect(result.meetings.map(meeting => meeting.title)).toEqual(['Saved meeting']);
    expect(fixture.calls).toHaveLength(2);
  });

  it('keeps its ten-second fetch deadline inside the lease and recovers after a timed-out round', async () => {
    const owned = feedEnv({ work: WORK_URL });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const attempt = calendarUpcoming(owned, { nowMs: NOW, fetchImpl });
    await reading;
    try {
      expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
      const [lease] = await env.STORE.read(tx => tx.query<{ expires_at: string }>(
        "SELECT expires_at FROM noticeos.integration_leases WHERE lease_key LIKE 'calendar-read:%'"));
      expect(Date.parse(javascriptInstant(lease!.expires_at)) - NOW).toBe(30_000);
    } finally {
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }
    const failed = await attempt;
    expect(failed).toMatchObject({ feedsOk: 0, calendars: [{ status: 'unreachable' }] });
    const recovered = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Recovered meeting')) });
    expect((await calendarUpcoming(owned, { nowMs: NOW + 10_000, fetchImpl: recovered.fetchImpl })).feedsOk).toBe(0);
    expect(recovered.calls).toHaveLength(0);
    const result = await calendarUpcoming(owned, { nowMs: NOW + CALENDAR_CACHE_TTL_MS, fetchImpl: recovered.fetchImpl });
    expect(result.meetings.map(meeting => meeting.title)).toEqual(['Recovered meeting']);
    expect(recovered.calls).toHaveLength(1);
  });

  it('separates identical private feed labels and addresses in two workspaces', async () => {
    const workspaceId = crypto.randomUUID();
    await asOwner(`INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
      VALUES ('${workspaceId}', 'calendar-fixture', 'Calendar fixture')`);
    const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
    const firstEnv = feedEnv({ work: WORK_URL });
    const secondEnv = { ...firstEnv, STORE: store };
    const a = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Workspace A')) });
    const b = feedFetch({ [WORK_URL]: ics(...laEvent('b', '20260810', '0900', 'Workspace B')) });
    try {
      for (const offset of [0, 1000]) {
        const first = await calendarUpcoming(firstEnv, { nowMs: NOW + offset, fetchImpl: a.fetchImpl });
        const second = await calendarUpcoming(secondEnv, { nowMs: NOW + offset, fetchImpl: b.fetchImpl });
        expect(first.meetings.map(meeting => meeting.title)).toEqual(['Workspace A']);
        expect(second.meetings.map(meeting => meeting.title)).toEqual(['Workspace B']);
      }
      expect(a.calls).toHaveLength(1);
      expect(b.calls).toHaveLength(1);
    } finally {
      await store.close();
      await asOwner(`DELETE FROM noticeos.integration_health_events WHERE workspace_id = '${workspaceId}';
        DELETE FROM noticeos.integration_capability_state WHERE workspace_id = '${workspaceId}';
        DELETE FROM noticeos.capability_targets WHERE workspace_id = '${workspaceId}';
        DELETE FROM noticeos.integration_leases WHERE workspace_id = '${workspaceId}';
        DELETE FROM noticeos.workspaces WHERE workspace_id = '${workspaceId}'`);
    }
  });

  it('reconnecting the same stored feed invalidates the earlier connection revision', async () => {
    const owned = feedEnv();
    const fields = { CALENDAR_FEEDS: JSON.stringify({ work: WORK_URL }) };
    expect(await putCredential(owned, { provider: 'calendar', fields })).toMatchObject({ ok: true });
    const before = await resolveCredential(owned, 'calendar');
    const first = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Before reconnect')) });
    await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: first.fetchImpl });
    expect(await putCredential(owned, { provider: 'calendar', fields })).toMatchObject({ ok: true });
    const after = await resolveCredential(owned, 'calendar');
    expect(after.revision).not.toEqual(before.revision);
    const second = feedFetch({ [WORK_URL]: ics(...laEvent('b', '20260810', '0900', 'After reconnect')) });
    const result = await calendarUpcoming(owned, { nowMs: NOW + 1000, fetchImpl: second.fetchImpl });
    expect(result.meetings.map(meeting => meeting.title)).toEqual(['After reconnect']);
    expect(second.calls).toHaveLength(1);
  });

  it('hydrates recurrence exclusions and returns independent mutable payloads from completed values', async () => {
    const body = ics(...vevent('UID:excluded', 'DTSTART:20260810T150000Z', 'DTEND:20260810T153000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20260811T150000Z', 'SUMMARY:Kept meeting'));
    const fixture = feedFetch({ [WORK_URL]: body });
    const owned = feedEnv({ work: WORK_URL });
    const first = await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    expect(first.meetings).toHaveLength(1);
    first.calendars[0]!.status = 'unreachable';
    first.meetings[0]!.title = 'Changed by one caller';
    const second = await calendarUpcoming(owned, { nowMs: NOW + 1000, fetchImpl: fixture.fetchImpl });
    expect(second.calendars[0]!.status).toBe('ok');
    expect(second.meetings.map(meeting => meeting.title)).toEqual(['Kept meeting']);
    expect(fixture.calls).toHaveLength(1);
  });

  it('cache loss or unavailable visibility never spends another request inside the calendar cooldown', async () => {
    const owned = feedEnv({ work: WORK_URL });
    const fixture = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Saved meeting')) });
    await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    const cold = await caches.open(crypto.randomUUID());
    await expect(calendarUpcoming(owned, { nowMs: NOW + 1000, fetchImpl: fixture.fetchImpl, cache: cold }))
      .rejects.toMatchObject({ code: 'calendar_read_in_progress' });
    const unavailable: Cache = { match: async () => { throw new Error('fixture cache unavailable'); },
      put: testCache.put.bind(testCache), delete: testCache.delete.bind(testCache) };
    await expect(calendarUpcoming(owned, { nowMs: NOW + 1000, fetchImpl: fixture.fetchImpl, cache: unavailable }))
      .rejects.toBeInstanceOf(CalendarReadError);
    expect(fixture.calls).toHaveLength(1);
    await calendarUpcoming(owned, { nowMs: NOW + CALENDAR_CACHE_TTL_MS, fetchImpl: fixture.fetchImpl, cache: cold });
    expect(fixture.calls).toHaveLength(2);
  });

  it('a refresh contender receives the same owner’s dated completed round without waiting for its I/O', async () => {
    const owned = feedEnv({ work: WORK_URL });
    const fixture = feedFetch({ [WORK_URL]: ics(...laEvent('a', '20260810', '0900', 'Saved meeting')) });
    const prior = await calendarUpcoming(owned, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const fetchImpl = vi.fn(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return new Response(ics(...laEvent('b', '20260810', '0900', 'Refreshed meeting')));
    }) as unknown as typeof fetch;
    const first = calendarUpcoming(owned, { nowMs: NOW + CALENDAR_CACHE_TTL_MS, fetchImpl });
    await reading;
    try {
      const contender = await calendarUpcoming(owned, { nowMs: NOW + CALENDAR_CACHE_TTL_MS, fetchImpl });
      expect(contender.meetings).toEqual(prior.meetings);
      expect(contender.fetchedAt).toBe(prior.fetchedAt);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect((await first).meetings.map(meeting => meeting.title)).toEqual(['Refreshed meeting']);
  });

  it('actual workerd RPC calls reuse completed values but never another invocation’s pending work', async () => {
    const fields = { CALENDAR_FEEDS: JSON.stringify({ work: WORK_URL }) };
    expect(await putCredential(feedEnv(), { provider: 'calendar', fields })).toMatchObject({ ok: true });
    const start = new Date(Date.now() + 60 * 60_000).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const finish = new Date(Date.now() + 90 * 60_000).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(String(input)).toBe(WORK_URL);
      // This timer and Response belong to the RPC invocation, not the test's
      // context. The second RPC must never inherit their pending capability.
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      return new Response(ics(...vevent('UID:native', `DTSTART:${start}`, `DTEND:${finish}`, 'SUMMARY:Native meeting')));
    });
    const results = await Promise.allSettled([workerExports.default.calendarUpcoming(), workerExports.default.calendarUpcoming()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain('Calendar is temporarily unavailable');
    const first = results.find(result => result.status === 'fulfilled');
    expect(first?.status === 'fulfilled' ? first.value.meetings.map(meeting => meeting.title) : []).toEqual(['Native meeting']);
    const next = await workerExports.default.calendarUpcoming();
    expect(next.meetings.map(meeting => meeting.title)).toEqual(['Native meeting']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
