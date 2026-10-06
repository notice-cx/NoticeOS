// @vitest-environment node
// What today's meetings ARE (lib/meetings): the distance strings and the
// hero/followers split the Wall's top strip reads. The panel that also drew
// them, with its feed colours and failure lines, left with the pre-D28 Wall
// (bead `ro-trai.20`).
import { describe, expect, it } from "vitest";
import type {
  CalendarFeed,
  CalendarUpcoming,
  UpcomingMeeting,
} from "@noticeos/contract";
import {
  MEETING_FOLLOWER_CAP,
  formatMeetingClock,
  formatMeetingDistance,
  meetingsView,
} from "@/lib/meetings";

const MINUTE = 60_000;
const HOUR = 3_600_000;

/**
 * Every fixture is built from a LOCAL wall-clock time, because the panel's
 * today/tomorrow split and its clock strings are both the viewer's local zone —
 * ISO literals would make these assertions pass or fail on the machine's TZ.
 * 9:05 AM on a fixed date is "now" throughout.
 */
const NOW = new Date(2026, 7, 10, 9, 5).getTime();

function at(days: number, hour: number, minute: number): number {
  const when = new Date(NOW);
  when.setDate(when.getDate() + days);
  when.setHours(hour, minute, 0, 0);
  return when.getTime();
}

function meeting(
  calendar: string,
  title: string,
  startMs: number,
  minutes: number,
  location: string | null = null,
): UpcomingMeeting {
  return {
    calendar,
    title,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + minutes * MINUTE).toISOString(),
    allDay: false,
    location,
  };
}

function allDay(calendar: string, title: string, days = 0): UpcomingMeeting {
  return {
    calendar,
    title,
    startsAt: new Date(at(days, 0, 0)).toISOString(),
    endsAt: new Date(at(days + 1, 0, 0)).toISOString(),
    allDay: true,
    location: null,
  };
}

/** Two feeds in config order with nothing pinned. The names are deliberately
 * NOT "work"/"personal" in most fixtures: feeds are operator-named, and no
 * behaviour may depend on a particular string. */
const FEEDS: CalendarFeed[] = [
  { id: "Day job", color: null, status: "ok" },
  { id: "House", color: null, status: "ok" },
];

function upcoming(
  meetings: UpcomingMeeting[],
  feedsConfigured = 2,
  feedsOk = feedsConfigured,
  calendars: CalendarFeed[] = FEEDS,
): CalendarUpcoming {
  return {
    fetchedAt: new Date(NOW).toISOString(),
    feedsConfigured,
    feedsOk,
    calendars,
    meetings,
  };
}

/** The local clock string the panel itself would print, so an assertion cannot
 * hardcode a 12-hour convention this machine's locale may not use. */
function clock(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ms);
}

function weekdayClock(ms: number): string {
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(ms);
  return `${weekday} ${clock(ms)}`;
}

describe("meetings time-distance strings", () => {
  it("anchors a running meeting on the time left, not the time since", () => {
    const running = meeting("work", "Standup", NOW - 10 * MINUTE, 35);
    expect(formatMeetingDistance(running, NOW)).toBe("now · 25m left");
  });

  it("counts minutes up to an hour and hours plus minutes beyond it", () => {
    expect(formatMeetingDistance(meeting("work", "a", NOW + 25 * MINUTE, 30), NOW)).toBe("in 25m");
    expect(formatMeetingDistance(meeting("work", "a", NOW + 59 * MINUTE, 30), NOW)).toBe("in 59m");
    expect(formatMeetingDistance(meeting("work", "a", NOW + 3 * HOUR, 30), NOW)).toBe("in 3h");
    expect(
      formatMeetingDistance(meeting("work", "a", NOW + 3 * HOUR + 40 * MINUTE, 30), NOW),
    ).toBe("in 3h 40m");
  });

  it("floors rather than rounds, so the figure never claims time it does not have", () => {
    // 24m30s is 24 minutes of usable time, not 25.
    expect(
      formatMeetingDistance(meeting("work", "a", NOW + 24 * MINUTE + 30_000, 30), NOW),
    ).toBe("in 24m");
    expect(formatMeetingDistance(meeting("work", "a", NOW + 40_000, 30), NOW)).toBe("in <1m");
  });

  it("names the weekday for a clock time that is not today", () => {
    const today = at(0, 13, 30);
    const tomorrow = at(1, 9, 30);
    expect(formatMeetingClock(new Date(today).toISOString(), NOW)).toBe(clock(today));
    expect(formatMeetingClock(new Date(tomorrow).toISOString(), NOW)).toBe(
      weekdayClock(tomorrow),
    );
  });
});

describe("meetings view split", () => {
  it("caps followers and keeps the hero", () => {
    const view = meetingsView(
      upcoming([
        meeting("work", "Standup", NOW + 25 * MINUTE, 15),
        meeting("work", "Design review", at(0, 11, 0), 50),
        meeting("personal", "Dentist", at(0, 13, 30), 45),
        meeting("work", "Vendor call", at(0, 15, 0), 30),
        meeting("work", "Retro", at(0, 16, 0), 45),
      ]),
      NOW,
    );

    expect(view.hero?.title).toBe("Standup");
    expect(view.followers).toHaveLength(MEETING_FOLLOWER_CAP);
    expect(view.followers.map((m) => m.title)).toEqual([
      "Design review",
      "Dentist",
      "Vendor call",
    ]);
  });

  it("excludes all-day events from the hero and the rows, and counts them", () => {
    const view = meetingsView(
      upcoming([
        allDay("personal", "Anniversary"),
        allDay("work", "Company shutdown"),
        meeting("work", "Standup", NOW + 25 * MINUTE, 15),
      ]),
      NOW,
    );

    expect(view.hero?.title).toBe("Standup");
    expect(view.followers).toEqual([]);
    expect(view.allDayCount).toBe(2);
  });

  it("prefers the running meeting over one starting sooner from now", () => {
    const view = meetingsView(
      upcoming([
        meeting("work", "Standup", NOW - 10 * MINUTE, 35),
        meeting("personal", "Call", NOW + 5 * MINUTE, 20),
      ]),
      NOW,
    );

    expect(view.hero?.title).toBe("Standup");
    expect(view.followers.map((m) => m.title)).toEqual(["Call"]);
  });

  it("drops meetings that have already finished", () => {
    const view = meetingsView(
      upcoming([
        meeting("work", "Yesterday's retro", NOW - 3 * HOUR, 30),
        meeting("work", "Standup", NOW + 25 * MINUTE, 15),
      ]),
      NOW,
    );

    expect(view.hero?.title).toBe("Standup");
    expect(view.followers).toEqual([]);
  });

  it("declines a hero for tomorrow and names it as the clear-until fact instead", () => {
    const view = meetingsView(
      upcoming([meeting("work", "Board prep", at(1, 9, 30), 60)]),
      NOW,
    );

    expect(view.hero).toBeNull();
    expect(view.nextTimed?.title).toBe("Board prep");
  });
});
