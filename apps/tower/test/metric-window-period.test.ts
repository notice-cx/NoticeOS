// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SignalTrend } from "@shared/wall";
import { metricWindow } from "@/routes/asset-detail/overview-metrics";

const day = (offset: number) => new Date(Date.UTC(2026, 8, 5 + offset)).toISOString().slice(0, 10);
const reports = (): SignalTrend => ({
  series: Array.from({ length: 190 }, (_, index) => ({ t: day(index - 189), v: 10 })),
  provisionalFrom: day(0), collectedAt: null, timeZoneChanges: [],
});

describe("metric window calendar labels", () => {
  it.each([7, 28, 90])("describes the existing completed arithmetic separately from the newest %i-day chart", (days) => {
    const source = reports();
    const original = structuredClone(source);
    const result = metricWindow([source], days, "sum");
    expect(result.completedWindow).toEqual({ start: day(-days), end: day(-1) });
    expect(result.reportedWindow).toEqual({ start: day(1 - days), end: day(0) });
    expect(result.delta?.window).toEqual(result.completedWindow);
    expect(result.value).toBe(days * 10);
    expect(result.delta).toMatchObject({ currentTotal: days * 10, priorTotal: days * 10, percent: 0 });
    expect(result.spark).toHaveLength(days);
    expect(result.spark[0]!.t).toBe(day(-days));
    expect(result.spark.at(-1)!.t).toBe(day(-1));
    expect(source).toEqual(original);
  });

  it("keeps missing dates in the labeled calendar window, not the reported-day count", () => {
    const source = reports();
    source.series = source.series.filter((point) => point.t !== day(-7) && point.t !== day(-3));
    const result = metricWindow([source], 7, "sum");
    expect(result.completedWindow).toEqual({ start: day(-7), end: day(-1) });
    expect(result.settled).toHaveLength(5);
    expect(result.value).toBe(50);
    expect(result.delta?.comparable).toBe(false);
  });

  it("uses the existing earliest provider boundary without hiding later raw reports", () => {
    const google = reports();
    const bing = { ...reports(), provisionalFrom: day(-2) };
    const result = metricWindow([google, bing], 7, "sum");
    expect(result.completedWindow).toEqual({ start: day(-9), end: day(-3) });
    expect(result.reportedWindow).toEqual({ start: day(-6), end: day(0) });
    expect(result.delta?.window).toEqual(result.completedWindow);
    expect(result.value).toBe(140);
    expect(result.merged.series.at(-1)).toEqual({ t: day(0), v: 20 });
  });

  it("does not invent a completed window for an entirely unfinished series", () => {
    const source = { ...reports(), series: [{ t: day(0), v: 999 }] };
    const result = metricWindow([source], 7, "sum");
    expect(result.completedWindow).toBeNull();
    expect(result.reportedWindow).toEqual({ start: day(-6), end: day(0) });
    expect(result.value).toBeNull();
    expect(result.delta).toBeNull();
  });

  it("does not assign dates when no source has reported", () => {
    const result = metricWindow([], 28, "sum");
    expect(result.completedWindow).toBeNull();
    expect(result.reportedWindow).toBeNull();
    expect(result.value).toBeNull();
  });

  it("uses the same calendar window when the newest observation is complete", () => {
    const result = metricWindow([{ ...reports(), provisionalFrom: null }], 7, "mean");
    expect(result.completedWindow).toEqual(result.reportedWindow);
    expect(result.value).toBe(10);
    expect(result.delta?.currentTotal).toBe(10);
  });
});
