import { describe, expect, it } from "vitest";
import { poissonLowerTail } from "@noticeos/contract/poisson";
import type { AlertHistoryRow } from "@shared/alert-history";
import type { AttentionItem } from "@shared/wall";
import { alertBoard, alertNormal, alertTimeline, poissonNormalRange, readingNights, SEVERAL_SITES, shortHeadline, siteOrder } from "@/lib/alerts-board";

const NOW = Date.parse("2026-09-22T19:30:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    asset: "plume.example",
    assetDisplayName: "Plume Studio",
    severity: "warn",
    kind: "anomaly",
    message: "Signups well below normal",
    firedAt: ago(2 * HOUR),
    metric: null,
    ruleId: "rule-the-translator-does-not-know",
    ruleInputs: null,
    correlatedChanges: [],
    occurrences: 1,
    firstFiredAt: ago(2 * HOUR),
    ...overrides,
  };
}

/** The range by the definition, one count at a time. */
function bruteRange(lambda: number, alpha: number): { low: number; high: number } {
  let low = 0;
  while (poissonLowerTail(low, lambda) < alpha) low += 1;
  let high = low;
  while (poissonLowerTail(high, lambda) < 1 - alpha) high += 1;
  return { low, high };
}

describe("the normal a Poisson rule computed", () => {
  it.each([
    [58.2, 0.01],
    [39.3, 0.01],
    [7.2, 0.01],
    [3, 0.05],
    [1200, 0.001],
  ])("puts λ=%s between its two α=%s tails", (lambda, alpha) => {
    expect(poissonNormalRange(lambda, alpha)).toEqual(bruteRange(lambda, alpha));
  });

  it("starts where the rule stops firing", () => {
    const { low } = poissonNormalRange(58.2, 0.01);
    expect(poissonLowerTail(low - 1, 58.2)).toBeLessThan(0.01);
    expect(poissonLowerTail(low, 58.2)).toBeGreaterThanOrEqual(0.01);
  });

  it("stays quick at a large site's volume", () => {
    const started = performance.now();
    const { low, high } = poissonNormalRange(250_000, 0.01);
    expect(performance.now() - started).toBeLessThan(200);
    expect(low).toBeLessThan(250_000);
    expect(high).toBeGreaterThan(250_000);
  });
});

describe("alertNormal — a reading against its rule's own normal", () => {
  it("reads a single-day drop as its count against the rule's range", () => {
    const normal = alertNormal(item({
      ruleId: "flow-poisson-low",
      ruleInputs: { metric: "plansSaved", observed: 19, baselinePerDay: 58.2, alpha: 0.01, pLowerTail: 4.1e-6 },
    }));
    expect(normal).toMatchObject({ value: 19, low: 41, high: 77, bad: "below", label: "Plans saved in 24 hours", unit: "in 24h" });
    expect(normal!.level.value).toBe(58.2);
  });

  it("reads a pooled window over the window's own count", () => {
    const normal = alertNormal(item({
      ruleId: "flow-lowvol-window",
      ruleInputs: { metric: "contactForms", windowObserved: 1, baselinePerDay: 2.4, alpha: 0.01, windowHours: 72, lambda: 7.2 },
    }));
    expect(normal).toMatchObject({ value: 1, ...poissonNormalRange(7.2, 0.01), unit: "in 3 days" });
  });

  it("uses the stored predictive band without reconstructing a Poisson range", () => {
    const facts = item({ ruleId: "flow-lowvol-window", ruleInputs: { windowObserved: 3, windowHours: 72,
      baselinePerDay: 11, alpha: 0.01, prediction: { model: "weekday-log-predictive-v1", lower: 6, upper: 120, typical: 30 } } });
    expect(alertNormal(facts)).toMatchObject({ value: 3, low: 6, high: 120, unit: "in 3 days", level: { value: 30 } });
    for (const prediction of [null, "future", { model: "future", lower: 6, upper: 120 }, { model: "weekday-log-predictive-v1", lower: 10, upper: 1 }])
      expect(alertNormal({ ...facts, ruleInputs: { ...facts.ruleInputs, prediction } })).toBeNull();
  });

  it("draws no range a rule did not keep", () => {
    expect(alertNormal(item())).toBeNull();
    // Without its α the rule's line is unknown, so nothing is drawn for it.
    expect(alertNormal(item({ ruleId: "flow-poisson-low", ruleInputs: { observed: 19, baselinePerDay: 58.2 } }))).toBeNull();
    expect(alertNormal(item({ ruleId: "ingest-freshness", ruleInputs: { state: "never-reported", thresholdHours: 48 } }))).toBeNull();
  });

  it("reads a late report against the hours the rule allows, and a quota against the share it fires below", () => {
    expect(alertNormal(item({ ruleId: "ingest-freshness", ruleInputs: { state: "stale", ageHours: 62, thresholdHours: 48 } })))
      .toMatchObject({ value: 62, low: 0, high: 48, bad: "above" });
    const quota = alertNormal(item({
      ruleId: "ga4-quota-pressure",
      ruleInputs: { pressured: [{ share: 0.3 }, { share: 0.12 }], threshold_ratio: 0.2 },
    }));
    expect(quota).toMatchObject({ low: 20, high: 100, bad: "below" });
    expect(quota!.value).toBeCloseTo(12);
    expect(quota!.format!(12)).toBe("12%");
  });
});

describe("readingNights — the nights behind a condition", () => {
  const inputs = (observed: number) => ({ metric: "signups", observed, baselinePerDay: 39.3, alpha: 0.01 });

  it("draws one bar a night, oldest first, the latest reading of a night winning", () => {
    expect(readingNights(item({
      ruleId: "flow-poisson-low",
      readings: [
        { at: "2026-09-22T06:00:00.000Z", message: null, ruleInputs: inputs(22) },
        { at: "2026-09-21T06:30:00.000Z", message: null, ruleInputs: inputs(25) },
        { at: "2026-09-21T06:00:00.000Z", message: null, ruleInputs: inputs(30) },
        { at: "2026-09-20T06:00:00.000Z", message: null, ruleInputs: null },
      ],
    }))).toEqual([{ t: "2026-09-21", v: 25 }, { t: "2026-09-22", v: 22 }]);
  });

  it("leaves a night with no stored reading as an empty slot, so the bars keep time", () => {
    expect(readingNights(item({
      ruleId: "flow-poisson-low",
      readings: [
        { at: "2026-09-22T06:00:00.000Z", message: null, ruleInputs: inputs(22) },
        { at: "2026-09-19T06:00:00.000Z", message: null, ruleInputs: inputs(18) },
      ],
    }))).toEqual([
      { t: "2026-09-19", v: 18 },
      { t: "2026-09-20", v: null },
      { t: "2026-09-21", v: null },
      { t: "2026-09-22", v: 22 },
    ]);
  });

  it("draws nothing for one night, which the band already is", () => {
    expect(readingNights(item({ ruleId: "flow-poisson-low", readings: [{ at: "2026-09-22T06:00:00.000Z", message: null, ruleInputs: inputs(22) }] }))).toBeNull();
  });
});

describe("alertBoard — by site, the long-standing apart", () => {
  it("leads with the site of the worst, newest alert and folds what is over a week old", () => {
    const board = alertBoard([
      item({ id: 1, asset: "plume.example", assetDisplayName: "Plume Studio", firstFiredAt: ago(2 * HOUR) }),
      item({ id: 2, asset: "acorn.example", assetDisplayName: "Acorn Atlas", severity: "error", firstFiredAt: ago(25 * 60_000) }),
      item({ id: 3, asset: "plume.example", assetDisplayName: "Plume Studio", firstFiredAt: ago(3 * DAY) }),
      item({ id: 4, asset: "ripple.example", assetDisplayName: "Ripple Index", firstFiredAt: ago(67 * DAY) }),
      item({ id: 5, asset: "acorn.example", assetDisplayName: "Acorn Atlas", severity: "error", firstFiredAt: ago(9 * DAY) }),
    ], NOW);
    expect(board.sites.map((site) => [site.key, site.items.map((entry) => entry.id)])).toEqual([
      ["acorn.example", [2]],
      ["plume.example", [1, 3]],
    ]);
    // Errors first, then the newest: the folded list is ranked too.
    expect(board.longStanding.map((entry) => entry.id)).toEqual([5, 4]);
  });

  it("gives a row that stands for several sites a group of its own", () => {
    const grouped = item({
      id: 7,
      members: [
        { id: 7, asset: "summit.example", assetDisplayName: "Summit", firedAt: ago(DAY) },
        { id: 8, asset: "acorn.example", assetDisplayName: "Acorn Atlas", firedAt: ago(DAY) },
      ],
    });
    expect(alertBoard([grouped], NOW).sites).toMatchObject([{ key: SEVERAL_SITES, asset: null, name: "Several sites" }]);
  });
});

describe("siteOrder — the week reads in the board's order", () => {
  it("leads with the site of the worst, newest alert and keeps the rest in the order given", () => {
    const order = siteOrder([
      item({ id: 1, asset: "plume.example", assetDisplayName: "Plume Studio", firstFiredAt: ago(2 * HOUR) }),
      item({ id: 2, asset: "acorn.example", assetDisplayName: "Acorn Atlas", severity: "error", firstFiredAt: ago(DAY) }),
      item({ id: 3, asset: "ripple.example", assetDisplayName: "Ripple Index", firstFiredAt: ago(67 * DAY) }),
    ], [
      { id: "plume.example", label: "Plume Studio" },
      { id: "summit.example", label: "Summit" },
      { id: "acorn.example", label: "Acorn Atlas" },
    ]);
    expect(order.map((site) => site.id)).toEqual(["acorn.example", "plume.example", "ripple.example", "summit.example"]);
  });
});

describe("alertTimeline — the week on one axis", () => {
  const settled = (id: number, closedDaysAgo: number, overrides: Partial<AlertHistoryRow["flag"]> = {}): AlertHistoryRow => ({
    flag: {
      id, firedAt: ago((closedDaysAgo + 1) * DAY), firstFiredAt: ago((closedDaysAgo + 1) * DAY), occurrences: 1,
      severity: "warn", kind: "anomaly", metric: null, message: "Home page check failed", ruleId: "rule-the-translator-does-not-know",
      ruleInputs: null, correlatedChanges: [], disposition: null, dispositionAt: null, dispositionNote: null, snoozeUntil: null,
      ackExpiry: null, resolvedAt: ago(closedDaysAgo * DAY), liveness: { state: "historical" }, ...overrides,
    },
    asset: { id: "acorn.example", domain: "acorn.example", displayName: "Acorn Atlas" },
  });
  const options = {
    nowMs: NOW,
    order: [{ id: "plume.example", label: "Plume Studio" }, { id: "acorn.example", label: "Acorn Atlas" }],
    sitePath: (id: string) => `/assets/${id}`,
    openHref: (entry: AttentionItem) => `/alerts#alert-${entry.id}`,
    settledHref: (row: AlertHistoryRow) => `/alerts/history?asset=${row.asset.id}`,
  };

  it("runs every open alert from its onset to now and closes what settled this week", () => {
    const { lanes, spans } = alertTimeline(
      [item({ id: 1, message: "Plans saved well below normal — 19 vs ~58/day" })],
      [settled(11, 2), settled(12, 9), settled(13, 1, { kind: "milestone", severity: "info" })],
      options,
    );
    expect(lanes.map((lane) => lane.id)).toEqual(["plume.example", "acorn.example"]);
    expect(spans).toEqual([
      expect.objectContaining({ id: "open:1:plume.example", to: null, label: "Plans saved well below normal", href: "/alerts#alert-1" }),
      expect.objectContaining({ id: "settled:11", lane: "acorn.example", to: ago(2 * DAY), href: "/alerts/history?asset=acorn.example" }),
    ]);
  });

  it("draws a grouped row on every site it stands for, each bar opening the one row", () => {
    const { spans } = alertTimeline([item({
      id: 7,
      members: [
        { id: 7, asset: "summit.example", assetDisplayName: "Summit", firedAt: ago(DAY) },
        { id: 8, asset: "acorn.example", assetDisplayName: "Acorn Atlas", firedAt: ago(2 * DAY) },
      ],
    })], [], options);
    expect(spans.map((span) => [span.lane, span.from, span.href])).toEqual([
      ["summit.example", ago(DAY), "/alerts#alert-7"],
      ["acorn.example", ago(2 * DAY), "/alerts#alert-7"],
    ]);
  });

  it("names a bar by what happened, leaving the figures to the row", () => {
    expect(shortHeadline("Plans saved well below normal — 19 vs ~58/day")).toBe("Plans saved well below normal");
    expect(shortHeadline("No nightly report has EVER arrived")).toBe("No nightly report has EVER arrived");
  });
});
