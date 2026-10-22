import { describe, expect, it } from "vitest";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import { healthSplit, orderSites, siteLines, visitorsAnswerFigure, watchedLines, weekOnWeek } from "@/lib/sites-index";
import { siteHealth } from "@/lib/site-health";
import type { WallIssue } from "@/lib/wall-issues";

const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const NO_READS = { credentials: undefined, items: null };
const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };

function card(overrides: Partial<AssetCard> & { id: string }): AssetCard {
  return {
    displayName: overrides.id,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: ZERO,
    forecast: ZERO,
    netPeriod: "2026-08",
    netByMonthCurrency: "USD",
    pulseReceivedAt: "2026-08-10T11:00:00.000Z",
    firstReportAt: null,
    dataSources: [],
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    work: null,
    panelReview: null,
    latestPanelDate: null,
    ...overrides,
  };
}

const PORTFOLIO: PortfolioBand = {
  netTrendCurrency: "USD",
  netTrendAllCurrency: "USD",
  period: "2026-08",
  periodIsCurrent: true,
  booked: ZERO,
  forecast: ZERO,
  netTrend: [],
  netTrendAll: [],
  trendGranularity: "monthly",
  bookedDelta: null,
  residue: { booked: ZERO, forecast: ZERO },
  firstRun: false,
  daysIn: 10,
};

/** A month's reported days, each `perDay` cents, through the 9th. */
function earning(perDay: number): Pick<AssetCard, "revenueProjection" | "dailyRevenue"> {
  const points = Array.from({ length: 9 }, (_, index) => ({
    date: `2026-08-0${index + 1}`,
    cumulativeMinor: perDay * (index + 1),
    projected: false,
  }));
  const projection: RevenueProjection = {
    period: "2026-08", status: "ready", reason: null, reportedThrough: "2026-08-09",
    earnedMinor: perDay * 9, projectedMinor: perDay * 31, dailyPaceMinor: perDay,
    previousPeriod: "2026-07", previousMonthMinor: null, changePercent: null,
    historyDays: 40, holidayHistoryDays: 0, points,
  };
  return {
    revenueProjection: projection,
    dailyRevenue: { date: "2026-08-09", amountMinor: perDay, reportedThrough: "2026-08-09", timeZone: "UTC" },
  };
}

/** `n` days of people ending on the 10th, the last one still being counted. */
function people(n: number, value: number): AssetCard["activeUsers"] {
  return {
    series: Array.from({ length: n }, (_, index) => ({ t: `2026-08-${String(11 - n + index).padStart(2, "0")}`, v: value })),
    provisionalFrom: "2026-08-10",
    collectedAt: null,
    timeZoneChanges: [],
  };
}

const issue = (asset: string, severity: "error" | "warn"): WallIssue => ({
  key: `alert-${asset}`, severity, assets: [asset], site: asset, line: "", mark: "", since: null, conditions: [],
});

describe("the Assets rows", () => {
  it("reads yesterday's money, its week-ago change and the share of the whole month", () => {
    const [big, small, none] = siteLines(
      [card({ id: "big.example", ...earning(3000) }), card({ id: "small.example", ...earning(1000) }), card({ id: "none.example", pulseReceivedAt: null })],
      PORTFOLIO, [], NO_READS, NOW,
    );
    expect(big!.row).toMatchObject({ revenue: 30, revenueChange: 0, share: 0.75, to: "/assets/big.example" });
    expect(big!.earned).toBe(270);
    expect(small!.row.share).toBe(0.25);
    // A site with no revenue source states no money at all, never a $0.
    expect(none!.row).toMatchObject({ revenue: null, revenueChange: null, share: null });
    // With no number yet its Overview is empty, so its row opens its Data sources.
    expect(none!.row.to).toBe("/assets/none.example/sources");
    expect(none!.earned).toBeNull();
  });

  it("opens the Overview for historical collection even with no current chart or source", () => {
    const [line] = siteLines([card({ id: "history.example", hasCollectedData: true, pulseReceivedAt: null })], PORTFOLIO, [], NO_READS, NOW);
    expect(line!.row.to).toBe("/assets/history.example");
  });

  it("states the latest finished day's people, never the day still being counted", () => {
    const series = [{ t: "2026-08-08", v: 40 }, { t: "2026-08-09", v: 77 }, { t: "2026-08-10", v: 5 }];
    const [line] = siteLines([card({ id: "a.example", activeUsers: { ...people(3, 0), series } })], PORTFOLIO, [], NO_READS, NOW);
    expect(line!.row.peopleLatest).toBe(77);
    expect(siteLines([card({ id: "b.example" })], PORTFOLIO, [], NO_READS, NOW)[0]!.row.peopleLatest).toBeNull();
  });

  it("colours only the two problem words", () => {
    const lines = siteLines(
      [card({ id: "off.example", openError: 1 }), card({ id: "risk.example" }), card({ id: "young.example", status: "onboarding" }), card({ id: "calm.example" })],
      PORTFOLIO, [issue("risk.example", "warn")], NO_READS, NOW,
    );
    expect(lines.map((line) => [line.row.health.word, line.row.health.tone])).toEqual([
      ["Off track", "error"], ["At risk", "warn"], ["On track", "quiet"], ["On track", "quiet"],
    ]);
  });

  it.each(["onboarding", "baselining"])("uses current health during %s instead of the manual stage", (status) => {
    const reporting = card({ id: "reporting.example", status, firstReportAt: "2026-01-01T12:00:00.000Z", reportDays: 28 });
    expect(siteHealth(reporting).key).toBe("on-track");
    expect(siteHealth({ ...reporting, senseOnly: true }).key).toBe("monitor-only");
    expect(siteHealth({ ...reporting, openError: 1 }).key).toBe("off-track");
    expect(siteHealth({ ...reporting, openWarn: 1 }).key).toBe("at-risk");
    expect(siteHealth(reporting, [issue(reporting.id, "error")]).key).toBe("off-track");
    expect(siteHealth(reporting, [issue(reporting.id, "warn")]).key).toBe("at-risk");
  });

  it("names each source beside its state, from the same cells Home's grid draws", () => {
    const [line] = siteLines([card({ id: "a.example", dataSources: [
      { id: "ga4", label: "Google Analytics", state: "live" },
      { id: "clarity", label: "Clarity", state: "skipped" },
    ] })], PORTFOLIO, [], NO_READS, NOW);
    expect(line!.row.sources.map((source) => source.label)).toEqual(["Google Analytics", "Clarity"]);
    expect(line!.row.sources[1]!.state).toBe("not-using");
  });
});

describe("the Assets orderings", () => {
  const lines = siteLines(
    [
      card({ id: "calm.example", displayName: "Calm", activeUsers: people(5, 10) }),
      card({ id: "rich.example", displayName: "Rich", openWarn: 1, ...earning(1000), activeUsers: people(5, 300) }),
      card({ id: "broken.example", displayName: "Broken", openError: 1, ...earning(3000) }),
      card({ id: "busy.example", displayName: "Busy", activeUsers: people(5, 900) }),
    ],
    PORTFOLIO, [], NO_READS, NOW,
  );
  const ids = (order: Parameters<typeof orderSites>[1]) => orderSites(lines, order).map((line) => line.card.id);

  it("keeps the saved order by default", () => {
    expect(ids("seed")).toEqual(["calm.example", "rich.example", "broken.example", "busy.example"]);
  });

  it("puts the asset that needs attention first, worst first", () => {
    expect(ids("health")).toEqual(["broken.example", "rich.example", "calm.example", "busy.example"]);
  });

  it("orders by the month's money, an asset that earned nothing reported last", () => {
    expect(ids("money")).toEqual(["broken.example", "rich.example", "calm.example", "busy.example"]);
  });

  it("orders by people, an asset with no finished day last", () => {
    expect(ids("users")).toEqual(["busy.example", "rich.example", "calm.example", "broken.example"]);
  });

  it("orders by name", () => {
    expect(ids("name")).toEqual(["broken.example", "busy.example", "calm.example", "rich.example"]);
  });

  it("keeps a retired asset at the foot of every ordering, as the sidebar does", () => {
    const withRetired = siteLines(
      [card({ id: "old.example", displayName: "Aardvark", status: "retired", openError: 1, ...earning(9000) }), ...lines.map((line) => line.card)],
      PORTFOLIO, [], NO_READS, NOW,
    );
    for (const order of ["seed", "health", "money", "users", "name"] as const) {
      expect(orderSites(withRetired, order).at(-1)!.card.id).toBe("old.example");
    }
  });

  it("splits the portfolio by health word, worst first, leaving out words nobody wears", () => {
    expect(healthSplit(lines)).toEqual([
      { key: "off-track", word: "Off track", count: 1 },
      { key: "at-risk", word: "At risk", count: 1 },
      { key: "on-track", word: "On track", count: 2 },
    ]);
  });
});

// A retired site is watched by nobody: it reads Retired whatever else is
// true of it, and is in no part of the split and no count of who needs you.
describe("a retired asset among the rows", () => {
  const three = siteLines(
    [card({ id: "off.example", openError: 1 }), card({ id: "old.example", status: "retired", openError: 1, worstSeverity: "error" }), card({ id: "calm.example" })],
    PORTFOLIO, [issue("old.example", "error")], NO_READS, NOW,
  );

  it("reads Retired, quiet, even with an open error alert", () => {
    const old = three.find((line) => line.card.id === "old.example")!;
    expect(old.health).toEqual({ key: "retired", word: "Retired", tone: "na" });
    expect(old.row.health).toEqual({ word: "Retired", tone: "quiet" });
    expect(siteHealth(card({ id: "x.example", status: "retired", openError: 2, openWarn: 3 }))).toMatchObject({ key: "retired", word: "Retired" });
  });

  it("is in no part of the split and in none of the watched assets", () => {
    expect(healthSplit(three)).toEqual([
      { key: "off-track", word: "Off track", count: 1 },
      { key: "on-track", word: "On track", count: 1 },
    ]);
    expect(watchedLines(three).map((line) => line.card.id)).toEqual(["off.example", "calm.example"]);
  });
});

describe("the Assets answer's visitors", () => {
  it("carries the change on the same weekday a week before, and none it cannot compare", () => {
    const week = (v: (index: number) => number): AssetCard["activeUsers"] => ({
      series: Array.from({ length: 8 }, (_, index) => ({ t: `2026-08-0${index + 1}`, v: v(index) })),
      provisionalFrom: null, collectedAt: null, timeZoneChanges: [],
    });
    expect(visitorsAnswerFigure([card({ id: "a.example", activeUsers: week((index) => (index === 7 ? 120 : 100)) })]))
      .toMatchObject({ label: "Visitors yesterday", value: "120", note: "↑ 20%" });
    expect(visitorsAnswerFigure([card({ id: "a.example", activeUsers: people(3, 50) })])?.note).toBeUndefined();
    expect(visitorsAnswerFigure([card({ id: "a.example" })])).toBeNull();
  });
});

describe("weekOnWeek", () => {
  const day = (t: string, v: number) => ({ t, v });
  it("compares the latest day with the same weekday a week before", () => {
    expect(weekOnWeek([day("2026-09-14", 200), day("2026-09-20", 10), day("2026-09-21", 150)])).toBe(-25);
  });
  it("is not comparable without that day or against a zero", () => {
    expect(weekOnWeek([day("2026-09-20", 10), day("2026-09-21", 150)])).toBeNull();
    expect(weekOnWeek([day("2026-09-14", 0), day("2026-09-21", 150)])).toBeNull();
    expect(weekOnWeek([])).toBeNull();
  });
});
