import { describe, expect, it } from "vitest";
import { todayUserCounts } from "@/lib/wall-today";
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
