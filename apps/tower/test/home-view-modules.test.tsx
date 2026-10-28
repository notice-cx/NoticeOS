import { fireEvent, render, screen, waitFor, within } from "./render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, CardChannels, CardDataSource, CardProduct, SeriesPoint, SignalTrend, WallPayload } from "@shared/wall";
import { emptyWorkHistory, type WorkPayload } from "@shared/work";
import type { RevenueProjection } from "@shared/revenue-projection";

// Home's four business modules (site health, the agents' week, where visitors
// come from, what is worth a look) and the views that draw them. The wall,
// work and provider reads are mocked; the stored view choice and the cards
// are the inputs that vary.

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

const uptime: CardDataSource = { id: "uptime", label: "Uptime", state: "live" };

function product(over: Partial<CardProduct> = {}): CardProduct {
  return {
    observedAt: "2026-10-18T06:00:00.000Z", speed: "clear", worstSpeed: "good", errors: "clear",
    errorPeople: 0, jsErrorFinding: false, funnel: null, ...over,
  };
}

/** 56 finished days at a steady level: four weeks against four weeks. */
function clicks(perDay: number): SignalTrend {
  const start = Date.parse("2026-08-23T00:00:00.000Z");
  const series: SeriesPoint[] = Array.from({ length: 56 }, (_, index) => ({
    t: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    v: perDay,
  }));
  return { series, provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
}

const codebase = { date: "2026-10-18", commit: "abc1234", codeLines: 40_000, growthPercent30d: 4, comparedDays: 30 };

/** Every fact measured and fine. */
const healthy = (id: string, over: Partial<AssetCard> = {}) =>
  card(id, { dataSources: [uptime], product: product(), searchClicks: clicks(100), codebase, ...over });

const state = vi.hoisted(() => ({
  payload: null as unknown as WallPayload,
  work: undefined as WorkPayload | undefined,
}));

function wall(assets: AssetCard[]): WallPayload {
  return {
    generatedAt: "2026-10-19T12:00:00.000Z",
    portfolio: {
      netTrendCurrency: "USD", netTrendAllCurrency: "USD", period: "2026-10", periodIsCurrent: true,
      booked: { currency: "USD", revenue: 100, cost: 20, net: 80 },
      forecast: { currency: "USD", revenue: 45, cost: 0, net: 45 },
      netTrend: [{ t: "2026-10", v: 80 }], netTrendAll: [{ t: "2026-10", v: 80 }], trendGranularity: "monthly",
      bookedDelta: null, residue: { booked: ZERO, forecast: ZERO }, firstRun: false, daysIn: 19,
    },
    system: {
      assetId: "root-os", hasPulse: true, spendTodayUsd: 1, dailyCapUsd: 2,
      ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 },
      scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: "2026-10-19T11:00:00.000Z", lastRanAt: "2026-10-19T11:00:00.000Z", failedRuns: 0, failingSince: null }],
    },
    dashboard: {},
    assets,
    attention: [],
    snoozed: [],
    operator: { waiting: 0, urgent: 0, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 1, capturedAt: "2026-10-19T12:00:00.000Z" },
    ledgerRecordedAt: "2026-10-19T12:00:00.000Z",
  } as unknown as WallPayload;
}

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  fetchTasksCapabilities: async () => ({ live: true, reason: null }),
  fetchTaskProjects: async () => [],
}));

vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: state.payload, isError: false, isPending: false }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isError: false, isPending: state.work === undefined }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: undefined, isError: false, status: { kind: "unknown" } }),
}));
vi.mock("@/hooks/useAssetDetail", () => ({ useAssetDetail: () => ({ data: undefined, isFetching: false, error: null }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-10-19T12:05:00.000Z") }));
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({ data: { generatedAt: "2026-10-19T12:05:00.000Z", since: "2026-10-19T01:00:00.000Z", items: [], limit: 50 }, isError: false }),
}));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

import { HomeRoute } from "@/routes/HomeRoute";
import { ChannelsModule, channelShares } from "@/routes/home/ChannelsModule";
import { FactoryModule } from "@/routes/home/FactoryModule";
import { GapsModule } from "@/routes/home/GapsModule";
import { HealthModule } from "@/routes/home/HealthModule";
import { useView } from "@/hooks/useView";
import { storageKey } from "@/lib/browser-storage";

afterEach(() => {
  window.localStorage.removeItem(storageKey("view"));
  state.work = undefined;
});

function storeView(view: string, focus: string[] = []) {
  window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus }));
}

function tree(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const renderHome = () => render(tree(<HomeRoute />));

const revenueProjection: RevenueProjection = {
  period: "2026-10", status: "ready", reason: null, reportedThrough: "2026-10-18",
  earnedMinor: 1800, projectedMinor: 3100, dailyPaceMinor: 100,
  previousPeriod: "2026-09", previousMonthMinor: 3000, changePercent: null,
  historyDays: 84, holidayHistoryDays: 0,
  points: Array.from({ length: 31 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, "0")}`,
    cumulativeMinor: (index + 1) * 100, projected: index >= 18,
  })),
};

describe("Home's combined revenue card", () => {
  const dailyRevenue = { date: "2026-10-18", amountMinor: 1176, reportedThrough: "2026-10-18", timeZone: "UTC" };

  it.each(["overview", "revenue"])("shows yesterday within the month card in the %s view", (view) => {
    state.payload = wall([healthy("first.example.com", { revenueProjection, dailyRevenue })]);
    storeView(view);
    const { container } = renderHome();
    const hero = container.querySelector<HTMLElement>("[data-money-hero]")!;
    const yesterday = within(hero).getByRole("link", { name: `Yesterday $11.76 est.` });
    expect(yesterday).toHaveAttribute("href", "/financials");
    expect(yesterday.getAttribute("title")).toContain("UTC");
    expect(hero.textContent?.match(/projected/gi)).toHaveLength(1);
    expect(within(hero).getByRole("img", { name: /^Revenue a day, October/ })).toBeInTheDocument();
    expect(container.querySelector('[data-stat="Revenue, yesterday"]')).toBeNull();
    expect(container.querySelector('[data-stat="Visitors in the last 28 days"]') !== null).toBe(view === "overview");
  });

  it.each([
    ["zero", { ...dailyRevenue, amountMinor: 0 }, "Yesterday $0.00 est."],
    ["missing", { ...dailyRevenue, amountMinor: null }, "Yesterday · not reported yet"],
    ["stale", { ...dailyRevenue, date: "2026-10-17" }, "Yesterday · not reported yet"],
  ])("preserves %s revenue without inventing an amount", (_state, summary, label) => {
    state.payload = wall([healthy("first.example.com", { revenueProjection, dailyRevenue: summary })]);
    const { container } = renderHome();
    expect(container.querySelector("[data-home-yesterday]")).toHaveTextContent(label);
  });

  it("labels partial reporting and keeps an estimated total across reporting clocks", () => {
    const first = healthy("first.example.com", { revenueProjection, dailyRevenue });
    const second = healthy("second.example.com", { revenueProjection });
    state.payload = wall([first, second]);
    const { container, rerender } = renderHome();
    expect(container.querySelector("[data-home-yesterday]")).toHaveTextContent("Yesterday $11.76 est. · 1 of 2 assets");
    state.payload = wall([first, { ...second, dailyRevenue: { ...dailyRevenue, timeZone: "Europe/London" } }]);
    rerender(tree(<HomeRoute />));
    expect(container.querySelector("[data-home-yesterday]")).toHaveTextContent('Yesterday $23.07 est.');
  });
});

/** The board's grid: the second child of the brief, under the answer. */
const grid = (container: HTMLElement) => container.querySelector("[data-home-brief]")!.children[1]!;

/** The modules in the order drawn, read off each region's own marker; a
 * stacked column contributes its members in order. */
function modulesDrawn(container: HTMLElement): string[] {
  if (grid(container).getAttribute("data-home-layout") === "stacks") {
    return [...grid(container).querySelectorAll("[data-home-module]")].map((el) => el.getAttribute("data-home-module")!);
  }
  return [...grid(container).querySelectorAll("[data-surface-hero], [data-home-visitors], [data-home-sites], [data-incident-list], [data-decision-queue], [data-home-agents], [data-home-timeline]")].map((element) => {
    if (element.hasAttribute("data-surface-hero")) return "money";
    if (element.hasAttribute("data-home-visitors")) return "yesterday";
    if (element.hasAttribute("data-home-sites")) return "sites";
    if (element.hasAttribute("data-incident-list")) return "problems";
    if (element.hasAttribute("data-decision-queue")) return "decide";
    if (element.hasAttribute("data-home-agents")) return "agents";
    return "timeline";
  });
}

/** The rows of a stacked board: a full-width module, or the two columns'
 * modules in order. */
function rowsOf(container: HTMLElement): Array<{ full: string } | { wide: string[]; narrow: string[] }> {
  const board = grid(container);
  expect(board).toHaveAttribute("data-home-layout", "stacks");
  return [...board.children].map((row) => {
    const own = row.getAttribute("data-home-module");
    if (own) return { full: own };
    const members = (stack: string) =>
      [...(row.querySelector(`:scope > [data-home-stack="${stack}"]`)?.children ?? [])].map((el) => el.getAttribute("data-home-module")!);
    return { wide: members("wide"), narrow: members("narrow") };
  });
}

/** Every stack is a flex column with the grid's gap that falls back to one
 * column below the twelve-column width, and no module is stretched to its
 * neighbour's height. */
function expectContentHeight(container: HTMLElement) {
  for (const row of grid(container).querySelectorAll("[data-home-row]")) {
    expect(row.className.split(" ")).toEqual(["grid", "items-start", "gap-5", "@6xl:grid-cols-12", "[&>*]:min-w-0"]);
  }
  for (const stack of grid(container).querySelectorAll("[data-home-stack]")) {
    expect(stack).toHaveClass("flex", "flex-col", "gap-5");
    expect(stack.className).not.toMatch(/(^| )(h-full|items-stretch|grid-cols-2)( |$)/);
  }
  const modules = [...grid(container).querySelectorAll("[data-home-module]")];
  expect(modules.length).toBeGreaterThan(0);
  for (const module of modules) {
    const name = module.getAttribute("data-home-module");
    // A block wrapper, so nothing inside it grows to fill a flex track.
    expect(module.className, `${name} wrapper`).toBe("min-w-0");
    // A module beside others: neither its region nor the frame inside it
    // takes a percentage height.
    if (!module.closest("[data-home-stack]")) continue;
    for (const el of [module.firstElementChild, module.firstElementChild?.firstElementChild]) {
      if (el) expect(el.getAttribute("class") ?? "", `${name} stretches`).not.toMatch(/(^| )(h-full|self-stretch)( |$)/);
    }
  }
}

describe("the views draw their modules", () => {
  it("draws the four overview cards as a responsive two-by-two group with Assets immediately below", () => {
    state.payload = wall([card("first.example.com"), card("second.example.com")]);
    const { container } = renderHome();

    expect(modulesDrawn(container)).toEqual(["money", "yesterday", "agents", "decide", "problems", "sites", "timeline"]);
    expect(grid(container).getAttribute("class")).toBe("grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0");
    const overview = container.querySelector("[data-home-overview]")!;
    expect(overview).toHaveClass("grid", "@3xl:grid-cols-2", "items-start");
    expect([...overview.children].map((card) => card.matches("[data-incident-list]") ? "problems" : card.matches("[data-decision-queue]") ? "decisions" : card.matches("[data-home-agents]") ? "agents" : card.matches("[data-home-visitors]") ? "visitors" : "unknown"))
      .toEqual(["visitors", "agents", "decisions", "problems"]);
    expect(overview.nextElementSibling).toHaveAttribute("data-home-sites");
    expect(container.querySelectorAll("[data-home-sites]")).toHaveLength(1);
    expect(container.querySelector("[data-home-visitors]")?.querySelector("[data-home-sites]")).toBeNull();
    expect(container.querySelector("[data-home-health]")).toBeNull();
    const visitors = overview.querySelector("[data-home-visitors]")!;
    expect(visitors).not.toHaveClass("h-full", "self-stretch");
    expect(container.querySelector("[data-home-module]")).toBeNull();
    expect(container.querySelector("[data-home-answer-health]")).toBeNull();
    expect(container.querySelector("[data-home-answer] h2")!.textContent).toBe("October so far $45 est. Nothing is broken.");
  });

  it.each([
    ["growth", ["channels", "gaps", "problems", "yesterday", "decide", "sites"]],
    ["revenue", ["money", "problems", "decide", "sites", "timeline"]],
    ["delivery", ["factory", "problems", "decide", "agents", "timeline"]],
    ["reliability", ["health", "problems", "decide", "timeline"]],
  ])("draws the %s modules with alerts and decisions", (view, modules) => {
    storeView(view as string);
    state.payload = wall([healthy("first.example.com"), card("second.example.com")]);
    const { container } = renderHome();
    expect(modulesDrawn(container)).toEqual(modules);
    expectContentHeight(container);
    expect(container.querySelector("[data-decision-queue]")).not.toBeNull();
    expect(container.querySelector("[data-incident-list]")).not.toBeNull();
  });

  it("puts an existing focus first when its module belongs to the purpose", () => {
    storeView("revenue", ["money"]);
    state.payload = wall([healthy("first.example.com")]);
    const { container } = renderHome();
    expect(rowsOf(container)).toEqual([
      { wide: ["money", "problems"], narrow: ["decide"] },
      { full: "sites" },
      { full: "timeline" },
    ]);
  });

  it("leads Reliability with measured asset health without adding financial figures", () => {
    storeView("reliability");
    state.payload = wall([
      healthy("first.example.com", { displayName: "First Asset" }),
      healthy("second.example.com", { displayName: "Second Asset", product: product({ speed: "fired" }) }),
      card("third.example.com", { status: "pre-launch" }),
    ]);
    const { container } = renderHome();
    const answer = container.querySelector("[data-home-answer-health]")!;
    expect(answer.textContent?.trim()).toBe("1 of 2 assets are fine. Second Asset: slow for 1 in 4 visitors.");
    expect(answer.firstElementChild).toHaveClass("text-warn");
    expect(answer).not.toHaveTextContent("October");
  });

  it("names an asset whose nightly report is late, and never calls it fine", () => {
    storeView("reliability");
    state.payload = wall([
      healthy("brief.example.com", { displayName: "Brief Asset", pulseReceivedAt: "2026-10-17T11:05:00.000Z" }),
      healthy("second.example.com", { displayName: "Second Asset" }),
    ]);
    const { container } = renderHome();
    expect(container.querySelector("[data-home-answer-health]")!.textContent).toMatch(/^1 of 2 assets are fine\. Brief Asset: no report for 2 days\./);
    const row = container.querySelector<HTMLElement>('[data-site-health-row="brief.example.com"]')!;
    expect(row).toHaveAttribute("data-tech-health", "watch");
    expect(row.querySelector("[data-site-health-note]")!.textContent).toBe("No report for 2 days");
  });

  it.each(["overview", "revenue"])("keeps technical revenue detail in the %s view", (view) => {
    storeView(view);
    state.payload = wall([healthy("first.example.com")]);
    const { container } = renderHome();
    expect(container.querySelector("[data-money-figure]")!.textContent).toBe("$45est.");
    expect(container.querySelector("[data-money-figure]")!.previousElementSibling!.textContent).toBe("Revenue, October so far");
    expect(container.querySelector("[data-home-answer] h2")!.textContent).toMatch(/^October so far \$45 est\. /);
  });

  it("leads Growth with observed visitor and channel counts", () => {
    storeView("growth");
    state.payload = wall([healthy("first.example.com", {
      activeUsers: clicks(10),
      channels: { windowStart: "2026-09-21", windowEnd: "2026-10-18", rows: [{ channel: "Organic Search", sessions: 60, share: 0.6 }, { channel: "Direct", sessions: 40, share: 0.4 }] },
    })]);
    const { container } = renderHome();
    const answer = container.querySelector('[data-home-purpose="growth"]')!;
    expect(answer).toHaveTextContent("280 visitors in the last 28 days.");
    expect(answer).toHaveTextContent("Organic Search accounts for 60% of reported sessions.");
    expect(answer).not.toHaveTextContent("October");
  });

  it("keeps unreported Growth, Delivery and Reliability readings unknown", () => {
    state.payload = wall([card("first.example.com")]);
    for (const [view, words] of [
      ["growth", "Visitors have not been reported yet."],
      ["delivery", "Work in progress has not been counted yet. Finished work this week has not been counted yet."],
      ["reliability", "Asset health has not been measured yet."],
    ]) {
      storeView(view!);
      const result = renderHome();
      expect(result.container.querySelector("[data-home-answer] h2")).toHaveTextContent(words!);
      result.unmount();
    }
  });

  it("preserves an open gap task draft when the purpose changes", async () => {
    storeView("growth");
    state.payload = wall([card("first.example.com")]);
    function ChangePurpose() {
      const { setChoice } = useView();
      return <button onClick={() => setChoice({ view: "revenue", focus: [] })}>Switch to Revenue</button>;
    }
    const { container } = render(tree(<><HomeRoute /><ChangePurpose /></>));
    const trigger = screen.getByRole("button", { name: "Make a task for first.example.com earns nothing" });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch to Revenue" }));
    expect(container.querySelector('[data-home-purpose="revenue"]')).not.toBeNull();
    expect(container.querySelector("[data-home-gaps]")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Keep this draft");
  });

  it("reports measured healthy assets in Reliability", () => {
    storeView("reliability");
    state.payload = wall([healthy("first.example.com"), healthy("second.example.com")]);
    const { container } = renderHome();
    expect(container.querySelector("[data-home-answer-health]")!.textContent).toMatch(/^All 2 assets are fine\./);
  });
});

describe("the asset-health module", () => {
  const cards = [
    healthy("fine.example.com", { displayName: "Fine Asset" }),
    healthy("slow.example.com", { displayName: "Slow Asset", product: product({ speed: "fired", errors: "fired", errorPeople: 3 }) }),
    card("new.example.com", { displayName: "New Asset", status: "pre-launch" }),
  ];

  const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-site-health-row="${id}"]`)!;

  it("draws one row per asset under one header of five facts", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    expect([...container.querySelectorAll("[data-fact-header]")].map((el) => el.textContent)).toEqual(["Up", "Speed", "Errors", "Search", "Code"]);
    expect(container.querySelectorAll("[data-site-health-row]")).toHaveLength(3);
    // One column template for the header and every row, so each word sits
    // over its own dots: on a phone (below `@md`) the name takes its own line
    // and the five dots share the width, each column at least a header wide.
    const header = container.querySelector<HTMLElement>("[data-site-health-header]")!;
    const template = (el: HTMLElement) => el.className.split(" ").filter((c) => /grid-cols/.test(c));
    expect(template(header)).toEqual(["grid-cols-5", "@md:grid-cols-[minmax(0,1fr)_repeat(5,3rem)]", "@2xl:grid-cols-[minmax(8rem,14rem)_repeat(5,3rem)_minmax(0,1fr)]"]);
    for (const site of container.querySelectorAll<HTMLElement>("[data-site-health-row]")) {
      expect(template(site)).toEqual(template(header));
      expect(site.querySelector("a")).toHaveClass("col-span-full", "@md:col-span-1");
    }
    expect(header.firstElementChild).toHaveClass("hidden", "@md:block");
    expect(within(row(container, "fine.example.com")).getByRole("link", { name: /Fine Asset/ })).toHaveAttribute("href", "/assets/fine.example.com");
  });

  it("colours only the problem dots, keeps a hidden word on each and an empty ring for unknown", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    const slow = row(container, "slow.example.com");
    const speed = slow.querySelector('[data-fact="speed"] [data-fact-dot]')!;
    expect(speed).toHaveAttribute("data-fact-dot", "warn");
    expect(speed).toHaveClass("bg-warn");
    expect(slow.querySelector('[data-fact="speed"] .sr-only')).toHaveTextContent("Slow");
    expect(within(slow).getByRole("button", { name: "Slow Asset, Speed: Slow" })).toBeInTheDocument();

    const fine = row(container, "fine.example.com");
    for (const dot of fine.querySelectorAll("[data-fact-dot]")) {
      expect(dot).toHaveAttribute("data-fact-dot", "ok");
      expect(dot.className).not.toMatch(/bg-(warn|error)/);
    }
    expect(fine.querySelector('[data-fact="reachable"] .sr-only')).toHaveTextContent("Up");

    for (const dot of row(container, "new.example.com").querySelectorAll("[data-fact-dot]")) {
      expect(dot).toHaveAttribute("data-fact-dot", "unknown");
      expect(dot).toHaveClass("border-dashed");
      expect(dot.className).not.toMatch(/bg-(warn|error)/);
    }
  });

  it("writes each row's problems beside it, else Fine, else that nothing is measured yet", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    const note = (id: string) => row(container, id).querySelector("[data-site-health-note]")!.textContent;
    expect(note("slow.example.com")).toBe("Slow for 1 in 4 visitors · 3 people hit an error");
    expect(note("fine.example.com")).toBe("Fine");
    expect(note("new.example.com")).toBe("Nothing measured yet");
  });

  it("colours a home page that did not load in the error colour", () => {
    const site = healthy("down.example.com");
    const down = { key: "alert-1", severity: "error" as const, assets: [site.id], site: site.id, line: "Home page down", mark: "Home page down", since: null, conditions: ["open-flags" as const] };
    const { container } = render(tree(<HealthModule cards={[site]} issues={[down]} />));

    expect(container.querySelector('[data-fact="reachable"] [data-fact-dot]')).toHaveClass("bg-error");
  });
});

describe("the agents' week", () => {
  it("reads not counted yet without any task project", () => {
    const { container } = render(tree(<FactoryModule cards={[card("first.example.com")]} work={null} nowMs={Date.parse("2026-10-19T12:00:00.000Z")} />));

    const figure = (key: string) => container.querySelector(`[data-factory-figure="${key}"]`)!;
    expect(figure("building")).toHaveTextContent("Buildingnot counted yet");
    expect(figure("finished")).toHaveTextContent("Finishednot counted yet");
    expect(figure("proven")).toHaveTextContent("Proven to work0");
    expect(container.querySelector("[data-factory-latest]")).toBeNull();
  });

  it("counts the bets that worked and lists the newest lines", () => {
    const watched = card("first.example.com", {
      displayName: "First Asset",
      watches: { open: 2, latest: { id: "w-1", ref: "abc", outcome: "ship_confirmed", nextCheckDate: null, closedAt: "2026-10-17T00:00:00.000Z" } },
    });
    const { container } = render(tree(<FactoryModule cards={[watched]} work={null} nowMs={Date.parse("2026-10-19T12:00:00.000Z")} />));

    expect(container.querySelector('[data-factory-figure="proven"]')).toHaveTextContent("1");
    expect(screen.getByText("2 being watched")).toBeInTheDocument();
    expect(container.querySelector("[data-factory-latest]")).toHaveTextContent("Latest betFirst Asset · Worked");
  });

  it("opens a finished task's page from its line", () => {
    const work: WorkPayload = {
      generatedAt: "2026-10-19T12:00:00.000Z", capturedAt: "2026-10-19T11:00:00.000Z", pollCadenceHours: 1 / 60, owner: "config/beads.json", historyDays: 30,
      projects: [{
        asset: "first.example.com", prefix: "fa", name: "First Asset", ok: true, error: null,
        counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
        history: emptyWorkHistory(), priorities: null, epics: null, ready: [], inProgress: [], recentlyClosed: [], deferred: [], waiting: [],
        recentWork: [{ kind: "closed", taskId: "fa-1w2", title: "Faster sign-up page", by: "agent", model: null, at: "2026-10-19T08:00:00.000Z", evidence: "Sign-up loads in half the time" }],
      }],
    };
    const { container } = render(tree(<FactoryModule cards={[card("first.example.com")]} work={work} nowMs={Date.parse("2026-10-19T12:00:00.000Z")} />));

    const line = container.querySelector<HTMLElement>('[data-factory-task="fa-1w2"]')!;
    expect(within(line).getByRole("link", { name: "Faster sign-up page" })).toHaveAttribute("href", "/tasks/fa-1w2");
  });
});

describe("where visitors come from", () => {
  const split = (rows: [string, number][]): CardChannels => {
    const total = rows.reduce((sum, [, sessions]) => sum + sessions, 0);
    return { windowStart: "2026-09-21", windowEnd: "2026-10-18", rows: rows.map(([channel, sessions]) => ({ channel, sessions, share: sessions / total })) };
  };

  it("sums every asset's visits by channel and shares them of the total", () => {
    const shares = channelShares([
      card("a.example.com", { channels: split([["Organic Search", 300], ["Direct", 100]]) }),
      card("b.example.com", { channels: split([["Direct", 500], ["Referral", 100]]) }),
      card("c.example.com"),
    ]);

    expect(shares).toEqual([
      { channel: "Direct", sessions: 600, share: 0.6 },
      { channel: "Organic Search", sessions: 300, share: 0.3 },
      { channel: "Referral", sessions: 100, share: 0.1 },
    ]);
    expect(channelShares([card("c.example.com")])).toBeNull();
  });

  it("draws five channels and the rest as Other", () => {
    const cards = [card("a.example.com", { channels: split([["A", 70], ["B", 60], ["C", 50], ["D", 40], ["E", 30], ["F", 20], ["G", 10]]) })];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const rows = [...container.querySelectorAll("[data-channel]")];
    expect(rows.map((el) => el.getAttribute("data-channel"))).toEqual(["A", "B", "C", "D", "E", "Other"]);
    expect(rows.at(-1)).toHaveTextContent("Other11%");
    expect(rows.at(-1)).toHaveAttribute("data-channel-share", (30 / 280).toFixed(4));
  });

  it("draws the funnel with the largest drop across assets, the drop step coloured", () => {
    const cards = [
      card("a.example.com", { displayName: "A Asset", product: product({ funnel: { name: "Signup", largestDrop: { fromStep: "Viewed /", toStep: "Signed up", lostPeople: 40, stepConversion: 0.2 } } }) }),
      card("b.example.com", { displayName: "B Asset", product: product({ funnel: { name: "Checkout", largestDrop: { fromStep: "Cart", toStep: "Paid", lostPeople: 90, stepConversion: 0.1 } } }) }),
    ];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const funnel = container.querySelector('[data-channels-funnel="Checkout"]')!;
    expect(funnel).toHaveTextContent("B Asset · Checkout");
    expect(funnel).toHaveTextContent("90 people left between these two steps.");
    expect(funnel.querySelector('[data-funnel-step="to"] .bg-warn')).not.toBeNull();
    expect(funnel.querySelector('[data-funnel-step="from"] .bg-warn')).toBeNull();
    expect(container.querySelector("[data-channels-empty]")).toHaveTextContent("Not joined yet");
  });

  it("draws every step of the worst funnel, the biggest drop coloured, in a box its content's height", () => {
    // The demo's shape: four steps, the biggest loss between the second and third.
    const steps = [
      { label: "Visited", people: 1_000 },
      { label: "Opened a recipe", people: 580 },
      { label: "Saved it", people: 55 },
      { label: "Signed up", people: 12 },
    ];
    const cards = [
      card("a.example.com", {
        displayName: "Recipe Asset",
        product: product({ funnel: { name: "Recipe to sign-up", largestDrop: { fromStep: "Opened a recipe", toStep: "Saved it", lostPeople: 525, stepConversion: 55 / 580 }, steps } }),
      }),
    ];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const funnel = container.querySelector('[data-channels-funnel="Recipe to sign-up"]')!;
    const drawn = [...funnel.querySelectorAll("[data-funnel-step]")];
    expect(drawn.map((step) => step.querySelector("span")!.textContent)).toEqual(["Visited", "Opened a recipe", "Saved it", "Signed up"]);
    expect(drawn.map((step) => step.getAttribute("data-funnel-step"))).toEqual(["step-1", "from", "to", "step-4"]);
    expect(funnel.querySelectorAll(".bg-warn")).toHaveLength(1);
    expect(funnel.querySelector('[data-funnel-step="to"] .bg-warn')).not.toBeNull();
    expect(funnel).toHaveTextContent("525 people left between “Opened a recipe” and “Saved it”.");
    // The section is not stretched: its rows start at the top.
    const section = container.querySelector("[data-home-channels]")!;
    expect(section).toHaveClass("content-start");
    expect(section).not.toHaveClass("h-full");
  });

  it("says no funnel is declared, or that nothing is joined yet", () => {
    const declared = render(tree(<ChannelsModule cards={[card("a.example.com", { product: product() })]} />));
    expect(declared.container.querySelector("[data-channels-funnel]")).toHaveTextContent("No funnel declared yet");
    declared.unmount();
    const none = render(tree(<ChannelsModule cards={[card("a.example.com")]} />));
    expect(none.container.querySelector("[data-channels-funnel]")).toHaveTextContent("Not joined yet");
  });
});

describe("worth a look", () => {
  it("lists the gaps, each with a way to make a task, capped", () => {
    const cards = Array.from({ length: 5 }, (_, index) => card(`site-${index}.example.com`, { displayName: `Asset ${index}`, codebase: null }));
    const { container } = render(tree(<GapsModule cards={cards} />));

    // Five sites each earn nothing, have no task project and send no code
    // report: fifteen gaps, eight listed.
    expect(container.querySelector("[data-home-gaps]")).toHaveAttribute("data-home-gaps", "8");
    expect(within(container).getByRole("region", { name: "Worth a look" })).toHaveTextContent("Worth a look8");
    expect(container.querySelectorAll("[data-business-gap]")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show 5 more" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make a task for Asset 0 earns nothing" })).toBeInTheDocument();
  });

  it("says nothing is missing on a complete portfolio", () => {
    const complete = card("full.example.com", {
      booked: { currency: "USD", revenue: 10, cost: 0, net: 10 },
      codebase,
      work: { open: 1, highPriority: 0, inProgress: 0, blocked: 0, closedRecent: 0, priorities: [0, 0, 1, 0, 0], capturedAt: "2026-10-19T12:00:00.000Z" },
    });
    const { container } = render(tree(<GapsModule cards={[complete]} />));

    expect(container).toHaveTextContent("Nothing is missing.");
  });
});
