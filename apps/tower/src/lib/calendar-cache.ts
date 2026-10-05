import type { CalendarUpcoming } from "@noticeos/contract";
import { isCalendarUpcoming } from "./api";
import { createDisplayCache } from "./display-cache";
import type { BrowserOwner } from "./browser-owner";

/** A partial round updates readable feeds without erasing the failed feeds'
 * last known events. The aggregate age dates its oldest retained information. */
export function retainCalendarEvents(next: CalendarUpcoming, prior?: CalendarUpcoming): CalendarUpcoming {
  const failed = new Set(next.calendars.filter(feed => feed.status !== "ok").map(feed => feed.id));
  const retained = prior?.meetings.filter(meeting => failed.has(meeting.calendar)) ?? [];
  if (!prior || retained.length === 0) return next;
  return { ...next, fetchedAt: new Date(Math.min(Date.parse(next.fetchedAt), Date.parse(prior.fetchedAt))).toISOString(),
    meetings: [...next.meetings, ...retained] };
}

/** Same-tab display continuity, after the browser has verified its owner.
 * A new runtime generation can read its own events; a different session or
 * workspace cannot. No calendar feed address reaches this cache. */
export function createCalendarCache(owner: BrowserOwner, storage: Storage | undefined,
  assertActive: () => void, assertReadable: () => void) {
  return createDisplayCache(owner, storage, assertActive, assertReadable, "calendar-upcoming",
    (value): value is CalendarUpcoming => isCalendarUpcoming(value) && value.feedsConfigured > 0 && value.feedsOk > 0);
}
