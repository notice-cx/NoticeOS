// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_GLYPH,
  DEFAULT_RANGE_DAYS,
  SURFACE_RANGES,
  averageSeries,
  deltaMeaning,
  lastPointIsProvisional,
  missingLabels,
  periodDelta,
  placeAnnotations,
  provisionalIndex,
  seriesGrain,
  shiftLabel,
  weekendSpans,
  windowSeries,
} from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";

/** A dense daily series of `count` days ending on `end`, value = index + 1. */
function daily(end: string, count: number, value: (i: number) => number): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    points.push({ t: shiftLabel(end, -i), v: value(count - 1 - i) });
  }
  return points;
}

describe("the range vocabulary", () => {
  it("offers the three ranges doc 14 names and defaults to 28 days", () => {
    expect([...SURFACE_RANGES]).toEqual([7, 28, 90]);
    expect(DEFAULT_RANGE_DAYS).toBe(28);
  });
});

describe("seriesGrain", () => {
  it("reads the grain off the labels", () => {
    expect(seriesGrain([{ t: "2026-09-01", v: 1 }])).toBe("daily");
    expect(seriesGrain([{ t: "2026-09", v: 1 }])).toBe("monthly");
    expect(seriesGrain([])).toBe("daily");
  });

  it("shifts a label along its own grain", () => {
    expect(shiftLabel("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftLabel("2026-01", -1)).toBe("2025-12");
  });
});

describe("windowSeries", () => {
  const series = daily("2026-09-05", 90, (i) => i);

  it("takes the last N calendar days, ending at the last point", () => {
    const week = windowSeries(series, 7);
    expect(week).toHaveLength(7);
    expect(week[0]!.t).toBe("2026-08-30");
    expect(week.at(-1)!.t).toBe("2026-09-05");
  });

  it("windows by DATE, so a gap does not widen the window", () => {
    // Four days missing out of the last 7: the window is still seven days of
    // calendar and returns the three days that exist inside it.
    const gappy = series.filter(
      (point) => point.t < "2026-09-01" || point.t > "2026-09-04",
    );
    const week = windowSeries(gappy, 7);
    expect(week.map((point) => point.t)).toEqual(["2026-08-30", "2026-08-31", "2026-09-05"]);
  });

  it("windows a monthly series by months", () => {
    const months: SeriesPoint[] = [
      { t: "2026-06", v: 118 },
      { t: "2026-07", v: 264 },
      { t: "2026-08", v: 436 },
    ];
    expect(windowSeries(months, 2).map((point) => point.t)).toEqual(["2026-07", "2026-08"]);
  });

  it("is empty for an empty series or a nonsense length", () => {
    expect(windowSeries([], 28)).toEqual([]);
    expect(windowSeries(series, 0)).toEqual([]);
  });
});

describe("averageSeries", () => {
  it("returns one point per input point, on the same labels", () => {
    const series = daily("2026-09-05", 10, () => 5);
    const average = averageSeries(series);
    expect(average).toHaveLength(10);
    expect(average.map((point) => point.t)).toEqual(series.map((point) => point.t));
  });

  it("averages the seven days ending at each point", () => {
    const series = daily("2026-09-05", 8, (i) => i); // 0..7
    const average = averageSeries(series);
    // The last point averages days 1..7 → 4.
    expect(average.at(-1)!.v).toBe(4);
    // The first point has nothing behind it and averages itself.
    expect(average[0]!.v).toBe(0);
    // The fourth point averages 0..3 → 1.5.
    expect(average[3]!.v).toBe(1.5);
  });

  it("shortens the window over a gap rather than bridging it or reading a zero", () => {
    const series: SeriesPoint[] = [
      { t: "2026-09-01", v: 10 },
      // 09-02 .. 09-04 never reported
      { t: "2026-09-05", v: 20 },
    ];
    const average = averageSeries(series);
    // Two observations inside the seven days ending 09-05 → 15, not 6 (which is
    // what counting the missing days as zero would give).
    expect(average.at(-1)!.v).toBe(15);
  });

  it("is empty for a nonsense window", () => {
    expect(averageSeries(daily("2026-09-05", 3, () => 1), 0)).toEqual([]);
  });

  /**
   * A DECLARED hole is different from a period that is simply absent (bead
   * `ro-78qo.37`): it keeps its place on the axis so the line can break over it.
   */
  it("keeps a declared hole a hole, and leaves it out of the windows around it", () => {
    const average = averageSeries([
      { t: "2026-09-01", v: 10 },
      { t: "2026-09-02", v: null },
      { t: "2026-09-03", v: 20 },
    ]);

    expect(average.map((point) => point.t)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    // The hole is never given a reading of its own …
    expect(average[1]!.v).toBeNull();
    // … and never counted as a zero in the window that spans it: 10 and 20.
    expect(average[2]!.v).toBe(15);
  });
});

describe("periodDelta", () => {
  it("compares the range with the same length of time before it", () => {
    // 56 days: the first 28 total 28, the last 28 total 56.
    const series = [
      ...daily("2026-08-08", 28, () => 1),
      ...daily("2026-09-05", 28, () => 2),
    ];
    const delta = periodDelta(series, 28)!;
    expect(delta.currentTotal).toBe(56);
    expect(delta.priorTotal).toBe(28);
    expect(delta.change).toBe(28);
    expect(delta.percent).toBe(100);
    expect(delta.tone).toBe("up");
    expect(delta.comparable).toBe(true);
    expect(delta.window).toEqual({ start: "2026-08-09", end: "2026-09-05" });
    expect(delta.priorWindow).toEqual({ start: "2026-07-12", end: "2026-08-08" });
  });

  it("names the direction the figures actually moved", () => {
    const down = [...daily("2026-08-29", 7, () => 4), ...daily("2026-09-05", 7, () => 1)];
    expect(periodDelta(down, 7)!.tone).toBe("down");
    const flat = daily("2026-09-05", 14, () => 3);
    expect(periodDelta(flat, 7)!.tone).toBe("flat");
    expect(periodDelta(flat, 7)!.change).toBe(0);
  });

  it("has no percent when the prior period totalled zero", () => {
    const series = [...daily("2026-08-29", 7, () => 0), ...daily("2026-09-05", 7, () => 5)];
    const delta = periodDelta(series, 7)!;
    expect(delta.percent).toBeNull();
    expect(delta.change).toBe(35);
    expect(delta.tone).toBe("up");
  });

  it("is null when the series does not reach back into a prior period", () => {
    expect(periodDelta(daily("2026-09-05", 28, () => 1), 28)).toBeNull();
    expect(periodDelta([], 7)).toBeNull();
    expect(periodDelta(daily("2026-09-05", 14, () => 1), 0)).toBeNull();
  });

  it("withdraws comparable when a reporting timezone change is inside the window", () => {
    const series = [...daily("2026-08-29", 7, () => 1), ...daily("2026-09-05", 7, () => 2)];
    const clean = periodDelta(series, 7, [
      { effectiveOn: "2026-06-01", from: "UTC", to: "America/New_York" },
    ])!;
    expect(clean.comparable).toBe(true);
    const straddled = periodDelta(series, 7, [
      { effectiveOn: "2026-09-01", from: "UTC", to: "America/New_York" },
    ])!;
    expect(straddled.comparable).toBe(false);
    // The figures and the direction survive: the operator decided a marked
    // number beats a blank. Only the verdict is withdrawn.
    expect(straddled.change).toBe(7);
    expect(straddled.tone).toBe("up");
  });

  it("withdraws comparable when the two sides cover different numbers of days", () => {
    const gappy = [
      ...daily("2026-08-29", 7, () => 1).filter((point) => point.t !== "2026-08-25"),
      ...daily("2026-09-05", 7, () => 2),
    ];
    const delta = periodDelta(gappy, 7)!;
    expect(delta.currentPeriods).toBe(7);
    expect(delta.priorPeriods).toBe(6);
    expect(delta.comparable).toBe(false);
  });

  it("compares months on a monthly series", () => {
    const months: SeriesPoint[] = [
      { t: "2026-06", v: 118 },
      { t: "2026-07", v: 264 },
      { t: "2026-08", v: 436 },
      { t: "2026-09", v: 200 },
    ];
    const delta = periodDelta(months, 2)!;
    expect(delta.currentTotal).toBe(636);
    expect(delta.priorTotal).toBe(382);
    expect(delta.window).toEqual({ start: "2026-08", end: "2026-09" });
  });

  it("excludes the day the provider has not closed", () => {
    // Fourteen days at 10, then a fifteenth the provider is still counting at 1.
    const series = [...daily("2026-09-04", 14, () => 10), { t: "2026-09-05", v: 1 }];

    // Anchored on the provisional day, the last seven days total 61 against 70
    // and every morning reports a fall.
    expect(periodDelta(series, 7)!.change).toBe(-9);

    // Anchored on the last COMPLETE day, the two sides are equal.
    const settled = periodDelta(series, 7, [], "2026-09-05")!;
    expect(settled.change).toBe(0);
    expect(settled.window.end).toBe("2026-09-04");
    expect(settled.currentTotal).toBe(70);
  });
});

describe("deltaMeaning", () => {
  it("says which two windows, over what", () => {
    const series = [...daily("2026-08-08", 28, () => 1), ...daily("2026-09-05", 28, () => 2)];
    expect(deltaMeaning(periodDelta(series, 28)!)).toBe(
      "the last 28 days vs the 28 days before",
    );
  });

  it("says why a withdrawn comparison was withdrawn", () => {
    const series = [...daily("2026-08-29", 7, () => 1), ...daily("2026-09-05", 7, () => 2)];
    const straddled = periodDelta(series, 7, [
      { effectiveOn: "2026-09-01", from: "UTC", to: "America/New_York" },
    ])!;
    expect(deltaMeaning(straddled)).toBe("the last 7 days vs the 7 days before · reporting timezone changed");

    const gappy = [
      ...daily("2026-08-29", 7, () => 1).filter((point) => point.t !== "2026-08-25"),
      ...daily("2026-09-05", 7, () => 2),
    ];
    expect(deltaMeaning(periodDelta(gappy, 7)!)).toBe("the last 7 days vs the 7 days before · 7 vs 6 days reported");
  });

  it("counts months on a monthly series", () => {
    const months: SeriesPoint[] = [
      { t: "2026-07", v: 264 },
      { t: "2026-08", v: 436 },
    ];
    expect(deltaMeaning(periodDelta(months, 1)!, "monthly")).toBe(
      "the last 1 month vs the 1 month before",
    );
  });
});

describe("the provisional point", () => {
  const series = daily("2026-09-05", 5, (i) => i);

  it("finds the first point at or after the boundary", () => {
    expect(provisionalIndex(series, "2026-09-05")).toBe(4);
    expect(provisionalIndex(series, "2026-09-04")).toBe(3);
    expect(provisionalIndex(series, null)).toBe(-1);
    expect(provisionalIndex(series, "2026-10-01")).toBe(-1);
  });

  it("only calls the last point provisional when the boundary reaches it", () => {
    expect(lastPointIsProvisional(series, "2026-09-05")).toBe(true);
    expect(lastPointIsProvisional(series, "2026-09-03")).toBe(true);
    // A provider that has published every day it drew has no provisional point.
    expect(lastPointIsProvisional(series, null)).toBe(false);
    expect(lastPointIsProvisional(series, "2026-09-06")).toBe(false);
  });
});

describe("placeAnnotations", () => {
  const series = daily("2026-09-05", 5, () => 1); // 09-01 .. 09-05

  it("lands a mark on the day the chart draws", () => {
    const placed = placeAnnotations(series, [
      { date: "2026-09-03", label: "GA4 reporting timezone changed" },
    ]);
    expect(placed).toEqual([
      {
        index: 2,
        at: "2026-09-03",
        glyph: ANNOTATION_GLYPH,
        labels: ["GA4 reporting timezone changed"],
        events: [{ date: "2026-09-03", label: "GA4 reporting timezone changed" }],
      },
    ]);
  });

  it("drops a mark outside the window rather than clamping it to an edge", () => {
    expect(placeAnnotations(series, [{ date: "2026-07-01", label: "before" }])).toEqual([]);
    expect(placeAnnotations(series, [{ date: "2026-12-01", label: "after" }])).toEqual([]);
    // A day inside the span that the series never reported has no x position.
    const gappy = series.filter((point) => point.t !== "2026-09-03");
    expect(placeAnnotations(gappy, [{ date: "2026-09-03", label: "gap" }])).toEqual([]);
  });

  it("matches a monthly series on the month", () => {
    const months: SeriesPoint[] = [
      { t: "2026-08", v: 436 },
      { t: "2026-09", v: 200 },
    ];
    const placed = placeAnnotations(months, [{ date: "2026-09-01", label: "new price" }]);
    expect(placed.map((mark) => mark.at)).toEqual(["2026-09"]);
  });

  it("merges several annotations on one day into one mark", () => {
    const placed = placeAnnotations(series, [
      { date: "2026-09-02", label: "timezone changed" },
      { date: "2026-09-02", label: "deployed" },
      { date: "2026-09-04", glyph: "◆", label: "price changed" },
    ]);
    expect(placed).toHaveLength(2);
    expect(placed[0]!.labels).toEqual(["timezone changed", "deployed"]);
    expect(placed[1]!.glyph).toBe("◆");
    expect(placed.map((mark) => mark.index)).toEqual([1, 3]);
  });
});

describe("weekendSpans", () => {
  it("bands Saturday and Sunday as one span", () => {
    // 2026-09-05 is a Saturday, 2026-09-06 a Sunday.
    const series = daily("2026-09-07", 9, () => 1); // 08-30 (Sun) .. 09-07 (Mon)
    const spans = weekendSpans(series);
    expect(spans).toEqual([
      { startIndex: 0, endIndex: 0 }, // Sun 08-30, no Saturday before it in view
      { startIndex: 6, endIndex: 7 }, // Sat 09-05 + Sun 09-06
    ]);
  });

  it("bands nothing on a monthly series", () => {
    expect(weekendSpans([{ t: "2026-08", v: 1 }, { t: "2026-09", v: 2 }])).toEqual([]);
  });
});

/**
 * THE LABELS A SERIES SKIPS (bead `ro-78qo.37`).
 *
 * A `Sparkline` spaces its points by position, so three points always look like
 * three consecutive periods. This is what a caller asks before drawing one, and
 * what a caller filling an axis uses to know where the holes go.
 */
describe("missingLabels", () => {
  it("finds nothing in a series with no holes", () => {
    expect(
      missingLabels([
        { t: "2026-06", v: 1 },
        { t: "2026-07", v: 2 },
        { t: "2026-08", v: 3 },
      ]),
    ).toEqual([]);
  });

  it("names the months an asset skipped, in order", () => {
    expect(
      missingLabels([
        { t: "2026-01", v: 1 },
        { t: "2026-04", v: 2 },
        { t: "2026-06", v: 3 },
      ]),
    ).toEqual(["2026-02", "2026-03", "2026-05"]);
  });

  it("walks a daily series in days, not months", () => {
    expect(
      missingLabels([
        { t: "2026-07-01", v: 1 },
        { t: "2026-07-04", v: 2 },
      ]),
    ).toEqual(["2026-07-02", "2026-07-03"]);
  });

  /** Bounded by the series' OWN span: a gap cannot be a period outside the
   * range the series already covers, so nothing here can invent a month. */
  it("never looks outside the first and last labels it was handed", () => {
    expect(missingLabels([])).toEqual([]);
    expect(missingLabels([{ t: "2026-07", v: 1 }])).toEqual([]);
  });

  it("crosses a year boundary the way the calendar does", () => {
    expect(
      missingLabels([
        { t: "2025-11", v: 1 },
        { t: "2026-02", v: 2 },
      ]),
    ).toEqual(["2025-12", "2026-01"]);
  });
});
