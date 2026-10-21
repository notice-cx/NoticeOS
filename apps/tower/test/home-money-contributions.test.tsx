import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { RevenueProjection } from "@shared/revenue-projection";
import type { AssetCard, PortfolioBand } from "@shared/wall";
import { assetContributors } from "@/lib/asset-contributors";
import { homeMoney } from "@/lib/home-money";
import { MoneyHero } from "@/routes/home/MoneyHero";
import { render } from "./render";

const projection = (amount: number): RevenueProjection => ({
  period: "2026-10", status: "ready", reason: null, reportedThrough: "2026-10-03", earnedMinor: amount * 3,
  projectedMinor: amount * 31, dailyPaceMinor: amount, previousPeriod: "2026-09", previousMonthMinor: amount * 30,
  changePercent: null, historyDays: 28, holidayHistoryDays: 0,
  points: [1, 2, 3, 4].map((day) => ({ date: `2026-10-0${day}`, cumulativeMinor: amount * day, projected: day === 4 })),
});

const asset = (id: string, amount: number): AssetCard => ({
  id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
  booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
  netPeriod: "2026-10", pulseReceivedAt: null, firstReportAt: null, dataSources: [], work: null,
  activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  netByMonthCurrency: "USD", netByMonth: [], netByMonthProvisionalFrom: null, panelReview: null, latestPanelDate: null,
  revenueProjection: projection(amount),
});

const zero = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const portfolio: PortfolioBand = {
  period: "2026-10", periodIsCurrent: true, firstRun: false, daysIn: 3,
  booked: zero, forecast: zero, bookedDelta: null, residue: { booked: zero, forecast: zero },
  netTrend: [], netTrendAll: [], netTrendCurrency: "USD", netTrendAllCurrency: "USD", trendGranularity: "monthly",
};

describe("Home revenue contributions", () => {
  it("stacks daily earnings and keeps an asset's colour when its revenue rank changes", () => {
    const assets = [asset("b.example", 300), asset("a.example", 100)];
    const money = homeMoney(portfolio, assets)!;
    expect(money.days).toHaveLength(3);
    expect(money.days[0]).toEqual({ t: "2026-10-01", v: 4, contributions: { "a.example": 1, "b.example": 3 } });
    expect(money.contributors).toEqual(assetContributors(assets));
    expect(money.bySite.map((site) => site.id)).toEqual(["b.example", "a.example"]);
    const { container } = render(<MemoryRouter><MoneyHero money={money} /></MemoryRouter>);
    const tone = money.contributors!.find((source) => source.id === "b.example")!.tone;
    expect(container.querySelector('[data-bar="2026-10-01"] [data-contributor="b.example"]')).toHaveStyle({ height: "75%" });
    expect(container.querySelector('[data-bar="2026-10-01"] [data-contributor="b.example"]')).toHaveClass(tone);
    expect(container.querySelector('[data-segment="b.example"]')).toHaveClass(tone);
    const swapped = homeMoney(portfolio, [asset("a.example", 300), asset("b.example", 100)])!;
    expect(swapped.contributors).toEqual(money.contributors);
  });
});
