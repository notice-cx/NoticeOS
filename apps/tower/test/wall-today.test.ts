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
  it("preserves genuine zeros and resolves the current date on the snapshot's calendar", () => {
    const { asset, snapshot } = fixture();
    snapshot.timeZone = "Pacific/Auckland";
    asset.activeUsers.series = [{ t: "2026-09-16", v: 0 }, { t: "2026-09-23", v: 0 }];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ date: "2026-09-23", today: 0, reference: 0 });
  });
  it("does not guess a date without timezone metadata or invent a count for an unreported day", () => {
    const { asset, snapshot } = fixture();
    expect(todayUserCounts(asset, undefined, nowMs)).toMatchObject({ today: null, reference: null, date: null });
    asset.activeUsers.series = [];
    asset.activeUsers.contextSeries = [];
    expect(todayUserCounts(asset, snapshot, nowMs)).toMatchObject({ today: null, reference: null });
  });
});
