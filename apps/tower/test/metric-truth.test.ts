import { describe, expect, it } from "vitest";
import type { FlagsSection, FlagRecord } from "@shared/asset-detail";
import type { SignalTrend } from "@shared/wall";
import { metricWindow, weightedMetricWindow, alertPosture } from "@/routes/asset-detail/overview-metrics";

function trend(values: number[], first = 1): SignalTrend {
  return {
    series: values.map((v, index) => ({ t: `2026-08-${String(first + index).padStart(2, "0")}`, v })),
    contextSeries: [],
    provisionalFrom: null,
    collectedAt: null,
    timeZoneChanges: [],
  };
}

describe("period metrics retain their real denominators", () => {
  it("computes CTR as total clicks over impressions, not mean daily CTR", () => {
    const result = weightedMetricWindow(trend([1, 10, 1]), trend([1, 1000, 1]), 7, "ratio");
    expect(result.value).toBeCloseTo(12 / 1002);
    expect(result.value).not.toBeCloseTo((1 + .01 + 1) / 3);
    expect(result.spark.map((point) => point.v)).toEqual([1, .01, 1]);
  });

  it("weights daily search position by that day's impressions", () => {
    const result = weightedMetricWindow(trend([1, 10, 1]), trend([1, 1000, 1]), 7, "weighted-mean");
    expect(result.value).toBeCloseTo(10002 / 1002);
  });

  it("compares weighted period rates, including history before the drawn series", () => {
    const clicks = trend([10, 10, 10, 1, 1, 1]);
    const impressions = trend([1000, 1000, 1000, 10, 10, 10]);
    clicks.contextSeries = clicks.series.splice(0, 3);
    impressions.contextSeries = impressions.series.splice(0, 3);
    const result = weightedMetricWindow(clicks, impressions, 3, "ratio");
    expect(result.value).toBeCloseTo(.1);
    expect(result.delta?.priorTotal).toBeCloseTo(.01);
    expect(result.delta?.percent).toBeCloseTo(900);
  });

  it("does not pair mismatched dates or invent a rate for zero impressions", () => {
    const result = weightedMetricWindow(trend([2, 2, 2, 999, 2]), trend([10, 10, 10, 0]), 7, "ratio");
    expect(result.value).toBeCloseTo(.2);
    expect(result.spark).toHaveLength(3);
  });

  it("excludes the unfinished tail of either input", () => {
    const impressions = trend([10, 10, 10, 10]);
    impressions.provisionalFrom = "2026-08-04";
    const result = weightedMetricWindow(trend([1, 1, 1, 10]), impressions, 7, "ratio");
    expect(result.value).toBeCloseTo(.1);
    expect(result.spark).toHaveLength(3);
  });

  it("shows no period rate below the same three-day evidence floor", () => {
    expect(weightedMetricWindow(trend([1, 1]), trend([10, 10]), 7, "ratio").value).toBeNull();
  });

  it("keeps timezone comparisons neutral", () => {
    const values = trend([1, 1, 1, 2, 2, 2]);
    values.timeZoneChanges = [{ effectiveOn: "2026-08-03", from: "UTC", to: "America/Los_Angeles" }];
    expect(weightedMetricWindow(values, trend([10, 10, 10, 10, 10, 10]), 3, "ratio").delta?.comparable).toBe(false);
  });

  it("labels people per day and compares daily averages despite missing days", () => {
    const users = trend(Array.from({ length: 14 }, () => 100));
    users.series.splice(1, 1);
    const result = metricWindow([users], 7, "mean");
    expect(result.value).toBe(100);
    expect(result.delta?.currentTotal).toBe(100);
    expect(result.delta?.priorTotal).toBe(100);
    expect(result.delta?.percent).toBe(0);
    expect(result.delta?.comparable).toBe(false);
  });
});

function flag(over: Partial<FlagRecord> = {}): FlagRecord {
  return {
    id: 1, firedAt: "2026-08-01T00:00:00.000Z", firstFiredAt: "2026-08-01T00:00:00.000Z",
    severity: "warn", kind: "anomaly", ruleId: "asset-declared", metric: "signups",
    message: null, ruleInputs: null, correlatedChanges: [], occurrences: 1,
    disposition: null, dispositionAt: null, dispositionNote: null, snoozeUntil: null,
    ackExpiry: null, resolvedAt: null, liveness: { state: "live" }, ...over,
  };
}

describe("current alert posture", () => {
  it("does not paint a healthy zero as a warning because stale raw records remain", () => {
    const flags: FlagsSection = {
      open: [], notCurrent: [flag({ liveness: { state: "stale", reason: "report-no-longer-flags" } })], snoozed: [],
      history: Array.from({ length: 25 }, (_, index) => flag({ id: index + 2, resolvedAt: "2026-08-02T00:00:00.000Z" })),
      openError: 7, openWarn: 30,
    };
    expect(alertPosture(flags)).toMatchObject({ open: 0, error: 0, warn: 0 });
  });

  it("counts current conditions, not repeated firings", () => {
    expect(alertPosture({ open: [flag({ severity: "error", occurrences: 20 })], notCurrent: [], snoozed: [], history: [], openError: 20, openWarn: 0 }))
      .toMatchObject({ open: 1, error: 1, warn: 0 });
  });
});
