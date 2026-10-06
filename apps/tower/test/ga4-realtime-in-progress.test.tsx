// Bead `ro-trai.40`: a GA4 read that is merely in progress — another caller
// holds it — says nothing new about a site, so the Wall's poll keeps what it
// drew instead of replacing the LIVE figure and the TODAY chart with a dash.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ga4RealtimeAsset, Ga4RealtimePayload } from "@noticeos/contract";
import { NO_READS } from "@shared/connection-status";
import { SiteRows } from "@/components/wall/SiteRows";
import { currentDayReadings, keepReadingsInProgress, useGa4Realtime } from "@/hooks/useGa4Realtime";
import { wallIssues } from "@/lib/wall-issues";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const fetchGa4Realtime = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchGa4Realtime,
}));

const NOW = Date.parse(WALL_FIXTURE_NOW);
const SITE = "menus.example";
const iso = (ms: number) => new Date(ms).toISOString();

type Reading = Extract<Ga4RealtimeAsset, { status: "success" }>;

/** The fixture's readings as ingest sends them: each dated by when its hours were read. */
function drawn(hoursReadAt = NOW - 5 * 60_000): Ga4RealtimePayload {
  const payload = wallFixtureRealtime();
  return {
    ...payload,
    assets: payload.assets.map((asset) => (asset.status === "success" ? { ...asset, hourlyObservedAt: iso(hoursReadAt) } : asset)),
  };
}

function reading(payload: Ga4RealtimePayload | undefined, asset = SITE): Reading {
  const found = payload?.assets.find((candidate) => candidate.asset === asset);
  if (found?.status !== "success") throw new Error(`expected a reading for ${asset}`);
  return found;
}

/** The next poll's payload, with one site's answer replaced. */
function nextPoll(previous: Ga4RealtimePayload, answer: (last: Reading) => Ga4RealtimeAsset, at = NOW + 30_000): Ga4RealtimePayload {
  return {
    ...previous,
    generatedAt: iso(at),
    assets: previous.assets.map((asset) => (asset.asset === SITE ? answer(reading(previous)) : asset)),
  };
}

/** A new live count; the hours held by another caller's read. */
const hoursInProgress = (last: Reading): Ga4RealtimeAsset => ({
  ...last,
  activeUsers30m: last.activeUsers30m + 4,
  observedAt: iso(NOW + 30_000),
  hourlyActiveUsers: null,
  hourlyErrorCode: "ga4_read_in_progress",
  hourlyObservedAt: iso(NOW + 30_000),
  hourlyNextAttemptAt: iso(NOW + 60_000),
});

const failed = (code: string) => (): Ga4RealtimeAsset => ({
  asset: SITE,
  status: "error",
  activeUsers5m: null,
  activeUsers30m: null,
  hourlyActiveUsers: null,
  observedAt: iso(NOW + 30_000),
  nextAttemptAt: iso(NOW + 60_000),
  errorCode: code,
});

describe("a read in progress keeps what the Wall drew", () => {
  it("keeps the hours while the hourly read is in progress, and takes the new live count", () => {
    const before = drawn();
    const kept = reading(keepReadingsInProgress(before, nextPoll(before, hoursInProgress)));
    expect(kept.hourlyActiveUsers).toEqual(reading(before).hourlyActiveUsers);
    expect(kept.hourlyErrorCode ?? null).toBeNull();
    expect(kept.hourlyObservedAt).toBe(reading(before).hourlyObservedAt);
    expect(kept.activeUsers30m).toBe(reading(before).activeUsers30m + 4);
    expect(kept.observedAt).toBe(iso(NOW + 30_000));
  });

  it("keeps the whole last reading, dated as it was, while the live read is in progress", () => {
    const before = drawn();
    const kept = keepReadingsInProgress(before, nextPoll(before, failed("ga4_read_in_progress")));
    expect(reading(kept)).toEqual(reading(before));
    expect(kept.generatedAt).toBe(iso(NOW + 30_000));
  });

  it("still replaces the reading when Google refused it", () => {
    const before = drawn();
    const refused = keepReadingsInProgress(before, nextPoll(before, failed("ga4_realtime_http_429")));
    expect(refused.assets.find((asset) => asset.asset === SITE)?.status).toBe("error");
    const hoursRefused = keepReadingsInProgress(
      before,
      nextPoll(before, (last) => ({ ...hoursInProgress(last), hourlyErrorCode: "ga4_intraday_http_429" })),
    );
    expect(reading(hoursRefused).hourlyActiveUsers).toBeNull();
    expect(reading(hoursRefused).hourlyErrorCode).toBe("ga4_intraday_http_429");
  });

  it("never carries yesterday's hours past midnight, or hours bucketed on another clock", () => {
    // Read at 11:55 PM on the fixture's clock; the next poll is after midnight.
    const lateEvening = Date.parse("2026-09-23T06:55:00.000Z");
    const before = drawn(lateEvening);
    const afterMidnight = Date.parse("2026-09-23T07:05:00.000Z");
    expect(reading(keepReadingsInProgress(before, nextPoll(before, hoursInProgress, afterMidnight))).hourlyActiveUsers).toBeNull();
    const liveHeld = reading(keepReadingsInProgress(before, nextPoll(before, failed("ga4_read_in_progress"), afterMidnight)));
    expect(liveHeld.activeUsers30m).toBe(reading(before).activeUsers30m);
    expect(liveHeld.hourlyActiveUsers).toBeNull();
    expect(liveHeld.hourlyErrorCode).toBe("ga4_read_in_progress");
    // A saved clock change re-buckets the hours: the old clock's are not kept.
    const today = drawn();
    const moved = nextPoll(today, (last) => ({ ...hoursInProgress(last), timeZone: "America/New_York" }));
    expect(reading(keepReadingsInProgress(today, moved)).hourlyActiveUsers).toBeNull();
  });

  it("changes nothing on the first answer, with nothing drawn yet", () => {
    const first = nextPoll(drawn(), hoursInProgress);
    expect(keepReadingsInProgress(undefined, first)).toBe(first);
  });

  it("discards saved hours before rendering a reload on the next local day", () => {
    const before = drawn(Date.parse("2026-09-23T06:55:00.000Z"));
    const restored = currentDayReadings(before, "2026-09-23T07:05:00.000Z");
    expect(reading(restored).hourlyActiveUsers).toBeNull();
    expect(reading(restored).activeUsers30m).toBe(reading(before).activeUsers30m);
    expect(restored.generatedAt).toBe(before.generatedAt);
    expect(reading(currentDayReadings(drawn(), iso(NOW))).hourlyActiveUsers).toEqual(reading(drawn()).hourlyActiveUsers);
  });

  it("dates saved hours without their own read time by the live read, as the chart does", () => {
    const undated = wallFixtureRealtime();
    expect(reading(undated).hourlyObservedAt).toBeUndefined();
    expect(reading(currentDayReadings(undated, iso(NOW))).hourlyActiveUsers).toEqual(reading(undated).hourlyActiveUsers);
    expect(reading(currentDayReadings(undated, "2026-09-23T07:05:00.000Z")).hourlyActiveUsers).toBeNull();
  });

  it("keeps current hours through a poll and dates unavailable-hour history", () => {
    const assets = structuredClone(wallFixturePayload().assets);
    assets.find(asset => asset.id === SITE)!.activeUsers = { series: [{ t: "2026-09-20", v: 17 }, { t: "2026-09-21", v: 0 }, { t: "2026-09-22", v: 50 }], provisionalFrom: "2026-09-22", collectedAt: "2026-09-22T19:24:00Z", timeZoneChanges: [] };
    const today = (realtime: Ga4RealtimePayload) =>
      render(
        <SiteRows
          assets={assets}
          issues={wallIssues({ assets, attention: [], connections: NO_READS, nowMs: NOW })}
          ga4Realtime={realtime}
          ga4RealtimeError={false}
          nowMs={NOW + 30_000}
        />,
      ).container.querySelector(`[data-site-row="${SITE}"]`)!;
    const before = drawn();
    const answer = nextPoll(before, hoursInProgress);
    const blank = today(answer);
    expect(blank.querySelector("[data-today]")).toBeNull();
    const history = blank.querySelector("[data-site-history]")!;
    expect(history.getAttribute("data-date")).toBe("2026-09-21");
    expect(history.querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-21");
    expect(history.textContent).toContain("Latest day");
    expect(history.textContent).toContain("0GA4 users");
    expect(blank.querySelector("[data-site-today]")).toBeNull();
    const kept = today(keepReadingsInProgress(before, answer));
    expect(kept.querySelector("[data-today]")).not.toBeNull();
    expect(kept.querySelector("[data-site-today]")?.textContent).toBe(today(before).querySelector("[data-site-today]")?.textContent);
    expect(kept.textContent).not.toBe("—");
  });
});

describe("the realtime poll", () => {
  beforeEach(() => {
    fetchGa4Realtime.mockReset();
    window.sessionStorage.clear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps the drawn hours through an in-progress answer", async () => {
    const before = drawn();
    fetchGa4Realtime.mockResolvedValueOnce(before).mockResolvedValueOnce(nextPoll(before, hoursInProgress));
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useGa4Realtime(), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(() => result.current.refetch());
    expect(fetchGa4Realtime).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(reading(result.current.data).activeUsers30m).toBe(reading(before).activeUsers30m + 4));
    expect(reading(result.current.data).hourlyActiveUsers).toEqual(reading(before).hourlyActiveUsers);
  });

  it("restores today's hours after a same-tab reload while the server's hourly read is in progress", async () => {
    const before = drawn();
    fetchGa4Realtime.mockResolvedValueOnce(before).mockResolvedValueOnce(nextPoll(before, hoursInProgress));
    const mount = () => {
      const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      return { client, hook: renderHook(() => useGa4Realtime(), { wrapper }) };
    };
    const first = mount();
    await waitFor(() => expect(first.hook.result.current.data).toBeDefined());
    first.hook.unmount();
    first.client.clear();
    vi.mocked(Date.now).mockReturnValue(NOW + 30_000);
    const reloaded = mount();
    expect(reading(reloaded.hook.result.current.data).hourlyActiveUsers).toEqual(reading(before).hourlyActiveUsers);
    await waitFor(() => expect(reading(reloaded.hook.result.current.data).activeUsers30m).toBe(reading(before).activeUsers30m + 4));
    expect(reading(reloaded.hook.result.current.data).hourlyObservedAt).toBe(reading(before).hourlyObservedAt);
    expect(fetchGa4Realtime).toHaveBeenCalledTimes(2);
    fetchGa4Realtime.mockResolvedValueOnce(nextPoll(before, failed("ga4_realtime_http_403")));
    await act(() => reloaded.hook.result.current.refetch());
    await waitFor(() => expect(reloaded.hook.result.current.data?.assets.find(asset => asset.asset === SITE)?.status).toBe("error"));
    reloaded.hook.unmount();
    reloaded.client.clear();
    const refused = mount();
    expect(refused.hook.result.current.data?.assets.find(asset => asset.asset === SITE)?.status).toBe("error");
    refused.hook.unmount();
    refused.client.clear();
  });
});
