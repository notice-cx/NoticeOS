// The three widgets the founder views brought to the TV: site health as five
// dots a site, the agents' week as three figures, and the portfolio's visitors
// by channel with its largest funnel drop. Each is drawn from the cards alone.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, CardProduct, WallPayload } from "@shared/wall";
import { WALL_PRESETS } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import { WallChannels, WALL_CHANNEL_ROWS, largestFunnelDrop, portfolioChannels } from "@/components/wall/WallChannels";
import { WallFactory } from "@/components/wall/WallFactory";
import { WallHealth, wallHealthNote } from "@/components/wall/WallHealth";
import { techHealth } from "@/lib/tech-health";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-10-19T12:00:00.000Z") }));
vi.mock("@/hooks/useWallFeed", () => ({ useWallFeed: () => ({ data: undefined, isError: false }) }));

const EMPTY_SERIES = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

const PRODUCT: CardProduct = {
  observedAt: "2026-10-18T12:30:00.000Z",
  speed: "clear",
  worstSpeed: "good",
  errors: "clear",
  errorPeople: 0,
  jsErrorFinding: false,
  funnel: null,
};

function card(id: string, displayName: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    netByMonthCurrency: "USD",
    id,
    displayName,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-10",
    pulseReceivedAt: "2026-10-19T11:00:00.000Z",
    firstReportAt: null,
    dataSources: [{ id: "uptime", label: "Uptime", state: "live" }],
    activeUsers: EMPTY_SERIES,
    work: null,
    panelReview: null,
    searchClicks: EMPTY_SERIES,
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    latestPanelDate: null,
    product: PRODUCT,
    ...over,
  };
}

const SLOW = card("slow.example.com", "Slow Site", {
  product: { ...PRODUCT, speed: "fired", worstSpeed: "poor", errors: "fired", errorPeople: 12 },
});
const FINE = card("fine.example.com", "Fine Site");

describe("WallHealth", () => {
  it("draws five dots a site, colouring only the problems, each with its word", () => {
    render(<WallHealth assets={[SLOW, FINE]} issues={[]} />);
    const slow = document.querySelector('[data-wall-health-row="slow.example.com"]')!;
    expect(slow.querySelectorAll("[data-wall-health-fact]")).toHaveLength(5);
    const speed = slow.querySelector('[data-wall-health-fact="speed"]')!;
    expect(speed.getAttribute("data-wall-health-state")).toBe("warn");
    expect(speed.querySelector(".bg-warn")).not.toBeNull();
    expect(speed).toHaveTextContent("Speed: Slow");
    const fine = document.querySelector('[data-wall-health-row="fine.example.com"]')!;
    expect(fine.querySelector(".bg-warn, .bg-error")).toBeNull();
    // Unmeasured is a ring, measured a filled dot: a shape as well as a colour.
    expect(fine.querySelector('[data-wall-health-fact="code"] .border-2')).not.toBeNull();
  });

  it("puts the problem's note beside its row and counts the rest", () => {
    render(<WallHealth assets={[SLOW]} issues={[]} />);
    const note = document.querySelector('[data-wall-health-row="slow.example.com"] [data-wall-health-note]')!;
    expect(note).toHaveTextContent("Slow for 1 in 4 visitors · +1");
  });

  it("names the worst problem first", () => {
    const facts = techHealth(SLOW, []).facts;
    expect(wallHealthNote(facts)).toEqual({ note: "Slow for 1 in 4 visitors", more: 1 });
    expect(wallHealthNote(techHealth(FINE, []).facts)).toBeNull();
  });

  it("says how many measured sites are fine", () => {
    render(<WallHealth assets={[SLOW, FINE]} issues={[]} />);
    expect(screen.getByText("1 of 2 fine")).toBeInTheDocument();
  });
});

describe("WallFactory", () => {
  it("reads building, shipped and proven in order, with the newest lines", () => {
    render(
      <WallFactory
        week={{
          building: 4,
          shipped: 9,
          proven: 1,
          watching: 2,
          latest: [{ title: "Latest bet", site: "Fine Site", line: "Worked" }],
        }}
      />,
    );
    const figures = [...document.querySelectorAll("[data-wall-factory-figure]")].map((node) => node.textContent);
    expect(figures).toEqual(["Building4", "Shipped9", "Proven1"]);
    expect(screen.getByText("2 being watched")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Latest bet · Fine SiteWorked");
  });

  it("draws an unknown count as a dash and says when nothing is finished", () => {
    render(<WallFactory week={{ building: null, shipped: null, proven: 0, watching: 0, latest: [] }} />);
    expect(screen.getAllByLabelText("Unknown")).toHaveLength(2);
    expect(screen.getByText("Nothing finished yet")).toBeInTheDocument();
  });
});

describe("WallChannels", () => {
  const window = { windowStart: "2026-10-11", windowEnd: "2026-10-17" };
  const a = card("a.example.com", "A", {
    channels: { ...window, rows: [{ channel: "Organic Search", sessions: 300, share: 0.75 }, { channel: "Direct", sessions: 100, share: 0.25 }] },
    product: { ...PRODUCT, funnel: { name: "Signup", largestDrop: { fromStep: "Visit", toStep: "Sign up", lostPeople: 40, stepConversion: 0.2 } } },
  });
  const b = card("b.example.com", "B", {
    channels: { ...window, rows: [{ channel: "Direct", sessions: 100, share: 1 }] },
    product: { ...PRODUCT, funnel: { name: "Checkout", largestDrop: { fromStep: "Cart", toStep: "Pay", lostPeople: 90, stepConversion: 0.4 } } },
  });

  it("sums each channel across the sites, largest first, with its share of the whole", () => {
    expect(portfolioChannels([a, b])).toEqual({
      total: 500,
      rows: [
        { channel: "Organic Search", sessions: 300, share: 0.6 },
        { channel: "Direct", sessions: 200, share: 0.4 },
      ],
    });
    expect(portfolioChannels([FINE])).toBeNull();
  });

  it("folds the channels past its limit into Other", () => {
    const many = card("m.example.com", "M", {
      channels: { ...window, rows: Array.from({ length: 8 }, (_, i) => ({ channel: `C${i}`, sessions: 80 - i * 10, share: 0 })) },
    });
    const rows = portfolioChannels([many])!.rows;
    expect(rows).toHaveLength(WALL_CHANNEL_ROWS);
    expect(rows.at(-1)).toMatchObject({ channel: "Other", sessions: 30 + 20 + 10 });
  });

  it("picks the funnel step that loses the most people", () => {
    expect(largestFunnelDrop([a, b])).toEqual({ site: "B", funnel: "Checkout", drop: b.product!.funnel!.largestDrop });
    expect(largestFunnelDrop([FINE])).toBeNull();
  });

  it("draws the bars and the drop", () => {
    render(<WallChannels assets={[a, b]} />);
    expect(screen.getByText("500 visits")).toBeInTheDocument();
    const bars = document.querySelectorAll("[data-wall-channel]");
    expect([...bars].map((bar) => bar.getAttribute("data-wall-channel"))).toEqual(["Organic Search", "Direct"]);
    expect(bars[0]).toHaveTextContent("60%");
    const drop = document.querySelector("[data-wall-funnel-drop]")!;
    expect(drop).toHaveTextContent("Largest drop · B · Checkout");
    expect(drop).toHaveTextContent("Cart to Pay");
    expect(drop).toHaveTextContent("90 people left · 40% went on");
  });

  it("says so when no site carries a channel split", () => {
    render(<WallChannels assets={[FINE]} />);
    expect(screen.getByText("No channel split yet")).toBeInTheDocument();
  });
});

describe("the presets on the canvas", () => {
  const payload = {
    generatedAt: "2026-10-19T11:58:00.000Z",
    portfolio: {
      netTrendCurrency: "USD", netTrendAllCurrency: "USD", period: "2026-10", periodIsCurrent: true,
      booked: { currency: "USD", revenue: 0, cost: 0, net: 0 },
      forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
      netTrend: [], netTrendAll: [], trendGranularity: "monthly", bookedDelta: null,
      residue: { booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 } },
      firstRun: false, daysIn: 19,
    },
    system: { assetId: "root-os", hasPulse: true, spendTodayUsd: 0, dailyCapUsd: 1, ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 }, scheduledLanes: [] },
    dashboard: {},
    assets: [SLOW, FINE],
    attention: [],
    snoozed: [],
    operator: null,
    ledgerRecordedAt: null,
  } as unknown as WallPayload;

  it.each([
    ["business", ["strip", "health", "revenue", "needs", "factory"]],
    ["product", ["strip", "revenue", "channels", "sites", "work"]],
  ] as const)("draws every widget of %s", (view, types) => {
    render(<WallCanvas layout={WALL_PRESETS[view]} data={payload} nowMs={NOW} />);
    const drawn = [...document.querySelectorAll("[data-wall-slot]")].map((node) => node.getAttribute("data-wall-slot"));
    expect(drawn).toEqual(types);
    if (view === "business") {
      expect(within(document.querySelector('[data-wall-slot="health"]') as HTMLElement).getByText("Slow Site")).toBeInTheDocument();
    }
  });
});
