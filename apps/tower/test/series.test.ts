import { describe, expect, it } from "vitest";
import {
  rollingDailyAverage,
  rollingWeeklyChange,
  rollingWeeklyWindow,
  splitDailySeries,
} from "@/lib/series";

function days(count: number, start = "2026-07-01") {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => ({
    t: new Date(first + index * 86_400_000).toISOString().slice(0, 10),
    v: index + 1,
  }));
}

describe("daily trend helpers", () => {
  it("builds a seven-day average and compares complete windows a week apart", () => {
    const trend = rollingDailyAverage(days(21));
    expect(trend[0]).toEqual({ t: "2026-07-07", v: 4 });
    expect(trend.at(-1)).toEqual({ t: "2026-07-21", v: 18 });
    expect(rollingWeeklyChange(trend)).toBeCloseTo(63.64, 2);
  });

  it("excludes the provisional tail so partial today cannot fake a decline", () => {
    const series = [...days(14), { t: "2026-07-15", v: 0 }];
    const trend = rollingDailyAverage(series, 7, "2026-07-15");
    expect(trend.at(-1)).toEqual({ t: "2026-07-14", v: 11 });
  });

  /**
   * Bead `ro-kukv.13`. A surface asks whether the comparison it is about to
   * colour is clean, so the window has to be the SAME fourteen days
   * `rollingWeeklyChange` used — derived here once, never retyped beside a chip.
   */
  it("names the fourteen days the weekly change really compares", () => {
    const trend = rollingDailyAverage(days(21));
    expect(rollingWeeklyWindow(trend)).toEqual({
      start: "2026-07-08",
      end: "2026-07-21",
    });
  });

  it("has no window to qualify where there is no comparison", () => {
    // Ten days make rolling averages but not two of them a week apart.
    expect(rollingWeeklyChange(rollingDailyAverage(days(10)))).toBeNull();
    expect(rollingWeeklyWindow(rollingDailyAverage(days(10)))).toBeNull();
    expect(rollingWeeklyWindow([])).toBeNull();
  });

  it("does not bridge missing calendar dates", () => {
    const series = days(18).filter((point) => point.t !== "2026-07-09");
    const trend = rollingDailyAverage(series);
    expect(trend.map((point) => point.t)).not.toContain("2026-07-10");
    expect(splitDailySeries(trend)).toHaveLength(2);
  });
});
