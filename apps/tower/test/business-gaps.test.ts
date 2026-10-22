// @vitest-environment node
// What the portfolio is missing as a business, ranked and capped.

import { describe, expect, it } from "vitest";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { AssetCard, CardDataSource, CardFinding, WorkSummary } from "@shared/wall";
import { BUSINESS_GAP_LIMIT, businessGaps } from "@/lib/business-gaps";

const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const NO_TREND = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
const WORK: WorkSummary = { open: 3, highPriority: 0, inProgress: 1, blocked: 0, closedRecent: 2, priorities: null, capturedAt: "2026-10-19T00:00:00.000Z" };

const source = (id: string, state: CardDataSource["state"]): CardDataSource => ({ id, label: id, state });

function projection(status: RevenueProjection["status"]): RevenueProjection {
  return {
    period: "2026-10", status, reason: null, reportedThrough: null, earnedMinor: null, projectedMinor: null,
    dailyPaceMinor: null, previousPeriod: "2026-09", previousMonthMinor: null, changePercent: null,
    historyDays: 0, holidayHistoryDays: 0, points: [],
  };
}

/** A site with nothing missing: income, live data feeds, tasks and a code report. */
function card(id: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-10", netByMonthCurrency: "USD",
    pulseReceivedAt: null, firstReportAt: null,
    dataSources: [source("nightly-report", "live"), source("ga4", "live"), source("gsc", "needs-setup"), source("uptime", "live")],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: WORK, panelReview: null, latestPanelDate: null,
    revenueProjection: projection("ready"),
    codebase: { date: "2026-10-18", commit: "abc1234", codeLines: 1000, growthPercent30d: 2, comparedDays: 30 },
    findings: [],
    ...over,
  };
}

const finding = (key: string, title: string, kind = "recommendation"): CardFinding => ({ key, kind, title });

describe("businessGaps", () => {
  it("lists nothing for a portfolio with nothing missing", () => {
    expect(businessGaps([card("a.example.com"), card("b.example.com")])).toEqual([]);
  });

  it("names each asset that earns nothing, with its own row", () => {
    const gaps = businessGaps([
      card("a.example.com", { displayName: "Acorn", revenueProjection: undefined }),
      card("b.example.com", { displayName: "Birch", revenueProjection: projection("no-revenue") }),
      // Money on the books counts, with or without a daily source.
      card("c.example.com", { revenueProjection: undefined, booked: { currency: "USD", revenue: 40, cost: 0, net: 40 } }),
      // Not launched yet: expected to earn nothing.
      card("d.example.com", { status: "pre-launch", revenueProjection: undefined }),
    ]);
    expect(gaps).toEqual([
      { key: "earns-nothing:a.example.com", siteId: "a.example.com", title: "Acorn earns nothing", detail: "Connect an income source, or mark it as free" },
      { key: "earns-nothing:b.example.com", siteId: "b.example.com", title: "Birch earns nothing", detail: "Connect an income source, or mark it as free" },
    ]);
  });

  it("names an asset with no data feeds, no task project or no code report", () => {
    const unfed = [source("nightly-report", "live"), source("ga4", "needs-setup"), source("gsc", "needs-setup"), source("uptime", "live")];
    const { codebase: _absent, ...older } = card("e.example.com");
    const gaps = businessGaps([
      card("a.example.com", { dataSources: unfed }),
      card("b.example.com", { work: null }),
      card("c.example.com", { codebase: null }),
      // A site with no slots at all says nothing about its feeds, and an older
      // payload without the code field says nothing about the code report.
      card("d.example.com", { dataSources: [] }),
      older,
    ]);
    expect(gaps.map((gap) => [gap.key, gap.title])).toEqual([
      ["no-data-feeds:a.example.com", "a.example.com has no data feeds"],
      ["no-task-project:b.example.com", "b.example.com has no task project"],
      ["no-code-report:c.example.com", "c.example.com sends no code report"],
    ]);
  });

  it("lists opportunity findings by kind, with the finding's own title", () => {
    const gaps = businessGaps([
      card("a.example.com", {
        displayName: "Acorn",
        findings: [
          finding("prune-candidates", "Twelve pages earn no visits"),
          finding("posthog-funnel-drop-signup", "Sign-up: the biggest loss is step 2"),
          finding("active-users-trend", "Visitors are steady", "insight"),
        ],
      }),
      card("b.example.com", { displayName: "Birch", findings: [finding("concentration-risk", "One page brings half the visits", "warning")] }),
      card("c.example.com", { displayName: "Cedar", findings: [finding("search-striking-distance", "Three queries sit just off page one")] }),
    ]);
    expect(gaps).toEqual([
      { key: "finding:b.example.com:concentration-risk", siteId: "b.example.com", title: "One page brings half the visits", detail: "Birch" },
      { key: "finding:c.example.com:search-striking-distance", siteId: "c.example.com", title: "Three queries sit just off page one", detail: "Cedar" },
      { key: "finding:a.example.com:posthog-funnel-drop-signup", siteId: "a.example.com", title: "Sign-up: the biggest loss is step 2", detail: "Acorn" },
      { key: "finding:a.example.com:prune-candidates", siteId: "a.example.com", title: "Twelve pages earn no visits", detail: "Acorn" },
    ]);
  });

  it("ranks money first and caps the list portfolio-wide", () => {
    const sites = Array.from({ length: 6 }, (_, index) =>
      card(`s${index}.example.com`, {
        work: index === 0 ? null : WORK,
        revenueProjection: undefined,
        findings: [finding("ai-referral-floor", `AI answers send visitors to s${index}`)],
      }),
    );
    const gaps = businessGaps(sites);
    expect(gaps).toHaveLength(BUSINESS_GAP_LIMIT);
    expect(gaps.slice(0, 6).every((gap) => gap.key.startsWith("earns-nothing:"))).toBe(true);
    expect(gaps[6]!.key).toBe("no-task-project:s0.example.com");
    expect(gaps[7]!.key).toBe("finding:s0.example.com:ai-referral-floor");
    expect(new Set(gaps.map((gap) => gap.key)).size).toBe(gaps.length);
  });

  it("leaves retired assets out", () => {
    expect(businessGaps([card("a.example.com", { status: "retired", revenueProjection: undefined, work: null, codebase: null })])).toEqual([]);
  });
});
