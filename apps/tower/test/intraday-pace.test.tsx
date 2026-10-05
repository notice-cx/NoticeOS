// Today's pace stays silent until its hours can carry a verdict, names the
// hours it compares, and the chart's now point waits at the clock while the
// provider's data lags (bead ro-trai.43).
//
// The numbers are the operator's report of 2026-09-24: at 07:25 on the OS
// clock GA4's hourly series for the first site held hours 0–2 only —
// [hour, today, last week] = [0, 30, 50], [1, 22, 50], [2, 5, 44] — and the
// Wall printed "↓48%" in red for hours 0–1 (52 vs 100 users).

import { render } from "./render";
import { describe, expect, it } from "vitest";
import type { Ga4HourlyActiveUsers, Ga4RealtimePayload } from "@noticeos/contract";
import { NO_READS } from "@shared/connection-status";
import { SiteRows } from "@/components/wall/SiteRows";
import {
  PACE_VERDICT_MINIMUM,
  clockHourLabel,
  clockHourNow,
  intradayUsersPace,
  paceWindowLabel,
} from "@/lib/intraday-pace";
import { wallIssues } from "@/lib/wall-issues";
import { wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const ZONE = "America/Los_Angeles";
/** 07:25 on the Pacific clock on the fixture's day. */
const BREAKFAST = Date.parse("2026-09-22T14:25:00.000Z");
/** 11:25 on the Pacific clock. */
const LATE_MORNING = Date.parse("2026-09-22T18:25:00.000Z");

/** A day of hours: `today` for the hours reported so far, last week for all 24. */
function hours(today: number[], lastWeek: (hour: number) => number): Ga4HourlyActiveUsers[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, today: today[hour] ?? null, sameDayLastWeek: lastWeek(hour) }));
}

/** The night of the report: hours 0–2, hour 2 still filling. */
const NIGHT = hours([30, 22, 5], (hour) => [50, 50, 44][hour] ?? 300);
/** Six completed hours (0–5) holding 3,000 of last week's users, hour 6 filling. */
const SIX_HOURS = hours([450, 450, 450, 450, 450, 450, 90], (hour) => (hour < 6 ? 500 : 600));

const asset = wallFixturePayload().assets[0]!;
function snapshotOf(hourly: Ga4HourlyActiveUsers[]): Ga4RealtimePayload["assets"][number] {
  const base = wallFixtureRealtime().assets.find((one) => one.asset === asset.id)!;
  if (base.status !== "success") throw new Error("the fixture's first site reads successfully");
  return { ...base, hourlyActiveUsers: hourly, timeZone: ZONE };
}

describe("intradayUsersPace: no percent until the hours can carry one", () => {
  it("states no percent for the report's two night hours (52 vs 100 users), only how far the data reaches", () => {
    const pace = intradayUsersPace(asset, snapshotOf(NIGHT))!;
    expect(pace.dataHours).toBe(2);
    expect(pace.lastWeekPace).toBe(100);
    expect(pace.todayPace).toBe(52);
    expect(pace.paceChange).toBeNull();
    expect(paceWindowLabel(pace)).toBe("to 2 AM");
  });

  it("states the percent once six completed hours hold 3,000 of last week's users, and names them", () => {
    const pace = intradayUsersPace(asset, snapshotOf(SIX_HOURS))!;
    expect(pace.dataHours).toBe(6);
    expect(pace.lastWeekPace).toBe(3_000);
    expect(pace.paceChange).toBeCloseTo(-10, 5);
    expect(paceWindowLabel(pace)).toBe("to 6 AM");
  });

  it("needs both: enough hours WITH DATA and enough of last week's users in them", () => {
    const { minDataHours, minLastWeekUsers } = PACE_VERDICT_MINIMUM;
    const enoughUsers = (hoursDone: number) => Math.ceil(minLastWeekUsers / hoursDone);
    // One hour short, with users to spare: silent.
    const short = hours([...Array(minDataHours - 1).fill(1_000), 10], () => 1_000);
    expect(intradayUsersPace(asset, snapshotOf(short))!.paceChange).toBeNull();
    // Hours enough, one user short of the floor in all of them: silent.
    const thin = hours([...Array(minDataHours).fill(1), 1], (hour) => (hour === 0 ? minLastWeekUsers - minDataHours : 1));
    expect(intradayUsersPace(asset, snapshotOf(thin))!.lastWeekPace).toBe(minLastWeekUsers - 1);
    expect(intradayUsersPace(asset, snapshotOf(thin))!.paceChange).toBeNull();
    // Exactly at both: a percent.
    const at = hours([...Array(minDataHours).fill(enoughUsers(minDataHours)), 1], () => enoughUsers(minDataHours));
    expect(intradayUsersPace(asset, snapshotOf(at))!.paceChange).toBe(0);
  });

  it("reads the hour on a 12-hour clock and places now on the snapshot's clock", () => {
    expect([0, 2, 11, 12, 13, 23, 24].map(clockHourLabel)).toEqual(["12 AM", "2 AM", "11 AM", "12 PM", "1 PM", "11 PM", "12 AM"]);
    expect(clockHourNow(BREAKFAST, ZONE)).toBeCloseTo(7 + 25 / 60, 5);
    expect(clockHourNow(BREAKFAST, "America/New_York")).toBeCloseTo(10 + 25 / 60, 5);
    expect(clockHourNow(BREAKFAST, "Not/AZone")).toBeNull();
  });
});

function drawRow(hourly: Ga4HourlyActiveUsers[], nowMs: number) {
  const realtime = wallFixtureRealtime();
  const payload: Ga4RealtimePayload = {
    ...realtime,
    assets: realtime.assets.map((one) => (one.asset === asset.id ? snapshotOf(hourly) : one)),
  };
  const assets = wallFixturePayload().assets;
  const container = render(
    <SiteRows assets={assets} issues={wallIssues({ assets, attention: [], connections: NO_READS, nowMs })} ga4Realtime={payload} nowMs={nowMs} />,
  ).container;
  return container.querySelector(`[data-site-row="${asset.id}"] [data-site-today]`)!;
}

/** Where an hour sits across the chart's 1000-wide viewBox (SiteRows' hourX). */
const x = (hour: number) => (2 + (hour / 23) * 96) * 10;

describe("the Wall's today cell", () => {
  it("while the hours carry no verdict: the window alone, muted, no percent, no tone", () => {
    const today = drawRow(NIGHT, BREAKFAST);
    expect(today.textContent).toBe("to 2 AM");
    expect(today.querySelector('[data-pace-window="silent"]')?.className).toContain("text-muted-foreground");
    expect(today.querySelector("[aria-label]")).toBeNull();
    expect(today.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("neutral");
  });

  it("once they do: the percent with the hours it compares beside it", () => {
    const today = drawRow(SIX_HOURS, LATE_MORNING);
    expect(today.querySelector('[data-pace-window="shown"]')?.textContent).toBe("10% behindto 6 AM");
    expect(today.querySelector('[data-pace-window="shown"] [aria-label]')?.getAttribute("aria-label"))
      .toMatch(/^10% behind; completed hours today vs /u);
    // The direction figure and the chart agree on the same comparable hours.
    const tones = [...today.querySelectorAll("[data-tone]")].map((element) => element.getAttribute("data-tone"));
    expect(tones).toEqual(["pace-behind", "pace-behind"]);
  });

  it("puts the breathing now point at the clock and ends today's line where the data ends", () => {
    const today = drawRow(NIGHT, BREAKFAST);
    const end = today.querySelector("[data-data-end]")!;
    const now = today.querySelector("[data-now]")!;
    // The line's last point is hour 2, still; the clock is 07:25, breathing, on the floor.
    expect(Number(end.getAttribute("data-x"))).toBeCloseTo(x(2), 5);
    expect(end.querySelector("[data-chart-breathe]")).toBeNull();
    expect(Number(now.getAttribute("data-x"))).toBeCloseTo(x(7 + 25 / 60), 5);
    expect(Number(now.getAttribute("data-y"))).toBe(100);
    expect(now.querySelector("[data-chart-breathe]")).not.toBeNull();
  });

  it("keeps the now point on the line while the newest hour is the one the clock is in", () => {
    // Data through hour 6 (filling) at 06:40: current, no lag to draw.
    const today = drawRow(SIX_HOURS, Date.parse("2026-09-22T13:40:00.000Z"));
    expect(today.querySelector("[data-data-end]")).toBeNull();
    const now = today.querySelector("[data-now]")!;
    expect(now.hasAttribute("data-filling-hour")).toBe(true);
    expect(Number(now.getAttribute("data-x"))).toBeCloseTo(x(6), 5);
    expect(now.querySelector("[data-chart-breathe]")).not.toBeNull();
  });
});
