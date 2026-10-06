// @vitest-environment node
// The Wall's revenue widget read model (docs/25-the-wall.md § Revenue, bead
// `ro-trai.4`): the figure is the ledger's, the pace is the sum of the sites'
// ready projections plus revenue no projection covers, and the month chart and
// its crossing are over the covered sites, day by day.

import { describe, expect, it } from "vitest";
import type { DailyRevenueSummary } from "@shared/daily-revenue";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { PortfolioBand } from "@shared/wall";
import { hasRevenueSource, monthRevenue, yesterdayTotal } from "@/lib/wall-revenue";

const ZERO = { currency: 'USD', revenue: 0, cost: 0, net: 0 };

function portfolio(forecastRevenue: number, over: Partial<PortfolioBand> = {}): PortfolioBand {
  return { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
    period: "2026-09", periodIsCurrent: true, booked: ZERO,
    forecast: forecastRevenue === 0 ? ZERO : { currency: 'USD', revenue: forecastRevenue, cost: 0, net: forecastRevenue },
    netTrend: [], netTrendAll: [], trendGranularity: "monthly", bookedDelta: null,
    residue: { booked: ZERO, forecast: ZERO }, firstRun: forecastRevenue === 0, daysIn: 22,
    ...over,
  };
}

/** A ready September projection: `perDay` minor units a day, reported through
 * the 21st, projected at `aheadPerDay` for the nine days left. */
function ready(perDay: number, aheadPerDay: number, previousMonthMinor: number | null): RevenueProjection {
  const points: RevenueProjection["points"] = [];
  let cumulative = 0;
  for (let day = 1; day <= 30; day += 1) {
    cumulative += day <= 21 ? perDay : aheadPerDay;
    points.push({ date: `2026-09-${String(day).padStart(2, "0")}`, cumulativeMinor: cumulative, projected: day > 21 });
  }
  return {
    period: "2026-09", status: "ready", reason: null, reportedThrough: "2026-09-21",
    earnedMinor: perDay * 21, projectedMinor: cumulative, dailyPaceMinor: aheadPerDay,
    previousPeriod: "2026-08", previousMonthMinor, changePercent: null, historyDays: 84, holidayHistoryDays: 0, points,
  };
}

const learning: RevenueProjection = {
  ...ready(0, 0, null), status: "insufficient-history", reason: "Learning from traffic and revenue · 12/21 days.",
  earnedMinor: null, projectedMinor: null, dailyPaceMinor: null, points: [],
};

describe("the month's revenue on the Wall", () => {
  it("paces the month at the sum of every ready projection plus revenue no projection covers", () => {
    // Two covered sites earned $315 + $105 = $420; the ledger holds $450, so $30
    // came from a source with no daily report and is added to the pace whole.
    const model = monthRevenue(portfolio(450), [
      { revenueProjection: ready(1_500, 2_000, 40_000) },
      { revenueProjection: ready(500, 600, 12_000) },
      { revenueProjection: learning },
      {},
    ]);
    expect(model?.revenue).toBe(450);
    expect(model?.state).toBe("forecast");
    // Covered: (1500×21 + 2000×9) + (500×21 + 600×9) = 49,500 + 15,900 minor.
    expect(model?.pace?.projected).toBe((49_500 + 15_900 + 3_000) / 100);
    expect(model?.pace?.daysLeft).toBe(9);
    expect(model?.pace?.sites).toBe(2);
    // The comparison is like for like: the covered sites against their own
    // previous month, never with the uncovered $30 on one side only.
    expect(model?.pace?.previousTotal).toBe(520);
    expect(model?.pace?.changePercent).toBeCloseTo((65_400 / 52_000 - 1) * 100, 6);
    // The chart adds the sites day by day.
    expect(model?.pace?.points[0]).toEqual({ day: 1, date: "2026-09-01", cumulative: 20, projected: false });
    expect(model?.pace?.points.at(-1)).toEqual({ day: 30, date: "2026-09-30", cumulative: 654, projected: true });
  });

  it("finds the day the month passed last month's total on reported days", () => {
    // $20 a day reaches last month's $300 on the 15th, before the 21st.
    const model = monthRevenue(portfolio(420), [{ revenueProjection: ready(2_000, 2_000, 30_000) }]);
    expect(model?.pace?.crossing).toEqual({ day: 15, date: "2026-09-15", projected: false });
  });

  it("finds the day the month is on pace to pass it on projected days", () => {
    // $420 by the 21st, then $40 a day: $500 is reached on the 23rd.
    const model = monthRevenue(portfolio(420), [{ revenueProjection: ready(2_000, 4_000, 50_000) }]);
    expect(model?.pace?.crossing).toEqual({ day: 23, date: "2026-09-23", projected: true });
  });

  it("marks no crossing when the month will not reach last month", () => {
    const model = monthRevenue(portfolio(420), [{ revenueProjection: ready(2_000, 2_000, 90_000) }]);
    expect(model?.pace?.crossing).toBeNull();
  });

  it("compares with no month when any covered site has no complete previous month", () => {
    const model = monthRevenue(portfolio(420), [
      { revenueProjection: ready(1_000, 1_000, 30_000) },
      { revenueProjection: ready(1_000, 1_000, null) },
    ]);
    expect(model?.pace?.previousTotal).toBeNull();
    expect(model?.pace?.changePercent).toBeNull();
    expect(model?.pace?.crossing).toBeNull();
  });

  it("states the figure and the projection's own reason when no site is ready yet", () => {
    const model = monthRevenue(portfolio(120), [{ revenueProjection: learning }]);
    expect(model).toMatchObject({ revenue: 120, pace: null, waiting: "Learning from traffic and revenue · 12/21 days." });
  });

  it("reads the reported days as the month so far when the ledger has no row yet", () => {
    const model = monthRevenue(portfolio(0), [{ revenueProjection: ready(1_000, 1_000, null) }]);
    expect(model?.revenue).toBe(210);
    expect(model?.pace?.projected).toBe(300);
  });

  // A new installation's first three weeks (bead ro-trai.33): its revenue site
  // reports daily, but the projection is still learning and the ledger has no
  // row for the month yet.
  it("states the reported days and the reason while every source is still learning and the ledger has no row", () => {
    const reporting: RevenueProjection = { ...learning, earnedMinor: 25_200 };
    const model = monthRevenue(portfolio(0), [{ revenueProjection: reporting }, { revenueProjection: { ...reporting, earnedMinor: 6_150 } }, {}]);
    expect(model).toMatchObject({
      period: "2026-09", periodIsCurrent: true, revenue: 313.5, state: "forecast", pace: null,
      waiting: "Learning from traffic and revenue · 12/21 days.",
    });
  });

  it("has no figure, only the reason, while no source has a complete day this month", () => {
    // `earnedMinor` is null until the month's reports are complete: missing is
    // not $0.
    const model = monthRevenue(portfolio(0), [{ revenueProjection: learning }, {}]);
    expect(model).toMatchObject({ revenue: null, pace: null, waiting: "Learning from traffic and revenue · 12/21 days." });
  });

  it('does not call a cost-only month reported zero, and keeps complete dated history', () => {
    const costOnly = portfolio(0, { firstRun: false, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, revenueRecorded: { forecast: false, booked: false } });
    const awaiting = { ...ready(0, 1000, 22800), earnedMinor: null };
    expect(monthRevenue(costOnly, [])).toBeNull();
    expect(monthRevenue(costOnly, [{ revenueProjection: awaiting }])).toMatchObject({ revenue: null, waiting: "Waiting for revenue reports.", previousMonth: { period: '2026-08', revenue: 228 } });
    expect(monthRevenue(costOnly, [{ revenueProjection: { ...learning, previousMonthMinor: null } }])).toMatchObject({ revenue: null, previousMonth: null });
    expect(monthRevenue(costOnly, [{ revenueProjection: { ...learning, earnedMinor: 0 } }])?.revenue).toBe(0);
    expect(monthRevenue(costOnly, [{ revenueProjection: awaiting }, { revenueProjection: { ...awaiting, previousMonthMinor: null } }])?.previousMonth).toEqual({ period: '2026-08', revenue: 228, reported: 1, sites: 2 });
  });

  it.each(['booked', 'forecast'] as const)('keeps an explicitly recorded %s revenue zero, without a daily source', state => {
    const band = portfolio(0, { revenueRecorded: { booked: state === 'booked', forecast: state === 'forecast' } });
    expect(monthRevenue(band, [])).toMatchObject({ revenue: 0, state });
  });

  it('does not use cost-only forecasts to hide recorded booked revenue or combine booking states', () => {
    const band = portfolio(0, { booked: { currency: 'USD', revenue: 100, cost: 0, net: 100 }, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, revenueRecorded: { booked: true, forecast: false } });
    expect(monthRevenue(band, [])).toMatchObject({ revenue: 100, state: 'booked' });
    expect(monthRevenue({ ...band, forecast: { currency: 'USD', revenue: 50, cost: 35, net: 15 }, revenueRecorded: { booked: true, forecast: true } }, [])).toMatchObject({ revenue: 50, state: 'forecast' });
  });

  it("has nothing to state only when no site has a revenue source", () => {
    const noRevenue: RevenueProjection = { ...learning, status: "no-revenue", reason: "Connect a daily revenue source." };
    expect(monthRevenue(portfolio(0), [{ revenueProjection: noRevenue }, {}])).toBeNull();
    expect(monthRevenue(portfolio(0), [])).toBeNull();
  });

  it("adds a learning site's reported days to the month so far and to the pace", () => {
    // Ready: $210 so far, $300 at the end. Learning: $61.50 so far, no pace of
    // its own, so it joins the pace whole, like revenue no projection covers.
    const model = monthRevenue(portfolio(0), [
      { revenueProjection: ready(1_000, 1_000, null) },
      { revenueProjection: { ...learning, earnedMinor: 6_150 } },
    ]);
    expect(model?.revenue).toBe(271.5);
    expect(model?.pace?.projected).toBe(361.5);
    expect(model?.pace?.sites).toBe(1);
  });

  it("does not pace an older ledger month with this month's projections", () => {
    const model = monthRevenue(portfolio(900, { period: "2026-08", periodIsCurrent: false }), [
      { revenueProjection: ready(1_000, 1_000, null) },
    ]);
    expect(model).toMatchObject({ period: "2026-08", periodIsCurrent: false, revenue: 900, pace: null });
  });
});

// Yesterday's revenue across the sites (bead `ro-trai.32`): the providers'
// saved estimates for yesterday, summed over the sites with a revenue source.
// Missing is not zero; a recorded $0 is.
describe("yesterday's revenue on the Wall", () => {
  const TZ = "America/Los_Angeles";
  /** 12:30 PM on Tue Sep 22 in Los Angeles: yesterday is Sep 21. */
  const NOW = Date.parse("2026-09-22T19:30:00.000Z");
  const day = (amountMinor: number | null, date = "2026-09-21"): DailyRevenueSummary => ({
    date,
    amountMinor,
    reportedThrough: amountMinor === null ? "2026-09-20" : date,
    timeZone: TZ,
  });
  const noRevenue: RevenueProjection = { ...learning, status: "no-revenue", reason: "Connect a daily revenue source." };
  const paced = ready(1_000, 1_000, null);
  /** A site with a paced revenue source, unless `revenueProjection` is given
   * (`null` for a site the Worker built no projection for). */
  const site = (dailyRevenue: DailyRevenueSummary | undefined, revenueProjection: RevenueProjection | null = paced) => ({
    revenueProjection: revenueProjection ?? undefined,
    dailyRevenue,
  });

  it("adds up every site's report when all of them are in", () => {
    expect(yesterdayTotal([site(day(4_318)), site(day(1_207))], NOW)).toEqual({ amount: 55.25, reported: 2, sites: 2, basis: { date: "2026-09-21", timeZone: TZ } });
  });

  it("leaves a site whose report is not in out of the sum, and counts it", () => {
    expect(yesterdayTotal([site(day(4_318)), site(day(null))], NOW)).toEqual({ amount: 43.18, reported: 1, sites: 2, basis: { date: "2026-09-21", timeZone: TZ } });
    // A site with no summary at all owes the day just the same.
    expect(yesterdayTotal([site(day(4_318)), site(undefined)], NOW)).toEqual({ amount: 43.18, reported: 1, sites: 2, basis: { date: "2026-09-21", timeZone: TZ } });
  });

  it("has no number, never $0, when no report is in yet", () => {
    expect(yesterdayTotal([site(day(null)), site(day(null))], NOW)).toEqual({ amount: null, reported: 0, sites: 2, basis: { date: "2026-09-21", timeZone: TZ } });
  });

  it("counts a recorded $0 as a real report", () => {
    expect(yesterdayTotal([site(day(0)), site(day(null))], NOW)).toEqual({ amount: 0, reported: 1, sites: 2, basis: { date: "2026-09-21", timeZone: TZ } });
    expect(yesterdayTotal([site(day(0))], NOW)).toEqual({ amount: 0, reported: 1, sites: 1, basis: { date: "2026-09-21", timeZone: TZ } });
  });
  it("does not combine incompatible provider reporting days into one same-day figure", () => {
    const at = Date.parse("2026-09-22T00:30:00Z");
    const pacific = day(100, "2026-09-20");
    const utc = { ...day(200, "2026-09-21"), timeZone: "UTC" };
    expect(yesterdayTotal([site(pacific), site(utc), site(day(0, "2026-09-20")), site(day(null))], at))
      .toEqual({ amount: null, reported: 3, sites: 4, basis: null, mixedBasis: true });
  });
  it("keeps different reporting clocks separate even when their date labels agree", () => {
    expect(yesterdayTotal([site(day(100)), site({ ...day(200), timeZone: "UTC" })], NOW))
      .toEqual({ amount: null, reported: 2, sites: 2, basis: null, mixedBasis: true });
  });

  it("preserves a received partial report's basis when another source's clock has no report", () => {
    const at = Date.parse("2026-09-22T00:30:00Z");
    expect(yesterdayTotal([site(day(100, "2026-09-20")), site({ ...day(null), timeZone: "UTC" })], at))
      .toEqual({ amount: 1, reported: 1, sites: 2, basis: { date: "2026-09-20", timeZone: TZ } });
  });

  it("counts only the sites with a revenue source", () => {
    const withoutSource = [site(day(null), noRevenue), site(undefined, null)];
    expect(hasRevenueSource(withoutSource[0]!)).toBe(false);
    expect(hasRevenueSource(withoutSource[1]!)).toBe(false);
    // A projection still learning is a source: the site reports, it just has
    // no pace yet.
    expect(hasRevenueSource(site(day(1_207), learning))).toBe(true);
    expect(yesterdayTotal([site(day(1_207), learning), ...withoutSource], NOW)).toEqual({ amount: 12.07, reported: 1, sites: 1, basis: { date: "2026-09-21", timeZone: TZ } });
    // No site with a source: the Wall says nothing about yesterday.
    expect(yesterdayTotal(withoutSource, NOW)).toBeNull();
    expect(yesterdayTotal([], NOW)).toBeNull();
  });

  it("never shows the day before as yesterday once the payload it holds crosses midnight", () => {
    // 1 AM on Sep 23 in Los Angeles: yesterday is now Sep 22, and the held
    // summaries still describe Sep 21.
    const afterMidnight = Date.parse("2026-09-23T08:00:00.000Z");
    expect(yesterdayTotal([site(day(4_318)), site(day(1_207))], afterMidnight)).toEqual({ amount: null, reported: 0, sites: 2, basis: { date: "2026-09-22", timeZone: TZ } });
    expect(yesterdayTotal([site(day(4_318, "2026-09-22")), site(day(1_207))], afterMidnight)).toEqual({
      amount: 43.18,
      reported: 1,
      sites: 2,
      basis: { date: "2026-09-22", timeZone: TZ },
    });
  });
});
