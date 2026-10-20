// @vitest-environment node
// A site's technical health: five facts, each measured or unknown, folded
// into one word.

import { describe, expect, it } from "vitest";
import type { AssetCard, CardDataSource, CardProduct, SeriesPoint, SignalTrend } from "@shared/wall";
import { NO_READS } from "@shared/connection-status";
import { rowFacts, techHealth, techHealthSummary, type TechFactKey } from "@/lib/tech-health";
import { wallIssues, type WallIssue } from "@/lib/wall-issues";

const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const NO_TREND: SignalTrend = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

function card(id: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-10", netByMonthCurrency: "USD",
    pulseReceivedAt: "2026-10-19T02:00:00.000Z", firstReportAt: null, dataSources: [],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: null, panelReview: null, latestPanelDate: null,
    ...over,
  };
}

const uptime = (state: CardDataSource["state"]): CardDataSource => ({ id: "uptime", label: "Uptime", state });

function product(over: Partial<CardProduct> = {}): CardProduct {
  return {
    observedAt: "2026-10-18T06:00:00.000Z", speed: "clear", worstSpeed: "good", errors: "clear",
    errorPeople: 0, jsErrorFinding: false, funnel: null, ...over,
  };
}

/** 56 finished days: four weeks at `before` a day, then four at `now`. */
function clicks(before: number, now: number): SignalTrend {
  const start = Date.parse("2026-08-23T00:00:00.000Z");
  const series: SeriesPoint[] = Array.from({ length: 56 }, (_, index) => ({
    t: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    v: index < 28 ? before : now,
  }));
  return { series, provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
}

const codebase = (growthPercent30d: number | null) => ({
  date: "2026-10-18", commit: "abc1234", codeLines: 40_000, growthPercent30d, comparedDays: growthPercent30d === null ? null : 30,
});

function issue(asset: string, key: string, mark: string, severity: WallIssue["severity"] = "error"): WallIssue {
  return { key, severity, assets: [asset], site: asset, line: mark, mark, since: null, conditions: ["open-flags"] };
}

const healthy = (id: string, over: Partial<AssetCard> = {}) =>
  card(id, { dataSources: [uptime("live")], product: product(), searchClicks: clicks(100, 100), codebase: codebase(4), ...over });

const fact = (c: AssetCard, key: TechFactKey, issues: WallIssue[] = []) => techHealth(c, issues).facts.find((f) => f.key === key)!;

describe("techHealth facts", () => {
  it("reads every fact as fine on a healthy site", () => {
    const health = techHealth(healthy("meadow.example.com"), []);
    expect(health).toMatchObject({ key: "fine", word: "Fine", tone: "affirmative" });
    expect(health.facts.map((f) => [f.key, f.state, f.word, f.note])).toEqual([
      ["reachable", "ok", "Up", null],
      ["speed", "ok", "Fast", null],
      ["errors", "ok", "None", null],
      ["search", "ok", "Steady", null],
      ["code", "ok", "Steady", null],
    ]);
  });

  it("reads reachability from the uptime slot and an open home-page alert", () => {
    const site = healthy("meadow.example.com");
    expect(fact(site, "reachable", [issue(site.id, "alert-1", "Home page down")])).toMatchObject({
      state: "bad", word: "Down", note: "The home page did not load",
    });
    expect(fact({ ...site, dataSources: [uptime("degraded")] }, "reachable").state).toBe("warn");
    expect(fact(site, "reachable", [issue(site.id, "source-uptime", "Uptime failing")]).state).toBe("warn");
    expect(fact({ ...site, dataSources: [uptime("needs-setup")] }, "reachable")).toMatchObject({ state: "unknown", word: "not measured yet" });
    expect(fact({ ...site, dataSources: [] }, "reachable").state).toBe("unknown");
    // Another site's alert is not this site's.
    expect(fact(site, "reachable", [issue("other.example.com", "alert-2", "Home page down")]).state).toBe("ok");
  });

  it("reads speed from the product reading", () => {
    const site = healthy("meadow.example.com");
    expect(fact({ ...site, product: product({ speed: "fired", worstSpeed: "poor" }) }, "speed")).toMatchObject({
      state: "warn", word: "Slow", note: "Slow for 1 in 4 visitors",
    });
    expect(fact({ ...site, product: product({ worstSpeed: "poor" }) }, "speed")).toMatchObject({ state: "warn", note: "Slow for some visitors" });
    expect(fact({ ...site, product: product({ worstSpeed: "needs-improvement" }) }, "speed")).toMatchObject({ state: "ok", word: "OK" });
    expect(fact({ ...site, product: product({ speed: "not-collected" }) }, "speed")).toMatchObject({ state: "unknown", word: "not measured yet" });
    expect(fact({ ...site, product: product({ speed: "not-enough-data", worstSpeed: null }) }, "speed").state).toBe("unknown");
    expect(fact({ ...site, product: null }, "speed").state).toBe("unknown");
    expect(fact(card("acorn.example.com"), "speed").state).toBe("unknown");
  });

  it("reads errors from the rule, the people counted and the error finding", () => {
    const site = healthy("meadow.example.com");
    expect(fact({ ...site, product: product({ errors: "fired", errorPeople: 12 }) }, "errors")).toMatchObject({
      state: "warn", note: "12 people hit an error",
    });
    expect(fact({ ...site, product: product({ errors: "fired", errorPeople: 1 }) }, "errors").note).toBe("1 person hit an error");
    expect(fact({ ...site, product: product({ jsErrorFinding: true, errorPeople: null }) }, "errors")).toMatchObject({
      state: "warn", note: "Some people hit an error",
    });
    expect(fact({ ...site, product: product({ errorPeople: 3 }) }, "errors")).toMatchObject({ state: "ok", word: "Few", note: null });
    expect(fact({ ...site, product: product({ errors: "not-collected" }) }, "errors").state).toBe("unknown");
  });

  it("reads search from four weeks against the four before", () => {
    const site = healthy("meadow.example.com");
    expect(fact({ ...site, searchClicks: clicks(100, 85) }, "search")).toMatchObject({
      state: "warn", word: "Falling", note: "Fewer people found it in search",
    });
    expect(fact({ ...site, searchClicks: clicks(100, 95) }, "search")).toMatchObject({ state: "ok", word: "Steady" });
    expect(fact({ ...site, searchClicks: clicks(100, 130) }, "search")).toMatchObject({ state: "ok", word: "Growing" });
    expect(fact({ ...site, searchClicks: NO_TREND }, "search")).toMatchObject({ state: "unknown", word: "not measured yet" });
    const young = { ...clicks(100, 100), series: clicks(100, 100).series.slice(40) };
    expect(fact({ ...site, searchClicks: young }, "search")).toMatchObject({ state: "unknown", word: "too early to tell" });
    expect(fact(site, "search", [issue(site.id, "alert-3", "Sitemap failing", "warn")]).state).toBe("warn");
  });

  it("reads code growth from the code report", () => {
    const site = healthy("meadow.example.com");
    expect(fact({ ...site, codebase: codebase(31.4) }, "code")).toMatchObject({
      state: "warn", word: "Growing fast", note: "Grew 31% in 30 days",
    });
    expect(fact({ ...site, codebase: codebase(24.9) }, "code").state).toBe("ok");
    expect(fact({ ...site, codebase: codebase(null) }, "code").state).toBe("unknown");
    expect(fact({ ...site, codebase: null }, "code")).toMatchObject({ state: "unknown", word: "not measured yet" });
    const { codebase: _absent, ...older } = site;
    expect(fact(older, "code").state).toBe("unknown");
  });
});

describe("techHealth's one word", () => {
  it("folds the facts: any bad is trouble, any warn is watch, all unknown is unknown", () => {
    const site = healthy("meadow.example.com");
    expect(techHealth(site, [issue(site.id, "alert-1", "Home page down")])).toMatchObject({ key: "trouble", tone: "critical" });
    expect(techHealth({ ...site, codebase: codebase(40) }, [])).toMatchObject({ key: "watch", word: "Worth a look", tone: "caution" });
    expect(techHealth(card("acorn.example.com"), [])).toMatchObject({ key: "unknown", word: "Not measured yet", tone: "na" });
    // One measured fact and four unknown is still fine.
    expect(techHealth(card("acorn.example.com", { dataSources: [uptime("live")] }), []).key).toBe("fine");
  });

  it("measures nothing on a retired or pre-launch site", () => {
    for (const status of ["retired", "pre-launch"]) {
      const site = healthy("meadow.example.com", { status });
      const health = techHealth(site, [issue(site.id, "alert-1", "Home page down")]);
      expect(health.key).toBe("unknown");
      expect(health.facts.every((f) => f.state === "unknown" && f.note === null)).toBe(true);
    }
  });
});

describe("a late or missing nightly report", () => {
  const NOW = Date.parse("2026-10-19T12:00:00.000Z");
  const HOUR = 3_600_000;
  const late = (hours: number) => healthy("brief.example.com", { pulseReceivedAt: new Date(NOW - hours * HOUR).toISOString() });
  const issuesFor = (site: AssetCard) => wallIssues({ assets: [site], attention: [], connections: NO_READS, nowMs: NOW });

  it("is a note on the row, in days from two days, and folds the site to watch, never fine", () => {
    const site = late(49);
    const issues = issuesFor(site);
    expect(issues.map((i) => i.mark)).toEqual(["Report late"]);
    const health = techHealth(site, issues, NOW);
    expect(health).toMatchObject({ key: "watch", word: "Worth a look" });
    expect(health.report).toEqual({ key: "report", state: "warn", word: "Report late", note: "No report for 2 days" });
    // No dot of its own: the five facts are unchanged.
    expect(health.facts.map((f) => f.state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    // The late report reads first among the row's notes.
    expect(rowFacts(health)[0]).toBe(health.report);
    expect(techHealth(late(80), issuesFor(late(80)), NOW).report?.note).toBe("No report for 3 days");
  });

  it("says the age in hours under two days, and gives no age without a clock or a last report", () => {
    const stale = staleAlert("brief.example.com");
    const site = healthy("brief.example.com", { pulseReceivedAt: new Date(NOW - 30 * HOUR).toISOString() });
    expect(techHealth(site, [stale], NOW).report?.note).toBe("No report for 30 hours");
    expect(techHealth(site, [stale]).report?.note).toBe("No recent nightly report");
    expect(techHealth({ ...site, pulseReceivedAt: null }, [stale], NOW).report?.note).toBe("No nightly report yet");
  });

  it("stays clear while the report is on time, and is the summary's lead", () => {
    const fresh = late(10);
    expect(issuesFor(fresh)).toEqual([]);
    expect(techHealth(fresh, [], NOW)).toMatchObject({ key: "fine", report: null });
    const site = late(49);
    const summary = techHealthSummary([healthy("a.example.com"), site], issuesFor(site), NOW);
    expect(summary).toMatchObject({ fine: 1, measured: 2 });
    expect(summary.lead?.card.id).toBe("brief.example.com");
  });

  // An open "report is stale" alert carries the same mark as the card's clock.
  function staleAlert(asset: string): WallIssue {
    return issue(asset, "alert-9", "Report late", "error");
  }
});

describe("techHealthSummary", () => {
  it("counts the fine among the measured and leads with the worst site", () => {
    const sites = [
      healthy("a.example.com"),
      healthy("b.example.com", { codebase: codebase(50) }),
      healthy("c.example.com"),
      healthy("d.example.com"),
      card("e.example.com"),
      healthy("f.example.com", { status: "retired" }),
    ];
    const down = [issue("d.example.com", "alert-1", "Home page down")];
    const summary = techHealthSummary(sites, down);
    expect(summary.fine).toBe(2);
    expect(summary.measured).toBe(4);
    expect(summary.lead?.card.id).toBe("d.example.com");
    expect(summary.lead?.health.key).toBe("trouble");
    expect(techHealthSummary(sites, []).lead?.card.id).toBe("b.example.com");
    expect(techHealthSummary([healthy("a.example.com")], [])).toEqual({ fine: 1, measured: 1, lead: null });
    expect(techHealthSummary([], [])).toEqual({ fine: 0, measured: 0, lead: null });
  });
});
