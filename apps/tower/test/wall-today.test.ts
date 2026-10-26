import { describe, expect, it } from "vitest";
import { estimatedTodayUsers, todayUserCounts } from "@/lib/wall-today";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

describe("the Today daily distinct-user totals", () => {
  const nowMs = Date.parse(WALL_FIXTURE_NOW);
  function fixture() {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    const snapshot = wallFixtureRealtime().assets.find(row => row.asset === asset.id)!;
    if (snapshot.status !== "success") throw new Error("Fixture must provide successful realtime metadata");
    return { asset, snapshot };
  }
  it("uses exact current and seven-days-earlier dates independently of hourly bucket totals", () => {
    const { asset, snapshot } = fixture();
    snapshot.timeZone = "America/Los_Angeles";
    asset.activeUsers.series = [{ t: "2026-09-15", v: 123 }, { t: "2026-09-22", v: 456 }];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ date: "2026-09-22", referenceDate: "2026-09-15", today: 456, reference: 123 });
    snapshot.hourlyActiveUsers = [{ hour: 0, today: 999, sameDayLastWeek: 999 }];
    expect(todayUserCounts(asset, snapshot, nowMs).today).toBe(456);
  });
  it("keeps an earlier latest daily count unavailable today, while retaining a known reference", () => {
    const { asset, snapshot } = fixture();
    snapshot.timeZone = "America/Los_Angeles";
    asset.activeUsers.series = [{ t: "2026-09-21", v: 999 }];
    asset.activeUsers.contextSeries = [{ t: "2026-09-15", v: 81 }];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ today: null, reference: 81 });
  });
  it("preserves genuine zeros and resolves the current date on the provider's calendar", () => {
    const { asset, snapshot } = fixture();
    snapshot.timeZone = "Pacific/Auckland";
    asset.activeUsers.timeZone = "Pacific/Auckland";
    asset.activeUsers.series = [{ t: "2026-09-16", v: 0 }, { t: "2026-09-23", v: 0 }];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ date: "2026-09-23", today: 0, reference: 0 });
  });
  it("does not guess a date without timezone metadata or invent a count for an unreported day", () => {
    const { asset, snapshot } = fixture();
    delete asset.activeUsers.timeZone;
    expect(todayUserCounts(asset, undefined, nowMs)).toMatchObject({ today: null, reference: null, date: null });
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ today: null, reference: null, date: null, timeZone: null, activityDateMatches: false });
    asset.activeUsers.timeZone = "America/Los_Angeles";
    asset.activeUsers.series = [];
    asset.activeUsers.contextSeries = [];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ today: null, reference: null });
  });
  it("prefers the daily provider calendar when the realtime OS clock is on a different date", () => {
    const { asset, snapshot } = fixture();
    asset.activeUsers.timeZone = "America/Los_Angeles";
    snapshot.timeZone = "Pacific/Auckland";
    asset.activeUsers.series = [{ t: "2026-09-15", v: 71 }, { t: "2026-09-16", v: 82 }, { t: "2026-09-22", v: 123 }, { t: "2026-09-23", v: 456 }];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ timeZone: "America/Los_Angeles", date: "2026-09-22", today: 123, reference: 71, activityDateMatches: false });
    expect(todayUserCounts(asset, undefined, nowMs)).toMatchObject({ today: 123, reference: 71 });
  });
  it.each([
    ["2026-03-08T09:30:00Z", "2026-03-08", "2026-03-01"],
    ["2026-03-08T10:30:00Z", "2026-03-08", "2026-03-01"],
    ["2026-11-01T08:30:00Z", "2026-11-01", "2026-10-25"],
    ["2026-11-01T09:30:00Z", "2026-11-01", "2026-10-25"],
  ])("keeps daily dates correct across daylight saving changes at %s", (instant, date, referenceDate) => {
    const { asset, snapshot } = fixture();
    asset.activeUsers.timeZone = "America/Los_Angeles";
    snapshot.timeZone = "UTC";
    asset.activeUsers.series = [{ t: referenceDate, v: 10 }, { t: date, v: 20 }];
    expect(todayUserCounts(asset, snapshot, Date.parse(instant))).toMatchObject({ date, referenceDate, today: 20, reference: 10 });
  });
  it("keeps an invalid stored provider timezone unknown instead of replacing it with a different valid calendar", () => {
    const { asset, snapshot } = fixture();
    asset.activeUsers.timeZone = "Invalid/Provider";
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ date: null, referenceDate: null, today: null, reference: null });
  });
});

describe('estimated users today so far', () => {
  const nowMs = Date.parse('2026-09-22T02:00:00Z');
  function fixture() {
    const asset = structuredClone(wallFixturePayload().assets[0]!);
    const snapshot = structuredClone(wallFixtureRealtime().assets[0]!);
    if (snapshot.status !== 'success') throw new Error('expected success');
    asset.activeUsers = { ...asset.activeUsers, timeZone: 'UTC', timeZoneChanges: [], contextSeries: [],
      series: [{ t: '2026-09-15', v: 1440 }] };
    snapshot.realtimeDay = { date: '2026-09-22', timeZone: 'UTC', startAt: '2026-09-22T00:00:00Z', endAt: '2026-09-23T00:00:00Z',
      minutes: Array<number | null>(1440).fill(null), sameDayLastWeek: Array<number>(1440).fill(2) };
    for (let i = 0; i < 120; i++) snapshot.realtimeDay.minutes[i] = 4;
    return { asset, snapshot, day: snapshot.realtimeDay };
  }
  it('calibrates user-minutes into users rather than summing duplicate appearances or projecting the whole day', () => {
    const { asset, snapshot } = fixture();
    expect(estimatedTodayUsers(asset, snapshot, nowMs)).toMatchObject({ users: 240, observedMinutes: 120, estimatedMinutes: 0, through: '2026-09-22T02:00:00.000Z' });
  });
  it('estimates missing minutes with the historical profile rather than silently treating them as zero', () => {
    const { asset, snapshot, day } = fixture();
    for (let i = 0; i < 60; i++) day.minutes[i] = null;
    expect(estimatedTodayUsers(asset, snapshot, nowMs)).toMatchObject({ users: 240, observedMinutes: 60, estimatedMinutes: 60 });
    // A busier missing hour contributes more than a flat time extrapolation.
    day.sameDayLastWeek![0] = 122;
    expect(estimatedTodayUsers(asset, snapshot, nowMs)?.users).toBe(346);
  });
  it('preserves observed zero, stays above reported users, and accepts later GA4 revisions', () => {
    const { asset, snapshot, day } = fixture();
    for (let i = 0; i < 120; i++) day.minutes[i] = 0;
    expect(estimatedTodayUsers(asset, snapshot, nowMs)?.users).toBe(0);
    asset.activeUsers.series.push({ t: '2026-09-22', v: 300 });
    expect(estimatedTodayUsers(asset, snapshot, nowMs)?.users).toBe(300);
    asset.activeUsers.series[1]!.v = 250;
    expect(estimatedTodayUsers(asset, snapshot, nowMs)?.users).toBe(250);
  });
  it('ignores partial and future minutes and never grows an estimate just because the clock advanced', () => {
    const { asset, snapshot, day } = fixture();
    day.minutes[120] = 99999;
    expect(estimatedTodayUsers(asset, snapshot, nowMs)?.users).toBe(240);
    day.minutes[120] = null;
    expect(estimatedTodayUsers(asset, snapshot, nowMs + 60 * 60_000)).toMatchObject({ users: 240, through: '2026-09-22T02:00:00.000Z' });
    expect(estimatedTodayUsers(asset, snapshot, Date.parse(day.endAt))).toBeNull();
  });
  it.each([
    ['2026-03-08', '2026-03-01', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-03-10', '2026-03-03', '2026-03-10T07:00:00Z', '2026-03-11T07:00:00Z'],
    ['2026-11-01', '2026-10-25', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
    ['2026-11-03', '2026-10-27', '2026-11-03T08:00:00Z', '2026-11-04T08:00:00Z'],
  ])('does not treat a clock-aligned DST comparison as a full daily calibration on %s', (date, referenceDate, startAt, endAt) => {
    const { asset, snapshot, day } = fixture();
    asset.activeUsers.timeZone = 'America/Los_Angeles';
    asset.activeUsers.series = [{ t: referenceDate, v: 1440 }];
    Object.assign(day, { date, timeZone: 'America/Los_Angeles', startAt, endAt });
    expect(estimatedTodayUsers(asset, snapshot, Date.parse(startAt) + 4 * 60 * 60_000)).toBeNull();
  });
  it.each(['missing-reference', 'zero-reference', 'incomplete-prior', 'zero-prior', 'too-few-minutes', 'no-minutes', 'different-zone', 'changed-zone', 'invalid-minute'])(
    'declines an unsupported calibration: %s', mode => {
      const { asset, snapshot, day } = fixture();
      if (mode === 'missing-reference') asset.activeUsers.series = [];
      if (mode === 'zero-reference') asset.activeUsers.series[0]!.v = 0;
      if (mode === 'incomplete-prior') day.sameDayLastWeek![700] = null;
      if (mode === 'zero-prior') day.sameDayLastWeek!.fill(0);
      if (mode === 'too-few-minutes') day.minutes.fill(null, 14);
      if (mode === 'no-minutes') day.minutes.fill(null);
      if (mode === 'different-zone') asset.activeUsers.timeZone = 'Europe/London';
      if (mode === 'changed-zone') asset.activeUsers.timeZoneChanges = [{ effectiveOn: '2026-09-20', from: 'Europe/London', to: 'UTC' }];
      if (mode === 'invalid-minute') day.minutes[0] = NaN;
      expect(estimatedTodayUsers(asset, snapshot, nowMs)).toBeNull();
    });
});
