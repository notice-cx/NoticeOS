import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "./render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarUpcoming } from "@noticeos/contract";
import { handleCalendarUpcomingRequest } from "../worker/calendar-upcoming-route";
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { fetchCalendarUpcoming } from "@/lib/api";
import { calendarReadState } from "@/lib/meetings";

const snapshot: CalendarUpcoming = {
  fetchedAt: "2026-08-10T16:00:00.000Z",
  feedsConfigured: 2,
  feedsOk: 2,
  calendars: [
    { id: "work", color: "#0b8043", status: "ok" },
    { id: "personal", color: null, status: "ok" },
  ],
  meetings: [
    {
      calendar: "work",
      title: "Standup",
      startsAt: "2026-08-10T16:30:00.000Z",
      endsAt: "2026-08-10T16:45:00.000Z",
      allDay: false,
      location: "Zoom",
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/calendar/upcoming", () => {
  it("forwards the ingest snapshot with no-store JSON headers", async () => {
    const ingest = { calendarUpcoming: vi.fn().mockResolvedValue(snapshot) };

    const res = await handleCalendarUpcomingRequest(
      new Request("http://tower.local/api/calendar/upcoming"),
      ingest,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual(snapshot);
    expect(ingest.calendarUpcoming).toHaveBeenCalledTimes(1);
  });

  it("answers a failed read with a code and nothing from behind the binding", async () => {
    const ingest = {
      calendarUpcoming: vi
        .fn()
        .mockRejectedValue(new Error("ics fetch failed for https://cal.example/private-abc123")),
    };

    const res = await handleCalendarUpcomingRequest(
      new Request("http://tower.local/api/calendar/upcoming"),
      ingest,
    );

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "calendar_upcoming_unavailable" });
    // The feed URL is the operator's secret; a leaked one is a leaked calendar.
    expect(body).not.toContain("cal.example");
    expect(body).not.toContain("private-abc123");
  });

  it("is a read: nothing else reaches the binding", async () => {
    const ingest = { calendarUpcoming: vi.fn().mockResolvedValue(snapshot) };

    const res = await handleCalendarUpcomingRequest(
      new Request("http://tower.local/api/calendar/upcoming", { method: "POST" }),
      ingest,
    );

    expect(res.status).toBe(405);
    expect(ingest.calendarUpcoming).not.toHaveBeenCalled();
  });
});

describe("calendar upcoming browser contract", () => {
  it("accepts a fully typed snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot)));

    await expect(fetchCalendarUpcoming()).resolves.toMatchObject({
      feedsConfigured: 2,
      meetings: [{ calendar: "work", title: "Standup" }],
    });
  });

  it("rejects a payload missing the feed counts", async () => {
    // The panel renders NOTHING when no feed is configured, so a payload that
    // lost the count must fail here rather than reach a surface that would read
    // the absence as "set up and clear".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ fetchedAt: snapshot.fetchedAt, calendars: [], meetings: [] }),
      ),
    );

    await expect(fetchCalendarUpcoming()).rejects.toThrow("invalid payload");
  });

  it("rejects a payload with no feed list, since order decides identity", async () => {
    const { calendars: _dropped, ...withoutFeeds } = snapshot;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(withoutFeeds)));

    await expect(fetchCalendarUpcoming()).rejects.toThrow("invalid payload");
  });

  it("keeps a pinned feed color exactly as the operator wrote it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(snapshot)));

    await expect(fetchCalendarUpcoming()).resolves.toMatchObject({
      calendars: [{ id: "work", color: "#0b8043", status: "ok" }, { id: "personal", color: null, status: "ok" }],
    });
  });

  it("rejects more feeds answering than were configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...snapshot, feedsConfigured: 1, feedsOk: 2 })),
    );

    await expect(fetchCalendarUpcoming()).rejects.toThrow("invalid payload");
  });

  it("accepts every feed status the panel knows how to act on", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...snapshot,
          feedsConfigured: 3,
          feedsOk: 1,
          calendars: [
            { id: "work", color: "#0b8043", status: "ok" },
            { id: "personal", color: null, status: "unreachable" },
            { id: "kids", color: null, status: "misconfigured" },
          ],
        }),
      ),
    );

    await expect(fetchCalendarUpcoming()).resolves.toMatchObject({
      calendars: [{ status: "ok" }, { status: "unreachable" }, { status: "misconfigured" }],
    });
  });

  it("rejects a feed status this build cannot act on", async () => {
    // `status` is a closed set, unlike the free-form color: each value becomes a
    // different instruction to the operator, so an unknown one must not slip
    // through and read as healthy.
    for (const status of ["throttled", "OK", "", null, undefined]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            ...snapshot,
            calendars: [{ id: "work", color: null, status }],
          }),
        ),
      );

      await expect(fetchCalendarUpcoming()).rejects.toThrow("invalid payload");
    }
  });

  it("rejects a meeting whose times are not instants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...snapshot,
          meetings: [{ ...snapshot.meetings[0]!, startsAt: "soon" }],
        }),
      ),
    );

    await expect(fetchCalendarUpcoming()).rejects.toThrow("invalid payload");
  });

  it("surfaces a 503 as a failed poll rather than an empty calendar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "calendar_upcoming_unavailable" }, { status: 503 }),
      ),
    );

    await expect(fetchCalendarUpcoming()).rejects.toThrow("failed: 503");
  });
});

// Bead `ro-ujb9.105`: this hook polled from hidden tabs on purpose, because
// "the TV is never focused". But TanStack's background is a HIDDEN page, not
// an unfocused one (`ro-ujb9.63`, test/wall-polling.test.tsx), so the TV keeps
// its minute either way, and only a desk tab nobody can see stops asking.
// Driven through the real hook, TanStack's focus manager and fake timers, so
// the assertions count requests, not option values.
describe("useCalendarUpcoming", () => {
  let visibility: DocumentVisibilityState = "visible";
  const fetchSpy = vi.fn();

  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }

  function renderCalendar() {
    // The desk's own defaults (src/main.tsx): no focus refetch unless a hook
    // asks for one, one retry.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
    });
    const hook = renderHook(() => useCalendarUpcoming(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    return { ...hook, client };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    // The TV's browser window is never the focused one.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    visibility = "visible";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps refreshing every minute while on screen, focused or not", async () => {
    renderCalendar();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("asks nothing while the tab is hidden, and refreshes at once on return", async () => {
    renderCalendar();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps the last good snapshot through a failed poll", async () => {
    const { client } = renderCalendar();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryState(["calendar-upcoming"])?.data).toEqual(snapshot);

    fetchSpy.mockImplementation(async () =>
      Response.json({ error: "calendar_upcoming_unavailable" }, { status: 503 }),
    );
    // The minute's poll, then its one retry. The panel reads this cache entry.
    await vi.advanceTimersByTimeAsync(60_000 + 5_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const state = client.getQueryState(["calendar-upcoming"]);
    expect(state?.status).toBe("error");
    expect(state?.data).toEqual(snapshot);
  });

  it("exposes an initial failed read and clears it when the next poll recovers", async () => {
    fetchSpy.mockImplementation(async () => Response.json({ error: "calendar_upcoming_unavailable" }, { status: 503 }));
    const hook = renderCalendar();
    expect(calendarReadState(hook.result.current)).toBe("loading");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calendarReadState(hook.result.current)).toBe("failed");
    expect(hook.result.current.data).toBeUndefined();

    fetchSpy.mockImplementation(async () => Response.json(snapshot));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calendarReadState(hook.result.current)).toBeUndefined();
    expect(hook.result.current.data).toEqual(snapshot);
  });

  it("holds readable events when all feeds fail, then accepts recovery and removal", async () => {
    const hook = renderCalendar();
    await vi.advanceTimersByTimeAsync(0);
    fetchSpy.mockImplementation(async () => Response.json({
      ...snapshot, feedsOk: 0, meetings: [],
      calendars: snapshot.calendars.map(feed => ({ ...feed, status: "unreachable" })),
    }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(calendarReadState(hook.result.current)).toBe("failed");
    expect(hook.result.current.data).toEqual(snapshot);

    fetchSpy.mockImplementation(async () => Response.json(snapshot));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calendarReadState(hook.result.current)).toBeUndefined();
    fetchSpy.mockImplementation(async () => Response.json({ ...snapshot, feedsConfigured: 0, feedsOk: 0, calendars: [], meetings: [] }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calendarReadState(hook.result.current)).toBeUndefined();
    expect(hook.result.current.data?.feedsConfigured).toBe(0);
  });
});
