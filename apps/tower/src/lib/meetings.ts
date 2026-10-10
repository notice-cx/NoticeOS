// What today's meetings are, before anything draws them: the Wall's top strip
// reads it.
//
// Time math is entirely a function of the `nowMs` handed in, so a surface ages
// between polls without refetching and every state is reachable in a test
// without faking a clock.

import type { CalendarUpcoming, UpcomingMeeting } from "@noticeos/contract";

export type CalendarReadState = "loading" | "retrying" | "failed" | "partial";

export function calendarReadState(read: {
  data?: CalendarUpcoming;
  isError?: boolean;
  isPending?: boolean;
  fetchStatus?: string;
  consecutiveFailures?: number;
}): CalendarReadState | undefined {
  if (read.isError) return (read.consecutiveFailures ?? 3) >= 3 ? "failed" : "retrying";
  if (read.data && read.data.feedsOk < read.data.feedsConfigured) return (read.consecutiveFailures ?? 3) >= 3 ? "partial" : "retrying";
  if (read.isPending && read.fetchStatus !== "idle") return "loading";
  return undefined;
}

/** How many meetings follow the hero: what the panel's fixed height can hold
 * beside a hero at TV type size. */
export const MEETING_FOLLOWER_CAP = 3;

/**
 * Whether this snapshot licenses a surface to say anything at all.
 *
 * Two different absences render nothing, for the same reason: a TV that nags
 * about setup is worse than a TV with one fewer fact, and a calendar nobody
 * could read is not an empty calendar. No feed configured means the operator has
 * not set the secret up; no feed answered means we looked and learned nothing.
 * Only a snapshot with at least one readable feed may state "No meetings".
 */
export function meetingsPanelHasContent(
  data: CalendarUpcoming | null | undefined,
): data is CalendarUpcoming {
  return data !== null && data !== undefined && data.feedsConfigured > 0 && data.feedsOk > 0;
}

export interface MeetingsView {
  /** The meeting in progress, or the next one starting today. */
  hero: UpcomingMeeting | null;
  /** Up to `MEETING_FOLLOWER_CAP` timed meetings after the hero. */
  followers: UpcomingMeeting[];
  /** With no hero, the next timed meeting in the window — the "clear until" fact. */
  nextTimed: UpcomingMeeting | null;
  /** All-day events still ahead. Counted, never listed. */
  allDayCount: number;
}

/**
 * Split one snapshot into the three things a surface renders.
 *
 * All-day events are excluded from the hero and the rows on purpose: an all-day
 * event has no time to be early for, so a distance figure over it would be
 * fiction. They survive as a count.
 *
 * The hero is deliberately TODAY-only. A hero reading "in 26h" answers a
 * question nobody asks; "Clear until Tue 9:30 AM" answers the one they do.
 */
export function meetingsView(data: CalendarUpcoming, nowMs: number): MeetingsView {
  const dated = data.meetings.filter(
    (meeting) =>
      Number.isFinite(Date.parse(meeting.startsAt)) &&
      Number.isFinite(Date.parse(meeting.endsAt)),
  );
  // Already over is already over; the producer's window includes in-progress
  // events and a held snapshot ages past some of them between polls.
  const ahead = dated.filter((meeting) => Date.parse(meeting.endsAt) > nowMs);
  const timed = ahead
    .filter((meeting) => !meeting.allDay)
    .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));

  const heroIndex = timed.findIndex(
    (meeting) =>
      isInProgress(meeting, nowMs) || sameLocalDay(Date.parse(meeting.startsAt), nowMs),
  );
  const hero = heroIndex === -1 ? null : timed[heroIndex]!;
  return {
    hero,
    followers:
      heroIndex === -1
        ? []
        : timed.slice(heroIndex + 1, heroIndex + 1 + MEETING_FOLLOWER_CAP),
    nextTimed: hero ? null : (timed[0] ?? null),
    allDayCount: ahead.filter((meeting) => meeting.allDay).length,
  };
}

export function isInProgress(meeting: UpcomingMeeting, nowMs: number): boolean {
  return Date.parse(meeting.startsAt) <= nowMs && Date.parse(meeting.endsAt) > nowMs;
}

/**
 * The hero's anchor figure: `now · 12m left` while it is running, `in 25m`
 * before it starts. Minutes floor rather than round, so the figure never claims
 * more time than there is.
 */
export function formatMeetingDistance(meeting: UpcomingMeeting, nowMs: number): string {
  if (isInProgress(meeting, nowMs)) {
    return `now · ${formatSpan(Date.parse(meeting.endsAt) - nowMs)} left`;
  }
  return `in ${formatSpan(Date.parse(meeting.startsAt) - nowMs)}`;
}

function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * A meeting's clock time in the VIEWER's zone, in whatever hour convention this
 * browser's locale uses — the same `Intl` defaults every clock on the page
 * formats with, so they can never disagree about what 9:30 means. A start on
 * another calendar day carries its weekday, because "9:30 AM" with no day could
 * send somebody to the wrong meeting.
 */
export function formatMeetingClock(startsAt: string, nowMs: number): string {
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs)) return "";
  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(startMs);
  if (sameLocalDay(startMs, nowMs)) return clock;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(startMs);
  return `${weekday} ${clock}`;
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
