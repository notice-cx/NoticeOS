// @vitest-environment node
// The site region's read model: what one site shown in depth reads from the
// payload it already has, and when a tile has nothing to show.

import { describe, expect, it } from "vitest";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { AssetCard, SeriesPoint, SignalTrend } from "@shared/wall";
import { FOUR_WEEKS, currentHourlyReading, latestFinishedUsers, focusTiles, fourWeeks, revenueByDay, searchTile, todayTile, visitorsTile } from "@/lib/wall-sites";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const NOW = Date.parse(WALL_FIXTURE_NOW);
const plate = () => wallFixturePayload().assets[0]!;
const snapshot = () => wallFixtureRealtime().assets[0]!;

const projection = (points: RevenueProjection["points"]): RevenueProjection => ({
  period: "2026-09", status: "ready", reason: null, reportedThrough: "2026-09-02", earnedMinor: 2_500,
  projectedMinor: 4_000, dailyPaceMinor: 1_500, previousPeriod: "2026-08", previousMonthMinor: null,
  changePercent: null, historyDays: 30, holidayHistoryDays: 0, points,
});

describe("each day's money", () => {
  it("is the running total's step from one reported day to the next, never a projected day", () => {
    const days = revenueByDay(
      projection([
        { date: "2026-09-01", cumulativeMinor: 1_000, projected: false },
        { date: "2026-09-02", cumulativeMinor: 2_500, projected: false },
        { date: "2026-09-03", cumulativeMinor: 4_000, projected: true },
      ]),
      undefined,
    );
    expect([...days]).toEqual([["2026-09-01", 10], ["2026-09-02", 15]]);
  });

  it("takes yesterday's saved estimate when the projection does not reach it, and never overrides a reported day", () => {
    const summary = (date: string, amountMinor: number | null) => ({ date, amountMinor, reportedThrough: date, timeZone: "America/Los_Angeles" });
    expect([...revenueByDay(undefined, summary("2026-09-21", 4_318))]).toEqual([["2026-09-21", 43.18]]);
    // Missing is not zero.
    expect(revenueByDay(undefined, summary("2026-09-21", null)).size).toBe(0);
    const reported = projection([{ date: "2026-09-01", cumulativeMinor: 1_000, projected: false }]);
    expect(revenueByDay(reported, summary("2026-09-01", 999)).get("2026-09-01")).toBe(10);
  });
});

describe("the visitors and money tile", () => {
  const site = (provisionalFrom: string): AssetCard => ({
    ...plate(),
    activeUsers: {
      series: [{ t: "2026-09-01", v: 500 }, { t: "2026-09-02", v: 1_000 }, { t: "2026-09-03", v: 300 }],
      provisionalFrom, collectedAt: WALL_FIXTURE_NOW, timeZoneChanges: [],
    },
    revenueProjection: projection([
      { date: "2026-09-01", cumulativeMinor: 1_000, projected: false },
      { date: "2026-09-02", cumulativeMinor: 2_500, projected: false },
      { date: "2026-09-03", cumulativeMinor: 4_000, projected: true },
    ]),
    dailyRevenue: undefined,
  });

  it("states revenue per 1,000 visitors on the newest day with a report and a finished count", () => {
    const tile = visitorsTile(site("2026-09-03"))!;
    expect(tile.perThousand).toEqual({ date: "2026-09-02", value: 15 });
    expect(tile.days.map((day) => [day.day, day.visitors, day.revenue, day.provisional])).toEqual([
      [1, 500, 10, false],
      [2, 1_000, 15, false],
      [3, 300, null, true],
    ]);
    expect(tile.hasMoney).toBe(true);
  });

  it("never divides by a day still being counted", () => {
    expect(visitorsTile(site("2026-09-02"))!.perThousand).toEqual({ date: "2026-09-01", value: 20 });
  });

  it("is absent for a site with neither visitors nor money this month", () => {
    const bare: AssetCard = {
      ...plate(),
      activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      revenueProjection: undefined,
      dailyRevenue: undefined,
    };
    expect(visitorsTile(bare)).toBeNull();
    // A series whose points are not calendar days has no month to draw.
    const unlabelled: AssetCard = {
      ...bare,
      activeUsers: { series: [{ t: "d01", v: 12 }, { t: "d02", v: 14 }], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    };
    expect(visitorsTile(unlabelled)).toBeNull();
  });
});

describe("the today tile", () => {
  it("states today's distinct users only while the daily series' newest day is today", () => {
    expect(todayTile(plate(), snapshot(), NOW)!.todayUsers).toBe(plate().activeUsers.series.at(-1)!.v);
    const yesterdayOnly: AssetCard = {
      ...plate(),
      activeUsers: { ...plate().activeUsers, series: plate().activeUsers.series.slice(0, -1) },
    };
    expect(todayTile(yesterdayOnly, snapshot(), NOW)!.todayUsers).toBeNull();
  });

  it("is absent without a successful snapshot carrying hours", () => {
    expect(todayTile(plate(), undefined, NOW)).toBeNull();
    const snap = snapshot();
    if (snap.status !== "success") throw new Error("fixture snapshot is a success");
    expect(todayTile(plate(), { ...snap, hourlyActiveUsers: null }, NOW)).toBeNull();
  });
});

describe("the search tile", () => {
  it("is absent for a site with no search source, and four weeks of finished days otherwise", () => {
    expect(searchTile(plate())).toBeNull();
    const users = plate().activeUsers;
    const tile = searchTile({ ...plate(), searchClicks: users })!;
    // Four weeks through the newest finished day, the day still being counted
    // left out, over the four weeks before (the site rows' `fourWeeks`).
    expect(tile.weeks.days).toHaveLength(FOUR_WEEKS);
    expect(tile.latest.t < users.provisionalFrom!).toBe(true);
    expect(tile.weeks.days.at(-1)!.date).toBe(tile.latest.t);
    expect(tile.weeks.hasPrior).toBe(true);
  });

  it("is one of three independent answers", () => {
    const tiles = focusTiles(plate(), snapshot(), NOW);
    expect([tiles.today !== null, tiles.visitors !== null, tiles.search !== null]).toEqual([true, true, false]);
  });
});

// A site's line is the last four finished weeks over the four before,
// weekday under weekday, and its % compares the same two spans.
describe("four weeks against the four before", () => {
  const END = "2026-09-21";
  /** `values` as consecutive days ending on `last`. */
  const dated = (values: number[], last = END): SeriesPoint[] => {
    const endMs = Date.parse(`${last}T00:00:00.000Z`);
    return values.map((v, i) => ({ t: new Date(endMs - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10), v }));
  };
  /** A trend as the payload carries it: the last 28 days drawn, the rest
   * before them; a provisional today when one is given. */
  const trend = (values: number[], options: { today?: number; timeZoneChanges?: SignalTrend["timeZoneChanges"] } = {}): SignalTrend => {
    const all = options.today === undefined ? dated(values) : dated([...values, options.today], "2026-09-22");
    return {
      contextSeries: all.slice(0, Math.max(0, all.length - FOUR_WEEKS)),
      series: all.slice(-FOUR_WEEKS),
      provisionalFrom: options.today === undefined ? null : "2026-09-22",
      collectedAt: null,
      timeZoneChanges: options.timeZoneChanges ?? [],
    };
  };
  const flat = (before: number, after: number) => [...Array<number>(FOUR_WEEKS).fill(before), ...Array<number>(FOUR_WEEKS).fill(after)];

  it("compares the last 28 finished days' total with the 28 before, each day beside the same weekday", () => {
    const weeks = fourWeeks(trend(flat(100, 118)))!;
    expect(weeks.days).toHaveLength(FOUR_WEEKS);
    expect(weeks.days[0]).toEqual({ date: "2026-08-25", value: 118, prior: 100 });
    expect(weeks.days.at(-1)).toEqual({ date: END, value: 118, prior: 100 });
    const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
    expect(weekday("2026-08-25")).toBe(weekday("2026-07-28"));
    expect(weeks.hasPrior).toBe(true);
    expect(weeks.change!.percent).toBeCloseTo(18, 6);
    expect(weeks.change!.tone).toBe("positive");
  });

  it("leaves the day still being counted out of the line and the %", () => {
    const weeks = fourWeeks(trend(flat(100, 100), { today: 3 }))!;
    expect(weeks.days.at(-1)!.date).toBe(END);
    expect(weeks.days.some((day) => day.value === 3)).toBe(false);
    expect(weeks.change).toEqual({ percent: 0, tone: "neutral" });
  });

  it("draws no dashed weeks and states no % with fewer than 56 finished days — never a fake 0", () => {
    const young = fourWeeks(trend(Array<number>(40).fill(100)))!;
    expect(young.days.filter((day) => day.value !== null)).toHaveLength(FOUR_WEEKS);
    expect(young.hasPrior).toBe(false);
    expect(young.change).toBeNull();
    // One unreported day in the earlier span is not a whole span either.
    const gap = trend(flat(100, 100));
    gap.contextSeries = gap.contextSeries!.filter((point) => point.t !== "2026-08-01");
    expect(fourWeeks(gap)).toMatchObject({ hasPrior: false, change: null });
    // Four weeks of zeros before have no percent to be compared with.
    expect(fourWeeks(trend(flat(0, 5)))!.change).toBeNull();
  });

  it("keeps the % but withdraws its colour when the 56 days span a reporting-timezone change", () => {
    const move = (effectiveOn: string) => [{ effectiveOn, from: "America/New_York", to: "America/Los_Angeles" }];
    expect(fourWeeks(trend(flat(100, 80), { timeZoneChanges: move("2026-08-10") }))!.change).toEqual({ percent: -20, tone: "neutral" });
    // A move before the window splits nothing in it.
    expect(fourWeeks(trend(flat(100, 80), { timeZoneChanges: move("2026-07-20") }))!.change!.tone).toBe("negative");
  });

  it("is absent with no finished day at all", () => {
    expect(fourWeeks({ series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] })).toBeNull();
  });
});


describe("dated site traffic", () => {
  it("reads the newest actual finished day, preserving zero and gaps", () => {
    const trend: SignalTrend = { series: [{ t: "2026-09-18", v: 90 }, { t: "2026-09-20", v: 0 }, { t: "2026-09-22", v: 8 }], provisionalFrom: "2026-09-22", collectedAt: WALL_FIXTURE_NOW, timeZoneChanges: [] };
    expect(latestFinishedUsers(trend)).toEqual({ t: "2026-09-20", v: 0 });
    expect(trend.series).toHaveLength(3);
    expect(latestFinishedUsers({ ...trend, series: [] })).toBeNull();
    expect(latestFinishedUsers({ ...trend, series: [{ t: "2026-09-22", v: 8 }] })).toBeNull();
  });

  it("cannot label an invalid date or invalid number as saved daily history", () => {
    const trend: SignalTrend = { series: [{ t: "2026-02-31", v: 3 }, { t: "2026-09-20", v: Number.NaN }, { t: "2026-09-19", v: -1 }, { t: WALL_FIXTURE_NOW, v: 8 }], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    expect(latestFinishedUsers(trend)).toBeNull();
  });

  it("keeps valid current-day hourly mode, including measured zero and stale same-day reads", () => {
    const read = snapshot();
    if (read.status !== "success") throw new Error("expected hourly fixture");
    expect(currentHourlyReading(read, NOW)).toBe(read);
    const stale = { ...read, observedAt: new Date(NOW - 20 * 60_000).toISOString(), hourlyObservedAt: new Date(NOW - 20 * 60_000).toISOString() };
    expect(currentHourlyReading(stale, NOW)).toBe(stale);
    const zero = { ...read, hourlyActiveUsers: read.hourlyActiveUsers!.map(hour => ({ ...hour, today: hour.today === null ? null : 0 })) };
    expect(currentHourlyReading(zero, NOW)).toBe(zero);
  });

  it("uses the hourly observation's own calendar date, not a newer realtime timestamp", () => {
    const read = snapshot();
    if (read.status !== "success") throw new Error("expected hourly fixture");
    const previous = { ...read, hourlyObservedAt: "2026-09-21T12:00:00Z", observedAt: WALL_FIXTURE_NOW };
    expect(currentHourlyReading(previous, NOW)).toBeNull();
    expect(todayTile(plate(), previous, NOW)).toBeNull();
    const midnight = { ...read, timeZone: "America/Los_Angeles", hourlyObservedAt: "2026-09-22T06:00:00Z" };
    expect(currentHourlyReading(midnight, Date.parse("2026-09-22T06:30:00Z"))).toBe(midnight);
    expect(currentHourlyReading(midnight, Date.parse("2026-09-22T07:30:00Z"))).toBeNull();
    expect(currentHourlyReading({ ...read, timeZone: "not-a-zone" }, NOW)).toBeNull();
  });

  it("requires genuine hourly data rather than an empty successful response", () => {
    const read = snapshot();
    if (read.status !== "success") throw new Error("expected hourly fixture");
    expect(currentHourlyReading(undefined, NOW)).toBeNull();
    expect(currentHourlyReading({ ...read, hourlyActiveUsers: null }, NOW)).toBeNull();
    expect(currentHourlyReading({ ...read, hourlyActiveUsers: read.hourlyActiveUsers!.map(hour => ({ ...hour, today: null })) }, NOW)).toBeNull();
  });
});
