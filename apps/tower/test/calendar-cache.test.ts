import { describe, expect, it } from "vitest";
import type { CalendarUpcoming } from "@noticeos/contract";
import { createCalendarCache, retainCalendarEvents } from "@/lib/calendar-cache";

const snapshot: CalendarUpcoming = {
  fetchedAt: "2026-10-05T12:00:00Z", feedsConfigured: 1, feedsOk: 1,
  calendars: [{ id: "work", status: "ok", color: null }],
  meetings: [{ calendar: "work", title: "Partner review", startsAt: "2026-10-05T14:00:00Z", endsAt: "2026-10-05T15:00:00Z", allDay: false, location: null }],
};
const owner = { mode: "hosted" as const, principalId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333", clientGeneration: 1 };
const active = () => {};

describe("same-tab calendar continuity", () => {
  it("restores its verified owner's events across a reload, never another session or workspace", () => {
    sessionStorage.clear();
    createCalendarCache(owner, sessionStorage, active, active).write(snapshot);
    expect(createCalendarCache({ ...owner, clientGeneration: 2 }, sessionStorage, active, active).read()).toEqual(snapshot);
    expect(createCalendarCache({ ...owner, workspaceId: "44444444-4444-4444-8444-444444444444" }, sessionStorage, active, active).read()).toBeUndefined();
    expect(createCalendarCache({ ...owner, sessionId: "55555555-5555-4555-8555-555555555555" }, sessionStorage, active, active).read()).toBeUndefined();
    expect(createCalendarCache({ ...owner, principalId: "66666666-6666-4666-8666-666666666666" }, sessionStorage, active, active).read()).toBeUndefined();
  });

  it("rejects corrupt bytes and safely works when browser storage is blocked", () => {
    sessionStorage.clear();
    const cache = createCalendarCache(owner, sessionStorage, active, active);
    cache.write(snapshot);
    sessionStorage.setItem(sessionStorage.key(0)!, '{"meetings":[]}');
    expect(cache.read()).toBeUndefined();
    expect(sessionStorage.length).toBe(0);
    const blocked = new Proxy(sessionStorage, { get() { throw new Error("Storage blocked"); } });
    const unavailable = createCalendarCache(owner, blocked, active, active);
    expect(() => unavailable.write(snapshot)).not.toThrow();
    expect(unavailable.read()).toBeUndefined();
  });

  it("forgets events when feeds are removed and refuses a retired owner's cache", () => {
    sessionStorage.clear();
    let retired = false;
    const assertActive = () => { if (retired) throw new Error("Retired"); };
    const cache = createCalendarCache(owner, sessionStorage, assertActive, assertActive);
    cache.write(snapshot);
    cache.write({ ...snapshot, feedsConfigured: 0, feedsOk: 0, calendars: [], meetings: [] });
    expect(cache.read()).toBeUndefined();
    retired = true;
    expect(() => cache.read()).toThrow("Retired");
    expect(() => cache.write(snapshot)).toThrow("Retired");
  });

  it("updates healthy feeds while keeping failed-feed events and their original reading age", () => {
    const fresh: CalendarUpcoming = { ...snapshot, fetchedAt: "2026-10-05T12:05:00Z", feedsConfigured: 2,
      calendars: [{ id: "work", status: "unreachable", color: null }, { id: "personal", status: "ok", color: null }],
      meetings: [{ ...snapshot.meetings[0]!, calendar: "personal", title: "Lunch" }] };
    const held = retainCalendarEvents(fresh, snapshot);
    expect(held.meetings.map(meeting => meeting.title)).toEqual(["Lunch", "Partner review"]);
    expect(Date.parse(held.fetchedAt)).toBe(Date.parse(snapshot.fetchedAt));
    expect(retainCalendarEvents({ ...fresh, calendars: fresh.calendars.slice(1), feedsConfigured: 1 }, snapshot).meetings.map(meeting => meeting.title)).toEqual(["Lunch"]);
  });
});
