// @vitest-environment node
// The charts' one geometry (bead `ro-trai.19`): a monotone cubic through every
// reading that never overshoots, the wash under it, and a point that stays
// round in a stretched viewBox.

import { describe, expect, it } from "vitest";
import { areaPath, dotPath, monotonePath, readingRuns, type ChartPoint } from "@/lib/chart-path";
import { TWEEN_MS, tweenAt } from "@/lib/use-tweened-number";

/** The path's segments as cubic Béziers: [start, control 1, control 2, end]. */
function segments(path: string): ChartPoint[][] {
  const numbers = (text: string) => text.trim().split(/[\s,]+/).map(Number);
  const [move, ...curves] = path.split("C");
  let from = { x: numbers(move!.slice(1))[0]!, y: numbers(move!.slice(1))[1]! };
  return curves.map((curve) => {
    const [x1, y1, x2, y2, x, y] = numbers(curve);
    const segment = [from, { x: x1!, y: y1! }, { x: x2!, y: y2! }, { x: x!, y: y! }];
    from = { x: x!, y: y! };
    return segment;
  });
}

/** The curve's y at `t` along one Bézier segment. */
function yAt([p0, p1, p2, p3]: ChartPoint[], t: number): number {
  const u = 1 - t;
  return u ** 3 * p0!.y + 3 * u ** 2 * t * p1!.y + 3 * u * t ** 2 * p2!.y + t ** 3 * p3!.y;
}

const points = (ys: number[]) => ys.map((y, x) => ({ x: x * 10, y }));

describe("monotonePath", () => {
  it("passes through every reading exactly", () => {
    const data = points([80, 20, 55, 55, 10, 90, 40]);
    const ends = [segments(monotonePath(data))[0]![0]!, ...segments(monotonePath(data)).map((segment) => segment[3]!)];
    expect(ends).toEqual(data);
  });

  it("never draws above or below the two readings either side of a segment", () => {
    // Spiky, flat, rising and falling runs: the shapes a site's month has.
    const data = points([3818, 2434, 1127, 1465, 2961, 3303, 4428, 3660, 2694, 1002, 1002, 1765, 8065, 3306, 1096]);
    for (const segment of segments(monotonePath(data))) {
      const low = Math.min(segment[0]!.y, segment[3]!.y);
      const high = Math.max(segment[0]!.y, segment[3]!.y);
      for (let step = 0; step <= 50; step += 1) {
        const y = yAt(segment, step / 50);
        expect(y).toBeGreaterThanOrEqual(low - 0.01);
        expect(y).toBeLessThanOrEqual(high + 0.01);
      }
    }
  });

  it("keeps a flat stretch flat and a straight run straight", () => {
    const flat = segments(monotonePath(points([50, 50, 50, 10])));
    // The two flat segments: every control point on y = 50.
    for (const segment of flat.slice(0, 2)) expect(segment.map((point) => point.y)).toEqual([50, 50, 50, 50]);
    const straight = segments(monotonePath(points([0, 10, 20, 30])));
    for (const segment of straight) {
      for (const point of segment) expect(point.y).toBeCloseTo(point.x, 5);
    }
  });

  it("flattens at a peak, so the curve turns ON the reading rather than past it", () => {
    const [rise, fall] = segments(monotonePath(points([10, 90, 10])));
    // The control points either side of the peak sit level with it.
    expect(rise![2]!.y).toBe(90);
    expect(fall![1]!.y).toBe(90);
  });

  it("draws one reading as a bare move and two as a straight line", () => {
    expect(monotonePath([])).toBe("");
    expect(monotonePath([{ x: 5, y: 7 }])).toBe("M5 7");
    expect(monotonePath([{ x: 0, y: 10 }, { x: 100, y: 2.345 }])).toBe("M0 10 L100 2.35");
  });
});

describe("areaPath", () => {
  it("closes the same curve down to the baseline at both ends", () => {
    const data = points([40, 10, 30]);
    const area = areaPath(data, 100);
    expect(area.startsWith(monotonePath(data))).toBe(true);
    expect(area.endsWith("L20 100 L0 100 Z")).toBe(true);
    expect(areaPath(data.slice(0, 1), 100)).toBe("");
  });
});

describe("dotPath", () => {
  it("is a zero-length stroke at the point, which a round cap draws as a circle", () => {
    expect(dotPath({ x: 12.345, y: 60 })).toBe("M12.35 60h0");
  });
});

describe("readingRuns", () => {
  it("breaks the line over a period nobody reported", () => {
    expect(readingRuns([1, 2, null, 4, null, null, 7])).toEqual([
      [{ index: 0, value: 1 }, { index: 1, value: 2 }],
      [{ index: 3, value: 4 }],
      [{ index: 6, value: 7 }],
    ]);
    expect(readingRuns([null, null])).toEqual([]);
  });
});

describe("tweenAt", () => {
  it("counts from the old reading to the new one, easing out, in whole readings", () => {
    expect(tweenAt(21, 34, 0)).toBe(21);
    expect(tweenAt(21, 34, 1)).toBe(34);
    // Past the halfway reading by the halfway moment: it eases OUT.
    expect(tweenAt(0, 100, 0.5)).toBe(88);
    expect(tweenAt(400, 396, 2)).toBe(396);
    expect(TWEEN_MS).toBeLessThan(30_000);
  });
});
