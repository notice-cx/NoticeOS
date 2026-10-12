import { describe, expect, it } from "vitest";
import type { AssetDetailPayload, FlagRecord } from "@shared/asset-detail";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import { shiftLabel } from "@shared/surface";
import type { HealthColumn, HealthRow } from "@/components/viz/HealthGrid";
import {
  calendarDays,
  chartedMeasure,
  dateRange,
  landmarks,
  measureDays,
  overviewMeasures,
  poissonQuantile,
  sourceHistory,
  type Measure,
} from "@/routes/asset-detail/overview-measures";
import { everyTabPayload, viewOf } from "./asset-detail-fixture";

/**
 * The Overview's numbers as data: which days a source owed and skipped, the
 * rule's own normal, which measure the chart opens on, and each source's
 * thirty days. The tab's own suite checks how they are drawn.
 */

const NOW = Date.parse("2026-07-05T14:00:00.000Z");
const LAST = "2026-07-05";
const days = (count: number, value: (index: number) => number, end = LAST) =>
  Array.from({ length: count }, (_, index) => ({ t: shiftLabel(end, index - (count - 1)), v: value(index) }));
const trend = (series: { t: string; v: number }[], provisionalFrom: string | null = null) =>
  ({ series, provisionalFrom, collectedAt: null, timeZoneChanges: [] });

function overview(edit: (body: AssetDetailPayload) => void = () => {}): AssetDetailFor<"overview"> {
  const body = everyTabPayload();
  body.osTimeZone = "UTC";
  edit(body);
  return viewOf(body, "overview") as AssetDetailFor<"overview">;
}

function flowAlert(over: Partial<FlagRecord> = {}): FlagRecord {
  return {
    id: 7, firedAt: "2026-07-05T03:00:00.000Z", firstFiredAt: "2026-07-05T03:00:00.000Z", severity: "warn", kind: "anomaly",
    metric: "signups", message: "12 in last24h (avg7d 40)", ruleId: "flow-poisson-low",
    ruleInputs: { metric: "signups", observed: 12, baselinePerDay: 40, alpha: 0.01 },
    correlatedChanges: [], disposition: null, dispositionAt: null, dispositionNote: null, snoozeUntil: null,
    ackExpiry: null, resolvedAt: null, liveness: { state: "live" }, occurrences: 1, ...over,
  };
}

describe("measureDays — owed, skipped and partial days", () => {
  it("leaves a day nobody owed empty, and names a skipped day and who skipped it", () => {
    const domain = calendarDays("2026-07-05", 7);
    const google = days(7, () => 10).filter((point) => point.t !== "2026-07-02" && point.t !== "2026-07-03");
    const bing = days(4, () => 1).filter((point) => point.t !== "2026-07-03");
    const { days: drawn, gaps } = measureDays(domain, [{ name: "Google", points: google }, { name: "Bing", points: bing }]);
    const byDate = Object.fromEntries(drawn.map((day) => [day.t, day]));
    // Bing began on Jul 2: the days before it owed nothing of Bing.
    expect(byDate["2026-06-29"]).toEqual({ t: "2026-06-29", v: 10, missing: [] });
    // Google skipped Jul 2 and Bing reported it: partial, never a low whole.
    expect(byDate["2026-07-02"]).toEqual({ t: "2026-07-02", v: 1, missing: ["Google"] });
    // Neither reported Jul 3: missing, never zero.
    expect(byDate["2026-07-03"]).toEqual({ t: "2026-07-03", v: null, missing: ["Google", "Bing"] });
    expect(gaps).toEqual([
      { start: "2026-07-02", end: "2026-07-02", days: 1, who: "Google", partial: true },
      { start: "2026-07-03", end: "2026-07-03", days: 1, who: "Google and Bing", partial: false },
    ]);
  });

  it("counts a late source's days since its last report as owed", () => {
    const { days: drawn, gaps } = measureDays(calendarDays("2026-07-05", 5), [
      { name: "Nightly report", points: days(3, () => 5, "2026-07-03"), owedThrough: "2026-07-05" },
    ]);
    expect(drawn.slice(-2).map((day) => day.v)).toEqual([null, null]);
    expect(gaps).toEqual([{ start: "2026-07-04", end: "2026-07-05", days: 2, who: null, partial: false }]);
  });

  it("starts a calendar at a series' first day when the range reaches past it", () => {
    expect(calendarDays("2026-07-05", 28, "2026-07-01")).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"]);
    expect(dateRange("2026-09-06", "2026-09-08")).toBe("Sep 6–8");
    expect(dateRange("2026-08-30", "2026-09-02")).toBe("Aug 30–Sep 2");
  });
});

describe("the rule's own normal", () => {
  it("reads the counts a Poisson baseline makes likely at the rule's sensitivity", () => {
    expect(poissonQuantile(58.2, 0.01)).toBe(41);
    expect(poissonQuantile(58.2, 0.99)).toBe(77);
    expect(poissonQuantile(0, 0.01)).toBe(0);
    // Past the exact sum, the normal approximation stays within a count of it.
    expect(Math.abs(poissonQuantile(1000, 0.01) - 927)).toBeLessThanOrEqual(1);
  });

  it("draws the single-day rule's band and the baseline as the usual level", () => {
    const data = overview((body) => {
      body.metrics = [{ name: "signups", last24h: 12, avg7d: 40, total: 900, series: days(14, (index) => (index === 13 ? 12 : 40)) }];
      body.flags.open = [flowAlert()];
    });
    const product = overviewMeasures(data, 28, NOW).find((measure) => measure.key === "product")!;
    expect(product.normal).toEqual({ low: poissonQuantile(40, 0.01), high: poissonQuantile(40, 0.99) });
    expect(product.usual).toEqual({ value: 40, label: "normally ~40 a day" });
    expect(product.alert).toMatchObject({ severity: "warn", since: LAST, onset: LAST });
    // The figure's own yardstick stays the reports before it.
    expect(product.comparison?.against).toBe("vs prior 7 reports");
  });

  it("states no daily band for a pooled or percentage rule", () => {
    const data = overview((body) => {
      body.metrics = [{ name: "signups", last24h: 12, avg7d: 40, total: 900, series: days(14, () => 40) }];
      body.flags.open = [flowAlert({ ruleId: "flow-pct-drop", ruleInputs: { metric: "signups", baselinePerDay: 40, dropFraction: 0.7 } })];
    });
    const product = overviewMeasures(data, 28, NOW).find((measure) => measure.key === "product")!;
    expect(product.normal).toBeNull();
    expect(product.usual?.value).toBe(40);
  });
});

describe("the product figure when its report is late", () => {
  const late = (lastReport: string) => overview((body) => {
    body.metrics = [{ name: "signups", last24h: 9, avg7d: 9, total: 900, series: days(14, () => 9, lastReport) }];
  });

  it("owes the days since the last report while they fall in the range", () => {
    const product = overviewMeasures(late("2026-07-02"), 28, NOW, true).find((measure) => measure.key === "product")!;
    expect(product.days.at(-1)).toEqual({ t: LAST, v: null, missing: ["Nightly report"] });
    expect(product.gaps).toEqual([{ start: "2026-07-03", end: LAST, days: 3, who: null, partial: false }]);
    expect(product.asOf).toBe("2026-07-02");
  });

  it("draws the last reports there were once the whole range is owed, and says how old", () => {
    const product = overviewMeasures(late("2026-05-01"), 28, NOW, true).find((measure) => measure.key === "product")!;
    expect(product.days.at(-1)).toEqual({ t: "2026-05-01", v: 9, missing: [] });
    expect(product.gaps).toEqual([]);
    expect(product.asOf).toBe("2026-05-01");
  });

  it("dates an alert older than the chart from its onset, not the chart's edge", () => {
    const data = overview((body) => {
      body.metrics = [{ name: "signups", last24h: 12, avg7d: 40, total: 900, series: days(10, () => 40) }];
      body.flags.open = [flowAlert({ firstFiredAt: "2026-05-20T03:00:00.000Z" })];
    });
    const product = overviewMeasures(data, 7, NOW).find((measure) => measure.key === "product")!;
    expect(product.alert).toMatchObject({ since: "2026-06-29", onset: "2026-05-20" });
  });
});

describe("which measure the chart opens on", () => {
  const measure = (key: Measure["key"], over: Partial<Measure> = {}) =>
    ({ key, days: [{ t: LAST, v: 1, missing: [] }], alert: null, ...over }) as Measure;
  const alert = (firstFiredAt: string) => ({ flagId: 1, severity: "warn" as const, since: LAST, onset: LAST, firstFiredAt, headline: "x" });

  it("opens on the operator's pick, else a fresh alert's measure, else the first with days", () => {
    const measures = [measure("money", { days: [] }), measure("people"), measure("product", { alert: alert("2026-07-04T00:00:00.000Z") })];
    expect(chartedMeasure(measures, null, NOW)?.key).toBe("product");
    expect(chartedMeasure(measures, "people", NOW)?.key).toBe("people");
    // A measure with no days cannot be picked onto the chart.
    expect(chartedMeasure(measures, "money", NOW)?.key).toBe("product");
  });

  it("leaves a week-old alert on its figure and the chart to the first measure", () => {
    const measures = [measure("people"), measure("product", { alert: alert("2026-06-20T00:00:00.000Z") })];
    expect(chartedMeasure(measures, null, NOW)?.key).toBe("people");
    expect(chartedMeasure([], null, NOW)).toBeNull();
  });

  it("names the best, the lowest and the newest complete day, never a partial or unfinished one", () => {
    const marks = landmarks({
      provisionalFrom: "2026-07-05",
      days: [
        { t: "2026-07-01", v: 5, missing: [] },
        { t: "2026-07-02", v: 1, missing: ["Bing"] },
        { t: "2026-07-03", v: 9, missing: [] },
        { t: "2026-07-04", v: 7, missing: [] },
        { t: "2026-07-05", v: 99, missing: [] },
      ],
    });
    expect([marks.best?.t, marks.worst?.t, marks.newest?.t]).toEqual(["2026-07-03", "2026-07-01", "2026-07-04"]);
  });
});

describe("the hero row's measures", () => {
  it("leads with money, then people, search and the product figure, leaving out what the site lacks", () => {
    const keys = (data: AssetDetailFor<"overview">) => overviewMeasures(data, 28, NOW).map((measure) => measure.key);
    expect(keys(overview())).toEqual(["money", "people", "search", "product"]);
    expect(keys(overview((body) => {
      body.ledger = { periods: [], recentRows: [], empty: true, currency: null };
      body.metrics = [];
    }))).toEqual(["people", "search"]);
  });

  it("compares ad revenue with the same number of days before it, on the network's clock", () => {
    const data = overview((body) => {
      const revenueDays = days(56, (index) => (index < 28 ? 400 : 500), "2026-07-04").map((point) => ({ date: point.t, amountMinor: point.v }));
      body.dailyRevenue = { from: revenueDays[0]!.date, to: "2026-07-04", reportedThrough: "2026-07-04", days: revenueDays };
    });
    const money = overviewMeasures(data, 28, NOW)[0]!;
    expect(money).toMatchObject({ key: "money", name: "Ad revenue", value: 140, estimated: true });
    expect(money.comparison).toMatchObject({ change: 28, against: "vs prior 28 days", comparable: true });
    expect(money.comparison?.percent).toBeCloseTo(25);
    expect(money.usual).toEqual({ value: 4, label: "prior 28 days · $4.00 a day" });
  });

  it("states search clicks as Google and Bing added, and people as a daily mean", () => {
    const data = overview((body) => {
      body.performance.activeUsers = trend(days(56, (index) => (index < 28 ? 100 : 120)));
      body.performance.webSearchClicks = { google: trend(days(56, () => 10)), bing: trend(days(56, () => 2)) };
    });
    const [, people, search] = overviewMeasures(data, 28, NOW);
    expect(people).toMatchObject({ key: "people", name: "Visitors a day", window: "28 days", value: 120, sources: ["GA4"] });
    expect(people!.comparison).toMatchObject({ percent: 20, against: "vs prior 28 days", comparable: true });
    expect(search).toMatchObject({ key: "search", value: 336, sources: ["Google", "Bing"] });
    expect(search!.usual?.label).toBe("prior 28 days · 12 a day");
  });
});

describe("each data source's thirty days", () => {
  const columns: HealthColumn[] = [
    { id: "nightly-report", label: "Nightly report", short: "Report" },
    { id: "gsc", label: "Google Search Console", short: "Search" },
    { id: "dataforseo", label: "DataForSEO", short: "Ranks" },
    { id: "posthog", label: "PostHog", short: "PostHog" },
    { id: "clarity", label: "Microsoft Clarity", short: "Clarity" },
  ];
  const row: HealthRow = {
    id: "meadow.example",
    name: "Meadow Board",
    cells: [
      { column: "nightly-report", state: "overdue", since: "2026-07-03T02:00:00.000Z" },
      { column: "gsc", state: "working" },
      { column: "dataforseo", state: "working" },
      { column: "posthog", state: "not-connected" },
      { column: "clarity", state: "not-using" },
    ],
  };

  it("marks each day reported, still counting, missed, owed or before the source began", () => {
    const data = overview((body) => {
      body.metrics = [{ name: "signups", last24h: 9, avg7d: 9, total: 1, series: days(10, () => 9, "2026-07-02").filter((point) => point.t !== "2026-06-28") }];
      body.performance.webSearchClicks.google = trend(days(5, () => 3, "2026-07-03"), "2026-07-03");
      body.performance.webSearchImpressions.google = trend([]);
    });
    const { rows, notConnected, domain } = sourceHistory(data, row, columns, LAST);
    expect(domain).toHaveLength(30);
    expect(domain.at(-1)).toBe(LAST);
    expect(rows.map((one) => one.id)).toEqual(["nightly-report", "gsc", "dataforseo"]);
    expect(notConnected).toEqual(["PostHog"]);
    const report = rows[0]!;
    expect(report.name).toBe("Nightly report");
    expect(report.state).toBe("overdue");
    const state = (one: typeof report, t: string) => one.days!.find((day) => day.t === t)!.state;
    expect(state(report, "2026-06-22")).toBe("before");
    expect(state(report, "2026-06-28")).toBe("missed");
    expect(state(report, "2026-07-02")).toBe("reported");
    expect(state(report, "2026-07-04")).toBe("late");
    expect(state(rows[1]!, "2026-07-03")).toBe("counting");
    // A weekly source has no day-by-day record in this read, and says so.
    expect(rows[2]!.days).toBeNull();
  });

  it("reads ad revenue's row from its days alone", () => {
    const data = overview((body) => {
      body.dailyRevenue = { from: "2026-06-01", to: "2026-07-04", reportedThrough: "2026-07-04", days: [{ date: "2026-07-04", amountMinor: 100 }] };
    });
    const revenue = sourceHistory(data, row, columns, LAST).rows.at(-1)!;
    expect(revenue).toMatchObject({ id: "ad-revenue", name: "Ad revenue", state: null, through: "2026-07-04" });
  });
});
