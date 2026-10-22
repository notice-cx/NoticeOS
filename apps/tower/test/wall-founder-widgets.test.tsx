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

const SLOW = card("slow.example.com", "Slow Asset", {
  product: { ...PRODUCT, speed: "fired", worstSpeed: "poor", errors: "fired", errorPeople: 12 },
});
const FINE = card("fine.example.com", "Fine Asset");

describe("WallHealth", () => {
  it("draws five dots an asset, colouring only the problems, each with its word", () => {
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

  it("puts each header over its own dots: every header cell is a grid cell in the rows' columns", () => {
    render(<WallHealth assets={[SLOW, FINE]} issues={[]} />);
    const table = screen.getByRole("table", { name: "Asset health" });
    const [header, ...rows] = within(table).getAllByRole("row");
    const headers = within(header!).getAllByRole("columnheader");
    // An `sr-only` cell is positioned out of the grid's flow and would shift
    // every visible header one column left.
    for (const cell of headers) expect(cell.className).not.toMatch(/\bsr-only\b/);
    expect(headers.map((cell) => cell.textContent)).toEqual(["Asset", "Up", "Speed", "Errors", "Search", "Code", "Problem"]);
    for (const row of rows) {
      const cells = [...row.children];
      expect(cells).toHaveLength(headers.length);
      for (const cell of cells) expect(cell.className).not.toMatch(/\bsr-only\b/);
      // The dots sit in the same columns as the headers above them.
      const dotColumns = cells.flatMap((cell, index) => (cell.hasAttribute("data-wall-health-fact") ? [index] : []));
      expect(dotColumns).toEqual([1, 2, 3, 4, 5]);
    }
    expect(header!.className).toContain("grid-cols-subgrid");
    for (const row of rows) expect(row.className).toContain("grid-cols-subgrid");
  });

  it("lets the rows share the widget's height on the TV, and keeps the +N note", () => {
    render(<WallHealth assets={[SLOW, FINE]} issues={[]} />);
    const section = screen.getByRole("region", { name: "Asset health" });
    expect(section.style.getPropertyValue("--health-rows")).toBe("2");
    const table = section.querySelector("[data-wall-health-table]")!;
    expect(table.className).toContain("tv:auto-rows-[minmax(min-content,1fr)]");
    expect(table.className).toContain("flex-1");
    expect(section.querySelector('[data-wall-health-fact] [aria-hidden]')!.className).toContain("size-(--wall-health-dot)");
    expect(section.querySelector('[data-wall-health-row="slow.example.com"] [data-wall-health-note]')).toHaveTextContent("· +1");
  });

  it("says how many measured assets are fine", () => {
    render(<WallHealth assets={[SLOW, FINE]} issues={[]} />);
    expect(screen.getByText("1 of 2 fine")).toBeInTheDocument();
  });
});

describe("WallFactory", () => {
  it("reads building, finished and proven in order, with the newest lines", () => {
    render(
      <WallFactory
        week={{
          building: 4,
          shipped: 9,
          proven: 1,
          watching: 2,
          latest: [{ title: "Latest bet", site: "Fine Asset", line: "Worked" }],
        }}
      />,
    );
    const figures = [...document.querySelectorAll("[data-wall-factory-figure]")].map((node) => node.textContent);
    // "Finished", as Home's agents module calls it.
    expect(figures).toEqual(["Building4", "Finished9", "Proven1"]);
    expect(screen.getByText("2 being watched")).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Latest bet · Fine AssetWorked");
  });

  it("starts the figures under the heading and the lines under them, each at its own height", () => {
    render(
      <WallFactory
        week={{
          building: 10,
          shipped: 4,
          proven: 1,
          watching: 1,
          latest: [
            { title: "Latest bet", site: "Fine Asset", line: "Worked" },
            { title: "Latest bet", site: "Slow Asset", line: "Did not help" },
          ],
        }}
      />,
    );
    const body = document.querySelector("[data-wall-factory-body]")!;
    const classes = body.className.split(" ");
    // Top-aligned on the TV, one gap apart: nothing centres the content in a
    // cell taller than it.
    expect(classes).toEqual(expect.arrayContaining(["tv:flex-1", "gap-3"]));
    expect(body.className).not.toMatch(/justify-center|justify-end|gap-\[1lh\]/);
    // The figures keep their height; the list takes the height left, and
    // each line in it keeps its own.
    const figures = body.querySelector("[data-wall-factory-figures]")!;
    expect(figures.className).not.toMatch(/flex-1|flex-\[/);
    expect(body.querySelector("ul")!.className.split(" ")).toEqual(expect.arrayContaining(["tv:flex-1", "tv:min-h-0", "tv:overflow-hidden"]));
    expect(body.querySelector("ul")!.className).not.toMatch(/justify-center/);
    for (const line of body.querySelectorAll("[data-wall-factory-line]")) {
      expect(line.className.split(" ")).toContain("shrink-0");
      expect(line.className).not.toMatch(/flex-1|flex-\[|justify-center/);
    }
  });

  it("draws every line the week has and hides the ones that do not fit whole", () => {
    const latest = ["One Asset", "Two Asset", "Three Asset", "Four Asset"].map((site) => ({ title: "Latest bet", site, line: "Worked" }));
    // The list is 200 px tall and each line 60 px with an 8 px gap: three fit whole.
    const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "UL") return box(0, 200) as DOMRect;
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return box(index * 68, 60) as DOMRect;
    });
    try {
      render(<WallFactory week={{ building: 1, shipped: 1, proven: 1, watching: 0, latest }} />);
      const lines = [...document.querySelectorAll("[data-wall-factory-line]")];
      expect(lines).toHaveLength(4);
      expect(lines.map((line) => line.hasAttribute("data-wall-factory-cut"))).toEqual([false, false, false, true]);
      expect(lines[3]).toHaveAttribute("aria-hidden", "true");
      expect(lines[3]).toHaveClass("invisible");
    } finally {
      spy.mockRestore();
    }
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

  it("sums each channel across the assets, largest first, with its share of the whole", () => {
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
    expect(largestFunnelDrop([a, b])).toEqual({ site: "B", funnel: "Checkout", drop: b.product!.funnel!.largestDrop, steps: [] });
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

  it("draws every step of the worst funnel, the step after the drop coloured, and fills its column", () => {
    const steps = [
      { label: "Visited", people: 1_000 },
      { label: "Opened a recipe", people: 580 },
      { label: "Saved it", people: 55 },
      { label: "Signed up", people: 12 },
    ];
    const recipes = card("r.example.com", "Recipe Asset", {
      channels: { ...window, rows: [{ channel: "Organic Search", sessions: 900, share: 0.9 }, { channel: "Direct", sessions: 100, share: 0.1 }] },
      product: { ...PRODUCT, funnel: { name: "Recipe to sign-up", largestDrop: { fromStep: "Opened a recipe", toStep: "Saved it", lostPeople: 525, stepConversion: 55 / 580 }, steps } },
    });
    render(<WallChannels assets={[recipes]} />);

    const section = screen.getByRole("region", { name: "Visitors by channel" });
    expect(section).toHaveClass("h-full", "min-h-0");
    const funnel = section.querySelector('[data-wall-funnel="Recipe to sign-up"]')!;
    expect(funnel).toHaveTextContent("Largest drop · Recipe Asset · Recipe to sign-up");
    const drawn = [...funnel.querySelectorAll("[data-wall-funnel-step]")];
    expect(drawn.map((step) => step.getAttribute("data-wall-funnel-step"))).toEqual(["step-1", "from", "to", "step-4"]);
    expect(drawn.map((step) => step.firstElementChild!.textContent)).toEqual(["Visited", "Opened a recipe", "Saved it", "Signed up"]);
    expect(funnel.querySelectorAll(".bg-warn")).toHaveLength(1);
    expect(funnel.querySelector('[data-wall-funnel-step="to"] .bg-warn')).not.toBeNull();
    expect(drawn[1]).toHaveTextContent("58058%");
    expect(funnel).toHaveTextContent("525 people left · 9% went on");

    // The channel rows and the steps share the height left under the header,
    // each list growing by its own count of rows, every row an equal track.
    const channels = section.querySelector<HTMLElement>("[data-wall-channel-rows]")!;
    expect(channels.style.getPropertyValue("--wall-bar-rows")).toBe("2");
    expect(funnel.getAttribute("style")).toContain("--wall-bar-rows: 4");
    for (const list of [channels, funnel, funnel.querySelector("ol")!]) {
      expect(list.className).toContain("tv:grow-(--wall-bar-rows)");
      expect(list.className).toContain("tv:basis-0");
    }
    for (const list of [channels, funnel.querySelector("ol")!]) expect(list.className).toContain("tv:auto-rows-[minmax(min-content,1fr)]");
  });

  it("says so when no asset carries a channel split", () => {
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
    ["business", ["strip", "next", "health", "revenue", "needs", "factory"]],
    ["product", ["strip", "revenue", "channels", "sites", "work"]],
  ] as const)("draws every widget of %s", (view, types) => {
    render(<WallCanvas layout={WALL_PRESETS[view]} data={payload} nowMs={NOW} />);
    const drawn = [...document.querySelectorAll("[data-wall-slot]")].map((node) => node.getAttribute("data-wall-slot"));
    expect(drawn).toEqual(types);
    if (view === "business") {
      expect(within(document.querySelector('[data-wall-slot="health"]') as HTMLElement).getByText("Slow Asset")).toBeInTheDocument();
    }
  });

  it("stacks the business preset on a phone with what waits on the operator right after what is broken", () => {
    render(<WallCanvas layout={WALL_PRESETS.business} data={payload} nowMs={NOW} />);
    const stacked = [...document.querySelectorAll<HTMLElement>("[data-wall-slot]")]
      .sort((a, b) => Number(a.style.order) - Number(b.style.order))
      .map((node) => node.getAttribute("data-wall-slot"));
    expect(stacked).toEqual(["strip", "revenue", "needs", "next", "health", "factory"]);
  });
});
